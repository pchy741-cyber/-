/**
 * DB 진단 + Paper 리셋 — /review/diag, /review/paper-reset
 */
import { Hono } from 'hono';
import { OVERSEAS_FEE_PCT } from '../../../config/constants.js';
import { logger } from '../../../utils/logger.js';

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
        FROM orders WHERE trigger_source='OVERSEAS' AND trading_mode IN ('paper','p_arch') AND status='FILLED'
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
    logger.error(`진단 조회 실패: ${err}`, { component: 'DIAGNOSTICS' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/** Track B (클로드 코드) 매수 성과 전수조사 — /review/track-b-perf */
app.get('/review/track-b-perf', async (c) => {
  try {
    const { getPool } = await import('../../../db/client.js');
    const pool = getPool();

    // 1. TRACK_B 매수로 생성된 체인 전체 (live 모드만)
    const { rows: chains } = await pool.query(`
      SELECT
        tc.id,
        tc.stock_code,
        tc.strategy_mode,
        tc.status,
        tc.total_quantity,
        tc.avg_buy_price::numeric AS avg_buy,
        tc.realized_pnl::numeric AS realized_pnl,
        tc.close_reason,
        tc.opened_at,
        tc.closed_at,
        (SELECT trigger_source FROM orders
         WHERE chain_id = tc.id AND side = 'BUY'
         ORDER BY created_at ASC LIMIT 1) AS buy_source
      FROM transaction_chains tc
      WHERE tc.is_paper = false
        AND EXISTS (
          SELECT 1 FROM orders o
          WHERE o.chain_id = tc.id AND o.side = 'BUY'
            AND o.trigger_source = 'TRACK_B'
        )
      ORDER BY tc.opened_at DESC
    `);

    // 2. TRACK_B가 아닌 매수 출처 비교 (같은 기간 live)
    const minDate = chains.length > 0
      ? chains[chains.length - 1].opened_at
      : new Date(Date.now() - 90 * 86400000).toISOString();

    const { rows: otherChains } = await pool.query(`
      WITH chain_sources AS (
        SELECT
          tc.realized_pnl::numeric AS pnl,
          (SELECT o2.trigger_source FROM orders o2
           WHERE o2.chain_id = tc.id AND o2.side = 'BUY'
           ORDER BY o2.created_at ASC LIMIT 1) AS buy_source
        FROM transaction_chains tc
        WHERE tc.is_paper = false
          AND tc.status = 'CLOSED'
          AND tc.opened_at >= $1
          AND NOT EXISTS (
            SELECT 1 FROM orders o WHERE o.chain_id = tc.id AND o.side = 'BUY'
              AND o.trigger_source = 'TRACK_B'
          )
      )
      SELECT
        buy_source,
        COUNT(*) as cnt,
        ROUND(AVG(pnl), 0) as avg_realized_pnl,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
        SUM(pnl) as total_pnl
      FROM chain_sources
      GROUP BY buy_source
      ORDER BY total_pnl DESC
    `, [minDate]);

    // 3. TRACK_B 통계 집계
    const closed = chains.filter((c: any) => c.status === 'CLOSED');
    const open = chains.filter((c: any) => c.status !== 'CLOSED');
    const wins = closed.filter((c: any) => Number(c.realized_pnl) > 0);
    const losses = closed.filter((c: any) => Number(c.realized_pnl) <= 0);
    const totalPnl = closed.reduce((s: number, c: any) => s + Number(c.realized_pnl ?? 0), 0);
    const totalGain = wins.reduce((s: number, c: any) => s + Number(c.realized_pnl), 0);
    const totalLoss = losses.reduce((s: number, c: any) => s + Number(c.realized_pnl), 0);

    // 손실 거래 상세 (큰 손실 순 정렬)
    const lossTrades = losses
      .sort((a: any, b: any) => Number(a.realized_pnl) - Number(b.realized_pnl))
      .map((c: any) => ({
        stock_code: c.stock_code,
        pnlKrw: Math.round(Number(c.realized_pnl)),
        close_reason: c.close_reason,
        opened_at: c.opened_at,
        closed_at: c.closed_at,
        avg_buy: Math.round(Number(c.avg_buy)),
        qty: c.total_quantity,
        strategy: c.strategy_mode,
      }));

    const summary = {
      trackB: {
        total: chains.length,
        closed: closed.length,
        open: open.length,
        wins: wins.length,
        losses: losses.length,
        winRate: closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) + '%' : '-',
        totalPnlKrw: Math.round(totalPnl),
        totalGainKrw: Math.round(totalGain),
        totalLossKrw: Math.round(totalLoss),
        avgPnlPerTrade: closed.length > 0 ? Math.round(totalPnl / closed.length) : 0,
        verdict: totalPnl > 0 ? '✅ 순이익' : '❌ 순손실',
      },
      lossTrades,  // 손실 거래 상세 (큰 손실 순)
      other: otherChains,
      chains,
    };

    return c.json(summary);
  } catch (err) {
    logger.error(`Track B 성과 조회 실패: ${err}`, { component: 'DIAGNOSTICS' });
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
      WHERE trading_mode IN ('paper','p_arch') AND status = 'FILLED' AND side = 'SELL'
        AND trigger_source = 'OVERSEAS'
      ORDER BY created_at`);
    const { rows: buyRows } = await pool.query(`
      SELECT stock_code, SUM(filled_quantity::numeric * filled_price::numeric) as total_cost,
             COUNT(*) as cnt
      FROM orders
      WHERE trading_mode IN ('paper','p_arch') AND status = 'FILLED' AND side = 'BUY'
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
    logger.error(`Paper 리셋 실패: ${err}`, { component: 'DIAGNOSTICS' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default app;
