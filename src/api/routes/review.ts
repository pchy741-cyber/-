import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

const app = new Hono();

// 최근 캡처 저장소 (메모리, 최대 1세트)
let latestCaptures: { tab: string; base64: string; capturedAt: string }[] = [];
let capturedAt = '';

/** POST /review/capture — 프론트에서 캡처한 스크린샷 저장 */
app.post('/review/capture', bodyLimit({ maxSize: 50 * 1024 * 1024 }), async (c) => {
  const body = await c.req.json<{ screenshots: { tab: string; base64: string }[] }>();
  if (!body?.screenshots?.length) return c.json({ error: 'no screenshots' }, 400);

  capturedAt = new Date().toISOString();
  latestCaptures = body.screenshots.map((s) => ({
    tab: s.tab,
    base64: s.base64,
    capturedAt,
  }));

  return c.json({ ok: true, count: latestCaptures.length, capturedAt });
});

/** GET /review/latest — 최근 캡처 메타데이터 */
app.get('/review/latest', (c) => {
  if (!latestCaptures.length) return c.json({ captures: [], capturedAt: null });
  return c.json({
    capturedAt,
    captures: latestCaptures.map((cap, i) => ({
      index: i,
      tab: cap.tab,
      sizeKb: Math.round((cap.base64.length * 3) / 4 / 1024),
    })),
  });
});

/** GET /review/image/:index — 개별 스크린샷 PNG 반환 */
app.get('/review/image/:index', (c) => {
  const idx = parseInt(c.req.param('index'), 10);
  if (isNaN(idx) || idx < 0 || idx >= latestCaptures.length) {
    return c.json({ error: 'not found' }, 404);
  }
  const cap = latestCaptures[idx];
  const raw = cap.base64.includes(',') ? cap.base64.split(',')[1] : cap.base64;
  const buffer = Buffer.from(raw, 'base64');
  return new Response(buffer, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': `inline; filename="quantops_${idx}.png"`,
      'X-Tab': encodeURIComponent(cap.tab),
      'X-Captured-At': cap.capturedAt,
    },
  });
});

/** GET /review/diag — DB 진단 (체인/주문 상태 요약) */
app.get('/review/diag', async (c) => {
  try {
    const { getPool } = await import('../../db/client.js');
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

    // 전략 설정 + KIS 잔고 (설정 검수용)
    const [strategyResult, snapshotResult] = await Promise.all([
      pool.query(`SELECT mode, buy_threshold, stop_loss_pct, take_profit_pct, is_active FROM strategy_config WHERE is_active = true LIMIT 1`).catch(() => ({ rows: [] })),
      pool.query(`SELECT is_paper, total_value, cash_balance, invested_value, snapshot_at FROM portfolio_snapshots ORDER BY snapshot_at DESC LIMIT 4`).catch(() => ({ rows: [] })),
    ]);

    let kisBalance = null;
    try {
      const { getAccountBalance } = await import('../../kis/account.js');
      const bal = await getAccountBalance(true);
      kisBalance = {
        orderableCash: bal.orderableCash,
        totalEvalAmount: bal.totalEvalAmount,
        totalProfitLoss: bal.totalProfitLoss,
        positionCount: bal.positions?.length ?? 0,
        positions: bal.positions?.map(p => ({ code: p.stockCode, name: p.stockName, qty: p.quantity, avg: p.avgBuyPrice, cur: p.currentPrice, pnl: p.profitLoss })),
      };
    } catch {}

    return c.json({
      chains: chains.rows,
      orderStats: orderStats.rows,
      recentOrders: recentOrders.rows,
      strategy: strategyResult.rows[0] ?? null,
      recentSnapshots: snapshotResult.rows,
      kisLiveBalance: kisBalance,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default app;
