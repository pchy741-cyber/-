/**
 * 스마트 재진입 필터
 *
 * 시간 기반 30일 차단 → 조건 기반 재진입으로 교체.
 * 기존 분석 함수(fibonacci, 5MA breakout, volume)를 재활용.
 *
 * 3가지 조건 합성:
 *   A. 차트박사 5일선 (relaxed — 60일 신고가 불필요)
 *   B. 피보나치 반등 (38.2%/50% 되돌림)
 *   C. 주도주 필터 (거래대금 or 신고가)
 *
 * 로직: (A OR B) AND C → 재진입 허용
 */

import { calcFibonacciLevels } from '../../../analysis/indicators.js';
import { sma } from '../../../analysis/moving-averages.js';
import type { LossRecord } from '../../../db/client.js';
import type { DailyCandle } from '../../../kis/market.js';

export interface SmartReentryResult {
  allowed: boolean;
  reason: string;
  /** 반등 캔들 저가 vs 5MA 중 타이트한 값 — SL 설정용 */
  suggestedSl?: number;
}

/**
 * Condition A: 차트박사 5일선 (relaxed)
 * — 60일 신고가 불필요, 20MA 상승추세 + 가격 20MA 지지 + 종가>5MA + 거래량 1.5x
 */
function checkConditionA(candles: DailyCandle[]): { pass: boolean; sl?: number } {
  if (candles.length < 25) return { pass: false };

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const currentPrice = closes[closes.length - 1];
  const currentVolume = volumes[volumes.length - 1];
  const currentLow = candles[candles.length - 1].low;

  // 5일/20일 SMA
  const sma5Arr = sma(closes, 5);
  const sma20Arr = sma(closes, 20);
  if (sma5Arr.length === 0 || sma20Arr.length === 0) return { pass: false };

  const sma5Now = sma5Arr[sma5Arr.length - 1];
  const sma20Now = sma20Arr[sma20Arr.length - 1];
  const sma20Prev = sma20Arr.length >= 6 ? sma20Arr[sma20Arr.length - 6] : sma20Now;

  // 20MA 상승추세
  const ma20Rising = sma20Now > sma20Prev;
  if (!ma20Rising) return { pass: false };

  // 가격이 20MA 지지 (현재가 ≥ 20MA × 0.97)
  const aboveSupport = currentPrice >= sma20Now * 0.97;
  if (!aboveSupport) return { pass: false };

  // 종가 > 5MA
  const above5MA = currentPrice > sma5Now;
  if (!above5MA) return { pass: false };

  // 거래량 1.5x
  const recentVol = volumes.slice(-21, -1);
  const avgVol = recentVol.length > 0 ? recentVol.reduce((a, b) => a + b, 0) / recentVol.length : 0;
  const volRatio = avgVol > 0 ? currentVolume / avgVol : 0;
  if (volRatio < 1.5) return { pass: false };

  // SL: 반등 캔들 저가 vs 5MA 중 타이트한 값
  const sl = Math.max(currentLow, sma5Now);

  return { pass: true, sl };
}

/**
 * Condition B: 피보나치 반등
 * — 38.2%/50% 되돌림 구간 + 양봉 + 거래량 1.3x
 */
function checkConditionB(candles: DailyCandle[]): { pass: boolean; sl?: number } {
  if (candles.length < 20) return { pass: false };

  const currentCandle = candles[candles.length - 1];
  const currentPrice = currentCandle.close;

  // 양봉 확인
  const isBullish = currentCandle.close > currentCandle.open;
  if (!isBullish) return { pass: false };

  // 피보나치 계산
  const fib = calcFibonacciLevels(candles, currentPrice);
  if (!fib) return { pass: false };

  // 38.2% 또는 50% 되돌림 구간 (±2%)
  const inFibZone = fib.levels
    .filter((l) => l.level === 0.382 || l.level === 0.5)
    .some((l) => Math.abs(l.pctFromCurrent) <= 2.0);
  if (!inFibZone) return { pass: false };

  // 거래량 1.3x
  const volumes = candles.map((c) => c.volume);
  const recentVol = volumes.slice(-21, -1);
  const avgVol = recentVol.length > 0 ? recentVol.reduce((a, b) => a + b, 0) / recentVol.length : 0;
  const volRatio = avgVol > 0 ? currentCandle.volume / avgVol : 0;
  if (volRatio < 1.3) return { pass: false };

  // SL: 반등 캔들 저가
  return { pass: true, sl: currentCandle.low };
}

/**
 * Condition C: 주도주 필터
 * — 거래대금 ≥ 150억원 OR 60일 신고가 이력
 */
function checkConditionC(candles: DailyCandle[], tradingValue: number): boolean {
  // 거래대금 150억 이상
  if (tradingValue >= 15_000_000_000) return true;

  // 60일 신고가 이력 (최근 10일 내)
  if (candles.length >= 62) {
    const highs = candles.map((c) => c.high);
    const lookback60 = highs.slice(-62, -2);
    const high60 = Math.max(...lookback60);
    const recentHighs = highs.slice(-10);
    if (recentHighs.some((h) => h >= high60 * 0.99)) return true;
  }

  return false;
}

/**
 * 스마트 재진입 체크 (동기 함수 — isHardBlocked 동기 유지)
 *
 * @param lossRecord 해당 종목의 손실 이력
 * @param candles 일봉 차트 데이터
 * @param tradingValue 거래대금 (volume × price)
 * @returns 재진입 허용 여부 + 사유 + SL 제안
 */
export function checkSmartReentry(
  lossRecord: LossRecord,
  candles: DailyCandle[] | undefined,
  tradingValue: number,
): SmartReentryResult {
  if (!candles || candles.length < 25) {
    return { allowed: false, reason: '차트 데이터 부족' };
  }

  // Condition C (주도주) 먼저 체크 — 실패하면 A/B 볼 필요 없음
  const passC = checkConditionC(candles, tradingValue);
  if (!passC) {
    return { allowed: false, reason: '주도주 필터 미달 (거래대금<150억, 60일 신고가 없음)' };
  }

  // Condition A (차트박사 5일선 relaxed)
  const condA = checkConditionA(candles);

  // Condition B (피보나치 반등)
  const condB = checkConditionB(candles);

  // (A OR B) AND C
  if (!condA.pass && !condB.pass) {
    return { allowed: false, reason: '기술적 조건 미충족 (5MA/피보나치 모두 미달)' };
  }

  // SL 결정: A와 B 중 통과한 조건의 SL, 둘 다면 타이트한 값
  let sl: number | undefined;
  if (condA.pass && condB.pass) {
    sl = Math.max(condA.sl!, condB.sl!); // 더 타이트한 (높은) SL
  } else if (condA.pass) {
    sl = condA.sl;
  } else {
    sl = condB.sl;
  }

  const passedConds = [condA.pass && '5MA', condB.pass && 'Fib'].filter(Boolean).join('+');
  const lossPctStr = lossRecord.lossPct.toFixed(1);

  return {
    allowed: true,
    reason: `스마트재진입(${passedConds}): 이전손실${lossPctStr}% → 기술적 반등 확인`,
    suggestedSl: sl,
  };
}
