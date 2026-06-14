/**
 * 🚦 개별 게이트 함수 (trade-gate에서 분리)
 */

import { analyzeTechnicals, atr, type OHLCV, sma } from '../analysis/indicators.js';
import { checkKrEarnings } from '../automation/earnings-sentinel.js';
import { checkNewsForStock } from '../automation/news-sentinel.js';
import { GATE } from '../config/constants.js';
import { getCtxIsPaper } from '../config/context.js';
import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import type { GateInput, GateResult } from './trade-gate-types.js';

// ── 차트 검수 게이트 ──
export function chartVerificationGate(input: GateInput): GateResult {
  const { candles, stopLossPct, takeProfitPct } = input;

  if (candles.length < 30) {
    if (getCtxIsPaper()) return { passed: true, reason: '일봉 부족 — 모의투자 통과' };
    return { passed: false, reason: '일봉 데이터 부족 (30일 미만)' };
  }

  const tech = analyzeTechnicals(candles);
  if (!tech) return { passed: false, reason: '기술적 분석 실패' };

  // 다중 타임프레임 정렬 체크
  const dailyBullish = tech.sma5 > tech.sma20 && tech.sma20 > tech.sma60;
  const dailyBearish = tech.sma5 < tech.sma20 && tech.sma20 < tech.sma60;

  if (input.candles60m && input.candles60m.length >= 30) {
    const tech60 = analyzeTechnicals(input.candles60m);
    if (tech60 && dailyBullish && !(tech60.sma5 > tech60.sma20)) {
      return { passed: false, reason: '다중TF 불일치: 일봉↑ 60분봉↓' };
    }
  }

  if (input.candles15m && input.candles15m.length >= 30) {
    const tech15 = analyzeTechnicals(input.candles15m);
    if (tech15 && dailyBearish && tech15.score > 15) {
      return { passed: false, reason: '다중TF 불일치: 일봉↓ 단기 반등' };
    }
  }

  // 거래량 이상치: 10배 이상 하드블록, 5~10배는 소프트 게이트 (기관매집 신호 가능)
  if (tech.volumeRatio > 10.0) {
    return { passed: false, reason: `거래량 이상치: ${tech.volumeRatio.toFixed(1)}배 (10x+ 하드블록)` };
  }
  if (tech.volumeRatio > 5.0) {
    logger.info(`🟡 [거래량 소프트] ${input.stockCode}: ${tech.volumeRatio.toFixed(1)}배 — 5~10x 경고 (기관매집 가능)`, { component: 'TRADE_GATE' });
  }
  if (tech.volumeRatio < 0.15) {
    return { passed: false, reason: `거래량 과소: ${tech.volumeRatio.toFixed(1)}배 (유동성 부족)` };
  }

  // R:R 검증 — R:R 부족 시 차단 대신 로깅 (소프트 게이트화)
  const absStopLoss = Math.abs(stopLossPct);
  const riskRewardRatio = absStopLoss > 0 ? takeProfitPct / absStopLoss : 0;
  const isScalping = input.strategyMode === 'SCALPING';
  const minRR = isScalping ? 0.9 : 0.5;
  if (riskRewardRatio < minRR) {
    // 소프트 게이트: R:R 부족 → 로깅만, 차단 안 함 (Phase 4 전환)
    logger.info(
      `🟡 [R:R 소프트] ${input.stockCode}: R:R=${riskRewardRatio.toFixed(2)} < ${minRR} — 포지션 50% 축소 권장`,
      { component: 'TRADE_GATE' },
    );
  }

  // ATR 대비 손절폭 검증 (0.35배로 완화 — 0.5배는 고변동 종목 전부 차단)
  if (!getCtxIsPaper() && !isScalping) {
    const currentPrice = candles[0]?.close ?? input.estimatedPrice;
    const atrPct = currentPrice > 0 ? (tech.atr14 / currentPrice) * 100 : 0;
    if (atrPct > 0 && absStopLoss < atrPct * 0.35) {
      return {
        passed: false,
        reason: `손절 너무 타이트: ${absStopLoss}% < ATR의 0.35배(${(atrPct * 0.35).toFixed(1)}%)`,
        riskRewardRatio,
      };
    }
  }

  return { passed: true, reason: '차트 검수 통과', riskRewardRatio };
}

// ── 진입 타이밍 게이트 ──
export function entryTimingGate(input: GateInput): GateResult {
  const { candles } = input;
  if (candles.length < 6) return { passed: true, reason: '데이터 부족 — 타이밍 게이트 스킵' };

  const [c0, c1, c2, c3, c4] = candles;
  const current = c0.close;

  const tech = analyzeTechnicals(candles);
  const rsi = tech?.rsi14 ?? 50;
  if (rsi >= 80) return { passed: false, reason: `🔴 RSI 과매수 차단: ${rsi.toFixed(1)} ≥ 80` };

  const recent3High = Math.max(c1.high, c2.high, c3.high);
  const pctFromHigh = recent3High > 0 ? ((current - recent3High) / recent3High) * 100 : -5;
  if (pctFromHigh > 8.0) return { passed: false, reason: `🔴 고점 추격 차단: +${pctFromHigh.toFixed(1)}%` };

  const body0 = Math.abs(c0.close - c0.open);
  const range0 = c0.high - c0.low;
  const lowerShadow0 = Math.min(c0.open, c0.close) - c0.low;
  const upperShadow0 = c0.high - Math.max(c0.open, c0.close);
  const isBullishCandle = c0.close >= c0.open;
  const isHammer = range0 > 0 && lowerShadow0 / range0 > 0.5 && upperShadow0 / range0 < 0.2;
  const isBullishEngulfing =
    isBullishCandle && c0.open <= c1.close && c0.close >= c1.open && body0 > Math.abs(c1.close - c1.open);
  const isVBounce = c1.close < c2.close && c0.close > c1.close;

  const closePositionInRange = range0 > 0 ? (c0.close - c0.low) / range0 : 0.5;
  if (closePositionInRange < 0.1 && !isHammer) {
    return {
      passed: false,
      reason: `🔴 낙하 중 매수 차단: 종가 일중 하위 ${(closePositionInRange * 100).toFixed(0)}%`,
    };
  }

  const recent5Low = Math.min(c0.low, c1.low, c2.low, c3.low, c4.low);
  const pctFromLow = recent5Low > 0 ? ((current - recent5Low) / recent5Low) * 100 : 0;
  const hasGoodPattern = isVBounce || isBullishEngulfing || isHammer || isBullishCandle;
  const isTooFarFromLow = pctFromLow > 10 && rsi > 65;

  if (isTooFarFromLow && !hasGoodPattern) {
    if (getCtxIsPaper()) return { passed: true, reason: `⚠️ [모의투자] 최적 타이밍 아님` };
    return { passed: false, reason: `🔴 진입 타이밍 부적합: 5일저점+${pctFromLow.toFixed(1)}%` };
  }

  const signals: string[] = [];
  if (isVBounce) signals.push('V반등');
  if (isBullishEngulfing) signals.push('인걸핑');
  if (isHammer) signals.push('망치형');
  if (pctFromHigh < -3) signals.push(`고가대비${pctFromHigh.toFixed(1)}%`);

  return { passed: true, reason: `✅ 타이밍: ${signals.join('+') || `RSI=${rsi.toFixed(0)}`}` };
}

// ── 변동성 사이징 ──
export function volatilitySizing(input: GateInput): GateResult {
  const { candles, estimatedPrice, budgetKrw } = input;
  if (candles.length < 30 || estimatedPrice <= 0) {
    return { passed: true, reason: '데이터 부족 — 기본 수량 유지', adjustedQuantity: input.quantity };
  }

  const candlesAsc = [...candles].reverse();
  const atrValues = atr(candlesAsc, 14);
  const currentATR = atrValues[atrValues.length - 1] ?? 0;
  if (currentATR <= 0) return { passed: true, reason: 'ATR 계산 불가', adjustedQuantity: input.quantity };

  const riskPerTrade = budgetKrw * 0.2;
  const stopDistance = currentATR * 1.5;
  const optimalQty = Math.floor(riskPerTrade / stopDistance);
  const maxQtyByBudget = Math.floor(budgetKrw / estimatedPrice);
  const adjustedQty = Math.min(optimalQty, maxQtyByBudget, input.quantity);

  if (adjustedQty <= 0) return { passed: true, reason: `ATR 과대 → 최소 1주`, adjustedQuantity: 1 };

  const reductionPct = input.quantity > 0 ? ((input.quantity - adjustedQty) / input.quantity) * 100 : 0;
  return {
    passed: true,
    reason: `ATR사이징: ${input.quantity}→${adjustedQty}주 (${reductionPct > 0 ? `-${reductionPct.toFixed(0)}%` : '유지'})`,
    adjustedQuantity: adjustedQty,
  };
}

// ── 레짐 게이트 ──
export type MarketRegime = 'BULLISH' | 'BEARISH' | 'SIDEWAYS' | 'HIGH_VOLATILITY';

export function detectRegime(candles: OHLCV[]): MarketRegime {
  if (candles.length < 30) return 'SIDEWAYS';
  const candlesAsc = [...candles].reverse();
  const closes = candlesAsc.map((c) => c.close);
  const sma20 = sma(closes, 20);
  const sma60 = closes.length >= 60 ? sma(closes, 60) : sma20;
  const s20 = sma20[sma20.length - 1] ?? 0;
  const s60 = sma60[sma60.length - 1] ?? s20;
  const current = closes[closes.length - 1] ?? 0;
  const atrValues = atr(candlesAsc, 14);
  const currentATR = atrValues[atrValues.length - 1] ?? 0;
  const atrPct = current > 0 ? (currentATR / current) * 100 : 0;

  if (atrPct > 3.0) return 'HIGH_VOLATILITY';
  if (current > s20 && s20 > s60) return 'BULLISH';
  if (current < s20 && s20 < s60) return 'BEARISH';
  return 'SIDEWAYS';
}

export function regimeGate(input: GateInput): GateResult {
  const regime = detectRegime(input.candles);
  const mode = input.strategyMode;

  if (mode === 'DEFENSE' && regime === 'BEARISH') {
    return { passed: true, reason: '방어모드+하락장: 소량 진입 허용', regime };
  }
  if (regime === 'SIDEWAYS') {
    return {
      passed: true,
      reason: '횡보장: 수량 50% 축소',
      adjustedQuantity: Math.max(1, Math.floor(input.quantity * 0.5)),
      regime,
    };
  }
  if (regime === 'HIGH_VOLATILITY') {
    return {
      passed: true,
      reason: '고변동장: 수량 50% 축소',
      adjustedQuantity: Math.max(1, Math.floor(input.quantity * 0.5)),
      regime,
    };
  }
  if (regime === 'BEARISH' && mode === 'SWING') {
    return {
      passed: true,
      reason: '하락장+스윙: 수량 30% 축소',
      adjustedQuantity: Math.max(1, Math.floor(input.quantity * 0.3)),
      regime,
    };
  }
  return { passed: true, reason: '상승장: 정상 진입', regime };
}

// ── 뉴스/공시 게이트 ──
export async function newsGate(stockCode: string): Promise<GateResult> {
  try {
    const [news, earnings] = await Promise.all([checkNewsForStock(stockCode), checkKrEarnings(stockCode)]);
    if (news.hasBadNews) return { passed: false, reason: `악재뉴스차단: "${news.headline.slice(0, 50)}"` };
    if (earnings.hasUpcomingEarnings)
      return { passed: false, reason: `실적발표 D+${earnings.daysUntil}일 — 변동성 회피` };
    if (news.isEarningsRisk) return { passed: false, reason: `실적발표리스크: "${news.headline.slice(0, 50)}"` };
    return { passed: true, reason: '뉴스·실적 이상없음' };
  } catch {
    return { passed: true, reason: '뉴스조회실패—통과' };
  }
}

// ── 재진입 쿨다운 (SCALPING 전용) ──
export async function reEntryCooldownGate(input: GateInput): Promise<GateResult> {
  if (input.strategyMode !== 'SCALPING') return { passed: true, reason: 'SCALPING 외 — 생략' };
  const isPaper = getCtxIsPaper();
  const reEntryCooldownMs = isPaper ? 5 * 60_000 : GATE.REENTRY_COOLDOWN_MS;
  const reEntryMinutes = isPaper ? 5 : 30;
  try {
    const { rows } = await getPool().query(
      `SELECT created_at FROM orders
       WHERE stock_code = $1 AND side = 'BUY'
         AND status IN ('FILLED', 'PENDING', 'PARTIAL')
         AND created_at >= NOW() - ($3 * INTERVAL '1 minute')
         AND trading_mode = $2
       ORDER BY created_at DESC LIMIT 1`,
      [input.stockCode, isPaper ? 'paper' : 'live', reEntryMinutes],
    );
    if (rows.length > 0) {
      const elapsed = Date.now() - new Date(rows[0].created_at).getTime();
      const remaining = Math.ceil((reEntryCooldownMs - elapsed) / 60_000);
      return { passed: false, reason: `재진입 쿨다운: ${remaining}분 남음` };
    }
  } catch {
    /* DB 실패 시 통과 */
  }
  return { passed: true, reason: '재진입 쿨다운 없음' };
}
