/**
 * 볼린저밴드 스퀴즈 패턴 감지 + 매수 신호
 * 스퀴즈 해소 후 상단 돌파 시 매수 기회 포착
 */
import { logger } from '../../utils/logger.js';
import type { TechResult } from './sell-logic.js';

// ── 타입 ──

export interface SqueezeSignal {
  code: string;
  squeezeLength: number; // 스퀴즈 지속 일수 (감지 시점 기준 1)
  breakoutDirection: 'UP' | 'DOWN' | 'NONE';
  volumeSurge: boolean; // 거래량 급증 여부
  strength: number; // 0~1 신호 강도
}

// ── 메인 ──

/**
 * TechResult 배열에서 스퀴즈 해소 + 상단 돌파 종목 감지
 * - bollingerSqueeze === true && bollingerBreakout === 'UP' → 스퀴즈 해소 상단 돌파
 * - strength >= 0.6 필터링
 */
export function detectSqueezeBreakouts(techResults: TechResult[]): SqueezeSignal[] {
  const signals: SqueezeSignal[] = [];

  for (const tr of techResults) {
    // 스퀴즈 상태에서 상단 돌파가 아니면 스킵
    if (!tr.bollingerSqueeze || tr.bollingerBreakout !== 'UP') continue;

    // 거래량 급증: 모멘텀 또는 당일 변동률 양수
    const volumeSurge = tr.isMomentum || tr.price.changePct > 0;

    // 강도 계산: 기본 0.5 + 조건별 보너스
    let strength = 0.5;
    if (volumeSurge) strength += 0.2;
    if (tr.adx >= 20) strength += 0.15;
    if (tr.score >= 25) strength += 0.15;

    // 최소 강도 필터
    if (strength < 0.6) continue;

    signals.push({
      code: tr.code,
      squeezeLength: 1, // 실시간 감지 시점 기준
      breakoutDirection: 'UP',
      volumeSurge,
      strength: Math.min(strength, 1),
    });
  }

  if (signals.length > 0) {
    logger.info(
      `[Squeeze] ${signals.length}개 스퀴즈 돌파 감지: ${signals.map((s) => `${s.code}(${s.strength.toFixed(2)})`).join(', ')}`,
    );
  }

  return signals;
}
