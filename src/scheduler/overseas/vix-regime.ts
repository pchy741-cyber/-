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
// Paper/Live 별도 추적 (runOverseasDual에서 paper→live 순서 실행 시 상태 오염 방지)
const _prevRegimeByMode: Record<string, VixRegime> = { paper: 'CALM', live: 'CALM' };
let _prevRegime: VixRegime = 'CALM'; // 폴백 (isPaper 미전달 시)

export function getVixRegime(vix: number, isPaper?: boolean): RegimeAdjustment {
  const modeKey = isPaper != null ? (isPaper ? 'paper' : 'live') : null;
  const prevRegime = modeKey ? (_prevRegimeByMode[modeKey] ?? 'CALM') : _prevRegime;
  // 히스테리시스: 현재 레짐에서 벗어나려면 경계값 + 데드밴드를 넘어야 함
  const crisisEntry = 30, crisisExit = 27;
  const stressEntry = 20, stressExit = 18;

  let regime: VixRegime;
  if (prevRegime === 'CRISIS') {
    regime = vix >= crisisExit ? 'CRISIS' : vix >= stressEntry ? 'STRESS' : 'CALM';
  } else if (prevRegime === 'STRESS') {
    regime = vix >= crisisEntry ? 'CRISIS' : vix >= stressExit ? 'STRESS' : 'CALM';
  } else {
    regime = vix >= crisisEntry ? 'CRISIS' : vix >= stressEntry ? 'STRESS' : 'CALM';
  }
  // 레짐 변경 알림 (#19)
  if (regime !== prevRegime) {
    import('../../notifications/smart-alerts.js')
      .then((m) => m.checkRegimeChangeAlert(regime, vix, isPaper ?? false))
      .catch(() => {});
  }

  if (modeKey) _prevRegimeByMode[modeKey] = regime;
  _prevRegime = regime;

  if (regime === 'CRISIS') {
    // v12.2: sizingMult 0.3→0.5 (BIS Bulletin 95: VIX 30+ 진입 시 12개월 양수 확률 높음)
    // confBoost 0.10→0.05 (기존 10% 부스트는 거의 모든 매수 차단 → 과보호)
    // VIX 40+: 극단 과매도 영역 — 역사적으로 100% 12개월 양수, 중앙값 +40%
    // 따라서 CRISIS에서 더 적극적으로 매수 (단, 포지션 사이즈로 리스크 관리)
    return {
      regime: 'CRISIS',
      confBoost: 0.05,
      sizingMult: vix >= 40 ? 0.6 : 0.5, // VIX 40+: 패닉 = 기회 (사이징 올림)
      allowNewBuy: true,
      trailTighten: 1.5, // 2.0→1.5 (너무 타이트하면 변동성에 흔들려 조기 익절)
    };
  }
  if (regime === 'STRESS') {
    return {
      regime: 'STRESS',
      confBoost: 0.02, // 0.03→0.02 (미세 완화)
      sizingMult: 0.85, // 0.8→0.85
      allowNewBuy: true,
      trailTighten: 0.8, // 1.0→0.8
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
