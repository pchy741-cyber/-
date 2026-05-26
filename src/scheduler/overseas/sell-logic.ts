/**
 * 매도 판단 로직 — SL/TP/ATR트레일/부분익절/AI매도/기술적매도
 * overseas-job.ts에서 추출
 */
import { OVERSEAS, SECTOR_CLASS, OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { logger } from '../../utils/logger.js';
import type { OverseasPrice } from '../../kis/overseas.js';
import {
  GLOBAL_WATCHLIST,
} from './watchlist.js';
import {
  updateTradeState, getMaxPrice, setMaxPrice, clearMaxPrice,
} from './state.js';
import {
  calcDynamicTrailDrop, type RegimeAdjustment,
  getPartialTpStages, getPartialTpStageNum, setPartialTpStageNum, clearPartialTpStageNum,
} from './risk-intelligence.js';
import { executeOverseasOrder } from './executor.js';

// ── 타입 ──

export interface TechResult {
  code: string; name: string; exchange: string; sector: string;
  price: OverseasPrice; signal: string; score: number;
  rsi: number; adx: number; trendStrength: string;
  dayRangePct: number; isMomentum: boolean; isBigMover: boolean;
  aboveMA20: boolean; aboveMA60: boolean;
  bollingerSqueeze: boolean; bollingerBreakout: 'UP' | 'DOWN' | 'NONE';
  atrPct: number;
}

export interface Holding {
  qty: number; avgPrice: number; boughtAt: string; exchange: string;
}

interface AIDecision {
  code: string; action: string; confidence: number; reasoning: string;
}

export interface SellContext {
  holdings: Map<string, Holding>;
  pendingOrderStocks: Set<string>;
  techResults: TechResult[];
  aiMap: Map<string, AIDecision>;
  vixRegime: RegimeAdjustment;
  cash: number;
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
  let { cash } = ctx;
  const sellOrders: string[] = [];

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

    const prevMax = await getMaxPrice(code);
    const newMax = Math.max(prevMax || holding.avgPrice, curPrice);
    if (newMax > prevMax) await setMaxPrice(code, newMax);
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
    const stopLossPct = isHighBeta ? -8.0 : isMediumBeta ? -5.0 : isDefense ? -4.0 : -5.0;
    const dynamicTrailDrop = calcDynamicTrailDrop({ sector, atrPct: atrPctValue, maxPnlPct, adx: tech.adx, rsi: tech.rsi });
    const effectiveTrailDropPct = dynamicTrailDrop - vixRegime.trailTighten;
    const trailActivatePct = isHighBeta ? 10.0 : isMediumBeta ? 8.0 : 5.0;

    const hardTpPct = isHighBeta ? 20.0 : 15.0;
    const minAiSellConf = isHighBeta ? 0.82 : 0.78;
    const minHoldForSell = isHighBeta ? 3 : 2;
    const maxHoldDays = OVERSEAS.MAX_HOLD_DAYS;
    const holdingDays = (Date.now() - new Date(holding.boughtAt).getTime()) / (1000 * 60 * 60 * 24);

    if (pnlPct <= stopLossPct) {
      sellReason = `손절(${stopLossPct}%): ${pnlPct.toFixed(1)}%`;
    } else if (maxPnlPct >= trailActivatePct && drawdownFromPeak <= effectiveTrailDropPct) {
      sellReason = `ATR트레일(${effectiveTrailDropPct.toFixed(1)}%/ATR${atrPctValue.toFixed(1)}%${vixRegime.trailTighten > 0 ? `/VIX${vixRegime.regime}` : ''}): 고점 +${maxPnlPct.toFixed(1)}% → 현재 +${pnlPct.toFixed(1)}%`;
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
    } else if (holdingDays > maxHoldDays && pnlPct < 0) {
      sellReason = `보유기한 초과(${holdingDays.toFixed(0)}일/손실): ${pnlPct.toFixed(1)}% → 청산`;
    } else if (isWeakStock(tech, holdingDays, pnlPct)) {
      sellReason = `약세종목 정리: ADX=${tech.adx.toFixed(0)} 횡보${holdingDays.toFixed(0)}일 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
    }

    // ── 3단계 부분 익절 (승자 라이딩 시 스킵) ──
    if (!sellReason && holding.qty >= 2 && !isWinnerRiding(tech, holdingDays)) {
      const tpStages = getPartialTpStages(sector);
      const currentStage = await getPartialTpStageNum(code);
      const nextStage = tpStages.find(st => st.stage > currentStage && pnlPct >= st.triggerPct);
      if (nextStage) {
        const partialQty = Math.max(1, Math.floor(holding.qty * nextStage.sellRatio));
        const partialReason = `부분익절${nextStage.stage}단계(+${nextStage.triggerPct}%) +${pnlPct.toFixed(1)}% → ${(nextStage.sellRatio * 100).toFixed(0)}% 실현`;
        logger.info(`[PartialTP-${nextStage.stage}] ${code} ${partialQty}주 @ $${curPrice.toFixed(2)} (${partialReason})`, { component: 'OVERSEAS' });
        const exec = await executeOverseasOrder(code, 'SELL', partialQty, curPrice, tech.exchange, partialReason, holding.qty, holding.avgPrice);
        if (exec.submitted && exec.filledQty > 0) {
          const proceeds = exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
          cash += proceeds;
          await updateTradeState({ code, exchange: tech.exchange, qty: exec.finalQty, avgPrice: exec.finalAvgPrice, newCash: cash });
          await setPartialTpStageNum(code, nextStage.stage);
          sellOrders.push(`부분익절${nextStage.stage} ${code} x${partialQty} @$${exec.filledPrice.toFixed(2)} (${partialReason})`);
        }
        continue;
      }
    }

    if (sellReason) {
      const exec = await executeOverseasOrder(code, 'SELL', holding.qty, curPrice, tech.exchange, sellReason, holding.qty, holding.avgPrice);
      if (!exec.submitted) continue;
      if (exec.filledQty <= 0) {
        pendingOrderStocks.add(code);
        sellOrders.push(`매도 접수 ${code} x${holding.qty} (체결 대기)`);
        continue;
      }
      const proceeds = exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
      cash += proceeds;
      await updateTradeState({ code, exchange: tech.exchange, qty: exec.finalQty, avgPrice: exec.finalAvgPrice, newCash: cash });
      if (exec.finalQty <= 0) {
        await clearMaxPrice(code); await clearPartialTpStageNum(code);
        // Scale-In 예약 삭제
        const { getPool } = await import('../../db/client.js');
        await getPool().query(`DELETE FROM overseas_state WHERE key = $1`, [`scale_in_${code}`]).catch(() => {});
      }
      sellOrders.push(`매도 ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (${sellReason}) [수수료 $${(exec.filledPrice * exec.filledQty * OVERSEAS_FEE_PCT).toFixed(2)}]`);
    }
  }

  return { sellOrders, cash };
}

/** 승자 라이딩 — 강한 종목은 익절 지연 (트레일링만 적용) */
function isWinnerRiding(tech: TechResult, holdingDays: number): boolean {
  if (holdingDays < 2) return false;
  // ADX 30+ & RSI 50~70 유지 → 강한 추세 지속
  if (tech.adx >= 30 && tech.rsi >= 50 && tech.rsi <= 70) return true;
  // MA20 상방 + 모멘텀 → 상승 지속
  if (tech.aboveMA20 && tech.aboveMA60 && tech.isMomentum) return true;
  return false;
}

/** 약세 종목 조기 정리 — ADX < 15 + 5일 이상 횡보 + 수익 미미 */
function isWeakStock(tech: TechResult, holdingDays: number, pnlPct: number): boolean {
  if (holdingDays < 5) return false;
  if (pnlPct > 3 || pnlPct < -3) return false; // 수익/손실 큰 건 기존 로직에서 처리
  // ADX < 15 = 추세 없음 + 횡보 + 미미한 수익/손실
  return tech.adx < 15 && Math.abs(tech.price.changePct) < 1.0;
}
