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

// ── AI 스코어 vs 실수익 R² 분석 ──
transparencyRoutes.get('/score-accuracy/r2', async (c) => {
  try {
    const pool = getPool();

    const [overall, tier, recent90] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          ROUND(CORR(entry_score::float, realized_pnl_pct::float)::numeric, 4) AS pearson_r,
          ROUND(POWER(CORR(entry_score::float, realized_pnl_pct::float), 2)::numeric, 4) AS r_squared,
          ROUND(AVG(realized_pnl_pct)::numeric, 2) AS avg_pnl_pct,
          ROUND(MIN(realized_pnl_pct)::numeric, 2) AS min_pnl_pct,
          ROUND(MAX(realized_pnl_pct)::numeric, 2) AS max_pnl_pct,
          COUNT(*) FILTER (WHERE outcome = 'WIN')::int AS wins,
          COUNT(*) FILTER (WHERE outcome = 'LOSS')::int AS losses
        FROM score_accuracy
        WHERE is_paper = false
          AND entry_score IS NOT NULL
          AND realized_pnl_pct IS NOT NULL
      `),
      pool.query(`
        SELECT
          CASE
            WHEN entry_score >= 90 THEN '90+'
            WHEN entry_score >= 80 THEN '80-89'
            WHEN entry_score >= 70 THEN '70-79'
            ELSE '70미만'
          END AS tier,
          COUNT(*)::int AS cnt,
          ROUND(AVG(realized_pnl_pct)::numeric, 2) AS avg_pnl,
          ROUND(MIN(realized_pnl_pct)::numeric, 2) AS min_pnl,
          ROUND(MAX(realized_pnl_pct)::numeric, 2) AS max_pnl,
          ROUND(COUNT(*) FILTER (WHERE outcome='WIN')::numeric / NULLIF(COUNT(*),0) * 100, 1) AS win_rate
        FROM score_accuracy
        WHERE is_paper = false AND entry_score IS NOT NULL
        GROUP BY 1
        ORDER BY MIN(entry_score) DESC
      `),
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          ROUND(CORR(entry_score::float, realized_pnl_pct::float)::numeric, 4) AS pearson_r,
          ROUND(POWER(CORR(entry_score::float, realized_pnl_pct::float), 2)::numeric, 4) AS r_squared
        FROM score_accuracy
        WHERE is_paper = false
          AND entry_score IS NOT NULL
          AND realized_pnl_pct IS NOT NULL
          AND recorded_at >= NOW() - INTERVAL '90 days'
      `),
    ]);

    const o = overall.rows[0];
    const r2 = o.r_squared !== null ? Number(o.r_squared) : null;
    const grade =
      r2 === null ? null
      : r2 >= 0.5 ? 'EXCELLENT'
      : r2 >= 0.25 ? 'GOOD'
      : r2 >= 0.1 ? 'MODERATE'
      : 'LOW';

    return c.json({
      overall: {
        total: o.total,
        pearsonR: o.pearson_r,
        rSquared: o.r_squared,
        avgPnlPct: o.avg_pnl_pct,
        minPnlPct: o.min_pnl_pct,
        maxPnlPct: o.max_pnl_pct,
        wins: o.wins,
        losses: o.losses,
        winRate: o.total > 0 ? Math.round((o.wins / o.total) * 100) : null,
        grade,
      },
      recent90: recent90.rows[0],
      tiers: tier.rows,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
