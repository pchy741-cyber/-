/**
 * 매도 판단 로직 — SL/TP/ATR트레일/부분익절/AI매도/기술적매도
 * overseas-job.ts에서 추출
 */

import { getOverride } from '../../ai/ai-overrides.js';
import { getOverseasDynamic, OVERSEAS_FEE_PCT, SECTOR_CLASS } from '../../config/constants.js';
import { getAllocRisk } from '../../db/alloc-risk-cache.js';
import type { OverseasPrice } from '../../kis/overseas.js';
import { logger } from '../../utils/logger.js';
import { executeOverseasOrder } from './executor.js';
import {
  calcDynamicTpSl,
  calcDynamicTrailDrop,
  getPartialTpStageNum,
  getPartialTpStages,
  type RegimeAdjustment,
  setPartialTpStageNum,
} from './risk-intelligence.js';
import { checkHoldingPriceShock } from './session-strategy.js';
import { isUSMarketLastNMinutes } from './session.js';
import { cleanupPositionState, getMaxPrice, setMaxPrice, updateTradeState } from './state.js';
import { getTunerOverrides } from './trade-tuner.js';
import { GLOBAL_WATCHLIST } from './watchlist.js';

// ── 타입 ──

export interface TechResult {
  code: string;
  name: string;
  exchange: string;
  sector: string;
  price: OverseasPrice;
  signal: string;
  score: number;
  rsi: number;
  adx: number;
  trendStrength: string;
  dayRangePct: number;
  isMomentum: boolean;
  isBigMover: boolean;
  aboveMA20: boolean;
  aboveMA60: boolean;
  bollingerSqueeze: boolean;
  bollingerBreakout: 'UP' | 'DOWN' | 'NONE';
  atrPct: number;
  vwapPosition?: 'ABOVE' | 'BELOW' | 'AT'; // 개선#4: VWAP 대비 위치
}

export interface Holding {
  qty: number;
  avgPrice: number;
  boughtAt: string;
  exchange: string;
  tpPct: number | null;
  slPct: number | null;
  bucket?: string;
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
  fxRate?: number; // 사이클 환율 (동일 루프 내 일관성 보장)
  nasdaqChange1d?: number | null; // 나스닥 전일 등락률 — 급락 선제 청산용
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
  const _allocRisk = await getAllocRisk(ctx.isPaper ?? false).catch(() => ({ positionCapPct: 25 }));
  const dynP = getOverseasDynamic(ctx.portfolioValue ?? 5000, ctx.isPaper, _allocRisk.positionCapPct / 100);
  // Trade Tuner 오버라이드 로드 (1회)
  const tunerOverrides: Record<string, number> = await getTunerOverrides(paperMode).catch(() => ({}));
  const maxHoldDays = tunerOverrides.max_hold_days ?? dynP.maxHoldDays;

  // 이벤트 기반 AI 리프레시: 보유 종목 ±3% 급변 감지
  const priceMap = new Map<string, number>();
  for (const tech of techResults) {
    if (tech.price?.currentPrice > 0) priceMap.set(tech.code, tech.price.currentPrice);
  }
  checkHoldingPriceShock(priceMap);

  for (const [code, holding] of holdings) {
    if (pendingOrderStocks.has(code)) {
      logger.info(`⏳ 미체결 주문 존재 → ${code} 추가 주문 스킵`, { component: 'OVERSEAS' });
      continue;
    }
    const tech = techResults.find((t) => t.code === code);
    if (!tech) continue;

    const curPrice = tech.price.currentPrice;
    const pnlPct = ((curPrice - holding.avgPrice) / holding.avgPrice) * 100;
    const ai = aiMap.get(code);

    // AI Loop forceHold: Claude Code가 매도 보류 지시 (실적 발표 대기 등)
    const aiForceHold = getOverride<boolean>(`${code}_forceHold`);
    if (aiForceHold && pnlPct > -8) {
      // 손절 한도(-8%) 이상이면 AI 홀드 존중
      logger.info(`🤖 AI Loop forceHold(해외): ${code} 매도 보류 (pnl=${pnlPct.toFixed(1)}%)`, {
        component: 'AI_LOOP',
      });
      continue;
    }
    // AI Loop forceSell: Claude Code가 즉시 매도 지시
    const aiForceSell = getOverride<boolean>(`${code}_forceSell`);
    if (aiForceSell) {
      const reason = `🤖 AI Loop 강제매도 (pnl=${pnlPct.toFixed(1)}%)`;
      const exec = await executeOverseasOrder(
        code,
        'SELL',
        holding.qty,
        curPrice,
        holding.exchange,
        reason,
        holding.qty,
        holding.avgPrice,
        { isPaper: paperMode },
      );
      if (exec.submitted && exec.filledQty > 0) {
        cash += exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
        sellOrders.push(`${code} AI강제매도 ${exec.filledQty}주`);
      }
      continue;
    }

    const prevMax = await getMaxPrice(code, paperMode);
    const newMax = Math.max(prevMax || holding.avgPrice, curPrice);
    if (newMax > prevMax) await setMaxPrice(code, newMax, paperMode);
    const maxPnlPct = ((newMax - holding.avgPrice) / holding.avgPrice) * 100;
    const drawdownFromPeak = ((curPrice - newMax) / newMax) * 100;

    let sellReason = '';

    const watchItem = GLOBAL_WATCHLIST.find((w) => w.code === code);
    const sector = watchItem?.sector ?? '';
    const isHighBeta = SECTOR_CLASS.HIGH_BETA.includes(sector);
    const isMediumBeta = SECTOR_CLASS.MEDIUM_BETA.includes(sector);
    const _isDefense = SECTOR_CLASS.DEFENSE.includes(sector);

    // ATR 동적 트레일링 스톱 + VIX 레짐 타이트닝
    const atrPctValue = tech.atrPct ?? 2.0;
    // TP/SL: 매 사이클마다 현재 조건으로 재계산 (DB 저장값은 참고용)
    // 기존 문제: DB에 20~25% TP가 박혀서 사실상 익절 불가 → 항상 현재 조건 반영
    const dyn = calcDynamicTpSl({
      sector,
      adx: tech.adx ?? 20,
      rsi: tech.rsi ?? 50,
      aiConfidence: ai?.confidence,
      aiAction: ai?.action,
      vixRegime,
      isMomentum: tech.isMomentum,
      tunerOverrides,
      atrPct: atrPctValue,
    });
    const hardTpPct = dyn.tpPct;
    let stopLossPct: number;
    if (holding.slPct != null) {
      stopLossPct = holding.slPct; // SL은 매수 시점 기준 유지 (안정성)
    } else {
      stopLossPct = -dyn.slPct; // slPct는 절댓값(양수) → 비교용 음수로 변환
    }
    // DB 동기화 (대시보드 표시용)
    const { updateHoldingTpSl } = await import('./state.js');
    updateHoldingTpSl(code, hardTpPct, stopLossPct, paperMode).catch(() => {});
    const dynamicTrailDrop = calcDynamicTrailDrop({
      sector,
      atrPct: atrPctValue,
      maxPnlPct,
      adx: tech.adx,
      rsi: tech.rsi,
    });
    // 수익 크기 비례 트레일 타이트닝: 수익 클수록 보호 강화 (2×ATR 연구 — 드로다운 32% 감소 검증)
    // maxPnl 10%+: 추가 0.5% 타이트, 15%+: 1.0% 타이트, 20%+: 1.5% 타이트
    const profitTighten = maxPnlPct >= 20 ? 1.5 : maxPnlPct >= 15 ? 1.0 : maxPnlPct >= 10 ? 0.5 : 0;
    const effectiveTrailDropPct = dynamicTrailDrop + vixRegime.trailTighten + profitTighten;
    const baseTrailActivate = isHighBeta ? 10.0 : isMediumBeta ? 8.0 : 5.0;
    const trailActivatePct = tunerOverrides.trail_activate_pct ?? baseTrailActivate;
    const minAiSellConf = isHighBeta ? 0.82 : 0.78;
    const holdingDays = (Date.now() - new Date(holding.boughtAt).getTime()) / (1000 * 60 * 60 * 24);
    // 🔧 강한 매도 신호(score≤-30 + 과매수) → minHold 완화 (HIGH_BETA 3→1일)
    const strongSellSignal = tech.score <= -30 && (tech.signal === 'SELL' || tech.signal === 'STRONG_SELL');
    const minHoldForSell = strongSellSignal ? 1 : isHighBeta ? 3 : 2;

    // ── 개선#9: ADX/승률 기반 동적 보유기간 ──
    const effectiveMaxHold = calcDynamicHoldDays(maxHoldDays, tech, holdingDays);

    // ════════════════════════════════════════════════════════
    // 매도 판단 우선순위 (위에서부터 체크, 먼저 걸리면 매도)
    //  0. TACTICAL(스캘핑) 오버나이트 금지 / 갭 방어
    //  1. 긴급 손절/리스크 관리 (SL, 하락장, 약세)
    //  2. 트레일링 스톱 (ATR, 수익보호, 마이크로)
    //  3. 하드 익절 — TP% 도달하면 무조건 매도 (isWinnerRiding 무시)
    //  4. 시간 기반 익절 — 오래 들고 있는데 작은 수익 → 확정
    //  5. AI/기술적 매도
    //  6. 시간 손절/약세 정리
    // ════════════════════════════════════════════════════════

    // ── 0. TACTICAL 오버나이트 금지 — 미국장 마감 30분 전 강제청산 (갭 리스크 방지) ──
    if (holding.bucket === 'TACTICAL' && isUSMarketLastNMinutes(30)) {
      sellReason = `스캘핑 마감 강제청산 (오버나이트 갭 방지): ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;

      // ── 0b. TACTICAL 갭 방어 하드플로어 — SL 뚫린 갭다운 즉시 탈출 ──
    } else if (holding.bucket === 'TACTICAL' && pnlPct <= -4.0) {
      sellReason = `TACTICAL 갭방어 손절(-4% 하드플로어): ${pnlPct.toFixed(1)}%`;

      // ── 0c. 시간 가중치 트레일링 스탑 (CEO 지시 #C, 2026-06-12) ──
      // Phase 1 (0~48h): 초기 휩소 방어 — 구조적 SL만 허용
      // Phase 2 (48~72h): 본절 이동
      // Phase 3 (72h+): 트레일링 강화
      // SWING bucket (장기 보유)만 적용 (TACTICAL/SCALPING은 위에서 처리)
    } else if (holding.bucket === 'SWING') {
      const { getTimeWeightedStop } = await import('../../risk/entry-timing-guard.js');
      const tws = getTimeWeightedStop({
        holdingHours: holdingDays * 24,
        pnlPct,
        baseSlPct: stopLossPct,
        belowMa20: !tech.aboveMA20,
        belowPrevLow: false, // TODO: 전저점 데이터 필요 시 채움
      });
      if (tws.action === 'EXECUTE_SL') {
        sellReason = `시간가중치 SL: ${tws.reason}`;
      } else if (tws.action === 'BREAK_EVEN' && pnlPct < 0) {
        // 본절 이동 후 손실 진입 → 손절 (본절 = 0%)
        sellReason = `본절 SL (Phase2): PnL ${pnlPct.toFixed(1)}% < 본절 0%`;
      } else if (tws.action === 'TRAIL_TIGHTEN' && pnlPct < tws.effectiveSlPct) {
        // 트레일링 SL 발동
        sellReason = `트레일링 SL (Phase3): PnL ${pnlPct.toFixed(1)}% < 트레일 ${tws.effectiveSlPct.toFixed(1)}%`;
      } else if (tws.action === 'HOLD') {
        // Phase 1 휩소 방어 중 — 다른 매도 조건 평가 건너뛰기
        // (sellReason 비워두면 매도 안 함)
      }
      // sellReason 비어있으면 아래 조건 계속 평가 (TP 등)
      if (!sellReason && pnlPct <= stopLossPct && tws.action !== 'HOLD') {
        sellReason = `손절(${stopLossPct}%): ${pnlPct.toFixed(1)}%`;
      }

      // ── 1. 손절 (SWING 외) ──
    } else if (pnlPct <= stopLossPct) {
      sellReason = `손절(${stopLossPct}%): ${pnlPct.toFixed(1)}%`;

      // ── 1b. 하락장 빠른 정리 ──
      // score<=-20 조건으로 강화 — 시장 전체 급락 시 전종목 동시 발동 방지
    } else if (
      vixRegime.regime !== 'CALM' &&
      pnlPct < -2.5 &&
      pnlPct > stopLossPct &&
      tech.score <= -20 &&
      !tech.aboveMA20 &&
      holdingDays >= 1.0
    ) {
      sellReason = `하락장정리(${vixRegime.regime}/${pnlPct.toFixed(1)}%): score=${tech.score} MA20↓ → 현금확보`;

      // ── 1c. 약세 조기 탈출 ──
      // 시장 전체 하락과 개별 종목 약세를 구분하기 위해 임계값 강화
    } else if (
      pnlPct < -3.0 &&
      pnlPct > stopLossPct &&
      tech.score <= -25 &&
      !tech.aboveMA20 &&
      tech.rsi < 40 &&
      holdingDays >= 1
    ) {
      sellReason = `약세조기탈출(${pnlPct.toFixed(1)}%): score=${tech.score} RSI=${tech.rsi.toFixed(0)} MA20↓ → SL전 정리`;

      // ── 1d. 시장 급락 수익 선제 확정 ──
      // VIX FEAR/PANIC + 수익 구간 → 마이너스 전환 전 즉시 청산 (수익 반납 방지)
    } else if (
      (vixRegime.regime === 'STRESS' || vixRegime.regime === 'CRISIS') &&
      pnlPct >= 1.0 &&
      holdingDays >= 0.25
    ) {
      sellReason = `VIX급락 수익선제확정(${vixRegime.regime}): +${pnlPct.toFixed(1)}% → 급락전 청산`;

      // ── 1e. 나스닥 급락 선제 청산 ──
      // 전일 나스닥 -2% 이하 + 수익 구간 → 당일 미국장 약세 선반영, 수익 잠금
    } else if (ctx.nasdaqChange1d != null && ctx.nasdaqChange1d <= -2.0 && pnlPct >= 0.5 && holdingDays >= 0.1) {
      sellReason = `나스닥급락 선제청산(${ctx.nasdaqChange1d.toFixed(1)}%): +${pnlPct.toFixed(1)}% → 미국장 하락 선반영 즉시 수익확정`;

      // ── 2. ATR 트레일링 스톱 ──
    } else if (maxPnlPct >= trailActivatePct && drawdownFromPeak <= effectiveTrailDropPct) {
      sellReason = `ATR트레일(${effectiveTrailDropPct.toFixed(1)}%/ATR${atrPctValue.toFixed(1)}%${vixRegime.trailTighten > 0 ? `/VIX${vixRegime.regime}` : ''}): 고점 +${maxPnlPct.toFixed(1)}% → 현재 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;

      // ── 2b. 수익보호 50% retrace 제거 — ATR 트레일링이 담당, 정상 풀백에서 위너 조기 절단 방지 ──
      // (기존: maxPnlPct >= 3.0 && pnlPct < maxPnlPct * 0.50 → 매도 → 삭제)

      // ── 2c. 마이크로 트레일 — +2%~트레일활성화 구간 ──
      // 🛡️ 강화 (2026-06-12): pnlPct >= 0 추가. 현재 손실 중이면 "수익보호"가 아니라 손실확정 →
      //   손절 임계까지 보유하거나 시간기반 손절(섹션 6)이 처리하게 양보
      //   과거 SONY 케이스: maxPnlPct=2.0 잠깐 가고 -1.19%에서 매도 (7회 누적 -11.7%)
    } else if (
      maxPnlPct >= 2.0 &&
      maxPnlPct < trailActivatePct &&
      pnlPct >= 0 && // 🛡️ 핵심 가드: 현재 수익 상태일 때만
      drawdownFromPeak <= -1.5 &&
      !tech.isMomentum &&
      !(tech.aboveMA20 && tech.adx >= 30)
    ) {
      sellReason = `마이크로트레일(+${maxPnlPct.toFixed(1)}%→+${pnlPct.toFixed(1)}%): 고점 대비 ${drawdownFromPeak.toFixed(1)}% 하락 → 수익보호`;

      // ── 3. 하드 익절 — TP% 도달하면 무조건 매도 (isWinnerRiding 무관) ──
    } else if (pnlPct >= hardTpPct) {
      sellReason = `익절(${hardTpPct}%): +${pnlPct.toFixed(1)}%`;

      // ── 4. 시간 기반 익절 — 3일+ 보유 & +2% 이상인데 모멘텀 없음 → 수익 확정 ──
    } else if (
      holdingDays >= 3 &&
      pnlPct >= 2.0 &&
      !tech.isMomentum &&
      !(tech.aboveMA20 && tech.adx >= 30) &&
      tech.rsi < 70
    ) {
      sellReason = `시간익절(${holdingDays.toFixed(0)}일/+${pnlPct.toFixed(1)}%): 모멘텀 없음 → 수익확정`;

      // ── 5. AI/기술적 매도 ──
    } else if (ai?.action === 'SELL' && ai.confidence >= 0.9) {
      sellReason = `AI 급매도(${(ai.confidence * 100).toFixed(0)}%): ${ai.reasoning}`;
    } else if (ai?.action === 'SELL' && ai.confidence >= minAiSellConf && holdingDays >= minHoldForSell) {
      sellReason = `AI 매도(${(ai.confidence * 100).toFixed(0)}%): ${ai.reasoning}`;
    } else if (
      (!ai || (ai.action === 'SELL' && ai.confidence < minAiSellConf)) &&
      tech.rsi > 78 &&
      tech.score < 10 &&
      pnlPct >= 3.0 &&
      holdingDays >= minHoldForSell
    ) {
      sellReason = `기술 익절(과매수): RSI=${tech.rsi.toFixed(0)} +${pnlPct.toFixed(1)}% ${ai ? `(AI=${(ai.confidence * 100).toFixed(0)}%보강)` : ''}`;
    } else if (
      (!ai || (ai.action === 'SELL' && ai.confidence < minAiSellConf)) &&
      tech.score <= -30 &&
      (tech.signal === 'SELL' || tech.signal === 'STRONG_SELL') &&
      holdingDays >= minHoldForSell
    ) {
      sellReason = `기술적 매도: score=${tech.score} RSI=${tech.rsi.toFixed(0)} ${ai ? `(AI SELL ${(ai.confidence * 100).toFixed(0)}%보강)` : ''}`;

      // ── 6. 시간 손절/약세 정리 ──
    } else if (holdingDays >= 3 && pnlPct <= -5.5 && !tech.isMomentum) {
      sellReason = `시간SL(${holdingDays.toFixed(0)}일/${pnlPct.toFixed(1)}%): 반등 없이 하락 → 조기손절`;
    } else if (holdingDays >= 5 && pnlPct <= -3.0 && tech.score < 0 && !tech.aboveMA20) {
      sellReason = `시간손절(${holdingDays.toFixed(0)}일/${pnlPct.toFixed(1)}%): score=${tech.score} MA20↓ → 조기정리`;
    } else if (holdingDays >= 7 && pnlPct <= -2.0 && pnlPct > -5.5 && tech.adx < 18) {
      sellReason = `횡보손절(${holdingDays.toFixed(0)}일/${pnlPct.toFixed(1)}%): ADX=${tech.adx.toFixed(0)} 추세없음 → 정리`;
    } else if (holdingDays > effectiveMaxHold && pnlPct < 3.0) {
      sellReason =
        pnlPct < 0
          ? `보유기한 초과(${holdingDays.toFixed(0)}일/손실): ${pnlPct.toFixed(1)}% → 청산`
          : `보유기한 초과(${holdingDays.toFixed(0)}일/미미한 수익): ${pnlPct.toFixed(1)}% → 청산`;
    } else if (isWeakStock(tech, holdingDays, pnlPct)) {
      sellReason = `약세종목 정리: ADX=${tech.adx.toFixed(0)} 횡보${holdingDays.toFixed(0)}일 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
    }

    // ── 부분 익절 — isWinnerRiding 무관하게 항상 실행 ──
    // 수익 있을 때 조금씩 확정하는 게 핵심 (승자 라이딩은 잔여 수량으로 충분)
    // ATR 급확장(ADX 35+ & ATR 3%+)일 때만 보류
    const atrExpanding = atrPctValue > 3.0 && tech.adx >= 35;
    if (!sellReason && holding.qty >= 2 && !atrExpanding) {
      const tpStages = getPartialTpStages(sector);
      const currentStage = await getPartialTpStageNum(code);
      // 수수료 반영: 왕복 수수료(0.7%) 를 트리거에 가산하여 실질 수익 보장
      const roundTripFee = OVERSEAS_FEE_PCT * 2 * 100; // 0.7%
      const nextStage = tpStages.find((st) => st.stage > currentStage && pnlPct >= st.triggerPct + roundTripFee);
      if (nextStage) {
        const partialQty = Math.max(1, Math.floor(holding.qty * nextStage.sellRatio));
        const partialReason = `부분익절${nextStage.stage}단계(+${nextStage.triggerPct}%) +${pnlPct.toFixed(1)}% → ${(nextStage.sellRatio * 100).toFixed(0)}% 실현`;
        logger.info(
          `[PartialTP-${nextStage.stage}] ${code} ${partialQty}주 @ $${curPrice.toFixed(2)} (${partialReason})`,
          { component: 'OVERSEAS' },
        );
        const exec = await executeOverseasOrder(
          code,
          'SELL',
          partialQty,
          curPrice,
          tech.exchange,
          partialReason,
          holding.qty,
          holding.avgPrice,
          { isPaper: paperMode },
        );
        if (exec.submitted && exec.filledQty > 0) {
          const proceeds = exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
          cash += proceeds;
          await updateTradeState({
            code,
            exchange: tech.exchange,
            qty: exec.finalQty,
            avgPrice: exec.finalAvgPrice,
            newCash: cash,
            isPaper: paperMode,
            fxRate: ctx.fxRate,
          });
          await setPartialTpStageNum(code, nextStage.stage, paperMode);
          sellOrders.push(
            `부분익절${nextStage.stage} ${code} x${partialQty} @$${exec.filledPrice.toFixed(2)} (${partialReason})`,
          );
        }
        continue;
      }
    }

    if (sellReason) {
      const exec = await executeOverseasOrder(
        code,
        'SELL',
        holding.qty,
        curPrice,
        tech.exchange,
        sellReason,
        holding.qty,
        holding.avgPrice,
        { isPaper: paperMode },
      );
      if (!exec.submitted) continue;
      if (exec.filledQty <= 0) {
        pendingOrderStocks.add(code);
        sellOrders.push(`매도 접수 ${code} x${holding.qty} (체결 대기)`);
        continue;
      }
      const proceeds = exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
      cash += proceeds;
      await updateTradeState({
        code,
        exchange: tech.exchange,
        qty: exec.finalQty,
        avgPrice: exec.finalAvgPrice,
        newCash: cash,
        isPaper: paperMode,
        fxRate: ctx.fxRate,
      });
      if (exec.finalQty <= 0) {
        await cleanupPositionState(code, paperMode);
      }
      sellOrders.push(
        `매도 ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (${sellReason}) [수수료 $${(exec.filledPrice * exec.filledQty * OVERSEAS_FEE_PCT).toFixed(2)}]`,
      );
    }
  }

  return { sellOrders, cash };
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
