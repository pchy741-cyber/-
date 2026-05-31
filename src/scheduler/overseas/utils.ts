/**
 * overseas 공통 유틸리티 — 중복 제거용 단일 정의
 * ctxMode, modePrefix, calcPnlPct, getSector, overseas_state KV
 */
import { getCtxIsPaper } from '../../config/context.js';
import { getPool } from '../../db/client.js';
import { GLOBAL_WATCHLIST } from './watchlist.js';

/** 현재 컨텍스트의 trading_mode 문자열 반환 */
export function ctxMode(isPaper?: boolean): string {
  return (isPaper ?? getCtxIsPaper()) ? 'paper' : 'live';
}

/** paper/live 분리 state key 접두사 */
export function modePrefix(isPaper?: boolean): string {
  return (isPaper ?? getCtxIsPaper()) ? 'p_' : 'l_';
}

/** PnL% 계산 */
export function calcPnlPct(currentPrice: number, avgPrice: number): number {
  if (avgPrice <= 0) return 0;
  return ((currentPrice - avgPrice) / avgPrice) * 100;
}

/** 종목 코드로 섹터 조회 */
export function getSector(code: string): string {
  return GLOBAL_WATCHLIST.find(w => w.code === code)?.sector ?? '';
}

/** overseas_state KV 저장 (upsert) */
export async function setOverseasState(key: string, value: string): Promise<void> {
  await getPool().query(
    `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, value],
  );
}

/** overseas_state KV 조회 */
export async function getOverseasState(key: string): Promise<string | null> {
  const { rows } = await getPool().query(
    'SELECT value FROM overseas_state WHERE key = $1', [key],
  );
  return rows.length > 0 ? String(rows[0].value) : null;
}

/** overseas_state KV 삭제 */
export async function deleteOverseasState(key: string): Promise<void> {
  await getPool().query('DELETE FROM overseas_state WHERE key = $1', [key]);
}
