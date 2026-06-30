/**
 * 승률 기반 live 매매 차단 가드
 * 국내/해외 각각 최근 14일 live 거래 승률 < 60% 시 live 실행 차단
 * 30분 인메모리 캐시 (3분 스케줄러 반복 쿼리 방지)
 */
import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

const MIN_SAMPLE = 5;        // 최소 샘플 미달 시 체크 스킵 (통과)
const CACHE_TTL_MS = 30 * 60 * 1000; // 30분 캐시

interface WinRateSnapshot {
  winRate: number;
  total: number;
  expiresAt: number;
}

const _cache: { kr: WinRateSnapshot | null; os: WinRateSnapshot | null } = {
  kr: null,
  os: null,
};

async function fetchKrWinRate(): Promise<{ winRate: number; total: number }> {
  const { rows } = await getPool().query<{ total: number; wins: number }>(`
    SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN pnl_pct > 0.4 THEN 1 ELSE 0 END)::int AS wins
    FROM transaction_chains
    WHERE is_paper = false
      AND status = 'CLOSED'
      AND closed_at >= NOW() - INTERVAL '14 days'
      AND pnl_pct IS NOT NULL
  `);
  const { total, wins } = rows[0] ?? { total: 0, wins: 0 };
  const winRate = total > 0 ? wins / total : 0;
  return { winRate, total };
}

async function fetchOsWinRate(): Promise<{ winRate: number; total: number }> {
  const { rows } = await getPool().query<{ total: number; wins: number }>(`
    SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN realized_pnl_pct > 0.4 THEN 1 ELSE 0 END)::int AS wins
    FROM (
      SELECT
        ((filled_price - (regexp_match(ai_reasoning, '\\[avgBuy:([0-9]+\\.?[0-9]*)\\]'))[1]::numeric)
          / NULLIF((regexp_match(ai_reasoning, '\\[avgBuy:([0-9]+\\.?[0-9]*)\\]'))[1]::numeric, 0) * 100
        ) AS realized_pnl_pct
      FROM orders
      WHERE trading_mode = 'live'
        AND side = 'SELL' AND status = 'FILLED'
        AND trigger_source = 'OVERSEAS'
        AND created_at >= NOW() - INTERVAL '14 days'
        AND filled_price IS NOT NULL
        AND (regexp_match(ai_reasoning, '\\[avgBuy:([0-9]+\\.?[0-9]*)\\]'))[1] IS NOT NULL
    ) t
  `);
  const { total, wins } = rows[0] ?? { total: 0, wins: 0 };
  const winRate = total > 0 ? wins / total : 0;
  return { winRate, total };
}

export async function isKrWinRateBelowThreshold(threshold = 0.60): Promise<boolean> {
  try {
    const now = Date.now();
    if (!_cache.kr || _cache.kr.expiresAt < now) {
      const data = await fetchKrWinRate();
      _cache.kr = { ...data, expiresAt: now + CACHE_TTL_MS };
    }
    const { winRate, total } = _cache.kr;
    if (total < MIN_SAMPLE) {
      logger.debug(`국내 승률 체크 스킵 — 샘플 ${total}건 (최소 ${MIN_SAMPLE}건 미달)`, { component: 'WIN_RATE_GUARD' });
      return false;
    }
    const blocked = winRate < threshold;
    if (blocked) {
      logger.warn(
        `⛔ 국내 승률 ${(winRate * 100).toFixed(1)}% < ${(threshold * 100).toFixed(0)}% (14일 ${total}건) → live 차단`,
        { component: 'WIN_RATE_GUARD' },
      );
    }
    return blocked;
  } catch (e) {
    logger.warn(`국내 승률 조회 실패 → 차단 스킵: ${e}`, { component: 'WIN_RATE_GUARD' });
    return false;
  }
}

export async function isOsWinRateBelowThreshold(threshold = 0.60): Promise<boolean> {
  try {
    const now = Date.now();
    if (!_cache.os || _cache.os.expiresAt < now) {
      const data = await fetchOsWinRate();
      _cache.os = { ...data, expiresAt: now + CACHE_TTL_MS };
    }
    const { winRate, total } = _cache.os;
    if (total < MIN_SAMPLE) {
      logger.debug(`해외 승률 체크 스킵 — 샘플 ${total}건 (최소 ${MIN_SAMPLE}건 미달)`, { component: 'WIN_RATE_GUARD' });
      return false;
    }
    const blocked = winRate < threshold;
    if (blocked) {
      logger.warn(
        `⛔ 해외 승률 ${(winRate * 100).toFixed(1)}% < ${(threshold * 100).toFixed(0)}% (14일 ${total}건) → live 차단`,
        { component: 'WIN_RATE_GUARD' },
      );
    }
    return blocked;
  } catch (e) {
    logger.warn(`해외 승률 조회 실패 → 차단 스킵: ${e}`, { component: 'WIN_RATE_GUARD' });
    return false;
  }
}
