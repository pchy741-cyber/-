/**
 * Tier 5: 시퀀스 패턴 분석
 *
 * 5일간 RSI/Volume/MACD 시계열 방향성 감지하여 보너스 점수 산출.
 * 데이터: data-loader.ts가 이미 30일 캔들 로딩 → 별도 API 호출 없음.
 *
 * 보너스 범위: -8 ~ +8점
 */

import type { DailyCandle } from '../kis/market.js';
import { rsi, macd } from './oscillators.js';

export interface SequencePatternResult {
  bonus: number;
  details: string[];
}

/**
 * 5일간 시계열 방향성 분석
 *
 * @param candles 일봉 배열 (최신순 정렬, candles[0] = 오늘)
 * @returns bonus 점수 (-8 ~ +8) 및 상세 정보
 */
export function analyzeSequencePatterns(candles: DailyCandle[]): SequencePatternResult {
  // 최소 7일 데이터 필요 (5일 분석 + RSI/MACD 계산용 여유)
  if (candles.length < 20) {
    return { bonus: 0, details: [] };
  }

  // 오름차순 (과거 → 최근) 변환
  const sorted = [...candles].reverse();
  const closes = sorted.map((c) => c.close);
  const volumes = sorted.map((c) => c.volume);

  let bonus = 0;
  const details: string[] = [];

  // ── RSI 기울기 분석 (최근 5일) ──
  const rsiValues = rsi(closes, 14);
  if (rsiValues.length >= 5) {
    const recent5Rsi = rsiValues.slice(-5);
    const rsiSlope = linearSlope(recent5Rsi);

    if (rsiSlope > 2.0) {
      bonus += 5;
      details.push(`RSI↑ (기울기 ${rsiSlope.toFixed(1)}/일)`);
    } else if (rsiSlope < -2.0) {
      bonus -= 5;
      details.push(`RSI↓ (기울기 ${rsiSlope.toFixed(1)}/일)`);
    }
  }

  // ── 거래량 3일+ 연속 증가 ──
  if (volumes.length >= 4) {
    const recentVols = volumes.slice(-4); // 최근 4일 (3구간 비교)
    let consecutiveUp = 0;
    for (let i = 1; i < recentVols.length; i++) {
      if (recentVols[i] > recentVols[i - 1] * 1.05) {
        consecutiveUp++;
      } else {
        consecutiveUp = 0;
      }
    }
    if (consecutiveUp >= 3) {
      bonus += 3;
      details.push(`거래량 ${consecutiveUp}일 연속↑`);
    }
  }

  // ── MACD 히스토그램 0 수렴 중 (반전 임박) ──
  const macdResult = macd(closes);
  if (macdResult.histogram.length >= 3) {
    const recentHist = macdResult.histogram.slice(-3);
    const allNearZero = recentHist.every((h) => Math.abs(h) < 0.5);
    const converging =
      recentHist.length >= 2 &&
      Math.abs(recentHist[recentHist.length - 1]) < Math.abs(recentHist[0]);

    if (allNearZero && converging) {
      bonus += 3;
      details.push('MACD 0선 수렴 (반전 임박)');
    }
  }

  // 범위 클램핑: -8 ~ +8
  bonus = Math.max(-8, Math.min(8, bonus));

  return { bonus, details };
}

/** 선형 회귀 기울기 (단위: 1일당 변화량) */
function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;

  return (n * sumXY - sumX * sumY) / denom;
}
