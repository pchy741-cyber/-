/**
 * 매도 판단 로직 — SL/TP/ATR트레일/부분익절/AI매도/기술적매도
 * overseas-job.ts에서 추출
 */
import { OVERSEAS, SECTOR_CLASS, OVERSEAS_FEE_PCT, getOverseasDynamic } from '../../config/constants.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { OverseasPrice } from '../../kis/overseas.js';
import {
  GLOBAL_WATCHLIST,
} from './watchlist.js';
import {
  updateTradeState, getMaxPrice, setMaxPrice,
  cleanupPositionState,
} from './state.js';
import {
  calcDynamicTrailDrop, calcDynamicTpSl, type RegimeAdjustment,
  getPartialTpStages, getPartialTpStageNum, setPartialTpStageNum,
} from './risk-intelligence.js';
import { executeOverseasOrder } from './executor.js';
import { getTunerOverrides } from './trade-tuner.js';


// ── 타입 ──

export interface TechResult {
  code: string; name: string; exchange: string; sector: string;
  price: OverseasPrice; signal: string; score: number;
  rsi: number; adx: number; trendStrength: string;
  dayRangePct: number; isMomentum: boolean; isBigMover: boolean;
  aboveMA20: boolean; aboveMA60: boolean;
  bollingerSqueeze: boolean; bollingerBreakout: 'UP' | 'DOWN' | 'NONE';
  atrPct: number;
  vwapPosition?: 'ABOVE' | 'BELOW' | 'AT';  // 개선#4: VWAP 대비 위치
}

export interface Holding {
  qty: number; avgPrice: number; boughtAt: string; exchange: string;
  tpPct: number | null; slPct: number | null;
}

import type { AIDecision } from './types.js';

export interface SellContext {
  holdings: Map<string, Holding>;
  pendingOrderStocks: Set<string>;
  techResults: TechResult[];
  aiMap: Map<string, AIDecision>;
  vixRegime: RegimeAdjustment;
  cash: number;
  isPaper?: boolean;
  portfolioValue?: number; // 동적 MAX_HOLD_DAYS 계산용
}

export interface SellResult {
  sellOrders: string[];
  cash: number;
}

/**
 * 보유종목 매도 판단 + 실행
 * - 손절 / ATR 트레일 / 하드 익절 / AI 매도 / 기술적 매도 / 보유기한 초과
 * - 3단계 부분 익절
 */
export async function evaluateSells(ctx: SellContext): Promise<SellResult> {
  const { holdings, pendingOrderStocks, techResults, aiMap, vixRegime } = ctx;
  const paperMode = ctx.isPaper;
  let { cash } = ctx;
  const sellOrders: string[] = [];
  // 동적 파라미터 1회 캐싱 (루프 밖)
  const dynP = getOverseasDynamic(ctx.portfolioValue ?? 5000);
  // Trade Tuner 오버라이드 로드 (1회)
  const tunerOverrides: Record<string, number> = await getTunerOverrides(paperMode).catch(() => ({}));
  const maxHoldDays = tunerOverrides.max_hold_days ?? dynP.maxHoldDays;

  for (const [code, holding] of holdings) {
    if (pendingOrderStocks.has(code)) {
      logger.info(`⏳ 미체결 주문 존재 → ${code} 추가 주문 스킵`, { component: 'OVERSEAS' });
      continue;
    }
    const tech = techResults.find(t => t.code === code);
    if (!tech) continue;

    const curPrice = tech.price.currentPrice;
    const pnlPct = ((curPrice - holding.avgPrice) / holding.avgPrice) * 100;
    const ai = aiMap.get(code);

    const prevMax = await getMaxPrice(code, paperMode);
    const newMax = Math.max(prevMax || holding.avgPrice, curPrice);
    if (newMax > prevMax) await setMaxPrice(code, newMax, paperMode);
    const maxPnlPct = ((newMax - holding.avgPrice) / holding.avgPrice) * 100;
    const drawdownFromPeak = ((curPrice - newMax) / newMax) * 100;

    let sellReason = '';

    const watchItem = GLOBAL_WATCHLIST.find(w => w.code === code);
    const sector = watchItem?.sector ?? '';
    const isHighBeta = SECTOR_CLASS.HIGH_BETA.includes(sector);
    const isMediumBeta = SECTOR_CLASS.MEDIUM_BETA.includes(sector);
    const isDefense = SECTOR_CLASS.DEFENSE.includes(sector);

    // ATR 동적 트레일링 스톱 + VIX 레짐 타이트닝
    const atrPctValue = tech.atrPct ?? 2.0;
    // TP/SL: overseas_holdings에 매수 시 저장된 값 우선 사용 (recalc 불필요)
    let hardTpPct: number;
    let stopLossPct: number;
    if (holding.tpPct != null && holding.slPct != null) {
      hardTpPct = holding.tpPct;
      stopLossPct = holding.slPct; // 이미 음수
    } else {
      // 레거시 보유종목 (tp_pct/sl_pct 미설정) → 1회 계산 후 DB 저장
      const dyn = calcDynamicTpSl({
        sector, adx: tech.adx ?? 20, rsi: tech.rsi ?? 50,
        aiConfidence: ai?.confidence, aiAction: ai?.action, vixRegime, isMomentum: tech.isMomentum,
        tunerOverrides,
      });
      hardTpPct = dyn.tpPct;
      stopLossPct = -dyn.slPct; // slPct는 절댓값(양수) → 비교용 음수로 변환
      // 레거시 보유종목 1회성 DB 저장 (다음 사이클부터 recalc 불필요)
      const { updateHoldingTpSl } = await import('./state.js');
      updateHoldingTpSl(code, hardTpPct, stopLossPct, paperMode).catch(() => {});
    }
    const dynamicTrailDrop = calcDynamicTrailDrop({ sector, atrPct: atrPctValue, maxPnlPct, adx: tech.adx, rsi: tech.rsi });
    const effectiveTrailDropPct = dynamicTrailDrop - vixRegime.trailTighten;
    const baseTrailActivate = isHighBeta ? 10.0 : isMediumBeta ? 8.0 : 5.0;
    const trailActivatePct = tunerOverrides.trail_activate_pct ?? baseTrailActivate;
    const minAiSellConf = isHighBeta ? 0.82 : 0.78;
    const minHoldForSell = isHighBeta ? 3 : 2;
    const holdingDays = (Date.now() - new Date(holding.boughtAt).getTime()) / (1000 * 60 * 60 * 24);

    // ── 개선#9: ADX/승률 기반 동적 보유기간 ──
    const effectiveMaxHold = calcDynamicHoldDays(maxHoldDays, tech, holdingDays);

    if (pnlPct <= stopLossPct) {
      sellReason = `손절(${stopLossPct}%): ${pnlPct.toFixed(1)}%`;
    } else if (maxPnlPct >= trailActivatePct && drawdownFromPeak <= effectiveTrailDropPct) {
      sellReason = `ATR트레일(${effectiveTrailDropPct.toFixed(1)}%/ATR${atrPctValue.toFixed(1)}%${vixRegime.trailTighten > 0 ? `/VIX${vixRegime.regime}` : ''}): 고점 +${maxPnlPct.toFixed(1)}% → 현재 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
    // ── 개선#1: 마이크로 트레일 — +4%~트레일활성화 구간 수익 보호 (추세 유지 시 제외) ──
    } else if (maxPnlPct >= 4.0 && maxPnlPct < trailActivatePct && drawdownFromPeak <= -2.5 && !tech.isMomentum && !(tech.aboveMA20 && tech.adx >= 20)) {
      sellReason = `마이크로트레일(+${maxPnlPct.toFixed(1)}%→${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%): 고점 대비 ${drawdownFromPeak.toFixed(1)}% 하락 → 수익보호`;
    } else if (pnlPct >= hardTpPct && !isWinnerRiding(tech, holdingDays)) {
      sellReason = `익절(${hardTpPct}%): +${pnlPct.toFixed(1)}%`;
    } else if (ai?.action === 'SELL' && ai.confidence >= 0.90) {
      sellReason = `AI 급매도(${(ai.confidence * 100).toFixed(0)}%): ${ai.reasoning}`;
    } else if (ai?.action === 'SELL' && ai.confidence >= minAiSellConf && holdingDays >= minHoldForSell) {
      sellReason = `AI 매도(${(ai.confidence * 100).toFixed(0)}%): ${ai.reasoning}`;
    } else if (!ai && tech.rsi > 78 && tech.score < 10 && pnlPct >= trailActivatePct && holdingDays >= minHoldForSell) {
      sellReason = `기술 익절(과매수): RSI=${tech.rsi.toFixed(0)} +${pnlPct.toFixed(1)}%`;
    } else if (!ai && tech.score <= -30 && (tech.signal === 'SELL' || tech.signal === 'STRONG_SELL') && holdingDays >= minHoldForSell) {
      sellReason = `기술적 매도(AI없음): score=${tech.score} RSI=${tech.rsi.toFixed(0)}`;
    } else if (holdingDays >= 3 && pnlPct <= -5.5 && !tech.isMomentum) {
      // 3일+ & -5.5% 이하 & 모멘텀 없음 → 반등 기대 어려움, 조기 손절
      sellReason = `시간SL(${holdingDays.toFixed(0)}일/${pnlPct.toFixed(1)}%): 반등 없이 하락 → 조기손절`;
    } else if (holdingDays >= 5 && pnlPct <= -3.0 && tech.score < 0 && !tech.aboveMA20) {
      // 5일+ & -3% & score 음수 & MA20 아래 → 약세 지속
      sellReason = `시간손절(${holdingDays.toFixed(0)}일/${pnlPct.toFixed(1)}%): score=${tech.score} MA20↓ → 조기정리`;
    } else if (holdingDays >= 7 && pnlPct <= -2.0 && pnlPct > -5.5 && tech.adx < 18) {
      // 7일+ & 소폭 손실 & 추세 없음 → 횡보 하락, 자본 묶임 방지
      sellReason = `횡보손절(${holdingDays.toFixed(0)}일/${pnlPct.toFixed(1)}%): ADX=${tech.adx.toFixed(0)} 추세없음 → 정리`;
    } else if (holdingDays > effectiveMaxHold && pnlPct < 3.0) {
      sellReason = pnlPct < 0
        ? `보유기한 초과(${holdingDays.toFixed(0)}일/손실): ${pnlPct.toFixed(1)}% → 청산`
        : `보유기한 초과(${holdingDays.toFixed(0)}일/미미한 수익): ${pnlPct.toFixed(1)}% → 청산`;
    } else if (isWeakStock(tech, holdingDays, pnlPct)) {
      sellReason = `약세종목 정리: ADX=${tech.adx.toFixed(0)} 횡보${holdingDays.toFixed(0)}일 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
    }

    // ── 3단계 부분 익절 (승자 라이딩 시 스킵, 개선#5: ATR 확장 시 스킵) ──
    // ATR 확장 중 = 추세 가속 → 부분 매도 보류 (더 큰 수익 가능)
    const atrExpanding = atrPctValue > 2.5 && tech.adx >= 25;
    if (!sellReason && holding.qty >= 3 && !isWinnerRiding(tech, holdingDays) && !atrExpanding) {
      const tpStages = getPartialTpStages(sector);
      const currentStage = await getPartialTpStageNum(code);
      const nextStage = tpStages.find(st => st.stage > currentStage && pnlPct >= st.triggerPct);
      if (nextStage) {
        const partialQty = Math.max(1, Math.floor(holding.qty * nextStage.sellRatio));
        const partialReason = `부분익절${nextStage.stage}단계(+${nextStage.triggerPct}%) +${pnlPct.toFixed(1)}% → ${(nextStage.sellRatio * 100).toFixed(0)}% 실현`;
        logger.info(`[PartialTP-${nextStage.stage}] ${code} ${partialQty}주 @ $${curPrice.toFixed(2)} (${partialReason})`, { component: 'OVERSEAS' });
        const exec = await executeOverseasOrder(code, 'SELL', partialQty, curPrice, tech.exchange, partialReason, holding.qty, holding.avgPrice, { isPaper: paperMode });
        if (exec.submitted && exec.filledQty > 0) {
          const proceeds = exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
          cash += proceeds;
          await updateTradeState({ code, exchange: tech.exchange, qty: exec.finalQty, avgPrice: exec.finalAvgPrice, newCash: cash, isPaper: paperMode });
          await setPartialTpStageNum(code, nextStage.stage, paperMode);
          sellOrders.push(`부분익절${nextStage.stage} ${code} x${partialQty} @$${exec.filledPrice.toFixed(2)} (${partialReason})`);
        }
        continue;
      }
    }

    if (sellReason) {
      const exec = await executeOverseasOrder(code, 'SELL', holding.qty, curPrice, tech.exchange, sellReason, holding.qty, holding.avgPrice, { isPaper: paperMode });
      if (!exec.submitted) continue;
      if (exec.filledQty <= 0) {
        pendingOrderStocks.add(code);
        sellOrders.push(`매도 접수 ${code} x${holding.qty} (체결 대기)`);
        continue;
      }
      const proceeds = exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
      cash += proceeds;
      await updateTradeState({ code, exchange: tech.exchange, qty: exec.finalQty, avgPrice: exec.finalAvgPrice, newCash: cash, isPaper: paperMode });
      if (exec.finalQty <= 0) {
        await cleanupPositionState(code, paperMode);
      }
      sellOrders.push(`매도 ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (${sellReason}) [수수료 $${(exec.filledPrice * exec.filledQty * OVERSEAS_FEE_PCT).toFixed(2)}]`);
    }
  }

  return { sellOrders, cash };
}

/** 승자 라이딩 — 강한 종목은 익절 지연 (트레일링만 적용) */
function isWinnerRiding(tech: TechResult, holdingDays: number): boolean {
  // ADX 40+ 초강세 → 보유기간 무관 즉시 라이딩 허용
  if (tech.adx >= 40 && tech.rsi >= 45 && tech.rsi <= 76) return true;
  if (holdingDays < 1) return false;
  // ADX 25+ & RSI 50~75 유지 → 추세 지속 (30→25 완화, 73→75 완화)
  if (tech.adx >= 25 && tech.rsi >= 50 && tech.rsi <= 75) return true;
  // MA20 상방 + 모멘텀 → 상승 지속
  if (tech.aboveMA20 && tech.aboveMA60 && tech.isMomentum) return true;
  return false;
}

/** 개선#9: ADX 기반 동적 보유기간 — 강한 추세는 오래, 횡보는 빨리 */
function calcDynamicHoldDays(baseMaxHold: number, tech: TechResult, _holdingDays: number): number {
  let mult = 1.0;
  // 강한 추세 (ADX ≥ 35) → 1.5배 보유 (러너 홀딩)
  if (tech.adx >= 35 && tech.rsi >= 45 && tech.rsi <= 75) mult = 1.5;
  // 보통 추세 (ADX 20~35) → 기본
  else if (tech.adx >= 20) mult = 1.0;
  // 약한 추세 (ADX < 20) → 60% 보유 (자본 회전 가속)
  else mult = 0.6;
  // 모멘텀/빅무버 → 최소 1.2배 보유
  if (tech.isMomentum || tech.isBigMover) mult = Math.max(mult, 1.2);
  return Math.round(baseMaxHold * mult);
}

/** 약세 종목 조기 정리 — ADX < 15 + 5일 이상 횡보 + 수익 미미 */
function isWeakStock(tech: TechResult, holdingDays: number, pnlPct: number): boolean {
  if (holdingDays < 5) return false;
  if (pnlPct > 5 || pnlPct < -5) return false; // ±5% 범위로 확장
  // ADX < 15 = 추세 없음 + 횡보 + 미미한 수익/손실
  return tech.adx < 15 && Math.abs(tech.price.changePct) < 1.5;
}
