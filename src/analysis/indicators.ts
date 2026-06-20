/**
 * 📊 기술적 지표 엔진 (Technical Indicators)
 *
 * 헤지펀드급 기술 분석 — 순수 TypeScript, 의존성 없음
 * 모든 계산은 정수 연산 기반 (금융 정밀도)
 *
 * 모듈 분리: moving-averages, oscillators, patterns
 * 이 파일: analyzeTechnicals + analyzeIntraday + re-exports
 */

export type { EnvelopeResult, OHLCV } from './moving-averages.js';
// ── Re-exports (기존 import 호환) ──
export { ema, envelope, sma, vwap } from './moving-averages.js';
export type { BollingerResult, CMFResult, MACDResult, OBVResult, RsiDivergence, StochasticResult, TTMSqueezeResult } from './oscillators.js';
export {
  adx,
  atr,
  bollingerBands,
  cmf,
  detectRsiDivergence,
  macd,
  obv,
  roc,
  rsi,
  stochastic,
  ttmSqueeze,
  williamsR,
} from './oscillators.js';
export type {
  CandlePatternResult,
  FibonacciLevel,
  FibonacciResult,
  StructuralPattern,
  VolumeLevelResult,
} from './patterns.js';
export { calcFibonacciLevels, detectCandlePatterns, detectStructuralPatterns, volumeProfile } from './patterns.js';

// ── Internal imports for analyzeTechnicals ──
import type { EnvelopeResult, OHLCV } from './moving-averages.js';
import { envelope, sma, vwap } from './moving-averages.js';
import {
  adx,
  atr,
  bollingerBands,
  cmf,
  type CMFResult,
  detectRsiDivergence,
  macd,
  obv,
  type OBVResult,
  type RsiDivergence,
  roc,
  rsi,
  stochastic,
  type TTMSqueezeResult,
  ttmSqueeze,
} from './oscillators.js';
import {
  type CandlePatternResult,
  calcFibonacciLevels,
  detectCandlePatterns,
  type FibonacciResult,
} from './patterns.js';

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
  rsiDivergence: RsiDivergence;
  // v4: 카테고리별 점수 (자기학습 피드백용)
  catTrend: number; // 추세 카테고리 (-25~+25)
  catMomentum: number; // 모멘텀 카테고리 (-25~+25)
  catVolatility: number; // 변동성 카테고리 (-25~+25)
  catVolume: number; // 거래량 카테고리 (-25~+25)
  catPositive: number; // 양수 카테고리 수 (0~4)
  // v10: 이격도 + Z-score 지표
  disparity20: number; // SMA20 이격도 (%)
  disparity60: number; // SMA60 이격도 (%)
  volZScore: number; // 거래량 Z-score (자기 60일 대비)
  // v11: OBV + CMF (매집/분산 판별)
  obvResult: OBVResult;
  cmfResult: CMFResult;
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
    prevSqueeze && current > (bb.upper[bb.upper.length - 1] ?? current)
      ? 'UP'
      : prevSqueeze && current < (bb.lower[bb.lower.length - 1] ?? current)
        ? 'DOWN'
        : 'NONE';

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
  const dynamicStopLossPct = Math.max(-8, Math.min(-1.5, -(atrPct * 1.5))); // v10.4: ATR×2→1.5 (노이즈 SL 방지)

  const adxValues = adx(candlesAsc, 14);
  const adx14 = adxValues.length > 0 ? adxValues[adxValues.length - 1] : 25;
  const trendStrength: TechnicalSummary['trendStrength'] = adx14 >= 30 ? 'STRONG' : adx14 >= 20 ? 'MODERATE' : 'WEAK';

  const volumes = candles.map((c) => c.volume);
  // 당일 거래량을 평균에서 제외 (자기 포함 바이어스 방지)
  const avgVol20 = volumes.slice(1, 21).reduce((s, v) => s + v, 0) / Math.min(20, volumes.length - 1 || 1);
  const volumeRatio = avgVol20 > 0 ? volumes[0] / avgVol20 : 1;

  // ══════════════════════════════════════════════════════════════════
  // 카테고리별 Cap 점수 시스템 (v4 — 2026-06 승률 개선)
  //
  // 문제: 상관관계 높은 지표들이 중복 가산 → 평범한 종목도 STRONG_BUY
  // 해결: 4개 독립 카테고리로 분리, 각각 ±25 cap → 합계 ±100
  //       최소 3/4 카테고리 양수여야 BUY 신호 발동 (다중확인 필수)
  // ══════════════════════════════════════════════════════════════════

  // ── 카테고리 1: 추세 (Trend) — cap ±25 ──
  // v10: 이격도(Disparity Index) 기반 차등 점수 — 이동평균과의 거리로 과열/침체 판단
  let trendScore = 0;
  const disparity20 = sma20Now > 0 ? ((current - sma20Now) / sma20Now) * 100 : 0;
  const disparity60 = sma60Now > 0 ? ((current - sma60Now) / sma60Now) * 100 : 0;
  const aligned = sma5Now > sma20Now && sma20Now > sma60Now; // 정배열
  const reverseAligned = sma5Now < sma20Now && sma20Now < sma60Now; // 역배열

  if (aligned) {
    // 정배열: 이격도에 따른 차등 점수 (과열 구간 감점)
    if (disparity20 >= 0 && disparity20 <= 3) trendScore += 20;      // 적정 이격 — 최적 타점
    else if (disparity20 > 3 && disparity20 <= 6) trendScore += 12;  // 약간 과열 — 추격 주의
    else if (disparity20 > 6) trendScore += 5;                        // 과열 — 고점 추격 위험
    else trendScore += 10;                                             // 이격 음수지만 정배열
  } else if (current > sma20Now && sma20Now > sma60Now) {
    trendScore += 8;
  }
  if (reverseAligned) {
    if (disparity20 < -6) trendScore -= 20;     // 급락 — 바닥 확인 전 매수 위험
    else if (disparity20 < -3) trendScore -= 15; // 하락 추세
    else trendScore -= 10;                        // 약한 역배열
  } else if (current < sma20Now && sma20Now < sma60Now) {
    trendScore -= 8;
  }
  if (goldenCross) trendScore += 5;
  if (deathCross) trendScore -= 5;

  const vwapValues = vwap(candlesAsc.slice(-20));
  const vwapNow = vwapValues[vwapValues.length - 1] ?? current;
  const vwapPrev = vwapValues[vwapValues.length - 2] ?? vwapNow;
  const prevClose = closesAsc[closesAsc.length - 2] ?? current;
  const vwapDiff = vwapNow > 0 ? ((current - vwapNow) / vwapNow) * 100 : 0;
  const vwapPosition: TechnicalSummary['vwapPosition'] = vwapDiff > 1 ? 'ABOVE' : vwapDiff < -1 ? 'BELOW' : 'AT';
  const vwapCross: TechnicalSummary['vwapCross'] =
    prevClose < vwapPrev && current > vwapNow
      ? 'JUST_ABOVE'
      : prevClose > vwapPrev && current < vwapNow
        ? 'JUST_BELOW'
        : 'NONE';
  if (vwapCross === 'JUST_ABOVE') trendScore += 8;
  else if (vwapCross === 'JUST_BELOW') trendScore -= 8;
  else if (vwapPosition === 'ABOVE') trendScore += 4;
  else if (vwapPosition === 'BELOW') trendScore -= 4;

  trendScore = Math.max(-25, Math.min(25, trendScore));

  // ── 카테고리 2: 모멘텀 (Momentum) — cap ±25 ──
  // RSI, MACD, Stochastic, ROC, RSI2, 캔들 패턴 (모두 "가격 변화율/진동" 계열)
  let momentumScore = 0;
  // v9: RSI 과매수 페널티 완화 — 모멘텀 상승 종목 과도한 감점이 랠리 기회 차단
  if (rsi14 < 30) momentumScore += 10;
  else if (rsi14 < 40) momentumScore += 5;
  else if (rsi14 >= 45 && rsi14 <= 62) momentumScore += 8;
  else if (rsi14 > 70) momentumScore -= 8; // v9: -15→-8
  else if (rsi14 > 65) momentumScore -= 3; // v9: -8→-3

  if (macdCross === 'BULLISH') momentumScore += 12;
  else if (macdCross === 'BEARISH') momentumScore -= 12;
  else if (macdHist > 0) momentumScore += 4;
  else if (macdHist < 0) momentumScore -= 4;
  // v9-fix: macdHist === 0 (데이터 부족/정확히 0) → 페널티 없음

  if (stochSignal === 'OVERSOLD' && rsi14 >= 28 && rsi14 <= 35) momentumScore += 3;
  if (stochSignal === 'OVERBOUGHT' && rsi14 >= 65 && rsi14 <= 72) momentumScore -= 3;

  const rocValues = roc(closesAsc, 12);
  const roc12 = rocValues[rocValues.length - 1] ?? 0;
  if (roc12 > 8) momentumScore += 3;
  else if (roc12 > 3) momentumScore += 1;
  else if (roc12 < -8) momentumScore -= 3;
  else if (roc12 < -3) momentumScore -= 1;

  const rsi2Values = rsi(closesAsc, 2);
  const rsi2 = rsi2Values[rsi2Values.length - 1] ?? 50;
  if (rsi2 < 15) momentumScore += 8;
  else if (rsi2 < 25) momentumScore += 4;
  else if (rsi2 > 85) momentumScore -= 8;
  else if (rsi2 > 75) momentumScore -= 4;

  const candlePatterns = detectCandlePatterns(candles);
  for (const p of candlePatterns) {
    const pts = p.strength === 'STRONG' ? 5 : p.strength === 'MODERATE' ? 3 : 1;
    momentumScore += p.bullish ? pts : -pts;
  }

  momentumScore = Math.max(-25, Math.min(25, momentumScore));

  // ── 카테고리 3: 변동성/돌파 (Volatility) — cap ±25 ──
  // 볼린저밴드, TTM 스퀴즈, 눌림매매, ADX 추세강도
  let volatilityScore = 0;
  if (bbPos === 'BELOW_LOWER') volatilityScore += 6;
  else if (bbPos === 'NEAR_LOWER') volatilityScore += 3;
  else if (bbPos === 'ABOVE_UPPER') volatilityScore -= 8;
  else if (bbPos === 'NEAR_UPPER') volatilityScore -= 3;

  const ttmSqueezeResult = ttmSqueeze(candles);
  if (ttmSqueezeResult.fireSignal === 'LONG') volatilityScore += 12;
  else if (ttmSqueezeResult.fireSignal === 'SHORT') volatilityScore -= 12;
  else if (ttmSqueezeResult.squeezeState === 'ON' && ttmSqueezeResult.consecutiveSqueezeOn >= 5) volatilityScore += 4;

  if (bollingerBreakout === 'UP') volatilityScore += 10;
  else if (bollingerBreakout === 'DOWN') volatilityScore -= 10;
  else if (bollingerSqueeze && macdCross === 'BULLISH') volatilityScore += 5;

  // ADX 보정: 약한 추세에서 양수 변동성 점수 감소
  if (trendStrength === 'WEAK' && volatilityScore > 0) volatilityScore = Math.floor(volatilityScore * 0.7);

  volatilityScore = Math.max(-25, Math.min(25, volatilityScore));

  // ── 카테고리 4: 거래량 (Volume) — cap ±25 ──
  // v10: Z-score 정규화 — 고정 임계값 대신 자기 역사 대비 상대적 위치로 판단
  const volWindow = volumes.slice(1, Math.min(61, volumes.length));
  const volMean = volWindow.reduce((s, v) => s + v, 0) / (volWindow.length || 1);
  const volVariance = volWindow.reduce((s, v) => s + (v - volMean) ** 2, 0) / (volWindow.length || 1);
  const volStd = Math.sqrt(volVariance);
  const volZScore = volStd > 0 ? (volumes[0] - volMean) / volStd : 0;

  // v11: OBV + CMF — 매집/분산 판별 (가짜 돌파 차단)
  const obvResult = obv(candlesAsc);
  const cmfResult = cmf(candlesAsc, 20);

  let volumeScore = 0;
  if (current > sma5Now) {
    // Z-score 기반: 자기 거래량 분포 대비 오늘의 위치
    volumeScore +=
      volZScore >= 3.0 ? 12 : volZScore >= 2.0 ? 9 : volZScore >= 1.0 ? 6 : volZScore >= 0.5 ? 3 : 0;
  }
  if (volZScore < -1.5) volumeScore -= 10; // Z-score 기반 극저거래량

  // OBV: 매집 추세 확인 — 거래량 급증 + OBV 상승 = 진짜 매집
  if (obvResult.trend === 'RISING' && volZScore >= 0.5) volumeScore += 4;  // 매집 확인
  else if (obvResult.trend === 'FALLING' && current > sma5Now) volumeScore -= 4; // 가격↑ + OBV↓ = 분산 의심
  // OBV 다이버전스: 가격-거래량 괴리 = 추세 반전 조기 경보
  if (obvResult.divergence === 'BEARISH') volumeScore -= 5; // 가격 신고가 but OBV 하락 → 위험
  else if (obvResult.divergence === 'BULLISH') volumeScore += 3; // 가격 신저가 but OBV 상승 → 바닥

  // CMF: 자금 유입/유출 압력 — 종가 위치 × 거래량
  if (cmfResult.signal === 'INFLOW') volumeScore += cmfResult.strength >= 0.5 ? 4 : 2; // 강한/약한 유입
  else if (cmfResult.signal === 'OUTFLOW') volumeScore -= cmfResult.strength >= 0.5 ? 4 : 2; // 강한/약한 유출

  // 핵심 필터: 돌파 시그널 + OBV/CMF 불일치 → 가짜 돌파 경고
  // 기술적 돌파(score>0) + OBV↓ + CMF 유출 = 가짜 돌파 가능성 높음 → 감점
  if (trendScore > 5 && obvResult.trend === 'FALLING' && cmfResult.signal === 'OUTFLOW') {
    volumeScore -= 6; // 가짜 돌파 강한 경고
  }

  // VWAP 풀백 (거래량 기반 확인)
  const vwapHistory = vwapValues.slice(-4);
  const closeHistory = closesAsc.slice(-4);
  let recentVwapBreak = false;
  for (let i = 1; i < Math.min(3, vwapHistory.length - 1); i++) {
    const pastClose = closeHistory[closeHistory.length - 1 - i] ?? 0;
    const pastVwap = vwapHistory[vwapHistory.length - 1 - i] ?? 0;
    if (pastClose > pastVwap * 1.005) {
      recentVwapBreak = true;
      break;
    }
  }
  const nearVwap = Math.abs(vwapDiff) < 0.5;
  const vwapPullback = recentVwapBreak && nearVwap && current > vwapNow * 0.995;
  if (vwapPullback) volumeScore += 6;

  // 거래대금 연속성
  const avgVol20ForConsistency = volumes.slice(0, 20).reduce((s, v) => s + v, 0) / 20;
  let volumeConsistency = 0;
  for (let i = 0; i < Math.min(5, volumes.length); i++) {
    if (volumes[i] >= avgVol20ForConsistency) volumeConsistency++;
  }
  if (volumeConsistency >= 4) volumeScore += 5;
  else if (volumeConsistency <= 1) volumeScore -= 5;

  volumeScore = Math.max(-25, Math.min(25, volumeScore));

  // ── 종합: 4개 카테고리 합산 + 다중확인 보너스/페널티 ──
  let score = trendScore + momentumScore + volatilityScore + volumeScore;

  // 다중확인(Multi-Confirmation): 3/4 카테고리 이상 양수여야 매수 신호 유효
  const positiveCats = [trendScore > 0, momentumScore > 0, volatilityScore > 0, volumeScore > 0].filter(Boolean).length;
  const negativeCats = [trendScore < 0, momentumScore < 0, volatilityScore < 0, volumeScore < 0].filter(Boolean).length;
  if (positiveCats < 3 && score > 0) score = Math.floor(score * 0.5); // 확인 부족 → 신호 약화
  if (negativeCats >= 3 && score > -15) score = Math.min(score, -15); // 3/4 음수 → 최소 SELL

  // 눌림매매 (Pullback Signal) — 카테고리 외 구조 보너스
  const sma10Val = sma(closesAsc, 10);
  const sma10Now = sma10Val[sma10Val.length - 1] ?? current;
  let recentDipBelowMA = false;
  const lookback = Math.min(5, closesAsc.length - 1);
  for (let i = 1; i <= lookback; i++) {
    const pastClose = closesAsc[closesAsc.length - 1 - i] ?? current;
    const pastSma5 = sma5Val[sma5Val.length - 1 - i] ?? sma5Now;
    if (pastClose < pastSma5) {
      recentDipBelowMA = true;
      break;
    }
  }
  const pullbackSignal = recentDipBelowMA && current > sma5Now && current > sma10Now && volumeRatio >= 0.8;
  if (pullbackSignal && positiveCats >= 3) score += 8; // 다중확인 통과한 경우만 풀백 보너스

  score = Math.max(-100, Math.min(100, score));

  let overallSignal: TechnicalSummary['overallSignal'];
  if (score >= 40) overallSignal = 'STRONG_BUY';
  else if (score >= 15) overallSignal = 'BUY';
  else if (score <= -40) overallSignal = 'STRONG_SELL';
  else if (score <= -15) overallSignal = 'SELL';
  else overallSignal = 'NEUTRAL';

  // 가격 위치 정보
  const recent3High = Math.max(candles[0].high, candles[1]?.high ?? 0, candles[2]?.high ?? 0);
  const recent5Low = Math.min(
    candles[0].low,
    candles[1]?.low ?? Infinity,
    candles[2]?.low ?? Infinity,
    candles[3]?.low ?? Infinity,
    candles[4]?.low ?? Infinity,
  );
  const pctFrom3DayHigh = recent3High > 0 ? ((current - recent3High) / recent3High) * 100 : 0;
  const pctFrom5DayLow = recent5Low > 0 && recent5Low < Infinity ? ((current - recent5Low) / recent5Low) * 100 : 0;

  // 엔벨로프
  const envelopeResult = envelope(closesAsc, 20, 0.05);

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
    rsiDivergence: detectRsiDivergence(closes, [...rsiValues].reverse(), 14),
    // v4: 카테고리별 점수 (자기학습 피드백용)
    catTrend: trendScore,
    catMomentum: momentumScore,
    catVolatility: volatilityScore,
    catVolume: volumeScore,
    catPositive: positiveCats,
    // v10: 이격도 + Z-score
    disparity20,
    disparity60,
    volZScore,
    // v11: OBV + CMF
    obvResult,
    cmfResult,
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
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    });
  }
  return result.reverse();
}

export function analyzeIntraday(minuteCandles: OHLCV[]): IntradaySignal {
  const empty: IntradaySignal = {
    score: 0,
    trend: 'NEUTRAL',
    trend15m: 'NEUTRAL',
    volumeSurge: false,
    vwapPosition: 'AT',
    reason: '데이터부족',
  };
  if (minuteCandles.length < 10) return empty;
  const asc = [...minuteCandles].reverse();
  const closes = asc.map((c) => c.close);
  const highs = asc.map((c) => c.high);
  const lows = asc.map((c) => c.low);
  const vols = asc.map((c) => c.volume);
  let score = 0;
  const tags: string[] = [];

  // 1. RSI (분봉)
  const rsiPeriod = Math.min(14, closes.length - 1);
  const rsiNow = rsi(closes, rsiPeriod).pop() ?? 50;
  if (rsiNow < 30) {
    score += 12;
    tags.push(`분봉RSI과매도(${rsiNow.toFixed(0)})`);
  } else if (rsiNow < 40) score += 6;
  else if (rsiNow > 70) {
    score -= 12;
    tags.push(`분봉RSI과매수(${rsiNow.toFixed(0)})`);
  } else if (rsiNow > 60) score -= 6;

  // 2. 단기 MACD (5/13/4)
  if (closes.length >= 14) {
    const m = macd(closes, 5, 13, 4);
    const h = m.histogram;
    const hNow = h[h.length - 1] ?? 0;
    const hPrev = h[h.length - 2] ?? hNow;
    if (hNow > 0 && hNow > hPrev) {
      score += 10;
      tags.push('분봉MACD상승');
    } else if (hNow < 0 && hNow < hPrev) score -= 10;
    else if (hNow > 0) score += 4;
    else score -= 4;
  }

  // 3. 최근 5봉 가격 추세
  if (closes.length >= 5) {
    const pct = ((closes[closes.length - 1] - closes[closes.length - 5]) / (closes[closes.length - 5] || 1)) * 100;
    if (pct > 0.5) {
      score += 8;
      tags.push('단기상승');
    } else if (pct > 0.2) score += 4;
    else if (pct < -0.5) {
      score -= 8;
      tags.push('단기하락');
    } else if (pct < -0.2) score -= 4;
  }

  // 4. 거래량 서지
  const surgeRatio =
    vols.length >= 15
      ? vols.slice(-5).reduce((a, b) => a + b, 0) / 5 / (vols.slice(-15, -5).reduce((a, b) => a + b, 0) / 10 || 1)
      : 1;
  const volumeSurge = surgeRatio >= 1.5;
  if (volumeSurge && score > 0) {
    score += 5;
    tags.push(`거래량급증(${surgeRatio.toFixed(1)}x)`);
  }

  // 5. 분봉 VWAP 위치
  let vwapPosition: IntradaySignal['vwapPosition'] = 'AT';
  if (closes.length >= 20 && vols.length >= 20) {
    let cumPV = 0,
      cumVol = 0;
    for (let i = 0; i < closes.length; i++) {
      const typical = (highs[i] + lows[i] + closes[i]) / 3;
      cumPV += typical * vols[i];
      cumVol += vols[i];
    }
    const vwapVal = cumVol > 0 ? cumPV / cumVol : closes[closes.length - 1];
    const curPrice = closes[closes.length - 1];
    const vwapPct = vwapVal > 0 ? ((curPrice - vwapVal) / vwapVal) * 100 : 0;
    if (vwapPct > 0.15) {
      vwapPosition = 'ABOVE';
      score += 5;
      tags.push('VWAP상방');
    } else if (vwapPct < -0.15) {
      vwapPosition = 'BELOW';
      score -= 5;
      tags.push('VWAP하방');
    }
  }

  // 6. 분봉 볼린저밴드
  if (closes.length >= 22) {
    const bbResult = bollingerBands(closes, 20);
    const bbU = bbResult.upper[bbResult.upper.length - 1] ?? 0;
    const bbL = bbResult.lower[bbResult.lower.length - 1] ?? 0;
    const bbM = bbResult.middle[bbResult.middle.length - 1] ?? 0;
    const cur = closes[closes.length - 1];
    if (cur > bbU) {
      score -= 6;
      tags.push('분봉BB상단돌파');
    } else if (cur < bbL) {
      score += 6;
      tags.push('분봉BB하단지지');
    } else if (bbM > 0 && cur > bbM + (bbU - bbM) * 0.7) {
      score -= 3;
    } else if (bbM > 0 && cur < bbM - (bbM - bbL) * 0.7) {
      score += 3;
    }
  }

  // 7. 15분봉 추세 분석
  let trend15m: IntradaySignal['trend15m'] = 'NEUTRAL';
  const candles15m = aggregateToTimeframe(minuteCandles, 15);
  if (candles15m.length >= 4) {
    const c15 = candles15m.map((c) => c.close);
    const last4 = c15.slice(-4);
    const upCount = last4.filter((v, i) => i > 0 && v > last4[i - 1]).length;
    const downCount = last4.filter((v, i) => i > 0 && v < last4[i - 1]).length;
    if (upCount >= 2 && downCount === 0) {
      trend15m = 'UP';
      score += 8;
      tags.push('15m상승추세');
    } else if (downCount >= 2 && upCount === 0) {
      trend15m = 'DOWN';
      score -= 8;
      tags.push('15m하락추세');
    }
    if (c15.length >= 8) {
      const rsi15 = rsi(c15, Math.min(7, c15.length - 1)).pop() ?? 50;
      if (rsi15 > 72) {
        score -= 4;
        tags.push(`15mRSI과매수(${rsi15.toFixed(0)})`);
      } else if (rsi15 < 28) {
        score += 4;
        tags.push(`15mRSI과매도(${rsi15.toFixed(0)})`);
      }
    }
  }

  // 8. 3연속 양봉/음봉
  if (closes.length >= 4) {
    const last3Dir = [
      closes[closes.length - 1] > closes[closes.length - 2],
      closes[closes.length - 2] > closes[closes.length - 3],
      closes[closes.length - 3] > closes[closes.length - 4],
    ];
    if (last3Dir.every(Boolean)) {
      score += 4;
      tags.push('3연속양봉');
    } else if (last3Dir.every((d) => !d)) {
      score -= 4;
      tags.push('3연속음봉');
    }
  }

  score = Math.max(-50, Math.min(50, score));
  const trend = score > 5 ? 'UP' : score < -5 ? 'DOWN' : 'NEUTRAL';
  return { score, trend, trend15m, volumeSurge, vwapPosition, reason: tags.join('+') || '중립' };
}
