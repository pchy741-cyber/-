/**
 * overseas 공통 유틸리티 — 중복 제거용 단일 정의
 * ctxMode, modePrefix, calcPnlPct, getSector, overseas_state KV
 */
import { getCtxIsPaper } from '../../config/context.js';
import { getPool } from '../../db/client.js';
import { WATCHLIST_BY_CODE } from './watchlist.js';

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
  return WATCHLIST_BY_CODE.get(code)?.sector ?? '';
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
  const { rows } = await getPool().query('SELECT value FROM overseas_state WHERE key = $1', [key]);
  return rows.length > 0 ? String(rows[0].value) : null;
}

/** 포지션 종료 시 정리해야 할 overseas_state 키 배열 반환 */
export function positionStateKeys(code: string, isPaper?: boolean): string[] {
  const pfx = modePrefix(isPaper);
  return [
    `${pfx}maxprice_${code}`,
    `${pfx}partial_tp_stage_${code}`,
    `${pfx}dynamic_tpsl_${code}`,
    `${pfx}scale_in_${code}`,
    `${pfx}turtle_trail_${code}`,
    `${pfx}sync_sell_pending_${code}`,
  ];
}

/** overseas_state KV 삭제 */
export async function deleteOverseasState(key: string): Promise<void> {
  await getPool().query('DELETE FROM overseas_state WHERE key = $1', [key]);
}

// ── 즐겨찾기 / 블랙리스트 ──

/** 사용자 즐겨찾기 종목 목록 (mode-independent — 통합 관리) */
export async function getUserFavorites(): Promise<Set<string>> {
  const raw = await getOverseasState('user_favorites');
  return new Set(raw ? (JSON.parse(raw) as string[]) : []);
}

// CEO 기본 블랙리스트 (코드에서 관리 — 왠만하면 매수 금지 종목)
const CEO_DEFAULT_BLACKLIST = new Set(['META']);

/** 사용자 블랙리스트 종목 목록 (CEO 기본 + DB 저장분 합산) */
export async function getUserBlacklist(): Promise<Set<string>> {
  const raw = await getOverseasState('user_blacklist');
  const dbList = raw ? (JSON.parse(raw) as string[]) : [];
  return new Set([...CEO_DEFAULT_BLACKLIST, ...dbList]);
}

/** 즐겨찾기 토글 */
export async function toggleFavorite(code: string): Promise<boolean> {
  const favs = await getUserFavorites();
  const wasActive = favs.has(code);
  if (wasActive) favs.delete(code);
  else favs.add(code);
  await setOverseasState('user_favorites', JSON.stringify([...favs]));
  return !wasActive; // returns new state
}

/** 블랙리스트 토글 */
export async function toggleBlacklist(code: string): Promise<boolean> {
  const list = await getUserBlacklist();
  const wasActive = list.has(code);
  if (wasActive) list.delete(code);
  else list.add(code);
  await setOverseasState('user_blacklist', JSON.stringify([...list]));
  return !wasActive;
}
