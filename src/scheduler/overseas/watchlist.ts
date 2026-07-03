/**
 * 글로벌 감시 목록 & 유틸리티
 * 데이터 정의는 shared/overseas/watchlist.ts로 이동 — 하위호환 re-export
 */
// ── 데이터 re-export ──
export {
  CORE_WATCHLIST,
  EXTENDED_WATCHLIST,
  GLOBAL_WATCHLIST,
  WATCHLIST_BY_CODE,
  WATCHLIST_BY_CODE_EXCHANGE,
} from '../../shared/overseas/watchlist.js';

import { WATCHLIST_BY_CODE, WATCHLIST_BY_CODE_EXCHANGE } from '../../shared/overseas/watchlist.js';

/** try-catch 래퍼 — 실패 시 null 반환, 오류 무시 */
export async function safely<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export function resolveOverseasStockName(code: string, exchange: string): string {
  return (
    WATCHLIST_BY_CODE_EXCHANGE.get(`${code}:${exchange}`)?.name ??
    WATCHLIST_BY_CODE.get(code)?.name ??
    code
  );
}
