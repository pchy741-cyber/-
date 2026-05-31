/**
 * 📊 기술적 지표 엔진 (Technical Indicators)
 *
 * 헤지펀드급 기술 분석 — 순수 TypeScript, 의존성 없음
 * 모든 계산은 정수 연산 기반 (금융 정밀도)
 *
 * 모듈 분리: moving-averages, oscillators, patterns
 * 이 파일: analyzeTechnicals + analyzeIntraday + re-exports
 */

// ── Re-exports (기존 import 호환) ──
export { sma, ema, envelope, vwap } from './moving-averages.js';
export type { OHLCV, EnvelopeResult } from './moving-averages.js';

export { rsi, macd, bollingerBands, stochastic, williamsR, roc, atr, adx, ttmSqueeze } from './oscillators.js';
export type { MACDResult, BollingerResult, StochasticResult, TTMSqueezeResult } from './oscillators.js';

export { detectCandlePatterns, calcFibonacciLevels, volumeProfile, detectStructuralPatterns } from './patterns.js';
export type { CandlePatternResult, FibonacciLevel, FibonacciResult, VolumeLevelResult, StructuralPattern } from './patterns.js';

// ── Internal imports for analyzeTechnicals ──
import type { OHLCV, EnvelopeResult } from './moving-averages.js';
import { sma, ema, envelope, vwap } from './moving-averages.js';
import { rsi, macd, bollingerBands, stochastic, williamsR, roc, atr, adx, ttmSqueeze, type TTMSqueezeResult } from './oscillators.js';
import { detectCandlePatterns, calcFibonacciLevels, type CandlePatternResult, type FibonacciResult } from './patterns.js';

// ── 종합 분석 리포트 ──

export interface TechnicalSummary {
  rsi14: number;
  macdHistogram: number;
  macdCrossover: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  bollingerPosition: 'ABOVE_UPPER' | 'NEAR_UPPER' | 'MIDDLE' | 'NEAR_LOWER' | 'BELOW_LOWER';
  bollingerWidth: number;
  bollingerSqueeze: boolean;
  bollingerBreakout: 'UP' | 'DOWN' | 'NONE';
  sma5: number;
  sma20: number;
  sma60: number;
  goldenCross: boolean;
  deathCross: boolean;
  stochasticK: number;
  stochasticSignal: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';
  atr14: number;
  atrPct: number;
  dynamicStopLossPct: number;
  adx14: number;
  trendStrength: 'STRONG' | 'MODERATE' | 'WEAK';
  volumeRatio: number;
  vwapCross: 'JUST_ABOVE' | 'JUST_BELOW' | 'NONE';
  vwapPullback: boolean;
  rsi2: number;
  ttmSqueeze: TTMSqueezeResult;
  overallSignal: 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL';
  score: number;
  candlePatterns: CandlePatternResult[];
  pctFrom3DayHigh: number;
  pctFrom5DayLow: number;
  vwapPosition: 'ABOVE' | 'BELOW' | 'AT';
  envelope: EnvelopeResult;
  pullbackSignal: boolean;
  volumeConsistency: number;
  fibResult: FibonacciResult | null;
}

export function analyzeTechnicals(candles: OHLCV[]): TechnicalSummary | null {
  if (candles.length < 30) return null;

  const closes = candles.map((c) => c.close);
  const current = closes[0];

  const closesAsc = [...closes].reverse();
  const candlesAsc = [...candles].reverse();

  const rsiValues = rsi(closesAsc, 14);
  const rsi14 = rsiValues[rsiValues.length - 1] ?? 50;

  const macdResult = macd(closesAsc, 12, 26, 9);
  const macdHist = macdResult.histogram[macdResult.histogram.length - 1] ?? 0;
  const macdPrev = macdResult.histogram[macdResult.histogram.length - 2] ?? 0;
  const macdCross =
    macdHist > 0 && macdPrev <= 0
      ? ('BULLISH' as const)
      : macdHist < 0 && macdPrev >= 0
        ? ('BEARISH' as const)
        : ('NEUTRAL' as const);

  const bb = bollingerBands(closesAsc, 20);
  const bbUpper = bb.upper[bb.upper.length - 1] ?? current;
  const bbLower = bb.lower[bb.lower.length - 1] ?? current;
  const bbMiddle = bb.middle[bb.middle.length - 1] ?? current;
  const bbWidth = bb.width[bb.width.length - 1] ?? 0;
  const bbWidthAvg20 = bb.width.slice(-20).reduce((s, v) => s + v, 0) / Math.max(bb.width.slice(-20).length, 1);
  const bollingerSqueeze = bbWidth < bbWidthAvg20 * 0.8;
  const prevBbWidth = bb.width[bb.width.length - 2] ?? bbWidth;
  const prevSqueeze = prevBbWidth < bbWidthAvg20 * 0.8;
  const bollingerBreakout: TechnicalSummary['bollingerBreakout'] =
    prevSqueeze && current > (bb.upper[bb.upper.length - 1] ?? current) ? 'UP' :
    prevSqueeze && current < (bb.lower[bb.lower.length - 1] ?? current) ? 'DOWN' : 'NONE';

  let bbPos: TechnicalSummary['bollingerPosition'] = 'MIDDLE';
  if (current > bbUpper) bbPos = 'ABOVE_UPPER';
  else if (current > bbMiddle + (bbUpper - bbMiddle) * 0.7) bbPos = 'NEAR_UPPER';
  else if (current < bbLower) bbPos = 'BELOW_LOWER';
  else if (current < bbMiddle - (bbMiddle - bbLower) * 0.7) bbPos = 'NEAR_LOWER';

  const sma5Val = sma(closesAsc, 5);
  const sma20Val = sma(closesAsc, 20);
  const sma60Val = closesAsc.length >= 60 ? sma(closesAsc, 60) : sma(closesAsc, Math.min(closesAsc.length, 20));

  const sma5Now = sma5Val[sma5Val.length - 1] ?? current;
  const sma20Now = sma20Val[sma20Val.length - 1] ?? current;
  const sma60Now = sma60Val.length > 0 ? sma60Val[sma60Val.length - 1] : current;
  const sma5Prev = sma5Val[sma5Val.length - 2] ?? sma5Now;
  const sma20Prev = sma20Val[sma20Val.length - 2] ?? sma20Now;

  const goldenCross = sma5Now > sma20Now && sma5Prev <= sma20Prev;
  const deathCross = sma5Now < sma20Now && sma5Prev >= sma20Prev;

  const stochResult = stochastic(candlesAsc, 14, 3);
  const stochK = stochResult.k[stochResult.k.length - 1] ?? 50;
  const stochSignal =
    stochK > 80 ? ('OVERBOUGHT' as const) : stochK < 20 ? ('OVERSOLD' as const) : ('NEUTRAL' as const);

  const atrValues = atr(candlesAsc, 14);
  const atr14 = atrValues[atrValues.length - 1] ?? 0;
  const atrPct = current > 0 ? (atr14 / current) * 100 : 0;
  const dynamicStopLossPct = Math.max(-8, Math.min(-1, -(atrPct * 2)));

  const adxValues = adx(candlesAsc, 14);
  const adx14 = adxValues.length > 0 ? adxValues[adxValues.length - 1] : 25;
  const trendStrength: TechnicalSummary['trendStrength'] = adx14 >= 30 ? 'STRONG' : adx14 >= 20 ? 'MODERATE' : 'WEAK';

  const volumes = candles.map((c) => c.volume);
  const avgVol20 = volumes.slice(0, 20).reduce((s, v) => s + v, 0) / 20;
  const volumeRatio = avgVol20 > 0 ? volumes[0] / avgVol20 : 1;

  // ══════════════════════════════════════════════════
  // 종합 점수 계산 (연구 기반 가중치)
  // ══════════════════════════════════════════════════
  let score = 0;

  // RSI
  if (rsi14 < 30) score += 15;
  else if (rsi14 < 40) score += 7;
  else if (rsi14 >= 45 && rsi14 <= 62) score += 18;
  else if (rsi14 > 70) score -= 25;
  else if (rsi14 > 65) score -= 12;

  // MACD
  if (macdCross === 'BULLISH') score += 25;
  else if (macdCross === 'BEARISH') score -= 20;
  else if (macdHist > 0) score += 8;
  else score -= 8;

  // 볼린저 밴드
  if (bbPos === 'BELOW_LOWER') score += 10;
  else if (bbPos === 'NEAR_LOWER') score += 5;
  else if (bbPos === 'ABOVE_UPPER') score -= 12;
  else if (bbPos === 'NEAR_UPPER') score -= 3;

  // 이동평균 정배열
  if (current > sma5Now && sma5Now > sma20Now && sma20Now > sma60Now) score += 28;
  else if (current > sma20Now && sma20Now > sma60Now) score += 14;
  if (current < sma5Now && sma5Now < sma20Now && sma20Now < sma60Now) score -= 20;
  else if (current < sma20Now && sma20Now < sma60Now) score -= 10;

  // 골든/데드크로스
  if (goldenCross) score += 18;
  if (deathCross) score -= 18;

  // 스토캐스틱
  if (stochSignal === 'OVERSOLD') score += 10;
  if (stochSignal === 'OVERBOUGHT') score -= 10;

  // Williams %R
  const wrValues = williamsR(candlesAsc, 14);
  const wr14 = wrValues[wrValues.length - 1] ?? -50;
  if (wr14 < -80) score += 8;
  else if (wr14 > -20) score -= 8;

  // ROC
  const rocValues = roc(closesAsc, 12);
  const roc12 = rocValues[rocValues.length - 1] ?? 0;
  if (roc12 > 8) score += 20;
  else if (roc12 > 3) score += 12;
  else if (roc12 < -8) score -= 12;
  else if (roc12 < -3) score -= 6;

  // 볼륨 돌파 보너스
  const vol2dAvg = (volumes[1] + volumes[2]) / 2;
  const todayVolSurge = vol2dAvg > 0 ? volumes[0] / vol2dAvg : 1;
  if (todayVolSurge >= 2.0 && current > sma5Now) {
    score += 15;
  } else if (todayVolSurge >= 1.5 && current > sma5Now) {
    score += 8;
  }

  // ADX 필터
  if (trendStrength === 'WEAK') {
    if (score > 0) score = Math.floor(score * 0.6);
  } else if (trendStrength === 'STRONG') {
    if (score > 0) score = Math.floor(score * 1.35);
  }

  // 거래량 확인 필터
  if (volumeRatio >= 2.0 && score > 0) {
    score = Math.floor(score * 1.2);
  } else if (volumeRatio >= 1.5 && score > 0) {
    score = Math.floor(score * 1.1);
  } else if (volumeRatio < 0.5 && score > 0) {
    score = Math.floor(score * 0.7);
  }

  // 캔들스틱 패턴
  const candlePatterns = detectCandlePatterns(candles);
  for (const p of candlePatterns) {
    const pts = p.strength === 'STRONG' ? 12 : p.strength === 'MODERATE' ? 7 : 3;
    score += p.bullish ? pts : -pts;
  }

  // VWAP
  const vwapValues = vwap(candlesAsc.slice(-20));
  const vwapNow = vwapValues[vwapValues.length - 1] ?? current;
  const vwapPrev = vwapValues[vwapValues.length - 2] ?? vwapNow;
  const prevClose = closesAsc[closesAsc.length - 2] ?? current;
  const vwapDiff = (current - vwapNow) / vwapNow * 100;
  const vwapPosition: TechnicalSummary['vwapPosition'] = vwapDiff > 1 ? 'ABOVE' : vwapDiff < -1 ? 'BELOW' : 'AT';
  const vwapCross: TechnicalSummary['vwapCross'] =
    prevClose < vwapPrev && current > vwapNow ? 'JUST_ABOVE' :
    prevClose > vwapPrev && current < vwapNow ? 'JUST_BELOW' : 'NONE';
  if (vwapCross === 'JUST_ABOVE') score += 20;
  else if (vwapCross === 'JUST_BELOW') score -= 15;
  else if (vwapPosition === 'ABOVE') score += 12;
  else if (vwapPosition === 'BELOW') score -= 8;

  // 볼린저 스퀴즈 돌파
  if (bollingerBreakout === 'UP') score += 22;
  else if (bollingerBreakout === 'DOWN') score -= 18;
  else if (bollingerSqueeze && macdCross === 'BULLISH') score += 10;

  // 중간 거래량 보너스
  if (todayVolSurge >= 1.3 && todayVolSurge < 1.5 && current > sma5Now) score += 4;

  // 2-day RSI
  const rsi2Values = rsi(closesAsc, 2);
  const rsi2 = rsi2Values[rsi2Values.length - 1] ?? 50;
  if (rsi2 < 15) score += 18;
  else if (rsi2 < 25) score += 10;
  else if (rsi2 > 85) score -= 18;
  else if (rsi2 > 75) score -= 10;

  // VWAP 풀백
  const vwapHistory = vwapValues.slice(-4);
  const closeHistory = closesAsc.slice(-4);
  let recentVwapBreak = false;
  for (let i = 1; i < Math.min(3, vwapHistory.length - 1); i++) {
    const pastClose = closeHistory[closeHistory.length - 1 - i] ?? 0;
    const pastVwap = vwapHistory[vwapHistory.length - 1 - i] ?? 0;
    if (pastClose > pastVwap * 1.005) { recentVwapBreak = true; break; }
  }
  const nearVwap = Math.abs(vwapDiff) < 0.5;
  const vwapPullback = recentVwapBreak && nearVwap && current > vwapNow * 0.995;
  if (vwapPullback) score += 15;

  // TTM 스퀴즈
  const ttmSqueezeResult = ttmSqueeze(candles);
  if (ttmSqueezeResult.fireSignal === 'LONG') score += 25;
  else if (ttmSqueezeResult.fireSignal === 'SHORT') score -= 20;
  else if (ttmSqueezeResult.squeezeState === 'ON' && ttmSqueezeResult.consecutiveSqueezeOn >= 5) score += 8;

  score = Math.max(-100, Math.min(100, score));

  let overallSignal: TechnicalSummary['overallSignal'];
  if (score >= 40) overallSignal = 'STRONG_BUY';
  else if (score >= 15) overallSignal = 'BUY';
  else if (score <= -40) overallSignal = 'STRONG_SELL';
  else if (score <= -15) overallSignal = 'SELL';
  else overallSignal = 'NEUTRAL';

  // 가격 위치 정보
  const recent3High = Math.max(candles[0].high, candles[1]?.high ?? 0, candles[2]?.high ?? 0);
  const recent5Low = Math.min(candles[0].low, candles[1]?.low ?? Infinity, candles[2]?.low ?? Infinity, candles[3]?.low ?? Infinity, candles[4]?.low ?? Infinity);
  const pctFrom3DayHigh = recent3High > 0 ? ((current - recent3High) / recent3High) * 100 : 0;
  const pctFrom5DayLow = recent5Low > 0 && recent5Low < Infinity ? ((current - recent5Low) / recent5Low) * 100 : 0;

  // 엔벨로프
  const envelopeResult = envelope(closesAsc, 20, 0.05);

  // 눌림매매 (Pullback Signal)
  const sma10Val = sma(closesAsc, 10);
  const sma10Now = sma10Val[sma10Val.length - 1] ?? current;
  let recentDipBelowMA = false;
  const lookback = Math.min(5, closesAsc.length - 1);
  for (let i = 1; i <= lookback; i++) {
    const pastClose = closesAsc[closesAsc.length - 1 - i] ?? current;
    const pastSma5 = sma5Val[sma5Val.length - 1 - i] ?? sma5Now;
    if (pastClose < pastSma5) { recentDipBelowMA = true; break; }
  }
  const pullbackSignal = recentDipBelowMA && current > sma5Now && current > sma10Now && volumeRatio >= 0.8;

  if (pullbackSignal) {
    score += 20;
  }

  // 엔벨로프 하단 터치
  if (envelopeResult.position === 'BELOW_LOWER' && volumeRatio >= 0.7) score += 12;
  else if (envelopeResult.position === 'NEAR_LOWER' && volumeRatio >= 0.7) score += 6;

  // 거래대금 연속성
  const avgVol20ForConsistency = volumes.slice(0, 20).reduce((s, v) => s + v, 0) / 20;
  let volumeConsistency = 0;
  for (let i = 0; i < Math.min(5, volumes.length); i++) {
    if (volumes[i] >= avgVol20ForConsistency) volumeConsistency++;
  }
  if (volumeConsistency >= 4 && score > 0) score = Math.floor(score * 1.12);
  else if (volumeConsistency <= 1 && score > 0) score = Math.floor(score * 0.85);

  score = Math.max(-100, Math.min(100, score));

  // overallSignal 재계산
  if (score >= 40) overallSignal = 'STRONG_BUY';
  else if (score >= 15) overallSignal = 'BUY';
  else if (score <= -40) overallSignal = 'STRONG_SELL';
  else if (score <= -15) overallSignal = 'SELL';
  else overallSignal = 'NEUTRAL';

  return {
    rsi14,
    macdHistogram: macdHist,
    macdCrossover: macdCross,
    bollingerPosition: bbPos,
    bollingerWidth: bbWidth,
    bollingerSqueeze,
    bollingerBreakout,
    sma5: sma5Now,
    sma20: sma20Now,
    sma60: sma60Now,
    goldenCross,
    deathCross,
    stochasticK: stochK,
    stochasticSignal: stochSignal,
    atr14,
    atrPct,
    dynamicStopLossPct,
    adx14,
    trendStrength,
    volumeRatio,
    vwapCross,
    vwapPullback,
    rsi2,
    ttmSqueeze: ttmSqueezeResult,
    overallSignal,
    score,
    candlePatterns,
    pctFrom3DayHigh,
    pctFrom5DayLow,
    vwapPosition,
    envelope: envelopeResult,
    pullbackSignal,
    volumeConsistency,
    fibResult: calcFibonacciLevels(candles, current),
  };
}

// ── 분봉 단기 신호 (장중 진입 타이밍 확인) ──

export interface IntradaySignal {
  score: number;
  trend: 'UP' | 'DOWN' | 'NEUTRAL';
  trend15m: 'UP' | 'DOWN' | 'NEUTRAL';
  volumeSurge: boolean;
  vwapPosition: 'ABOVE' | 'BELOW' | 'AT';
  reason: string;
}

/** 1분 캔들 → N분 캔들로 집계 */
export function aggregateToTimeframe(minuteCandles: OHLCV[], minutes: number): OHLCV[] {
  if (minuteCandles.length < minutes) return [];
  const asc = [...minuteCandles].reverse();
  const result: OHLCV[] = [];
  for (let i = 0; i + minutes <= asc.length; i += minutes) {
    const chunk = asc.slice(i, i + minutes);
    result.push({
      date: chunk[0].date,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    });
  }
  return result.reverse();
}

export function analyzeIntraday(minuteCandles: OHLCV[]): IntradaySignal {
  const empty: IntradaySignal = { score: 0, trend: 'NEUTRAL', trend15m: 'NEUTRAL', volumeSurge: false, vwapPosition: 'AT', reason: '데이터부족' };
  if (minuteCandles.length < 10) return empty;
  const asc = [...minuteCandles].reverse();
  const closes = asc.map(c => c.close);
  const highs = asc.map(c => c.high);
  const lows = asc.map(c => c.low);
  const vols = asc.map(c => c.volume);
  let score = 0;
  const tags: string[] = [];

  // 1. RSI (분봉)
  const rsiPeriod = Math.min(14, closes.length - 1);
  const rsiNow = rsi(closes, rsiPeriod).pop() ?? 50;
  if (rsiNow < 30) { score += 12; tags.push(`분봉RSI과매도(${rsiNow.toFixed(0)})`); }
  else if (rsiNow < 40) score += 6;
  else if (rsiNow > 70) { score -= 12; tags.push(`분봉RSI과매수(${rsiNow.toFixed(0)})`); }
  else if (rsiNow > 60) score -= 6;

  // 2. 단기 MACD (5/13/4)
  if (closes.length >= 14) {
    const m = macd(closes, 5, 13, 4);
    const h = m.histogram;
    const hNow = h[h.length - 1] ?? 0;
    const hPrev = h[h.length - 2] ?? hNow;
    if (hNow > 0 && hNow > hPrev) { score += 10; tags.push('분봉MACD상승'); }
    else if (hNow < 0 && hNow < hPrev) score -= 10;
    else if (hNow > 0) score += 4;
    else score -= 4;
  }

  // 3. 최근 5봉 가격 추세
  if (closes.length >= 5) {
    const pct = (closes[closes.length - 1] - closes[closes.length - 5]) / (closes[closes.length - 5] || 1) * 100;
    if (pct > 0.5) { score += 8; tags.push('단기상승'); }
    else if (pct > 0.2) score += 4;
    else if (pct < -0.5) { score -= 8; tags.push('단기하락'); }
    else if (pct < -0.2) score -= 4;
  }

  // 4. 거래량 서지
  const surgeRatio = vols.length >= 15
    ? (vols.slice(-5).reduce((a, b) => a + b, 0) / 5) / (vols.slice(-15, -5).reduce((a, b) => a + b, 0) / 10 || 1)
    : 1;
  const volumeSurge = surgeRatio >= 1.5;
  if (volumeSurge && score > 0) { score += 5; tags.push(`거래량급증(${surgeRatio.toFixed(1)}x)`); }

  // 5. 분봉 VWAP 위치
  let vwapPosition: IntradaySignal['vwapPosition'] = 'AT';
  if (closes.length >= 20 && vols.length >= 20) {
    let cumPV = 0, cumVol = 0;
    for (let i = 0; i < closes.length; i++) {
      const typical = (highs[i] + lows[i] + closes[i]) / 3;
      cumPV += typical * vols[i];
      cumVol += vols[i];
    }
    const vwapVal = cumVol > 0 ? cumPV / cumVol : closes[closes.length - 1];
    const curPrice = closes[closes.length - 1];
    const vwapPct = ((curPrice - vwapVal) / vwapVal) * 100;
    if (vwapPct > 0.15) {
      vwapPosition = 'ABOVE';
      score += 5; tags.push('VWAP상방');
    } else if (vwapPct < -0.15) {
      vwapPosition = 'BELOW';
      score -= 5; tags.push('VWAP하방');
    }
  }

  // 6. 분봉 볼린저밴드
  if (closes.length >= 22) {
    const bbResult = bollingerBands(closes, 20);
    const bbU = bbResult.upper[bbResult.upper.length - 1] ?? 0;
    const bbL = bbResult.lower[bbResult.lower.length - 1] ?? 0;
    const bbM = bbResult.middle[bbResult.middle.length - 1] ?? 0;
    const cur = closes[closes.length - 1];
    if (cur > bbU) { score -= 6; tags.push('분봉BB상단돌파'); }
    else if (cur < bbL) { score += 6; tags.push('분봉BB하단지지'); }
    else if (bbM > 0 && cur > bbM + (bbU - bbM) * 0.7) { score -= 3; }
    else if (bbM > 0 && cur < bbM - (bbM - bbL) * 0.7) { score += 3; }
  }

  // 7. 15분봉 추세 분석
  let trend15m: IntradaySignal['trend15m'] = 'NEUTRAL';
  const candles15m = aggregateToTimeframe(minuteCandles, 15);
  if (candles15m.length >= 4) {
    const c15 = candles15m.map(c => c.close);
    const last4 = c15.slice(-4);
    const upCount = last4.filter((v, i) => i > 0 && v > last4[i - 1]).length;
    const downCount = last4.filter((v, i) => i > 0 && v < last4[i - 1]).length;
    if (upCount >= 2 && downCount === 0) {
      trend15m = 'UP'; score += 8; tags.push('15m상승추세');
    } else if (downCount >= 2 && upCount === 0) {
      trend15m = 'DOWN'; score -= 8; tags.push('15m하락추세');
    }
    if (c15.length >= 8) {
      const rsi15 = rsi(c15, Math.min(7, c15.length - 1)).pop() ?? 50;
      if (rsi15 > 72) { score -= 4; tags.push(`15mRSI과매수(${rsi15.toFixed(0)})`); }
      else if (rsi15 < 28) { score += 4; tags.push(`15mRSI과매도(${rsi15.toFixed(0)})`); }
    }
  }

  // 8. 3연속 양봉/음봉
  if (closes.length >= 4) {
    const last3Dir = [
      closes[closes.length - 1] > closes[closes.length - 2],
      closes[closes.length - 2] > closes[closes.length - 3],
      closes[closes.length - 3] > closes[closes.length - 4],
    ];
    if (last3Dir.every(Boolean)) { score += 4; tags.push('3연속양봉'); }
    else if (last3Dir.every(d => !d)) { score -= 4; tags.push('3연속음봉'); }
  }

  score = Math.max(-50, Math.min(50, score));
  const trend = score > 5 ? 'UP' : score < -5 ? 'DOWN' : 'NEUTRAL';
  return { score, trend, trend15m, volumeSurge, vwapPosition, reason: tags.join('+') || '중립' };
}
