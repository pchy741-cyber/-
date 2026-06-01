/**
 * VIX 레짐 감지 + 파라미터 자동 전환
 * 연구 근거: VolatilityBox 2025
 */

export type VixRegime = 'CALM' | 'STRESS' | 'CRISIS';

export interface RegimeAdjustment {
  regime: VixRegime;
  confBoost: number;       // AI confidence threshold 조정 (+0.05 = 더 보수적)
  sizingMult: number;       // 포지션 사이즈 배율 (0.5 = 반감)
  allowNewBuy: boolean;     // 신규 매수 허용 여부
  trailTighten: number;     // 트레일링 스톱 타이트닝 (고점 수익 보호)
}

export function getVixRegime(vix: number): RegimeAdjustment {
  if (vix >= 30) {
    return {
      regime: 'CRISIS',
      confBoost: 0.10,    // AI threshold +10%p → 극고확신만 진입
      sizingMult: 0.3,    // 포지션 30%로 축소
      allowNewBuy: false,  // 신규 매수 금지
      trailTighten: 2.0,  // 트레일 2%p 타이트닝
    };
  }
  if (vix >= 20) {
    return {
      regime: 'STRESS',
      confBoost: 0.05,    // AI threshold +5%p
      sizingMult: 0.80,   // 포지션 80%로 유지 (기존 60% → VIX 20-30은 일상적)
      allowNewBuy: true,
      trailTighten: 1.0,  // 트레일 1%p 타이트닝
    };
  }
  return {
    regime: 'CALM',
    confBoost: 0,
    sizingMult: 1.0,
    allowNewBuy: true,
    trailTighten: 0,
  };
}
