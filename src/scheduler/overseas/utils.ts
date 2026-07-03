/**
 * overseas 공통 유틸리티 — 중복 제거용 단일 정의
 * 핵심 함수는 shared/overseas/position-utils.ts로 이동 — 하위호환 re-export
 */
import { getPool } from '../../db/client.js';
import { WATCHLIST_BY_CODE } from '../../shared/overseas/watchlist.js';

// ── 하위호환 re-export ──
export { ctxMode, modePrefix, calcPnlPct, positionStateKeys } from '../../shared/overseas/position-utils.js';

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

/** overseas_state KV 삭제 (내부 전용) */
async function deleteOverseasState(key: string): Promise<void> {
  await getPool().query('DELETE FROM overseas_state WHERE key = $1', [key]);
}

// ── 즐겨찾기 / 블랙리스트 ──

/** 사용자 즐겨찾기 종목 목록 (mode-independent — 통합 관리) */
export async function getUserFavorites(): Promise<Set<string>> {
  const raw = await getOverseasState('user_favorites');
  return new Set(raw ? (JSON.parse(raw) as string[]) : []);
}

const CEO_DEFAULT_BLACKLIST = new Set<string>();

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
  return !wasActive;
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
