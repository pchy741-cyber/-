/**
 * DB 진단 + Paper 리셋 — /review/diag, /review/paper-reset
 */
import { Hono } from 'hono';
import { OVERSEAS_FEE_PCT } from '../../../config/constants.js';

const app = new Hono();

app.get('/review/diag', async (c) => {
  try {
    const { getPool } = await import('../../../db/client.js');
    const pool = getPool();

    const [chains, orderStats, recentOrders] = await Promise.all([
      pool.query(`
        SELECT id, stock_code, status, is_paper, total_quantity, total_invested,
               realized_pnl, strategy_mode, opened_at, closed_at
        FROM transaction_chains
        WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING')
           OR (status = 'CLOSED' AND closed_at >= NOW() - INTERVAL '3 days')
        ORDER BY opened_at DESC LIMIT 30
      `),
      pool.query(`
        SELECT trading_mode, status, COUNT(*) as cnt
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY trading_mode, status
        ORDER BY trading_mode, status
      `),
      pool.query(`
        SELECT id, stock_code, side, trading_mode, status, filled_quantity, filled_price,
               chain_id IS NOT NULL AS has_chain, trigger_source, created_at
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '3 days'
        ORDER BY created_at DESC LIMIT 20
      `),
    ]);

    const [strategyResult, snapshotResult] = await Promise.all([
      pool
        .query(
          `SELECT mode, buy_threshold, stop_loss_pct, take_profit_pct, is_active FROM strategy_config WHERE is_active = true LIMIT 1`,
        )
        .catch(() => ({ rows: [] })),
      pool
        .query(
          `SELECT is_paper, total_value, cash_balance, invested_value, snapshot_at FROM portfolio_snapshots ORDER BY snapshot_at DESC LIMIT 4`,
        )
        .catch(() => ({ rows: [] })),
    ]);

    let kisBalance = null;
    try {
      const { getAccountBalance } = await import('../../../kis/account.js');
      const bal = await getAccountBalance(true);
      kisBalance = {
        orderableCash: bal.orderableCash,
        totalEvalAmount: bal.totalEvalAmount,
        totalProfitLoss: bal.totalProfitLoss,
        positionCount: bal.positions?.length ?? 0,
        positions: bal.positions?.map((p) => ({
          code: p.stockCode,
          name: p.stockName,
          qty: p.quantity,
          avg: p.avgBuyPrice,
          cur: p.currentPrice,
          pnl: p.profitLoss,
        })),
      };
    } catch {}

    let overseasPaperStats = null;
    try {
      const { rows: osStat } = await pool.query(`
        SELECT side, COUNT(*) as cnt,
          ROUND(SUM(COALESCE(filled_price, price) * quantity)::numeric, 2) as total_volume,
          ROUND(SUM(CASE WHEN side='SELL' AND avg_buy_price>0
            THEN (COALESCE(filled_price,price)-avg_buy_price)*quantity ELSE 0 END)::numeric, 2) as realized_pnl
        FROM orders WHERE trigger_source='OVERSEAS' AND trading_mode='paper' AND status='FILLED'
        GROUP BY side`);
      const { rows: osState } = await pool.query(
        "SELECT key, value FROM overseas_state WHERE key IN ('cash_paper','cash')",
      );
      overseasPaperStats = { trades: osStat, state: osState };
    } catch {}

    return c.json({
      chains: chains.rows,
      orderStats: orderStats.rows,
      recentOrders: recentOrders.rows,
      strategy: strategyResult.rows[0] ?? null,
      recentSnapshots: snapshotResult.rows,
      kisLiveBalance: kisBalance,
      overseasPaperStats,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.post('/review/paper-reset', async (c) => {
  try {
    const { getPool } = await import('../../../db/client.js');
    const pool = getPool();

    const { rows: stateRows } = await pool.query("SELECT key, value FROM overseas_state WHERE key IN ('cash_paper')");
    const currentCash = Number(stateRows.find((r: any) => r.key === 'cash_paper')?.value ?? 0);

    const { rows: holdingRows } = await pool.query(
      'SELECT stock_code, exchange, quantity, avg_price FROM overseas_holdings WHERE is_paper = true',
    );
    const holdingsCost = holdingRows.reduce((s: number, r: any) => s + Number(r.quantity) * Number(r.avg_price), 0);

    const { rows: sellRows } = await pool.query(`
      SELECT stock_code, filled_quantity::numeric as qty, filled_price::numeric as price,
             avg_buy_price::numeric as avg_buy, created_at
      FROM orders
      WHERE trading_mode = 'paper' AND status = 'FILLED' AND side = 'SELL'
        AND trigger_source = 'OVERSEAS'
      ORDER BY created_at`);
    const { rows: buyRows } = await pool.query(`
      SELECT stock_code, SUM(filled_quantity::numeric * filled_price::numeric) as total_cost,
             COUNT(*) as cnt
      FROM orders
      WHERE trading_mode = 'paper' AND status = 'FILLED' AND side = 'BUY'
        AND trigger_source = 'OVERSEAS'
      GROUP BY stock_code`);

    let totalRealizedPnl = 0;
    const sellDetails = sellRows.map((r: any) => {
      const qty = Number(r.qty);
      const price = Number(r.price);
      const avgBuy = Number(r.avg_buy) || 0;
      const pnl = avgBuy > 0 ? (price - avgBuy) * qty : 0;
      const fee = price * qty * OVERSEAS_FEE_PCT;
      totalRealizedPnl += pnl;
      return {
        stock_code: r.stock_code,
        qty,
        price,
        avgBuy,
        pnl: +pnl.toFixed(2),
        fee: +fee.toFixed(2),
        date: r.created_at,
      };
    });

    const totalBuyVolume = buyRows.reduce((s: number, r: any) => s + Number(r.total_cost), 0);
    const totalSellVolume = sellRows.reduce((s: number, r: any) => s + Number(r.qty) * Number(r.price), 0);
    const estFees = (totalBuyVolume + totalSellVolume) * OVERSEAS_FEE_PCT;

    const body = (await c.req.json().catch(() => ({}))) as any;
    const targetCash = body.target ?? 10000;

    const deficit = targetCash - (currentCash + holdingsCost);
    if (body.execute) {
      await pool.query('DELETE FROM overseas_holdings WHERE is_paper = true');
      await pool.query(
        "INSERT INTO overseas_state (key, value) VALUES ('cash_paper', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
        [String(targetCash)],
      );
      return c.json({
        action: 'RESET_COMPLETE',
        previousCash: +currentCash.toFixed(2),
        previousHoldings: holdingRows.map((r: any) => ({
          code: r.stock_code,
          qty: +Number(r.quantity).toFixed(4),
          avg: +Number(r.avg_price).toFixed(2),
        })),
        newCash: targetCash,
        analysis: {
          totalRealizedPnl: +totalRealizedPnl.toFixed(2),
          estFees: +estFees.toFixed(2),
          totalBuyVolume: +totalBuyVolume.toFixed(2),
          totalSellVolume: +totalSellVolume.toFixed(2),
          deficit: +deficit.toFixed(2),
          sellCount: sellRows.length,
          buyCount: buyRows.reduce((s: number, r: any) => s + Number(r.cnt), 0),
        },
      });
    }

    return c.json({
      action: 'DRY_RUN',
      currentCash: +currentCash.toFixed(2),
      holdings: holdingRows.map((r: any) => ({
        code: r.stock_code,
        qty: +Number(r.quantity).toFixed(4),
        avg: +Number(r.avg_price).toFixed(2),
        cost: +(Number(r.quantity) * Number(r.avg_price)).toFixed(2),
      })),
      holdingsCost: +holdingsCost.toFixed(2),
      totalAccountValue: +(currentCash + holdingsCost).toFixed(2),
      deficit: +deficit.toFixed(2),
      analysis: {
        totalRealizedPnl: +totalRealizedPnl.toFixed(2),
        estFees: +estFees.toFixed(2),
        totalBuyVolume: +totalBuyVolume.toFixed(2),
        totalSellVolume: +totalSellVolume.toFixed(2),
        sellDetails: sellDetails.slice(-20),
      },
      target: targetCash,
      hint: 'POST with { "execute": true } to reset paper cash to target',
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default app;
