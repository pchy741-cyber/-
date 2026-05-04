import { Hono } from 'hono';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';

export const journalRoutes = new Hono();

interface JournalTrade {
  market: 'KR' | 'US';
  code: string;
  name: string;
  pnlPct: number;
  pnlAmount: number;    // KRW (KR) 또는 USD (US)
  entryPrice: number;
  exitPrice: number;
  openedAt: string;
  closedAt: string;
  holdingDays: number;
  closeReason: string;
  strategyMode?: string;
}

/**
 * GET /journal?days=30
 * 국내(KR) + 해외(US) 완결 매매 통합 조회
 */
journalRoutes.get('/journal', async (c) => {
  const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? 30)));
  const pool = getPool();
  const trades: JournalTrade[] = [];

  try {
    // ── 국내 종결 체인 (transaction_chains) ──
    const { rows: krRows } = await pool.query(`
      SELECT
        tc.stock_code,
        w.stock_name,
        tc.avg_buy_price,
        tc.total_invested,
        tc.realized_pnl,
        tc.strategy_mode,
        tc.opened_at,
        tc.closed_at,
        tc.close_reason,
        -- 매도 시세: CLOSED 체인의 마지막 SELL 주문 평균가
        (
          SELECT AVG(o.filled_price)
          FROM orders o
          WHERE o.chain_id = tc.id
            AND o.side = 'SELL'
            AND o.status = 'FILLED'
            AND o.filled_price IS NOT NULL
        ) AS exit_price
      FROM transaction_chains tc
      LEFT JOIN watchlist w ON w.stock_code = tc.stock_code
      WHERE tc.status = 'CLOSED'
        AND tc.closed_at >= NOW() - ($1 || ' days')::interval
        AND tc.realized_pnl IS NOT NULL
      ORDER BY tc.closed_at DESC
      LIMIT 200
    `, [days]);

    for (const r of krRows) {
      const entryPrice = Number(r.avg_buy_price ?? 0);
      const exitPrice = Number(r.exit_price ?? 0);
      const pnlAmount = Number(r.realized_pnl ?? 0);
      const invested = Number(r.total_invested ?? 0);
      const pnlPct = invested > 0 ? (pnlAmount / invested) * 100 : 0;
      const openedAt = r.opened_at ? new Date(r.opened_at).toISOString() : '';
      const closedAt = r.closed_at ? new Date(r.closed_at).toISOString() : '';
      const holdingDays = openedAt && closedAt
        ? (new Date(closedAt).getTime() - new Date(openedAt).getTime()) / 86_400_000
        : 0;

      trades.push({
        market: 'KR',
        code: String(r.stock_code),
        name: String(r.stock_name ?? r.stock_code),
        pnlPct: Math.round(pnlPct * 100) / 100,
        pnlAmount: Math.round(pnlAmount),
        entryPrice,
        exitPrice: exitPrice || entryPrice,
        openedAt,
        closedAt,
        holdingDays: Math.round(holdingDays * 10) / 10,
        closeReason: String(r.close_reason ?? ''),
        strategyMode: String(r.strategy_mode ?? 'SWING'),
      });
    }
  } catch (e) {
    logger.warn(`저널 KR 조회 실패: ${(e as Error).message}`, { component: 'JOURNAL' });
  }

  try {
    // ── 해외 완결 매매 (BUY→SELL 페어) ──
    const { rows: usRows } = await pool.query(`
      SELECT
        b.stock_code AS code,
        b.filled_price  AS entry_price,
        b.created_at    AS opened_at,
        b.ai_reasoning  AS buy_reasoning,
        s.filled_price  AS exit_price,
        s.created_at    AS closed_at,
        s.ai_reasoning  AS sell_reasoning,
        s.quantity      AS qty
      FROM orders b
      JOIN LATERAL (
        SELECT filled_price, created_at, ai_reasoning, quantity
        FROM orders
        WHERE stock_code = b.stock_code
          AND side = 'SELL'
          AND status = 'FILLED'
          AND trigger_source = 'OVERSEAS'
          AND created_at > b.created_at
          AND filled_price IS NOT NULL
        ORDER BY created_at ASC
        LIMIT 1
      ) s ON TRUE
      WHERE b.side = 'BUY'
        AND b.status = 'FILLED'
        AND b.trigger_source = 'OVERSEAS'
        AND b.created_at >= NOW() - ($1 || ' days')::interval
        AND b.filled_price IS NOT NULL
        AND b.filled_price > 0
      ORDER BY b.created_at DESC
      LIMIT 200
    `, [days]);

    for (const r of usRows) {
      const entryPrice = Number(r.entry_price);
      const exitPrice = Number(r.exit_price);
      const qty = Number(r.qty ?? 0);
      const pnlPct = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
      const pnlAmount = (exitPrice - entryPrice) * qty;
      const openedAt = r.opened_at ? new Date(r.opened_at).toISOString() : '';
      const closedAt = r.closed_at ? new Date(r.closed_at).toISOString() : '';
      const holdingDays = openedAt && closedAt
        ? (new Date(closedAt).getTime() - new Date(openedAt).getTime()) / 86_400_000
        : 0;

      // 매도 사유: sell_reasoning에서 추출
      const sellReasoning = String(r.sell_reasoning ?? '');
      const closeReason = sellReasoning.replace(/\[avgBuy:[^\]]+\]\s*/, '').trim();

      trades.push({
        market: 'US',
        code: String(r.code),
        name: String(r.code),
        pnlPct: Math.round(pnlPct * 100) / 100,
        pnlAmount: Math.round(pnlAmount * 100) / 100,
        entryPrice,
        exitPrice,
        openedAt,
        closedAt,
        holdingDays: Math.round(holdingDays * 10) / 10,
        closeReason,
      });
    }
  } catch (e) {
    logger.warn(`저널 US 조회 실패: ${(e as Error).message}`, { component: 'JOURNAL' });
  }

  // 시간순 정렬 (최신 먼저)
  trades.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime());

  const wins = trades.filter(t => t.pnlPct >= 0).length;
  const total = trades.length;
  const avgPnlPct = total > 0 ? trades.reduce((s, t) => s + t.pnlPct, 0) / total : 0;

  return c.json({
    trades,
    summary: {
      totalTrades: total,
      wins,
      losses: total - wins,
      winRate: total > 0 ? Math.round((wins / total) * 1000) / 10 : 0,
      avgPnlPct: Math.round(avgPnlPct * 100) / 100,
    },
    days,
  });
});
