/**
 * 스마트 재진입 필터
 *
 * 시간 기반 30일 차단 → 조건 기반 재진입으로 교체.
 * 기존 분석 함수(fibonacci, 5MA breakout, volume)를 재활용.
 *
 * 4가지 조건 합성:
 *   A. 차트박사 5일선 (relaxed — 60일 신고가 불필요)
 *   B. 피보나치 반등 (38.2%/50% 되돌림)
 *   C. 주도주 필터 (거래대금 or 신고가)
 *   D. RSI 꺾인 포인트 (과매도 → 회복 크로스 — CEO 지시 2026-06-17)
 *
 * 로직: (A OR B OR D) AND C → 재진입 허용
 */

import { calcFibonacciLevels } from '../../../analysis/indicators.js';
import { sma } from '../../../analysis/moving-averages.js';
import { rsi } from '../../../analysis/oscillators.js';
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
  const currentPrice = closes[0];
  const currentVolume = volumes[0];
  const currentLow = candles[0].low;

  // 5일/20일 SMA (candles descending: index 0 = newest → sma result[0] = latest)
  const sma5Arr = sma(closes, 5);
  const sma20Arr = sma(closes, 20);
  if (sma5Arr.length === 0 || sma20Arr.length === 0) return { pass: false };

  const sma5Now = sma5Arr[0];
  const sma20Now = sma20Arr[0];
  const sma20Prev = sma20Arr.length >= 6 ? sma20Arr[5] : sma20Now;

  // 20MA 상승추세
  const ma20Rising = sma20Now > sma20Prev;
  if (!ma20Rising) return { pass: false };

  // 가격이 20MA 지지 (현재가 ≥ 20MA × 0.97)
  const aboveSupport = currentPrice >= sma20Now * 0.97;
  if (!aboveSupport) return { pass: false };

  // 종가 > 5MA
  const above5MA = currentPrice > sma5Now;
  if (!above5MA) return { pass: false };

  // 거래량 1.5x (descending: index 0=today, 1~20=past 20일)
  const recentVol = volumes.slice(1, 21);
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

  const currentCandle = candles[0];
  const currentPrice = currentCandle.close;

  // 양봉 확인
  const isBullish = currentCandle.close > currentCandle.open;
  if (!isBullish) return { pass: false };

  // 피보나치 계산
  const fib = calcFibonacciLevels(candles, currentPrice);
  if (!fib) return { pass: false };

  // 38.2% 또는 50% 되돌림 구간 (±2%)
  const inFibZone = fib.levels
    .filter((l) => Math.abs(l.level - 0.382) < 1e-9 || Math.abs(l.level - 0.5) < 1e-9)
    .some((l) => Math.abs(l.pctFromCurrent) <= 2.0);
  if (!inFibZone) return { pass: false };

  // 거래량 1.3x (descending: index 0=today, 1~20=past 20일)
  const volumes = candles.map((c) => c.volume);
  const recentVol = volumes.slice(1, 21);
  const avgVol = recentVol.length > 0 ? recentVol.reduce((a, b) => a + b, 0) / recentVol.length : 0;
  const volRatio = avgVol > 0 ? currentCandle.volume / avgVol : 0;
  if (volRatio < 1.3) return { pass: false };

  // SL: 반등 캔들 저가
  return { pass: true, sl: currentCandle.low };
}

/**
 * Condition D: RSI 꺾인 포인트 (CEO 지시 — 2026-06-17)
 * — RSI(14)가 최근 3캔들 내 ≤30 이었다가 현재 ≥50
 * — 종가 > 5MA (반등 확인)
 * — 최근 5캔들 내 20MA 터치 (±3%) = 지지선 확인
 *
 * "하락 변곡점(꺾인 포인트)" 자동 감지용
 */
function checkConditionD(candles: DailyCandle[]): { pass: boolean; sl?: number } {
  if (candles.length < 25) return { pass: false };

  // candles descending: index 0 = newest
  // rsi() expects ascending order → reverse closes
  const closes = candles.map((c) => c.close);
  const closesAsc = [...closes].reverse();
  const rsiArr = rsi(closesAsc, 14);
  if (rsiArr.length < 4) return { pass: false };

  // 현재 RSI ≥ 50 (과매도 탈출 + 중립 회복)
  const rsiNow = rsiArr[rsiArr.length - 1];
  if (rsiNow < 50) return { pass: false };

  // 최근 3캔들 내 RSI ≤ 30 이력 (과매도 구간 통과 확인)
  const recentRsi = rsiArr.slice(-4, -1); // 3캔들 이전 (ascending output → latest at end)
  const hadOversold = recentRsi.some((r) => r <= 30);
  if (!hadOversold) return { pass: false };

  // 종가 > 5MA (상승 모멘텀 확인) — descending: index 0 = latest
  const sma5Arr = sma(closes, 5);
  const sma20Arr = sma(closes, 20);
  if (sma5Arr.length === 0 || sma20Arr.length === 0) return { pass: false };

  const sma5Now = sma5Arr[0];
  const currentPrice = closes[0];
  if (currentPrice <= sma5Now) return { pass: false };

  // 최근 5캔들 내 20MA 터치 (저가 ≤ 20MA × 1.03)
  const sma20Now = sma20Arr[0];
  const recent5 = candles.slice(0, 5);
  const touched20MA = recent5.some((c) => c.low <= sma20Now * 1.03);
  if (!touched20MA) return { pass: false };

  // SL: 5MA 바로 아래
  const sl = sma5Now * 0.995;

  return { pass: true, sl };
}

/**
 * Condition C: 주도주 필터
 * — 거래대금 ≥ 150억원 OR 60일 신고가 이력
 */
function checkConditionC(candles: DailyCandle[], tradingValue: number): boolean {
  // 거래대금 150억 이상
  if (tradingValue >= 15_000_000_000) return true;

  // 60일 신고가 이력 (최근 10일 내) — descending: index 0 = newest
  if (candles.length >= 62) {
    const highs = candles.map((c) => c.high);
    const lookback60 = highs.slice(2, 62);
    const high60 = Math.max(...lookback60);
    const recentHighs = highs.slice(0, 10);
    if (recentHighs.some((h) => h >= high60 * 0.99)) return true;
  }

  return false;
}

/**
 * 스마트 재진입 체크 (동기 함수 — isHardBlocked 동기 유지)
 *
 * @param lossRecord 해당 종목의 손실 이력 (optional — 수익 익절 후 재진입도 지원)
 * @param candles 일봉 차트 데이터
 * @param tradingValue 거래대금 (volume × price)
 * @returns 재진입 허용 여부 + 사유 + SL 제안
 */
export function checkSmartReentry(
  lossRecord: LossRecord | null | undefined,
  candles: DailyCandle[] | undefined,
  tradingValue: number,
): SmartReentryResult {
  if (!candles || candles.length < 25) {
    return { allowed: false, reason: '차트 데이터 부족' };
  }

  // Condition C (주도주) 먼저 체크 — 실패하면 A/B/D 볼 필요 없음
  const passC = checkConditionC(candles, tradingValue);
  if (!passC) {
    return { allowed: false, reason: '주도주 필터 미달 (거래대금<150억, 60일 신고가 없음)' };
  }

  // Condition A (차트박사 5일선 relaxed)
  const condA = checkConditionA(candles);

  // Condition B (피보나치 반등)
  const condB = checkConditionB(candles);

  // Condition D (RSI 꺾인 포인트 — 과매도 탈출 + 5MA 안착)
  const condD = checkConditionD(candles);

  // (A OR B OR D) AND C
  if (!condA.pass && !condB.pass && !condD.pass) {
    return { allowed: false, reason: '기술적 조건 미충족 (5MA/피보나치/RSI꺾임 모두 미달)' };
  }

  // SL 결정: 통과 조건 중 가장 타이트한 (높은) SL
  const passedSls = [
    condA.pass ? condA.sl : undefined,
    condB.pass ? condB.sl : undefined,
    condD.pass ? condD.sl : undefined,
  ].filter((v): v is number => v !== undefined);

  const sl = passedSls.length > 0 ? Math.max(...passedSls) : undefined;

  const passedConds = [condA.pass && '5MA', condB.pass && 'Fib', condD.pass && 'RSI꺾임']
    .filter(Boolean)
    .join('+');

  const contextStr = lossRecord
    ? `이전손실${lossRecord.lossPct.toFixed(1)}% →`
    : '익절후재진입 →';

  return {
    allowed: true,
    reason: `스마트재진입(${passedConds}): ${contextStr} 기술적 반등 확인`,
    suggestedSl: sl,
  };
}
