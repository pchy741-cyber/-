/**
 * 성과 분석 — 승률, 최근 실적, 미체결 주문 조회
 */
import { getCtxIsPaper } from '../../config/context.js';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { ctxMode } from './utils.js';

export interface OverseasExecutionResult {
  submitted: boolean;
  filledQty: number;
  filledPrice: number;
  finalQty: number;
  finalAvgPrice: number;
  orderNo: string;
}

export interface OverseasWinRate {
  winRate: number;
  avgPnlPct: number;
  sampleCount: number;
}

/**
 * 최근 해외 매도 실적 요약 — AI 자기학습용 컨텍스트
 */
export async function getRecentPerfSummary(isPaper?: boolean): Promise<string> {
  try {
    const mode = ctxMode(isPaper);
    const { rows } = await getPool().query(
      `
      SELECT ai_reasoning, filled_price, quantity
      FROM orders
      WHERE trigger_source = 'OVERSEAS'
        AND (trading_mode = $1::text OR ($1::text = 'paper' AND trading_mode = 'p_arch'))
        AND side = 'SELL'
        AND status = 'FILLED'
        AND filled_price IS NOT NULL
        AND created_at >= NOW() - INTERVAL '14 days'
      ORDER BY created_at DESC
      LIMIT 20
    `,
      [mode],
    );
    if (rows.length === 0) return '';

    let wins = 0,
      losses = 0,
      totalPnlPct = 0,
      counted = 0;
    for (const r of rows) {
      const match = String(r.ai_reasoning ?? '').match(/\[avgBuy:([\d.]+)\]/);
      if (!match) continue;
      const avgBuy = Number(match[1]);
      const fillPx = Number(r.filled_price);
      if (avgBuy <= 0 || fillPx <= 0) continue;
      const pnlPct = ((fillPx - avgBuy) / avgBuy) * 100;
      // v23-QA: 왕복 수수료 0.70% 기준 통일 (기존 0.35% 편도 → executor PNL_BREAKEVEN_THRESHOLD=0.75%와 불일치)
      const netPnlPct = pnlPct - 0.70;
      if (netPnlPct > 0) wins++;
      else losses++;
      totalPnlPct += pnlPct;
      counted++;
    }
    if (counted === 0) return '';

    const winRate = ((wins / counted) * 100).toFixed(0);
    const avgPnl = (totalPnlPct / counted).toFixed(2);
    return `최근 ${counted}건 실적: 승률 ${winRate}% (${wins}승 ${losses}패) | 평균 PnL ${Number(avgPnl) >= 0 ? '+' : ''}${avgPnl}%`;
  } catch (e) {
    logger.warn(`실적 요약 조회 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
    return '';
  }
}

export async function getOverseasWinRates(codes: string[], isPaper?: boolean): Promise<Map<string, OverseasWinRate>> {
  const map = new Map<string, OverseasWinRate>();
  if (codes.length === 0) return map;
  try {
    const mode = ctxMode(isPaper);
    const { rows } = await getPool().query(
      `
      SELECT
        stock_code,
        COUNT(*)::int AS total,
        -- v23-QA: > 0.4 → > 0.75 (PNL_BREAKEVEN_THRESHOLD=0.75%와 통일)
        -- 왕복 수수료 0.70% + 슬리피지 감안 → 0.75% 이상만 실질 수익
        SUM(CASE WHEN realized_pnl_pct > 0.75 THEN 1 ELSE 0 END)::int AS wins,
        AVG(realized_pnl_pct)::float AS avg_pnl
      FROM (
        SELECT
          stock_code,
          ((filled_price - (regexp_match(ai_reasoning, '\\[avgBuy:([0-9]+\\.?[0-9]*)\\]'))[1]::numeric)
            / NULLIF((regexp_match(ai_reasoning, '\\[avgBuy:([0-9]+\\.?[0-9]*)\\]'))[1]::numeric, 0) * 100
          ) AS realized_pnl_pct
        FROM orders
        WHERE stock_code = ANY($1)
          AND (trading_mode = $2::text OR ($2::text = 'paper' AND trading_mode = 'p_arch'))
          AND side = 'SELL' AND status = 'FILLED'
          AND trigger_source = 'OVERSEAS'
          AND created_at >= NOW() - INTERVAL '90 days'
          AND filled_price IS NOT NULL
          AND ai_reasoning ~ '\\[avgBuy:[0-9]'
      ) sub
      WHERE realized_pnl_pct IS NOT NULL
      GROUP BY stock_code
      HAVING COUNT(*) >= 2
    `,
      [codes, mode],
    );
    for (const r of rows) {
      const total = Number(r.total);
      const wins = Number(r.wins);
      const avgPnl = Number(r.avg_pnl ?? 0);
      // Guard against NaN from DB parsing
      if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(wins)) continue;
      map.set(String(r.stock_code), {
        winRate: wins / total,
        avgPnlPct: Number.isFinite(avgPnl) ? avgPnl : 0,
        sampleCount: total,
      });
    }
  } catch (e) {
    logger.warn(`해외 승률 조회 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
  return map;
}

export async function getPendingOverseasStocks(isPaper?: boolean): Promise<Set<string>> {
  const mode = (isPaper ?? getCtxIsPaper()) ? 'paper' : 'live';
  const pending = new Set<string>();
  try {
    const { rows } = await getPool().query(
      `SELECT DISTINCT stock_code
       FROM orders
       WHERE trigger_source = 'OVERSEAS'
         AND trading_mode = $1
         AND status = 'PENDING'
         AND created_at >= NOW() - INTERVAL '1 day'`,
      [mode],
    );
    for (const row of rows) {
      if (row.stock_code) pending.add(String(row.stock_code));
    }
  } catch (e) {
    logger.warn(`미체결 주문 조회 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
  return pending;
}
