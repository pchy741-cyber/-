/**
 * DB 기반 보유종목·현금·트레일링 상태 관리 — barrel re-export
 * 서버 재시작해도 유지되는 영속 상태
 *
 * 통합증거금 모드:
 *   - Live: KIS API가 원화 기반 주문가능금액 반환 (별도 USD 풀 불필요)
 *   - Paper: orders 테이블에서 결정론적 계산 (상태 오염 불가능)
 */

export * from './state-holdings.js';
export * from './state-cash.js';
export * from './state-tpsl.js';
export * from './state-trade.js';
export * from './state-refill.js';
export * from './state-bucket.js';

// ── paper-cash re-export (하위호환) ──
export { computePaperCash, getEffectivePaperSeedKrw, getPaperSeedKrw, PAPER_OVERSEAS_SEED_KRW } from '../../shared/overseas/paper-cash.js';
