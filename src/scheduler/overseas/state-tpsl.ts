/**
 * 해외 TP/SL & 최고가 추적 — state.ts에서 분리
 */
import { cacheGet, cacheSet } from '../../cache/memory.js';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { modePrefix } from './utils.js';

// ── 트레일링 스탑용 최고가 추적 (paper/live 분리, 메모리 캐시 적용) ──
export async function getMaxPrice(code: string, isPaper?: boolean): Promise<number> {
  const cacheKey = `ov_maxprice:${modePrefix(isPaper)}${code}`;
  const cached = cacheGet<number>(cacheKey);
  if (cached != null) return cached;
  try {
    const { rows } = await getPool().query('SELECT value FROM overseas_state WHERE key = $1', [
      `${modePrefix(isPaper)}maxprice_${code}`,
    ]);
    const raw = rows.length > 0 ? Number(rows[0].value) : 0;
    const val = Number.isFinite(raw) ? raw : 0;
    if (val > 0) cacheSet(cacheKey, val, 300); // 5min TTL
    return val;
  } catch (e) {
    logger.warn(`getMaxPrice 조회 실패 (${code}): ${(e as Error).message}`, { component: 'OVERSEAS' });
    return 0;
  }
}

export async function setMaxPrice(code: string, price: number, isPaper?: boolean): Promise<void> {
  const cacheKey = `ov_maxprice:${modePrefix(isPaper)}${code}`;
  cacheSet(cacheKey, price, 300); // 캐시 즉시 갱신
  const dbKey = `${modePrefix(isPaper)}maxprice_${code}`;
  const sql = `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`;
  try {
    await getPool().query(sql, [dbKey, price.toString()]);
  } catch (e1) {
    // 1회 재시도 (트레일링 스탑 핵심 데이터 — 유실 시 손절 오작동)
    logger.warn(`setMaxPrice DB 실패 (${code}=$${price}), 1회 재시도: ${(e1 as Error).message}`, { component: 'OVERSEAS' });
    try {
      await getPool().query(sql, [dbKey, price.toString()]);
    } catch (e2) {
      logger.error(`🚨 setMaxPrice DB 최종 실패 (${code}=$${price}): ${(e2 as Error).message} — 트레일링 스탑 정확도 저하 위험`, { component: 'OVERSEAS' });
    }
  }
}

export async function clearMaxPrice(code: string, isPaper?: boolean): Promise<void> {
  await getPool()
    .query('DELETE FROM overseas_state WHERE key = $1', [`${modePrefix(isPaper)}maxprice_${code}`])
    .catch(() => {});
}

/** 동적 TP/SL 저장 — 매매 엔진이 계산한 실시간 값을 대시보드에 동기화 */
export async function saveDynamicTpSl(code: string, tpPct: number, slPct: number, isPaper?: boolean): Promise<void> {
  const pfx = modePrefix(isPaper);
  const val = JSON.stringify({ tp: tpPct, sl: slPct, at: Date.now() });
  await getPool()
    .query(
      `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
      [`${pfx}dynamic_tpsl_${code}`, val],
    )
    .catch(() => {});
}

/** 동적 TP/SL 조회 — 대시보드에서 사용 */
export async function getDynamicTpSl(
  codes: string[],
  isPaper?: boolean,
): Promise<Map<string, { tp: number; sl: number }>> {
  const pfx = modePrefix(isPaper);
  const keys = codes.map((c) => `${pfx}dynamic_tpsl_${c}`);
  const map = new Map<string, { tp: number; sl: number }>();
  if (keys.length === 0) return map;
  try {
    const { rows } = await getPool().query('SELECT key, value FROM overseas_state WHERE key = ANY($1)', [keys]);
    for (const r of rows) {
      const code = String(r.key).replace(`${pfx}dynamic_tpsl_`, '');
      try {
        const v = JSON.parse(r.value);
        const tp = Number(v.tp);
        const sl = Number(v.sl);
        if (Number.isFinite(tp) && Number.isFinite(sl)) {
          map.set(code, { tp, sl });
        }
      } catch {
        /* skip invalid JSON — non-critical */
      }
    }
  } catch (e) {
    logger.warn(`동적 TP/SL 조회 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
  return map;
}

/** 동적 TP/SL 삭제 (포지션 청산 시) */
export async function clearDynamicTpSl(code: string, isPaper?: boolean): Promise<void> {
  await getPool()
    .query('DELETE FROM overseas_state WHERE key = $1', [`${modePrefix(isPaper)}dynamic_tpsl_${code}`])
    .catch(() => {});
}
