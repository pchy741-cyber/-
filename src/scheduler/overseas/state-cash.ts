/**
 * 해외 현금 관리 — state.ts에서 분리
 */
import { fetchExchangeRate } from '../../automation/macro-data.js';
import { getCtxIsPaper } from '../../config/context.js';
import { getPool } from '../../db/client.js';
import { computePaperCash } from '../../shared/overseas/paper-cash.js';
import { logger } from '../../utils/logger.js';

/** paper/live 별 현금 키 */
export function cashKey(isPaper?: boolean): string {
  return (isPaper ?? getCtxIsPaper()) ? 'cash_paper' : 'cash';
}

let _lastTradeAt = 0; // 마지막 매매 시점 (ms) — reconcile 쿨다운용

/** 매매 발생 기록 — reconcileCashWithKIS 쿨다운 트리거 */
export function markTradeExecuted(): void {
  _lastTradeAt = Date.now();
}
/** 마지막 매매 후 경과 시간(ms) */
export function getTimeSinceLastTrade(): number {
  return Date.now() - _lastTradeAt;
}

/**
 * 현금 조회 — USD 반환 (트레이딩 로직용)
 * - Paper: orders 기반 결정론적 계산 (USD)
 * - Live: DB에 KRW 저장 → 환율로 USD 변환 반환
 * @param fxRate 동일 사이클 내 일관된 환율 전달 (미전달 시 자체 조회)
 */
export async function getCash(isPaper?: boolean, fxRate?: number): Promise<number> {
  const paper = isPaper ?? getCtxIsPaper();
  if (paper) {
    return computePaperCash(fxRate);
  }
  // Live: DB에 KRW 저장 → USD로 변환
  const krw = await getCashKrw();
  if (krw <= 0) return 0;
  const rate = fxRate ?? (await fetchExchangeRate());
  return rate > 0 ? krw / rate : 0;
}

/**
 * Live 현금 KRW 직접 조회 (디스플레이/리포트용)
 * overseas_state['cash']에 원화 금액 저장
 */
export async function getCashKrw(): Promise<number> {
  try {
    const { rows } = await getPool().query('SELECT value FROM overseas_state WHERE key = $1', [cashKey(false)]);
    if (rows.length === 0) return 0;
    const val = Number(rows[0].value);
    return Number.isFinite(val) ? val : 0;
  } catch (e) {
    logger.warn(`Live 현금(KRW) 조회 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
    return 0;
  }
}

/** Live 현금 설정 — KRW 단위로 저장 (reconcileCashWithKIS에서 호출) */
export async function setCash(amountKrw: number, isPaper?: boolean): Promise<void> {
  const paper = isPaper ?? getCtxIsPaper();
  if (paper) return; // Paper: computed from orders, no need to store
  const safe = Math.max(0, amountKrw);
  const key = cashKey(false);
  await getPool().query(
    `INSERT INTO overseas_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, safe.toString()],
  );
}
