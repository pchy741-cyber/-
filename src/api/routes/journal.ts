import { Hono } from 'hono';
import { config } from '../../config/index.js';
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
  const viewModeParam = c.req.query('viewMode');
  const viewIsPaper = viewModeParam === 'paper' ? true : viewModeParam === 'live' ? false : config.isPaper;
  const viewTradingMode = viewIsPaper ? 'paper' : 'live';
  const pool = getPool();
  const trades: JournalTrade[] = [];

  try {
    // ── 국내 종결 체인 (transaction_chains) ──
    const { rows: krRows } = await pool.query(`
      SELECT
        tc.stock_code,
        w.stock_name,
        tc.avg_buy_price,
        tc.total_quantity,
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
        AND tc.is_paper = $2
      ORDER BY tc.closed_at DESC
      LIMIT 200
    `, [days, viewIsPaper]);

    for (const r of krRows) {
      const entryPrice = Number(r.avg_buy_price ?? 0);
      const exitPrice = Number(r.exit_price ?? 0);
      // realized_pnl=0은 미업데이트(버그) 가능성 — exit_price 기반으로 재계산
      const pnlAmount = (r.realized_pnl != null && Number(r.realized_pnl) !== 0)
        ? Number(r.realized_pnl)
        : exitPrice > 0 && entryPrice > 0
          ? (exitPrice - entryPrice) * Number(r.total_quantity ?? 0)
          : 0;
      const invested = Number(r.total_invested ?? 0);
      const pnlPct = invested > 0 ? (pnlAmount / invested) * 100
        : entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100
        : 0;
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
    // ── 해외 완결 매매 (SELL 기반 — 중복 없음) ──
    // BUY 기준 JOIN은 동일 SELL에 여러 BUY가 붙어 중복 발생 (AMD 반복매수 등)
    // SELL 기준으로 조회하고 ai_reasoning에 내장된 [avgBuy:X] 를 평단가로 사용
    const { rows: usRows } = await pool.query(`
      SELECT
        s.stock_code   AS code,
        s.created_at   AS closed_at,
        s.filled_price AS exit_price,
        s.quantity     AS qty,
        s.ai_reasoning AS sell_reasoning,
        -- avg_buy_price 컬럼 우선, 없으면 ai_reasoning 파싱 폴백
        COALESCE(
          s.avg_buy_price,
          (regexp_match(s.ai_reasoning, '\\[avgBuy:([0-9]+\\.?[0-9]*)\\]'))[1]::numeric
        ) AS avg_buy_price,
        -- 이 SELL 이전 첫 매수 시점 (포지션 개시일)
        (
          SELECT MIN(b.created_at)
          FROM orders b
          WHERE b.stock_code = s.stock_code
            AND b.side = 'BUY' AND b.status = 'FILLED'
            AND b.trigger_source = 'OVERSEAS'
            AND b.created_at < s.created_at
            AND b.filled_price IS NOT NULL
        ) AS opened_at
      FROM orders s
      WHERE s.side = 'SELL'
        AND s.status = 'FILLED'
        AND s.trigger_source = 'OVERSEAS'
        AND s.created_at >= NOW() - ($1 || ' days')::interval
        AND s.filled_price IS NOT NULL
        AND s.filled_price > 0
        AND (s.avg_buy_price IS NOT NULL OR s.ai_reasoning ~ '\\[avgBuy:[0-9]')
        AND s.trading_mode = $2
      ORDER BY s.created_at DESC
      LIMIT 200
    `, [days, viewTradingMode]);

    for (const r of usRows) {
      const entryPrice = Number(r.avg_buy_price ?? 0);
      const exitPrice = Number(r.exit_price);
      const qty = Number(r.qty ?? 0);
      if (entryPrice <= 0) continue;
      const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
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
