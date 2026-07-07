/**
 * 🎯 Innovation #3: Smart Confidence-Based Position Sizing (통합 사이저)
 *
 * 산재된 사이징 로직을 통합하여 일관된 포지션 크기 결정
 * confidence, winRate, ATR, regime, EV, macro, streak 모두 반영
 */

import type { RegimeV2 } from './regime-v2.js';
import { logger } from '../../utils/logger.js';

export interface UnifiedSizerInput {
  /** 기본 배분 비율 (0~1, 예: 0.15 = 15%) */
  basePct: number;
  /** AI/기술 점수 기반 신뢰도 (0~1) */
  confidence: number;
  /** 종목별 승률 (0~1, 없으면 undefined) */
  winRate?: number;
  /** 승률 샘플 수 */
  winRateSamples?: number;
  /** ATR 변동성 % */
  atrPct?: number;
  /** 현재 레짐 */
  regime?: RegimeV2;
  /** EV 배율 (기존 evMultiplier, 기본 1.0) */
  evScore?: number;
  /** 매크로 사이징 배율 (기본 1.0) */
  macroScore?: number;
  /** 연속 승/패 (양수=연승, 음수=연패) */
  streak?: number;
  /** 포지션 상한 비율 (기본 0.5) */
  maxPositionPct?: number;
  /** Paper 모드 여부 */
  isPaper?: boolean;
}

export interface UnifiedSizerResult {
  /** 최종 배분 비율 (0~1) */
  positionPct: number;
  /** 적용된 요소 설명 */
  reasoning: string;
}

/**
 * 통합 포지션 사이징 계산
 *
 * 공식: finalPct = basePct × confidenceFactor × winRateFactor × atrInverseFactor
 *                 × regimeScale × evMult × macroMult × streakMult
 *
 * 모든 팩터는 독립적으로 계산 → 곱연산 → clamp
 */
export function computeUnifiedPositionSize(input: UnifiedSizerInput): UnifiedSizerResult {
  const {
    basePct,
    confidence,
    winRate,
    winRateSamples,
    atrPct,
    regime,
    evScore,
    macroScore,
    streak,
    maxPositionPct = 0.5,
    isPaper = false,
  } = input;

  const factors: string[] = [];

  // 1. Confidence Factor: 고확신 → 확대, 저확신 → 축소
  // v28: 0.9→0.85 (해외 AI confidence 캡=0.88이라 0.9 달성 불가 — 최고등급 데드코드 수정)
  const confidenceFactor =
    confidence >= 0.85 ? 1.3 :
    confidence >= 0.75 ? 1.15 :
    confidence >= 0.65 ? 1.0 :
    confidence >= 0.55 ? 0.8 :
    0.5;
  if (confidenceFactor !== 1.0) factors.push(`conf×${confidenceFactor}`);

  // 2. Win Rate Factor: 실적 기반 (최소 3건 이상)
  const hasEnoughSamples = (winRateSamples ?? 0) >= 3;
  const winRateFactor =
    hasEnoughSamples && winRate != null
      ? winRate >= 0.8 ? 1.3 :
        winRate >= 0.65 ? 1.2 :
        winRate >= 0.5 ? 1.0 :
        winRate >= 0.4 ? 0.8 :
        0.7
      : 1.0;
  if (winRateFactor !== 1.0) factors.push(`wr×${winRateFactor}(${((winRate ?? 0) * 100).toFixed(0)}%)`);

  // 3. ATR Inverse Factor: 고변동 → 축소, 저변동 → 기본
  const atrInverseFactor =
    atrPct != null
      ? atrPct >= 5.0 ? 0.6 :
        atrPct >= 3.5 ? 0.8 :
        atrPct >= 2.0 ? 1.0 :
        1.1
      : 1.0;
  if (atrInverseFactor !== 1.0) factors.push(`atr×${atrInverseFactor}(${atrPct?.toFixed(1)}%)`);

  // 4. Regime Scale: 레짐별 포지션 규모 조정
  const regimeScaleMap: Record<RegimeV2, number> = {
    TREND_BULL: 1.3,
    BREAKOUT: 1.15,
    RANGE_LOW_VOL: 1.0,
    RANGE_HIGH_VOL: 0.8,
    TREND_BEAR: 0.6,
    DISTRIBUTION: 0.5,
  };
  const regimeScale = regime ? (regimeScaleMap[regime] ?? 1.0) : 1.0;
  if (regimeScale !== 1.0) factors.push(`reg×${regimeScale}(${regime})`);

  // 5. EV Multiplier: 기대값 기반 (기존 로직 통합)
  const evMult = evScore ?? 1.0;
  if (evMult !== 1.0) factors.push(`ev×${evMult.toFixed(2)}`);

  // 6. Macro Multiplier: 매크로 환경 (RISK_OFF, 하락장 등)
  const macroMult = macroScore ?? 1.0;
  if (macroMult !== 1.0) factors.push(`macro×${macroMult}`);

  // 7. Streak Multiplier: 연승/연패 반영
  const streakMult =
    streak != null
      ? streak <= -3 ? 0.6 :
        streak <= -2 ? 0.7 :
        streak >= 5 ? 1.2 :
        streak >= 3 ? 1.1 :
        1.0
      : 1.0;
  if (streakMult !== 1.0) factors.push(`streak×${streakMult}(${streak})`);

  // 곱연산
  const rawPct = basePct * confidenceFactor * winRateFactor * atrInverseFactor
    * regimeScale * evMult * macroMult * streakMult;

  // 곱연산 바닥: 과도한 축소 방지 (Paper=0.5, Live=0.25 of basePct)
  const floorMult = isPaper ? 0.5 : 0.25;
  const floorPct = basePct * floorMult;

  // Clamp: [1% (최소), maxPositionPct (최대)]
  const positionPct = Math.max(0.01, Math.min(maxPositionPct, Math.max(rawPct, floorPct)));

  const reasoning = factors.length > 0
    ? `UNIFIED_SIZER: base=${(basePct * 100).toFixed(0)}% → ${(positionPct * 100).toFixed(1)}% [${factors.join(' ')}]`
    : `UNIFIED_SIZER: base=${(basePct * 100).toFixed(0)}% → ${(positionPct * 100).toFixed(1)}% (조정 없음)`;

  if (factors.length > 0) {
    logger.info(`📏 ${reasoning}`, { component: 'TRACK_B' });
  }

  return { positionPct, reasoning };
}
