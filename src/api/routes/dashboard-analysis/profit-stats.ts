import { Hono } from 'hono';
import { getKSTNow } from '../../../utils/time.js';
import { getDinnerMoneyStats } from '../../../automation/profit-withdraw.js';
import { KR_FEE } from '../../../config/constants.js';
import { getPool } from '../../../db/client.js';
import { resolveRequestMode } from '../../guards/live-pin.js';

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
      // 국내: transaction_chains 기반 (기존)
      const codeFilter = `AND stock_code ~ '^[0-9]{6}$'`;

      const { rows: monthly } = await pool.query(
        `
        SELECT
          to_char(closed_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM') AS month,
          SUM(realized_pnl) AS pnl,
          COUNT(*) AS trades
        FROM transaction_chains
        WHERE status = 'CLOSED'
          AND closed_at >= NOW() - INTERVAL '12 months'
          AND is_paper = $1
          ${codeFilter}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
        [isPaper],
      );

      const { rows: total } = await pool.query(
        `
        SELECT COALESCE(SUM(realized_pnl), 0) AS total_pnl
        FROM transaction_chains
        WHERE status = 'CLOSED'
          AND is_paper = $1
          ${codeFilter}
      `,
        [isPaper],
      );

      const { rows: thisMonth } = await pool.query(
        `
        SELECT COALESCE(SUM(realized_pnl), 0) AS pnl
        FROM transaction_chains
        WHERE status = 'CLOSED'
          AND closed_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Seoul')
          AND is_paper = $1
          ${codeFilter}
      `,
        [isPaper],
      );

      const dinnerMoney = await getDinnerMoneyStats();

      const { rows: firstTrade } = await pool.query(
        `SELECT MIN(closed_at) AS first_date FROM transaction_chains WHERE status = 'CLOSED' AND is_paper = $1 ${codeFilter}`,
        [isPaper],
      );
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
      // 수익률 100% 초과 = 비정상 (입금으로 왜곡된 평단가) → 제외
      const osFilter = `side = 'SELL' AND status = 'FILLED'
          AND trigger_source = 'OVERSEAS'
          AND avg_buy_price IS NOT NULL AND avg_buy_price > 0
          AND filled_price IS NOT NULL AND filled_price > 0
          AND (filled_price / avg_buy_price) <= 2.0
          AND (avg_buy_price / filled_price) <= 2.0`;

      const { rows: monthly } = await pool.query(
        `
        SELECT
          to_char(created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM') AS month,
          SUM((filled_price - avg_buy_price) * filled_quantity) AS pnl,
          COUNT(*) AS trades
        FROM orders
        WHERE ${osFilter}
          AND is_paper = $1
          AND (trading_mode = $2::text OR ($2::text = 'paper' AND trading_mode = 'p_arch'))
          AND created_at >= NOW() - INTERVAL '12 months'
        GROUP BY 1
        ORDER BY 1 ASC
      `,
        [isPaper, tradingMode],
      );

      const { rows: total } = await pool.query(
        `
        SELECT COALESCE(SUM((filled_price - avg_buy_price) * filled_quantity), 0) AS total_pnl
        FROM orders
        WHERE ${osFilter}
          AND is_paper = $1
          AND (trading_mode = $2::text OR ($2::text = 'paper' AND trading_mode = 'p_arch'))
      `,
        [isPaper, tradingMode],
      );

      const { rows: thisMonth } = await pool.query(
        `
        SELECT COALESCE(SUM((filled_price - avg_buy_price) * filled_quantity), 0) AS pnl
        FROM orders
        WHERE ${osFilter}
          AND is_paper = $1
          AND (trading_mode = $2::text OR ($2::text = 'paper' AND trading_mode = 'p_arch'))
          AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Seoul')
      `,
        [isPaper, tradingMode],
      );

      const { rows: firstTradeUs } = await pool.query(
        `SELECT MIN(created_at) AS first_date FROM orders WHERE ${osFilter} AND is_paper = $1 AND trading_mode = $2`,
        [isPaper, tradingMode],
      );
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
