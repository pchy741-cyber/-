/**
 * 📊 이동평균 지표 (Moving Averages)
 * SMA, EMA, Envelope, VWAP
 */

export interface OHLCV {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── 이동평균 (SMA / EMA) ──

export function sma(prices: number[], period: number): number[] {
  if (prices.length === 0 || period <= 0 || prices.length < period) return [];
  const result: number[] = [];
  for (let i = 0; i <= prices.length - period; i++) {
    const sum = prices.slice(i, i + period).reduce((a, b) => a + b, 0);
    result.push(sum / period);
  }
  return result;
}

export function ema(prices: number[], period: number): number[] {
  if (prices.length < period || period <= 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];

  // 첫 EMA = SMA
  let prev = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(prev);

  for (let i = period; i < prices.length; i++) {
    prev = prices[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

// ── 엔벨로프 (Envelope) — SMA ± 고정 비율 밴드 ──

export interface EnvelopeResult {
  upper: number[];
  middle: number[];
  lower: number[];
  upperNow: number;
  middleNow: number;
  lowerNow: number;
  position: 'ABOVE_UPPER' | 'NEAR_UPPER' | 'MIDDLE' | 'NEAR_LOWER' | 'BELOW_LOWER';
  touchingLower: boolean;
}

export function envelope(prices: number[], period = 20, deviation = 0.05): EnvelopeResult {
  if (prices.length === 0) {
    return {
      upper: [], middle: [], lower: [],
      upperNow: 0, middleNow: 0, lowerNow: 0,
      position: 'MIDDLE', touchingLower: false,
    };
  }
  const mid = sma(prices, period);
  const upper = mid.map((m) => m * (1 + deviation));
  const lower = mid.map((m) => m * (1 - deviation));
  const cur = prices[prices.length - 1] ?? 0;
  const middleNow = mid[mid.length - 1] ?? cur;
  const upperNow = upper[upper.length - 1] ?? cur;
  const lowerNow = lower[lower.length - 1] ?? cur;

  let position: EnvelopeResult['position'] = 'MIDDLE';
  if (cur >= upperNow) position = 'ABOVE_UPPER';
  else if (cur >= middleNow + (upperNow - middleNow) * 0.6) position = 'NEAR_UPPER';
  else if (cur <= lowerNow) position = 'BELOW_LOWER';
  else if (cur <= middleNow - (middleNow - lowerNow) * 0.6) position = 'NEAR_LOWER';

  return { upper, middle: mid, lower, upperNow, middleNow, lowerNow, position, touchingLower: cur <= lowerNow };
}

// ── VWAP (Volume Weighted Average Price) ──

export function vwap(candles: OHLCV[]): number[] {
  if (candles.length === 0) return [];
  const result: number[] = [];
  let cumVolume = 0;
  let cumVP = 0;

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumVolume += c.volume;
    cumVP += typicalPrice * c.volume;
    result.push(cumVolume > 0 ? cumVP / cumVolume : typicalPrice);
  }

  return result;
}
