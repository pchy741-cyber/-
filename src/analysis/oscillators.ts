/**
 * 📊 오실레이터 지표 (Oscillators)
 * RSI, MACD, Bollinger, Stochastic, Williams %R, ROC, ATR, ADX, TTM Squeeze
 */

import { sma, ema, type OHLCV } from './moving-averages.js';

// ── RSI (Relative Strength Index) ──

export function rsi(prices: number[], period: number = 14): number[] {
  if (prices.length < period + 1) return [];

  const changes: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  const result: number[] = [];
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push(100 - 100 / (1 + rs));

  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs2 = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs2));
  }

  return result;
}

// ── RSI 다이버전스 감지 (Momentum+Mean Reversion 결합 — Serban 2010, Velissaris 2016 검증) ──
// Bullish divergence: 가격 lower low + RSI higher low → 평균회귀 매수 신호
// Bearish divergence: 가격 higher high + RSI lower high → 모멘텀 약화 매도 신호
export interface RsiDivergence {
  type: 'BULLISH' | 'BEARISH' | 'NONE';
  strength: number; // 0~1 (RSI 차이 크기 비례)
}

export function detectRsiDivergence(
  prices: number[],  // 최신→과거 (desc)
  rsiValues: number[], // 최신→과거 (desc) — rsi() 결과를 reverse한 것
  lookback: number = 14,
): RsiDivergence {
  if (prices.length < lookback || rsiValues.length < lookback) return { type: 'NONE', strength: 0 };

  // 최근 lookback 기간 내 가격 저점 2개, 고점 2개 찾기
  let priceMinIdx1 = 0, priceMinIdx2 = -1;
  let priceMaxIdx1 = 0, priceMaxIdx2 = -1;

  // 가장 최근 저점/고점
  for (let i = 1; i < lookback; i++) {
    if (prices[i] < prices[priceMinIdx1]) { priceMinIdx2 = priceMinIdx1; priceMinIdx1 = i; }
    else if (priceMinIdx2 < 0 || prices[i] < prices[priceMinIdx2]) priceMinIdx2 = i;
    if (prices[i] > prices[priceMaxIdx1]) { priceMaxIdx2 = priceMaxIdx1; priceMaxIdx1 = i; }
    else if (priceMaxIdx2 < 0 || prices[i] > prices[priceMaxIdx2]) priceMaxIdx2 = i;
  }

  // Bullish: 현재 가격이 이전 저점보다 낮지만, RSI는 이전보다 높음
  if (priceMinIdx2 >= 0 && priceMinIdx1 < priceMinIdx2) {
    const priceDrop = prices[priceMinIdx1] < prices[priceMinIdx2]; // price lower low
    const rsiRise = rsiValues[priceMinIdx1] > rsiValues[priceMinIdx2]; // RSI higher low
    if (priceDrop && rsiRise) {
      const rsiDiff = rsiValues[priceMinIdx1] - rsiValues[priceMinIdx2];
      return { type: 'BULLISH', strength: Math.min(1, rsiDiff / 15) };
    }
  }

  // Bearish: 현재 가격이 이전 고점보다 높지만, RSI는 이전보다 낮음
  if (priceMaxIdx2 >= 0 && priceMaxIdx1 < priceMaxIdx2) {
    const priceRise = prices[priceMaxIdx1] > prices[priceMaxIdx2]; // price higher high
    const rsiFall = rsiValues[priceMaxIdx1] < rsiValues[priceMaxIdx2]; // RSI lower high
    if (priceRise && rsiFall) {
      const rsiDiff = rsiValues[priceMaxIdx2] - rsiValues[priceMaxIdx1];
      return { type: 'BEARISH', strength: Math.min(1, rsiDiff / 15) };
    }
  }

  return { type: 'NONE', strength: 0 };
}

// ── MACD (Moving Average Convergence Divergence) ──

export interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(prices: number[], fast = 12, slow = 26, signal = 9): MACDResult {
  const emaFast = ema(prices, fast);
  const emaSlow = ema(prices, slow);

  const offset = emaFast.length - emaSlow.length;
  const macdLine: number[] = [];
  for (let i = 0; i < emaSlow.length; i++) {
    macdLine.push(emaFast[i + offset] - emaSlow[i]);
  }

  const signalLine = ema(macdLine, signal);
  const histOffset = macdLine.length - signalLine.length;
  const histogram: number[] = [];
  for (let i = 0; i < signalLine.length; i++) {
    histogram.push(macdLine[i + histOffset] - signalLine[i]);
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

// ── 볼린저 밴드 ──

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  width: number[];
}

export function bollingerBands(prices: number[], period = 20, stdDev = 2): BollingerResult {
  const middle = sma(prices, period);
  const upper: number[] = [];
  const lower: number[] = [];
  const width: number[] = [];

  for (let i = 0; i <= prices.length - period; i++) {
    const slice = prices.slice(i, i + period);
    const mean = middle[i];
    const variance = slice.reduce((sum, p) => sum + (p - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);

    upper.push(mean + stdDev * std);
    lower.push(mean - stdDev * std);
    width.push(mean > 0 ? ((stdDev * std * 2) / mean) * 100 : 0);
  }

  return { upper, middle, lower, width };
}

// ── 스토캐스틱 ──

export interface StochasticResult {
  k: number[];
  d: number[];
}

export function stochastic(candles: OHLCV[], kPeriod = 14, dPeriod = 3): StochasticResult {
  const k: number[] = [];

  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const high = Math.max(...slice.map((c) => c.high));
    const low = Math.min(...slice.map((c) => c.low));
    const close = candles[i].close;

    k.push(high === low ? 50 : ((close - low) / (high - low)) * 100);
  }

  const d = sma(k, dPeriod);
  return { k, d };
}

// ── Williams %R ──

export function williamsR(candles: OHLCV[], period = 14): number[] {
  const result: number[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const high = Math.max(...slice.map((c) => c.high));
    const low = Math.min(...slice.map((c) => c.low));
    const close = candles[i].close;
    result.push(high === low ? -50 : ((high - close) / (high - low)) * -100);
  }
  return result;
}

// ── ROC (Rate of Change) ──

export function roc(prices: number[], period = 12): number[] {
  const result: number[] = [];
  for (let i = period; i < prices.length; i++) {
    const prev = prices[i - period];
    result.push(prev !== 0 ? ((prices[i] - prev) / prev) * 100 : 0);
  }
  return result;
}

// ── ATR (Average True Range) ──

export function atr(candles: OHLCV[], period = 14): number[] {
  if (candles.length < 2) return [];

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    trueRanges.push(tr);
  }

  return sma(trueRanges, period);
}

// ── ADX (Average Directional Index) ──

export function adx(candles: OHLCV[], period: number = 14): number[] {
  if (candles.length < period * 2) return [];

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const highDiff = candles[i].high - candles[i - 1].high;
    const lowDiff = candles[i - 1].low - candles[i].low;

    plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);

    tr.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      ),
    );
  }

  const smoothedTR = ema(tr, period);
  const smoothedPlusDM = ema(plusDM, period);
  const smoothedMinusDM = ema(minusDM, period);

  const dx: number[] = [];
  const minLen = Math.min(smoothedTR.length, smoothedPlusDM.length, smoothedMinusDM.length);

  for (let i = 0; i < minLen; i++) {
    const plusDI = smoothedTR[i] > 0 ? (smoothedPlusDM[i] / smoothedTR[i]) * 100 : 0;
    const minusDI = smoothedTR[i] > 0 ? (smoothedMinusDM[i] / smoothedTR[i]) * 100 : 0;
    const sum = plusDI + minusDI;
    dx.push(sum > 0 ? (Math.abs(plusDI - minusDI) / sum) * 100 : 0);
  }

  return ema(dx, period);
}

// ── TTM Squeeze (John Carter) ──

export interface TTMSqueezeResult {
  squeezeState: 'ON' | 'OFF';
  momentum: number;
  momentumPrev: number;
  fireSignal: 'LONG' | 'SHORT' | 'NONE';
  consecutiveSqueezeOn: number;
}

export function ttmSqueeze(candles: OHLCV[], bbPeriod = 20, bbMult = 2.0, kcPeriod = 20, kcMult = 1.5): TTMSqueezeResult {
  if (candles.length < bbPeriod + 5) {
    return { squeezeState: 'OFF', momentum: 0, momentumPrev: 0, fireSignal: 'NONE', consecutiveSqueezeOn: 0 };
  }

  const closes = candles.map((c) => c.close);
  const bbResult = bollingerBands(closes.reverse(), bbPeriod, bbMult);
  closes.reverse();

  const closesAsc = [...closes].reverse();
  const candlesAsc = [...candles].reverse();

  const emaValues = ema(closesAsc, kcPeriod);
  const atrValues = atr(candlesAsc, kcPeriod);
  const kcUpper = emaValues.map((e, i) => e + kcMult * (atrValues[i] ?? 0));
  const kcLower = emaValues.map((e, i) => e - kcMult * (atrValues[i] ?? 0));

  const minLen = Math.min(bbResult.upper.length, kcUpper.length);
  const bbU = bbResult.upper.slice(-minLen);
  const bbL = bbResult.lower.slice(-minLen);
  const kcU = kcUpper.slice(-minLen);
  const kcL = kcLower.slice(-minLen);

  const lastIdx = minLen - 1;
  const prevIdx = minLen - 2;
  const currSqueezeOn = (bbU[lastIdx] ?? 0) < (kcU[lastIdx] ?? 0) && (bbL[lastIdx] ?? 0) > (kcL[lastIdx] ?? 0);
  const prevSqueezeOn = prevIdx >= 0 && (bbU[prevIdx] ?? 0) < (kcU[prevIdx] ?? 0) && (bbL[prevIdx] ?? 0) > (kcL[prevIdx] ?? 0);

  let consecutiveSqueezeOn = 0;
  for (let i = minLen - 1; i >= 0; i--) {
    if ((bbU[i] ?? 0) < (kcU[i] ?? 0) && (bbL[i] ?? 0) > (kcL[i] ?? 0)) consecutiveSqueezeOn++;
    else break;
  }

  const midpoints = closesAsc.slice(-kcPeriod).map((c, i) => {
    const bbMid = bbResult.middle[bbResult.middle.length - kcPeriod + i] ?? c;
    const kcMid = emaValues[emaValues.length - kcPeriod + i] ?? c;
    return c - (bbMid + kcMid) / 2;
  });
  const momentum = midpoints[midpoints.length - 1] ?? 0;
  const momentumPrev = midpoints[midpoints.length - 2] ?? 0;

  let fireSignal: TTMSqueezeResult['fireSignal'] = 'NONE';
  if (prevSqueezeOn && !currSqueezeOn) {
    if (momentum > 0 && momentum > momentumPrev) fireSignal = 'LONG';
    else if (momentum < 0 && momentum < momentumPrev) fireSignal = 'SHORT';
  }

  return {
    squeezeState: currSqueezeOn ? 'ON' : 'OFF',
    momentum,
    momentumPrev,
    fireSignal,
    consecutiveSqueezeOn,
  };
}
