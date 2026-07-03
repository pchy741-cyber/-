/**
 * Tier 3: 적응형 시그모이드 필터
 *
 * 기존 이진 게이트(4/6 pass) 위에 시그모이드 오버레이.
 * RSI, Volume, Trend, Momentum 각각에 시그모이드 함수를 적용하여
 * confluencyScore (0~1.0) 산출.
 *
 * 판단: max(기존_게이트_통과, confluencyScore > 0.55)
 * → 기존 이진 게이트를 제거하지 않음. 둘 중 하나만 통과해도 진입.
 */

import type { TechnicalSummary } from '../../../analysis/indicators.js';

export interface AdaptiveScoringResult {
  confluencyScore: number;
  passed: boolean;
  details: {
    rsiScore: number;
    volumeScore: number;
    trendScore: number;
    momentumScore: number;
  };
}

/** 시그모이드 함수: center를 기준으로 0~1 매핑 */
function sigmoid(x: number, center: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * (x - center)));
}

/**
 * 적응형 시그모이드 스코어 계산
 *
 * @param tech 기술적 분석 결과
 * @param adjustedVolRatio 시간대 보정된 거래량 비율
 * @returns confluencyScore (0~1.0) 및 통과 여부
 */
export function computeAdaptiveScore(
  tech: TechnicalSummary,
  adjustedVolRatio: number,
): AdaptiveScoringResult {
  // ── RSI 시그모이드 ──
  // RSI 30~45에서 고점수 (과매도 반등 영역), RSI 70+에서 저점수
  // sigmoid(55 - rsi, 0, 0.12) → RSI가 낮을수록 높은 값
  const rsiScore = sigmoid(55 - tech.rsi14, 0, 0.12);

  // ── Volume 시그모이드 ──
  // 적정 거래량(1.0~2.0x)에서 고점수, 5x+ 폭증에서 급감
  // sigmoid(vol, 1.0, 0.5) 기반, 5x+ 패널티 적용
  let volumeScore = sigmoid(adjustedVolRatio, 1.0, 0.5);
  if (adjustedVolRatio >= 5.0) {
    volumeScore *= 0.3; // 극단 폭증 패널티
  } else if (adjustedVolRatio >= 3.5) {
    volumeScore *= 0.5;
  }
  // 거래량 고갈 패널티
  if (adjustedVolRatio < 0.5) {
    volumeScore *= 0.4;
  }

  // ── Trend 점수 ──
  // SMA 정렬도 (SMA5>20 +0.3, SMA20>60 +0.3, 비약세 +0.4)
  let trendScore = 0;
  if (tech.sma5 > tech.sma20) trendScore += 0.3;
  if (tech.sma20 > tech.sma60) trendScore += 0.3;
  if (tech.trendStrength !== 'WEAK') trendScore += 0.4;

  // ── Momentum 시그모이드 ──
  // MACD 히스토그램 기반: 양수 = 상승 모멘텀
  const macdHist = tech.macdHistogram;
  const momentumScore = sigmoid(macdHist, 0, 2.0);

  // ── 가중 합산 ──
  // RSI 30%, Volume 20%, Trend 25%, Momentum 25%
  const confluencyScore =
    rsiScore * 0.30 +
    volumeScore * 0.20 +
    trendScore * 0.25 +
    momentumScore * 0.25;

  return {
    confluencyScore,
    passed: confluencyScore > 0.55,
    details: {
      rsiScore: Math.round(rsiScore * 100) / 100,
      volumeScore: Math.round(volumeScore * 100) / 100,
      trendScore: Math.round(trendScore * 100) / 100,
      momentumScore: Math.round(momentumScore * 100) / 100,
    },
  };
}
