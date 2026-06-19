import { Hono } from 'hono';
import { getPool } from '../../../db/client.js';
import { resolveRequestMode } from '../../guards/live-pin.js';

export const transparencyRoutes = new Hono();

// 통합 헬퍼 사용 — viewMode/mode 양쪽 지원
const resolveViewIsPaper = resolveRequestMode;

// ── AI 판단 투명성 (보유 종목 중심) ──
transparencyRoutes.get('/ai-transparency', async (c) => {
  const viewIsPaper = resolveViewIsPaper(c);
  try {
    const pool = getPool();
    // 1) 보유 종목별 AI 매수 이유 + 현재 점수
    const { rows: holdings } = await pool.query(
      `SELECT tc.stock_code, tc.avg_buy_price, tc.total_quantity, tc.opened_at,
              tc.strategy_mode, tc.status,
              COALESCE(w.stock_name, tc.stock_name, tc.stock_code) AS stock_name,
              -- 매수 시 AI reasoning (가장 최초 매수 주문)
              (SELECT o.ai_reasoning FROM orders o
               WHERE o.chain_id = tc.id AND o.side = 'BUY' AND o.is_paper = tc.is_paper
               ORDER BY o.created_at ASC LIMIT 1) AS buy_reason,
              -- 매수 당시 AI 점수
              (SELECT s.composite_score FROM ai_scores s
               WHERE s.stock_code = tc.stock_code
                 AND s.created_at <= tc.opened_at + INTERVAL '1 hour'
               ORDER BY s.created_at DESC LIMIT 1) AS entry_score,
              -- 현재 최신 AI 점수
              (SELECT s.composite_score FROM ai_scores s
               WHERE s.stock_code = tc.stock_code
               ORDER BY s.created_at DESC LIMIT 1) AS current_score,
              -- 현재 시그널
              (SELECT s.signal FROM ai_scores s
               WHERE s.stock_code = tc.stock_code
               ORDER BY s.created_at DESC LIMIT 1) AS current_signal
       FROM transaction_chains tc
       LEFT JOIN watchlist w ON tc.stock_code = w.stock_code
       WHERE tc.status IN ('OPEN', 'AVERAGING', 'PROFIT_TAKING')
         AND tc.is_paper = $1
       ORDER BY tc.opened_at DESC
       LIMIT 10`,
      [viewIsPaper],
    );

    // 2) 최근 AI 매매 결정 (매수 + 매도, 최근 5건)
    const { rows: decisions } = await pool.query(
      `SELECT o.stock_code, o.side, o.filled_price, o.filled_quantity,
              o.ai_reasoning, o.trigger_source, o.created_at,
              COALESCE(w.stock_name, o.stock_code) AS stock_name
       FROM orders o
       LEFT JOIN watchlist w ON o.stock_code = w.stock_code
       WHERE o.status = 'FILLED'
         AND o.is_paper = $1
         AND (o.trading_mode = $2::text OR ($2::text = 'paper' AND o.trading_mode = 'p_arch'))
         AND o.ai_reasoning IS NOT NULL
         AND o.ai_reasoning != ''
       ORDER BY o.created_at DESC
       LIMIT 5`,
      [viewIsPaper, viewIsPaper ? 'paper' : 'live'],
    );

    // 3) AI 적중률 (최근 30일)
    const { rows: accuracy } = await pool.query(
      `SELECT outcome, COUNT(*)::int AS cnt
       FROM score_accuracy
       WHERE created_at >= NOW() - INTERVAL '30 days'
         AND is_paper = $1
       GROUP BY outcome`,
      [viewIsPaper],
    );
    const wins = accuracy.find((r: any) => r.outcome === 'WIN')?.cnt ?? 0;
    const losses = accuracy.find((r: any) => r.outcome === 'LOSS')?.cnt ?? 0;
    const total = wins + losses;
    const winRate = total > 0 ? Math.round((wins / total) * 100) : null;

    return c.json({ holdings, decisions, winRate, totalTrades: total, wins, losses });
  } catch (_err: any) {
    return c.json({ holdings: [], decisions: [], winRate: null, totalTrades: 0 }, 200);
  }
});
