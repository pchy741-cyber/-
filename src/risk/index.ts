/**
 * risk/index.ts — 리스크 모듈 배럴
 *
 * 외부에서는 이 파일만 import:
 *   import { riskEngine, getPaperBalance, ... } from '../risk/index.js'
 *
 * 내부 파일 역할:
 *   risk-engine.ts  — 주문 전 리스크 검증 (포지션 한도, 일일 손실 한도)
 *   paper-balance.ts — Paper 모드 현금 관리 (결정론적 계산)
 *   paper.ts        — Paper 주문 실행 어댑터
 *   kill-switch.ts  — 긴급 정지 스위치 (KR / OVERSEAS 독립 스코프)
 *   seed-capital.ts — 시드 자본 & 일일 손실 한도
 *   trade-gate.ts   — 거래 품질 게이트 (기술적 검수 + 쿨다운)
 */

export type { KillSwitchScope } from './kill-switch.js';
// 킬스위치
export {
  activateKillSwitch,
  activateKillSwitchAll,
  deactivateKillSwitch,
  deactivateKillSwitchAll,
  getKillSwitchStatus,
  getKillSwitchStatusAll,
  isKillSwitchActive,
} from './kill-switch.js';

// Paper 잔고
export {
  addPaperInvestment,
  getPaperBalance,
  PAPER_INITIAL_CAPITAL,
  removePaperInvestment,
  restorePaperState,
} from './paper-balance.js';
export type { PreTradeCheckResult } from './risk-engine.js';
// 리스크 엔진
export { RiskEngine, riskEngine } from './risk-engine.js';

// 시드 자본
export { getSeedCapitalStatus, setSeedCapital } from './seed-capital.js';
export type { GateInput, GateResult } from './trade-gate.js';
// 트레이드 게이트
export { getCooldownStatus, resetCooldown, runTradeGates } from './trade-gate.js';
