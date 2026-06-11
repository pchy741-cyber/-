/**
 * 🎯 6-상태 시장 레짐 감지 v2
 *
 * 기존 penalty/boost 2상태 → 6상태 세분화
 * 각 레짐별 최적 전략/SL/포지션 배율 제공
 */

import { adx, atr, bollingerBands, sma } from '../../analysis/indicators.js';
import type { TechnicalSummary } from '../../analysis/indicators.js';

// ── 레짐 타입 ──
export type RegimeV2 =
  | 'TREND_BULL'     // 강한 상승추세
  | 'TREND_BEAR'     // 강한 하락추세
  | 'RANGE_LOW_VOL'  // 저변동 횡보 (평균회귀)
  | 'RANGE_HIGH_VOL' // 고변동 횡보
  | 'BREAKOUT'       // BB스퀴즈 → 돌파 임박
  | 'DISTRIBUTION';  // 분배구간 (자기상관 음수 + 고점권)

export interface RegimeV2Result {
  regime: RegimeV2;
  confidence: number;  // 0~1
  adx: number;
  atrMedian: number;
  currentAtr: number;
  bbSqueeze: boolean;
  autocorrelation: number;
}

export interface RegimeEntryConfig {
  slMultiplier: number;    // ATR 배수
  tpMultiplier: number;    // ATR 배수 (TP)
  positionScale: number;   // 기본 포지션 대비 배율
  strategy: string;        // 최적 전략 라벨
}

// ── Lag-1 수익률 자기상관 ──
// closes는 내림차순 (closes[0] = 최신), period개의 최근 수익률을 사용
export function calcLag1Autocorrelation(closes: number[], period: number = 20): number {
  if (closes.length < period + 2) return 0;

  const returns: number[] = [];
  for (let i = 1; i <= period; i++) {
    // closes[i-1] = 더 최근, closes[i] = 하루 전 → 당일 수익률
    returns.push((closes[i - 1] - closes[i]) / closes[i]);
  }

  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  let num = 0, den = 0;
  for (let i = 0; i < returns.length - 1; i++) {
    num += (returns[i] - mean) * (returns[i + 1] - mean);
    den += (returns[i] - mean) ** 2;
  }

  return den > 0 ? num / den : 0;
}

// ── 6-상태 레짐 감지 ──
export function detectRegimeV2(tech: TechnicalSummary, closes: number[]): RegimeV2Result {
  const closesAsc = [...closes].reverse();

  // ATR 중간값 (20일)
  const atrPctArr: number[] = [];
  if (closesAsc.length >= 30) {
    const atrVals = atr(closesAsc.map((c, i) => ({
      date: '', open: c, high: c * 1.01, low: c * 0.99, close: c,
      volume: 0,
    })), 14);
    // 실제 atrPct은 tech에서 가져옴
  }
  const currentAtr = tech.atrPct;

  // BB 폭 → 스퀴즈 감지 (BB폭 < 70% 평균)
  const bbSqueeze = tech.bollingerSqueeze; // 이미 80% 기준 계산됨

  // 자기상관
  const autocorrelation = calcLag1Autocorrelation(closes);

  // ADX
  const adxVal = tech.adx14;

  // ATR 중간값 (tech.atrPct 기반 추정 — 실제는 tech에서)
  const atrMedian = currentAtr; // 단순화: 현재 ATR을 기준으로

  let regime: RegimeV2;
  let confidence: number;

  // 1. BREAKOUT — BB스퀴즈 + ADX 낮음 (에너지 축적 → 돌파 임박)
  if (bbSqueeze && adxVal < 20) {
    regime = 'BREAKOUT';
    confidence = 0.7 + (20 - adxVal) / 100; // ADX 낮을수록 확신
  }
  // 2. DISTRIBUTION — 자기상관 음수 + 가격 > SMA60 (고점권 분배)
  else if (autocorrelation < -0.2 && closes[0] > tech.sma60) {
    regime = 'DISTRIBUTION';
    confidence = Math.min(0.9, 0.6 + Math.abs(autocorrelation));
  }
  // 3. TREND_BULL — ADX > 25 + SMA20 > SMA60
  else if (adxVal > 25 && tech.sma20 > tech.sma60) {
    regime = 'TREND_BULL';
    confidence = Math.min(0.95, 0.6 + (adxVal - 25) / 50);
  }
  // 4. TREND_BEAR — ADX > 25 + SMA20 < SMA60
  else if (adxVal > 25 && tech.sma20 < tech.sma60) {
    regime = 'TREND_BEAR';
    confidence = Math.min(0.95, 0.6 + (adxVal - 25) / 50);
  }
  // 5. RANGE_HIGH_VOL — ADX < 20 + 높은 변동성 (ATR > 2%)
  else if (adxVal < 20 && currentAtr > 2.0) {
    regime = 'RANGE_HIGH_VOL';
    confidence = 0.65;
  }
  // 6. RANGE_LOW_VOL — 나머지 (ADX < 20 + 낮은 변동성)
  else {
    regime = 'RANGE_LOW_VOL';
    confidence = adxVal < 15 ? 0.8 : 0.6;
  }

  return {
    regime,
    confidence,
    adx: adxVal,
    atrMedian,
    currentAtr,
    bbSqueeze,
    autocorrelation,
  };
}

// ── 레짐별 진입 설정 ──
export function getRegimeEntryConfig(regime: RegimeV2): RegimeEntryConfig {
  switch (regime) {
    case 'TREND_BULL':
      return { slMultiplier: 2.0, tpMultiplier: 4.0, positionScale: 1.2, strategy: '모멘텀/돌파' };
    case 'TREND_BEAR':
      return { slMultiplier: 1.5, tpMultiplier: 2.0, positionScale: 0.3, strategy: '현금/방어' };
    case 'RANGE_LOW_VOL':
      return { slMultiplier: 1.5, tpMultiplier: 2.5, positionScale: 0.8, strategy: '평균회귀' };
    case 'RANGE_HIGH_VOL':
      return { slMultiplier: 2.5, tpMultiplier: 3.5, positionScale: 0.5, strategy: '넓은SL 소량' };
    case 'BREAKOUT':
      return { slMultiplier: 2.0, tpMultiplier: 3.0, positionScale: 1.0, strategy: 'TTM 스퀴즈' };
    case 'DISTRIBUTION':
      return { slMultiplier: 1.5, tpMultiplier: 2.0, positionScale: 0.4, strategy: '노출 축소' };
  }
}
