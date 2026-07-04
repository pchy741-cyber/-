import { Hono } from 'hono';
import { getKSTNow } from '../../../utils/time.js';
import { getDinnerMoneyStats } from '../../../automation/profit-withdraw.js';
import { KR_FEE, OVERSEAS_FEE_PCT } from '../../../config/constants.js';
import { getPool } from '../../../db/client.js';
import { resolveRequestMode } from '../../guards/live-pin.js';
import { computeStrategyHealth } from '../../../risk/strategy-health.js';

export const profitStatsRoutes = new Hono();

// 통합 헬퍼 사용 — viewMode/mode 양쪽 지원
const resolveViewIsPaper = resolveRequestMode;

// ── 수익 통계 (누적 총수익 + 월별 분해) ──
profitStatsRoutes.get('/profit-stats', async (c) => {
  try {
    const market = (c.req.query('market') ?? 'KR') as 'KR' | 'US';
    const isKr = market === 'KR';
    const pool = getPool();

    const isPaper = resolveViewIsPaper(c);
    const tradingMode = isPaper ? 'paper' : 'live';

    if (isKr) {
      // 국내: transaction_chains 기반 — v10.10.5c: 4 쿼리 병렬화
      const codeFilter = `AND stock_code ~ '^[0-9]{6}$'`;

      const [{ rows: monthly }, { rows: total }, { rows: thisMonth }, dinnerMoney, { rows: firstTrade }] = await Promise.all([
        pool.query(
          `SELECT to_char(closed_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM') AS month,
                  SUM(realized_pnl) AS pnl, COUNT(*) AS trades
           FROM transaction_chains
           WHERE status = 'CLOSED' AND closed_at >= NOW() - INTERVAL '12 months'
             AND is_paper = $1 ${codeFilter}
           GROUP BY 1 ORDER BY 1 ASC`,
          [isPaper],
        ),
        pool.query(
          `SELECT COALESCE(SUM(realized_pnl), 0) AS total_pnl
           FROM transaction_chains WHERE status = 'CLOSED' AND is_paper = $1 ${codeFilter}`,
          [isPaper],
        ),
        pool.query(
          `SELECT COALESCE(SUM(realized_pnl), 0) AS pnl
           FROM transaction_chains
           WHERE status = 'CLOSED' AND closed_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Seoul')
             AND is_paper = $1 ${codeFilter}`,
          [isPaper],
        ),
        getDinnerMoneyStats(),
        pool.query(
          `SELECT MIN(closed_at) AS first_date FROM transaction_chains WHERE status = 'CLOSED' AND is_paper = $1 ${codeFilter}`,
          [isPaper],
        ),
      ]);
      const firstDate = firstTrade[0]?.first_date ? new Date(firstTrade[0].first_date) : new Date();
      const operatingDays = Math.max(1, Math.floor((Date.now() - firstDate.getTime()) / 86400000));
      const totalCumulative = Number(total[0]?.total_pnl ?? 0);

      return c.json({
        market,
        totalCumulative,
        thisMonthPnl: Number(thisMonth[0]?.pnl ?? 0),
        monthly: monthly.map((r: any) => ({ month: r.month, pnl: Number(r.pnl ?? 0), trades: Number(r.trades ?? 0) })),
        dinnerMoney,
        operatingDays,
        dailyAvgPnl: totalCumulative / operatingDays,
      });
    } else {
      // 해외: orders 테이블 SELL 기록 기반 (transaction_chains 없음)
      // PnL = (filled_price - avg_buy_price) * filled_quantity (USD)
      // v14-fix: ratio<=2.0 필터가 큰 손실(-50%+) 숨김 → 5.0으로 확대
      // 5x = 400% 수익까지 허용 (입금 왜곡만 제거, 정상 손실은 전부 반영)
      const osFilter = `side = 'SELL' AND status = 'FILLED'
          AND trigger_source = 'OVERSEAS'
          AND avg_buy_price IS NOT NULL AND avg_buy_price > 0
          AND filled_price IS NOT NULL AND filled_price > 0
          AND (filled_price / avg_buy_price) <= 5.0
          AND (avg_buy_price / filled_price) <= 5.0`;

      // v14-fix: 해외 수수료 반영 (기존: 수수료 미적용 → PnL 과대 표시)
      const OS_FEE = OVERSEAS_FEE_PCT; // 매수/매도 각 0.35%
      const modeFilter = `AND is_paper = $1 AND (trading_mode = $2::text OR ($2::text = 'paper' AND trading_mode = 'p_arch'))`;
      // PnL = 매도금액*(1-fee) - 매수금액*(1+fee) = (sell - buy) - fee*(sell + buy)
      const pnlExpr = `(filled_price * filled_quantity * (1 - ${OS_FEE}) - avg_buy_price * filled_quantity * (1 + ${OS_FEE}))`;
      const [{ rows: monthly }, { rows: total }, { rows: thisMonth }, { rows: firstTradeUs }] = await Promise.all([
        pool.query(
          `SELECT to_char(created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM') AS month,
                  SUM(${pnlExpr}) AS pnl, COUNT(*) AS trades
           FROM orders WHERE ${osFilter} ${modeFilter} AND created_at >= NOW() - INTERVAL '12 months'
           GROUP BY 1 ORDER BY 1 ASC`,
          [isPaper, tradingMode],
        ),
        pool.query(
          `SELECT COALESCE(SUM(${pnlExpr}), 0) AS total_pnl
           FROM orders WHERE ${osFilter} ${modeFilter}`,
          [isPaper, tradingMode],
        ),
        pool.query(
          `SELECT COALESCE(SUM(${pnlExpr}), 0) AS pnl
           FROM orders WHERE ${osFilter} ${modeFilter}
           AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Seoul')`,
          [isPaper, tradingMode],
        ),
        pool.query(
          `SELECT MIN(created_at) AS first_date FROM orders WHERE ${osFilter} AND is_paper = $1 AND trading_mode = $2`,
          [isPaper, tradingMode],
        ),
      ]);
      const firstDateUs = firstTradeUs[0]?.first_date ? new Date(firstTradeUs[0].first_date) : new Date();
      const operatingDaysUs = Math.max(1, Math.floor((Date.now() - firstDateUs.getTime()) / 86400000));
      const totalCumulativeUs = Number(total[0]?.total_pnl ?? 0);

      return c.json({
        market,
        totalCumulative: totalCumulativeUs,
        thisMonthPnl: Number(thisMonth[0]?.pnl ?? 0),
        monthly: monthly.map((r: any) => ({ month: r.month, pnl: Number(r.pnl ?? 0), trades: Number(r.trades ?? 0) })),
        dinnerMoney: null,
        operatingDays: operatingDaysUs,
        dailyAvgPnl: totalCumulativeUs / operatingDaysUs,
      });
    }
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── 에퀴티 커브 (portfolio_snapshots → 일별 총자산) ──
profitStatsRoutes.get('/equity-curve', async (c) => {
  try {
    const rawDays = Number(c.req.query('days') ?? 30);
    const days = Math.min(365, Math.max(7, Number.isFinite(rawDays) ? rawDays : 30));
    const isPaper = resolveViewIsPaper(c);
    // v25 P0-1: 일 마지막 스냅샷 (종가 기준) — MAX(total_value) 장중 고점 → 왜곡 제거
    const { rows } = await getPool().query(
      `SELECT DISTINCT ON ((snapshot_at AT TIME ZONE 'Asia/Seoul')::date)
         (snapshot_at AT TIME ZONE 'Asia/Seoul')::date AS date,
         total_value,
         daily_pnl
       FROM portfolio_snapshots
       WHERE is_paper = $1
         AND snapshot_at >= NOW() - ($2 || ' days')::INTERVAL
       ORDER BY (snapshot_at AT TIME ZONE 'Asia/Seoul')::date, snapshot_at DESC`,
      [isPaper, days],
    );
    return c.json({
      points: rows.map((r: any) => ({
        date: r.date,
        totalValue: Number(r.total_value ?? 0),
        dailyPnl: Number(r.daily_pnl ?? 0),
      })),
    });
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── 세금 추정 (양도세 + 거래세) ──
profitStatsRoutes.get('/market/tax-estimate', async (c) => {
  try {
    const pool = getPool();
    const isPaper = resolveViewIsPaper(c);
    const year = getKSTNow().getUTCFullYear();
    const { rows } = await pool.query(
      `
      SELECT
        SUM(GREATEST(0, (o.filled_price - tc.avg_buy_price) * o.filled_quantity)) AS gross_gain,
        SUM(GREATEST(0, (tc.avg_buy_price - o.filled_price) * o.filled_quantity)) AS gross_loss,
        SUM(o.filled_price * o.filled_quantity * $3) AS transaction_tax,
        SUM(o.filled_price * o.filled_quantity) AS total_sell_amount
      FROM orders o
      JOIN transaction_chains tc ON tc.id = o.chain_id
      WHERE o.side = 'SELL' AND o.status = 'FILLED'
        AND o.trigger_source != 'OVERSEAS'
        AND tc.is_paper = $2
        AND EXTRACT(YEAR FROM o.created_at) = $1
        AND o.filled_price IS NOT NULL AND tc.avg_buy_price IS NOT NULL
    `,
      [year, isPaper, KR_FEE.TRANSACTION_TAX_PCT]
    );
    const r = rows[0] ?? {};
    const grossGain = Number(r.gross_gain ?? 0);
    const grossLoss = Number(r.gross_loss ?? 0);
    const netGain = grossGain - grossLoss;
    const transactionTax = Number(r.transaction_tax ?? 0);
    // 소액주주 국내 상장 주식: 양도세 없음 (단, 대주주 판정 기준 50억 미만)
    const capitalGainsTax = 0;
    return c.json({
      year,
      grossGain,
      grossLoss,
      netGain,
      transactionTax,
      capitalGainsTax,
      totalSellAmount: Number(r.total_sell_amount ?? 0),
    });
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── 전략 종합 성과 평가 (Strategy Health) ──
profitStatsRoutes.get('/strategy-health', async (c) => {
  try {
    const rawDays = Number(c.req.query('days') ?? 90);
    const days = Math.min(365, Math.max(7, Number.isFinite(rawDays) ? rawDays : 90));
    const target = Number(c.req.query('target') ?? 5);
    const monthlyTarget = Number.isFinite(target) ? target : 5;
    const isPaper = resolveViewIsPaper(c);

    const health = await computeStrategyHealth(isPaper, days, monthlyTarget);
    return c.json(health);
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});
