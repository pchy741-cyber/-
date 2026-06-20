/**
 * VIX 레짐 감지 + 파라미터 자동 전환
 * 연구 근거: VolatilityBox 2025
 */

export type VixRegime = 'CALM' | 'STRESS' | 'CRISIS';

export interface RegimeAdjustment {
  regime: VixRegime;
  confBoost: number; // AI confidence threshold 조정 (+0.05 = 더 보수적)
  sizingMult: number; // 포지션 사이즈 배율 (0.5 = 반감)
  allowNewBuy: boolean; // 신규 매수 허용 여부
  trailTighten: number; // 트레일링 스톱 타이트닝 (고점 수익 보호)
}

// 히스테리시스: VIX 경계에서 떨림 방지 (2포인트 데드밴드)
let _prevRegime: VixRegime = 'CALM';

export function getVixRegime(vix: number): RegimeAdjustment {
  // 히스테리시스: 현재 레짐에서 벗어나려면 경계값 + 데드밴드를 넘어야 함
  const crisisEntry = 30, crisisExit = 27;
  const stressEntry = 20, stressExit = 18;

  let regime: VixRegime;
  if (_prevRegime === 'CRISIS') {
    regime = vix >= crisisExit ? 'CRISIS' : vix >= stressEntry ? 'STRESS' : 'CALM';
  } else if (_prevRegime === 'STRESS') {
    regime = vix >= crisisEntry ? 'CRISIS' : vix >= stressExit ? 'STRESS' : 'CALM';
  } else {
    regime = vix >= crisisEntry ? 'CRISIS' : vix >= stressEntry ? 'STRESS' : 'CALM';
  }
  _prevRegime = regime;

  if (regime === 'CRISIS') {
    return {
      regime: 'CRISIS',
      confBoost: 0.1,
      sizingMult: 0.3,
      allowNewBuy: true,
      trailTighten: 2.0,
    };
  }
  if (regime === 'STRESS') {
    return {
      regime: 'STRESS',
      confBoost: 0.03,
      sizingMult: 0.8,
      allowNewBuy: true,
      trailTighten: 1.0,
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
