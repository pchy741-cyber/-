/**
 * 📊 정량 팩터 모델 — 모멘텀 · 밸류 · 퀄리티 · 수급
 *
 * 실리콘밸리 퀀트 전략의 핵심: 감(感)이 아닌 데이터 기반 팩터 스코어링
 *
 * 팩터 정의:
 *   - Momentum (0~100): 가격 추세 강도 + 상대 강도 (RS)
 *   - Value    (0~100): PER·PBR 기반 저평가 정도
 *   - Quality  (0~100): 수급 건전성 + 기관 확신도
 *   - FlowDiv  (-100~+100): 가격-수급 괴리 (다이버전스)
 *
 * 입력: OHLCV 배열 + CurrentPrice 메타 + 투자자 수급
 * 출력: FactorScores (Track A·B에서 활용)
 */

import type { OHLCV } from './moving-averages.js';
import { ema, sma } from './moving-averages.js';
import { rsi, atr } from './oscillators.js';
import { logger } from '../utils/logger.js';

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

export interface FactorScores {
  momentum: number;       // 0~100: 추세 강도 (높을수록 강한 상승세)
  value: number;          // 0~100: 저평가 매력 (높을수록 저렴)
  quality: number;        // 0~100: 수급 건전성 (높을수록 기관 확신)
  flowDivergence: number; // -100~+100: 가격↑수급↓=-100(위험), 가격↓수급↑=+100(기회)
  composite: number;      // 0~100: 종합 (가중평균)
  regime: 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL';
  details: FactorDetails;
}

export interface FactorDetails {
  // Momentum sub-factors
  priceVsMa20: number;   // 현재가/MA20 비율 (1.05 = 5% 위)
  priceVsMa60: number;   // 현재가/MA60 비율
  rsi14: number;
  rateOfChange20: number; // 20일 수익률 %
  rateOfChange60: number; // 60일 수익률 %
  relativeStrength: number; // 0~100: 시장 대비 상대강도

  // Value sub-factors
  per: number;
  dividendYield: number;
  priceVs52wHigh: number; // 52주 고점 대비 %

  // Quality sub-factors
  foreignNetStreak: number;  // 외인 연속 순매수 일수
  institutionNetStreak: number;
  volumeRatio: number;       // 최근5일 평균거래량 / 20일 평균

  // Flow divergence
  priceChange5d: number;     // 5일 가격 변화 %
  flowScore5d: number;       // 5일 수급 점수
}

export interface FactorInput {
  candles: OHLCV[];          // 최소 60일 일봉
  per?: number;              // PER (KIS CurrentPrice.per)
  dividendYield?: number;    // 배당수익률 %
  marketCapEok?: number;     // 시가총액 억원
  foreignNetDays?: number[]; // 외인 순매수 일별 (최신→과거, 양수=순매수)
  institutionNetDays?: number[]; // 기관 순매수 일별
  benchmarkReturns?: number[]; // 벤치마크(KOSPI) 수익률 일별 (최신→과거)
}

// ────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────

/** 팩터 가중치 */
const W_MOMENTUM = 0.30;
const W_VALUE = 0.20;
const W_QUALITY = 0.30;
const W_FLOW_DIV = 0.20;

// ────────────────────────────────────────────
// Main
// ────────────────────────────────────────────

export function calcFactorScores(input: FactorInput): FactorScores {
  const { candles } = input;
  if (candles.length < 20) {
    return defaultScores('데이터 부족 (20일 미만)');
  }

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const highs = candles.map(c => c.high);

  // ─── Momentum Factor ───
  const ma20 = sma(closes, 20);
  const ma60 = closes.length >= 60 ? sma(closes, 60) : ma20;
  const curPrice = closes[closes.length - 1];
  const curMa20 = ma20[ma20.length - 1] || curPrice;
  const curMa60 = ma60[ma60.length - 1] || curPrice;

  const priceVsMa20 = curMa20 > 0 ? curPrice / curMa20 : 1;
  const priceVsMa60 = curMa60 > 0 ? curPrice / curMa60 : 1;

  const rsi14Arr = rsi(closes, 14);
  const rsi14Val = rsi14Arr[rsi14Arr.length - 1] ?? 50;

  const roc20 = closes.length >= 21
    ? ((curPrice - closes[closes.length - 21]) / closes[closes.length - 21]) * 100
    : 0;
  const roc60 = closes.length >= 61
    ? ((curPrice - closes[closes.length - 61]) / closes[closes.length - 61]) * 100
    : roc20;

  // 상대강도 (RS): 내 수익률 vs 벤치마크 수익률
  let relativeStrength = 50;
  if (input.benchmarkReturns && input.benchmarkReturns.length >= 20) {
    const benchRoc20 = input.benchmarkReturns.slice(0, 20).reduce((a, b) => a + b, 0);
    const rsDiff = roc20 - benchRoc20;
    relativeStrength = clamp(50 + rsDiff * 2, 0, 100); // ±25% 차이 → 0~100
  }

  const momentumScore = calcMomentumScore(priceVsMa20, priceVsMa60, rsi14Val, roc20, relativeStrength);

  // ─── Value Factor ───
  const per = input.per ?? 0;
  const divYield = input.dividendYield ?? 0;
  const high52w = Math.max(...highs.slice(-Math.min(252, highs.length)));
  const priceVs52wHigh = high52w > 0 ? (curPrice / high52w) * 100 : 100;
  const valueScore = calcValueScore(per, divYield, priceVs52wHigh);

  // ─── Quality Factor (수급 건전성) ───
  const foreignStreak = calcStreak(input.foreignNetDays ?? []);
  const instStreak = calcStreak(input.institutionNetDays ?? []);

  const vol5 = average(volumes.slice(-5));
  const vol20 = average(volumes.slice(-20));
  const volumeRatio = vol20 > 0 ? vol5 / vol20 : 1;

  const qualityScore = calcQualityScore(foreignStreak, instStreak, volumeRatio);

  // ─── Flow Divergence ───
  const priceChange5d = closes.length >= 6
    ? ((curPrice - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
    : 0;
  const flowScore5d = calcFlowScore5d(input.foreignNetDays ?? [], input.institutionNetDays ?? []);
  const flowDivergence = calcFlowDivergence(priceChange5d, flowScore5d);

  // ─── Composite ───
  // flowDivergence는 -100~+100 → 0~100으로 정규화
  const flowNorm = (flowDivergence + 100) / 2;
  const composite = Math.round(
    momentumScore * W_MOMENTUM +
    valueScore * W_VALUE +
    qualityScore * W_QUALITY +
    flowNorm * W_FLOW_DIV
  );

  const regime = compositeToRegime(composite);

  return {
    momentum: Math.round(momentumScore),
    value: Math.round(valueScore),
    quality: Math.round(qualityScore),
    flowDivergence: Math.round(flowDivergence),
    composite: clamp(composite, 0, 100),
    regime,
    details: {
      priceVsMa20: round2(priceVsMa20),
      priceVsMa60: round2(priceVsMa60),
      rsi14: round2(rsi14Val),
      rateOfChange20: round2(roc20),
      rateOfChange60: round2(roc60),
      relativeStrength: Math.round(relativeStrength),
      per: round2(per),
      dividendYield: round2(divYield),
      priceVs52wHigh: round2(priceVs52wHigh),
      foreignNetStreak: foreignStreak,
      institutionNetStreak: instStreak,
      volumeRatio: round2(volumeRatio),
      priceChange5d: round2(priceChange5d),
      flowScore5d: round2(flowScore5d),
    },
  };
}

// ────────────────────────────────────────────
// Sub-factor calculations
// ────────────────────────────────────────────

function calcMomentumScore(
  pMa20: number, pMa60: number, rsi14: number,
  roc20: number, rs: number,
): number {
  let score = 50;

  // MA 위치 (±15점)
  score += (pMa20 - 1) * 150; // MA20 5% 위 = +7.5점
  score += (pMa60 - 1) * 100; // MA60 5% 위 = +5점

  // RSI (±15점): 50 중심, 30~70 사이에서 정규화
  if (rsi14 > 50) score += Math.min(15, (rsi14 - 50) * 0.5);
  else score -= Math.min(15, (50 - rsi14) * 0.5);

  // ROC 20일 (±10점)
  score += clamp(roc20 * 0.5, -10, 10);

  // 상대강도 (±10점)
  score += (rs - 50) * 0.2;

  return clamp(score, 0, 100);
}

function calcValueScore(per: number, divYield: number, priceVs52wHigh: number): number {
  let score = 50;

  // PER (±25점): 낮을수록 매력적
  if (per > 0 && per < 8) score += 25;         // 극저PER
  else if (per >= 8 && per < 12) score += 15;   // 저PER
  else if (per >= 12 && per < 20) score += 0;   // 보통
  else if (per >= 20 && per < 40) score -= 10;  // 고PER
  else if (per >= 40) score -= 20;              // 거품

  // 배당수익률 (±15점)
  if (divYield >= 5) score += 15;
  else if (divYield >= 3) score += 10;
  else if (divYield >= 1.5) score += 5;

  // 52주 고점 대비 (±10점): 20~40% 하락 = 잠재 가치
  const discount = 100 - priceVs52wHigh;
  if (discount >= 30) score += 10;       // 30%+ 할인
  else if (discount >= 15) score += 5;   // 15~30% 할인
  else if (discount < 5) score -= 5;     // 고점 근처 (밸류 매력 낮음)

  return clamp(score, 0, 100);
}

function calcQualityScore(foreignStreak: number, instStreak: number, volumeRatio: number): number {
  let score = 50;

  // 외인 연속 순매수 (±20점)
  score += clamp(foreignStreak * 4, -20, 20);

  // 기관 연속 순매수 (±15점)
  score += clamp(instStreak * 3, -15, 15);

  // 외인+기관 동시 매수 보너스
  if (foreignStreak >= 2 && instStreak >= 2) score += 10;

  // 거래량 비율 (±5점): 적정 수준(1.0~2.0) 선호
  if (volumeRatio >= 1.2 && volumeRatio <= 2.5) score += 5; // 건전한 관심 증가
  else if (volumeRatio > 4.0) score -= 5; // 과열 경고

  return clamp(score, 0, 100);
}

/** 5일 수급 점수: 외인+기관 순매수 합산 → 정규화 */
function calcFlowScore5d(foreignDays: number[], instDays: number[]): number {
  const f5 = foreignDays.slice(0, 5);
  const i5 = instDays.slice(0, 5);
  if (f5.length === 0 && i5.length === 0) return 0;

  const fSum = f5.reduce((a, b) => a + b, 0);
  const iSum = i5.reduce((a, b) => a + b, 0);

  // 정규화: 합계의 부호와 크기 기반 (-100~+100)
  const combined = fSum + iSum;
  const absMax = Math.max(Math.abs(fSum), Math.abs(iSum), 1);
  return clamp((combined / absMax) * 50, -100, 100);
}

/**
 * 가격-수급 다이버전스
 *
 * 핵심 시그널:
 *  - 가격↑ + 수급↓ = 위험 (스마트머니 이탈) → -100
 *  - 가격↓ + 수급↑ = 기회 (스마트머니 저가 매집) → +100
 *  - 동방향 = 정상 → 0 근처
 */
function calcFlowDivergence(priceChange5d: number, flowScore5d: number): number {
  // 둘 다 미미하면 중립
  if (Math.abs(priceChange5d) < 0.5 && Math.abs(flowScore5d) < 5) return 0;

  const priceDir = Math.sign(priceChange5d);
  const flowDir = Math.sign(flowScore5d);

  if (priceDir === flowDir) {
    // 동방향: 강도에 비례 (약한 시그널)
    return clamp(flowScore5d * 0.3, -30, 30);
  }

  // 역방향: 다이버전스! 강도에 비례
  const magnitude = Math.abs(priceChange5d) * Math.abs(flowScore5d) / 10;

  if (priceDir > 0 && flowDir < 0) {
    // 가격↑ 수급↓ = 위험 (배도, Smart Money 이탈)
    return -clamp(magnitude, 0, 100);
  }
  // 가격↓ 수급↑ = 기회 (Smart Money 매집)
  return clamp(magnitude, 0, 100);
}

// ────────────────────────────────────────────
// Portfolio-level metrics
// ────────────────────────────────────────────

export interface PortfolioMetrics {
  hhi: number;             // Herfindahl-Hirschman Index (0~10000, 낮을수록 분산)
  effectiveN: number;      // 유효 종목수 = 1/HHI (분산 정도)
  maxWeight: number;       // 최대 비중 %
  top3Weight: number;      // 상위3 비중 합계 %
  concentrationLevel: 'EXCELLENT' | 'GOOD' | 'MODERATE' | 'HIGH' | 'DANGEROUS';
}

export function calcPortfolioMetrics(
  weights: Array<{ code: string; weight: number }>, // weight: 0~1 (비중)
): PortfolioMetrics {
  if (weights.length === 0) {
    return { hhi: 0, effectiveN: 0, maxWeight: 0, top3Weight: 0, concentrationLevel: 'EXCELLENT' };
  }

  // HHI = Σ(w_i × 100)²
  const hhi = weights.reduce((sum, w) => sum + (w.weight * 100) ** 2, 0);
  const effectiveN = hhi > 0 ? Math.round((10000 / hhi) * 10) / 10 : weights.length;

  const sorted = [...weights].sort((a, b) => b.weight - a.weight);
  const maxWeight = (sorted[0]?.weight ?? 0) * 100;
  const top3Weight = sorted.slice(0, 3).reduce((s, w) => s + w.weight * 100, 0);

  let concentrationLevel: PortfolioMetrics['concentrationLevel'];
  if (hhi < 1500) concentrationLevel = 'EXCELLENT';       // 7+ 종목 균등
  else if (hhi < 2500) concentrationLevel = 'GOOD';       // 4~6 종목
  else if (hhi < 4000) concentrationLevel = 'MODERATE';   // 3~4 종목
  else if (hhi < 6000) concentrationLevel = 'HIGH';       // 2~3 종목
  else concentrationLevel = 'DANGEROUS';                   // 1~2 종목 집중

  return {
    hhi: Math.round(hhi),
    effectiveN,
    maxWeight: Math.round(maxWeight * 10) / 10,
    top3Weight: Math.round(top3Weight * 10) / 10,
    concentrationLevel,
  };
}

// ────────────────────────────────────────────
// Batch scoring (watchlist 전체)
// ────────────────────────────────────────────

export interface BatchFactorResult {
  code: string;
  name?: string;
  scores: FactorScores;
}

/**
 * 워치리스트 전체 팩터 스코어링
 * Track A 파이프라인에서 호출 — 기술적 데이터 + 수급 → 정량 팩터
 */
export async function scoreBatchFactors(
  items: Array<{
    code: string;
    name?: string;
    candles: OHLCV[];
    per?: number;
    dividendYield?: number;
    marketCapEok?: number;
    foreignNetDays?: number[];
    institutionNetDays?: number[];
  }>,
  benchmarkReturns?: number[],
): Promise<BatchFactorResult[]> {
  const results: BatchFactorResult[] = [];

  for (const item of items) {
    try {
      const scores = calcFactorScores({
        candles: item.candles,
        per: item.per,
        dividendYield: item.dividendYield,
        marketCapEok: item.marketCapEok,
        foreignNetDays: item.foreignNetDays,
        institutionNetDays: item.institutionNetDays,
        benchmarkReturns,
      });
      results.push({ code: item.code, name: item.name, scores });
    } catch (e) {
      logger.warn(`팩터 스코어링 실패 ${item.code}: ${(e as Error).message}`, { component: 'FACTOR' });
    }
  }

  return results;
}

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function average(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** 연속 순매수/순매도 일수 (양수=순매수 연속, 음수=순매도 연속) */
function calcStreak(days: number[]): number {
  if (days.length === 0) return 0;
  const dir = days[0] > 0 ? 1 : days[0] < 0 ? -1 : 0;
  if (dir === 0) return 0;
  let count = 0;
  for (const d of days) {
    if ((dir > 0 && d > 0) || (dir < 0 && d < 0)) count++;
    else break;
  }
  return count * dir;
}

function compositeToRegime(score: number): FactorScores['regime'] {
  if (score >= 75) return 'STRONG_BUY';
  if (score >= 60) return 'BUY';
  if (score >= 40) return 'NEUTRAL';
  if (score >= 25) return 'SELL';
  return 'STRONG_SELL';
}

function defaultScores(reason: string): FactorScores {
  logger.debug(`팩터 기본값 사용: ${reason}`, { component: 'FACTOR' });
  return {
    momentum: 50, value: 50, quality: 50, flowDivergence: 0, composite: 50,
    regime: 'NEUTRAL',
    details: {
      priceVsMa20: 1, priceVsMa60: 1, rsi14: 50, rateOfChange20: 0, rateOfChange60: 0,
      relativeStrength: 50, per: 0, dividendYield: 0, priceVs52wHigh: 100,
      foreignNetStreak: 0, institutionNetStreak: 0, volumeRatio: 1,
      priceChange5d: 0, flowScore5d: 0,
    },
  };
}
