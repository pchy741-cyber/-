/**
 * 📊 차트 패턴 감지 (Chart Patterns)
 * 캔들스틱 패턴, 피보나치, 볼륨 프로파일, 구조적 패턴
 */

import { type OHLCV, sma } from './moving-averages.js';

// ── 캔들스틱 패턴 감지 ──

export interface CandlePatternResult {
  name: string;
  bullish: boolean;
  strength: 'WEAK' | 'MODERATE' | 'STRONG';
}

export function detectCandlePatterns(candles: OHLCV[]): CandlePatternResult[] {
  if (candles.length < 3) return [];
  const patterns: CandlePatternResult[] = [];

  const [c0, c1, c2] = candles;

  const body0 = Math.abs(c0.close - c0.open);
  const range0 = c0.high - c0.low || 1;
  const lower0 = Math.min(c0.open, c0.close) - c0.low;
  const upper0 = c0.high - Math.max(c0.open, c0.close);
  const bull0 = c0.close > c0.open;

  const body1 = Math.abs(c1.close - c1.open);
  const range1 = c1.high - c1.low || 1;
  const bull1 = c1.close > c1.open;

  // 1. 망치형 (Hammer)
  if (lower0 / range0 >= 0.5 && upper0 / range0 < 0.15 && body0 / range0 < 0.4) {
    patterns.push({ name: '망치형', bullish: true, strength: 'STRONG' });
  }

  // 2. 역망치형 (Inverted Hammer) — bullish/bearish 모두 감지 (하락 추세 후 반등 신호)
  if (upper0 / range0 >= 0.5 && lower0 / range0 < 0.15 && body0 / range0 < 0.4) {
    patterns.push({ name: '역망치형', bullish: true, strength: 'MODERATE' });
  }

  // 3. 슈팅스타 (Shooting Star)
  if (upper0 / range0 >= 0.5 && lower0 / range0 < 0.15 && body0 / range0 < 0.4 && bull1) {
    patterns.push({ name: '슈팅스타', bullish: false, strength: 'STRONG' });
  }

  // 4. 도지 (Doji) — 선행 캔들 방향으로 편향 결정 (중립 시 약세 기본)
  if (body0 / range0 < 0.1) {
    if (!bull1 && c0.close > c1.close) {
      // 이전 음봉 + 도지가 이전보다 높게 마감 → 반전 강세 신호
      patterns.push({ name: '도지(강세)', bullish: true, strength: 'MODERATE' });
    } else if (bull1 && c0.close < c1.close) {
      // 이전 양봉 + 도지가 이전보다 낮게 마감 → 반전 약세 신호
      patterns.push({ name: '도지(약세)', bullish: false, strength: 'MODERATE' });
    } else {
      // 방향 불명확 → 이전 캔들 방향 반대 (잠재 반전), 약한 신호
      patterns.push({ name: '도지(중립)', bullish: !bull1, strength: 'WEAK' });
    }
  }

  // 5. 불리쉬 인걸핑 (Bullish Engulfing)
  if (bull0 && !bull1 && c0.open <= c1.close && c0.close >= c1.open && body0 > body1 * 1.1) {
    patterns.push({ name: '불리쉬인걸핑', bullish: true, strength: 'STRONG' });
  }

  // 6. 베어리쉬 인걸핑 (Bearish Engulfing)
  if (!bull0 && bull1 && c0.open >= c1.close && c0.close <= c1.open && body0 > body1 * 1.1) {
    patterns.push({ name: '베어리쉬인걸핑', bullish: false, strength: 'STRONG' });
  }

  // 7. 모닝스타 / 이브닝스타 (Morning/Evening Star)
  if (candles.length >= 3) {
    const bull2 = c2.close > c2.open;
    if (!bull2 && body1 / range1 < 0.3 && bull0 && c0.close > (c2.open + c2.close) / 2) {
      patterns.push({ name: '모닝스타', bullish: true, strength: 'STRONG' });
    }
    if (bull2 && body1 / range1 < 0.3 && !bull0 && c0.close < (c2.open + c2.close) / 2) {
      patterns.push({ name: '이브닝스타', bullish: false, strength: 'STRONG' });
    }
  }

  // 8. V자 반등
  if (!bull1 && bull0 && c0.close > c1.open) {
    patterns.push({ name: 'V반등', bullish: true, strength: 'MODERATE' });
  }

  return patterns;
}

// ── 피보나치 되돌림 레벨 ──

export interface FibonacciLevel {
  level: number;
  price: number;
  pctFromCurrent: number;
  isNear: boolean;
}

export interface FibonacciResult {
  swingHigh: number;
  swingLow: number;
  levels: FibonacciLevel[];
  nearestBuyLevel: FibonacciLevel | null;
  isAtFibSupport: boolean;
  fibScore: number;
}

export function calcFibonacciLevels(candles: OHLCV[], currentPrice: number): FibonacciResult | null {
  if (candles.length < 20 || currentPrice <= 0) return null;

  const lookback = Math.min(candles.length, 60);
  const recent = candles.slice(0, lookback);
  const swingHigh = Math.max(...recent.map((c) => c.high));
  const swingLow = Math.min(...recent.map((c) => c.low));

  const range = swingHigh - swingLow;
  if (range <= 0 || swingLow <= 0) return null;

  const fibRatios = [0.382, 0.5, 0.618];
  const levels: FibonacciLevel[] = fibRatios.map((ratio) => {
    const price = swingHigh - range * ratio;
    const pctFromCurrent = ((currentPrice - price) / price) * 100;
    return {
      level: ratio,
      price,
      pctFromCurrent,
      isNear: Math.abs(pctFromCurrent) <= 2.0,
    };
  });

  const supportLevels = levels.filter((l) => l.pctFromCurrent >= -2.0 && l.pctFromCurrent <= 3.0);
  const nearestBuyLevel =
    supportLevels.length > 0
      ? supportLevels.reduce((best, l) => (Math.abs(l.pctFromCurrent) < Math.abs(best.pctFromCurrent) ? l : best))
      : null;

  const isAtFibSupport = levels.some((l) => l.isNear && l.pctFromCurrent >= -2.0);

  let fibScore = 0;
  if (isAtFibSupport) {
    const nearest = levels.find((l) => l.isNear);
    if (nearest) {
      // Fibonacci ratios are constants defined in fibRatios, safe to compare directly
      fibScore = Math.abs(nearest.level - 0.382) < 1e-9 ? 15 : Math.abs(nearest.level - 0.5) < 1e-9 ? 12 : 10;
      if (Math.abs(nearest.pctFromCurrent) <= 0.5) fibScore += 3;
    }
  }

  return { swingHigh, swingLow, levels, nearestBuyLevel, isAtFibSupport, fibScore };
}

// ── 볼륨 프로파일 ──

export interface VolumeLevelResult {
  priceLevel: number;
  volumePct: number;
  isSupport: boolean;
  isResistance: boolean;
}

export function volumeProfile(candles: OHLCV[], bins = 24): VolumeLevelResult[] {
  if (candles.length < 10 || bins <= 0) return [];
  const minP = Math.min(...candles.map((c) => c.low));
  const maxP = Math.max(...candles.map((c) => c.high));
  if (maxP <= minP) return [];
  const binSize = (maxP - minP) / bins;
  const volByBin = new Array(bins).fill(0);
  for (const c of candles) {
    const s = Math.max(0, Math.floor((c.low - minP) / binSize));
    const e = Math.min(bins - 1, Math.floor((c.high - minP) / binSize));
    const n = Math.max(1, e - s + 1);
    for (let b = s; b <= e; b++) volByBin[b] += c.volume / n;
  }
  const total = volByBin.reduce((a, b) => a + b, 0);
  const threshold = total > 0 ? (total / bins) * 1.5 : 0;
  const cur = candles[0].close;
  return volByBin
    .map((vol, i) => {
      const priceLevel = minP + (i + 0.5) * binSize;
      return {
        priceLevel,
        volumePct: total > 0 ? (vol / total) * 100 : 0,
        isSupport: vol >= threshold && priceLevel < cur,
        isResistance: vol >= threshold && priceLevel > cur,
      };
    })
    .filter((v) => v.isSupport || v.isResistance);
}

// ── 구조적 차트 패턴 (이중 바닥/천장, 삼각수렴) ──

export interface StructuralPattern {
  name: 'DOUBLE_BOTTOM' | 'DOUBLE_TOP' | 'SYM_TRIANGLE' | 'ASC_TRIANGLE' | 'DESC_TRIANGLE';
  bullish: boolean;
  confidence: number;
  score: number;
  label: string;
}

function _linearSlope(arr: number[]): number {
  const n = arr.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = arr.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (arr[i] - ym);
    den += (i - xm) ** 2;
  }
  return den !== 0 ? num / den / (ym || 1) : 0;
}

function _localExtremes(arr: number[], type: 'min' | 'max', w = 3): number[] {
  if (arr.length < w * 2 + 1) return [];
  const result: number[] = [];
  for (let i = w; i < arr.length - w; i++) {
    const s = arr.slice(i - w, i + w + 1);
    if (type === 'min' && arr[i] === Math.min(...s)) result.push(i);
    if (type === 'max' && arr[i] === Math.max(...s)) result.push(i);
  }
  return result;
}

export function detectStructuralPatterns(candles: OHLCV[]): StructuralPattern[] {
  if (candles.length < 30) return [];
  const recent = candles.slice(0, 30).reverse();
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const closes = recent.map((c) => c.close);
  const patterns: StructuralPattern[] = [];

  // 이중 바닥 (Double Bottom)
  const mins = _localExtremes(lows, 'min');
  if (mins.length >= 2) {
    const [i1, i2] = [mins[0], mins[mins.length - 1]];
    if (i2 - i1 >= 5) {
      const diff = Math.abs(lows[i1] - lows[i2]) / (lows[i1] || 1);
      if (diff < 0.03) {
        const conf = 1 - diff / 0.03;
        patterns.push({
          name: 'DOUBLE_BOTTOM',
          bullish: true,
          confidence: conf,
          score: Math.round(15 * conf),
          label: `이중바닥(${lows[i1].toFixed(0)}/${lows[i2].toFixed(0)})`,
        });
      }
    }
  }

  // 이중 천장 (Double Top)
  const maxs = _localExtremes(highs, 'max');
  if (maxs.length >= 2) {
    const [i1, i2] = [maxs[0], maxs[maxs.length - 1]];
    if (i2 - i1 >= 5) {
      const diff = Math.abs(highs[i1] - highs[i2]) / (highs[i1] || 1);
      if (diff < 0.03) {
        const conf = 1 - diff / 0.03;
        patterns.push({
          name: 'DOUBLE_TOP',
          bullish: false,
          confidence: conf,
          score: -Math.round(15 * conf),
          label: `이중천장(${highs[i1].toFixed(0)}/${highs[i2].toFixed(0)})`,
        });
      }
    }
  }

  // 삼각수렴 (Triangle)
  const hSlope = _linearSlope(highs.slice(-20));
  const lSlope = _linearSlope(lows.slice(-20));
  const curClose = closes[closes.length - 1];
  const sma20v = sma(closes, 20).pop() ?? curClose;
  if (hSlope < -0.001 && lSlope > 0.001) {
    const bull = curClose > sma20v;
    patterns.push({
      name: 'SYM_TRIANGLE',
      bullish: bull,
      confidence: 0.6,
      score: bull ? 8 : -8,
      label: '대칭삼각수렴',
    });
  } else if (hSlope < -0.001 && Math.abs(lSlope) < 0.0005) {
    patterns.push({ name: 'DESC_TRIANGLE', bullish: false, confidence: 0.65, score: -12, label: '하강삼각형' });
  } else if (Math.abs(hSlope) < 0.0005 && lSlope > 0.001) {
    patterns.push({ name: 'ASC_TRIANGLE', bullish: true, confidence: 0.65, score: 12, label: '상승삼각형' });
  }

  return patterns;
}
