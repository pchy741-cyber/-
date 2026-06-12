import pg from 'pg';

// CLI args: --host --port --db --user
const argv = process.argv.slice(2);
const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };

let pool;
if (process.env.DATABASE_URL) {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
} else {
  pool = new pg.Pool({
    host:     arg('--host') ?? process.env.DB_HOST     ?? '127.0.0.1',
    port:     Number(arg('--port') ?? process.env.DB_PORT ?? 5434),
    database: arg('--db')   ?? process.env.DB_NAME     ?? 'quantops',
    user:     arg('--user') ?? process.env.DB_USER     ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
  });
}

try {
  // 1. Orders by trading_mode
  const modes = await pool.query(`
    SELECT trading_mode, side, COUNT(*) as cnt,
           SUM(COALESCE(filled_quantity,0) * COALESCE(filled_price,0))::bigint as total_value
    FROM orders
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY trading_mode, side
    ORDER BY trading_mode, side
  `);
  console.log('=== Orders by mode (last 30 days) ===');
  console.table(modes.rows);

  // 2. Open chains
  const chains = await pool.query(`
    SELECT is_paper, COUNT(*) as cnt,
           SUM(COALESCE(invested_amount,0))::bigint as total_invested
    FROM transaction_chains
    WHERE exit_date IS NULL
    GROUP BY is_paper
  `);
  console.log('=== Open chains (현재 보유) ===');
  console.table(chains.rows);

  // 3. Paper balance calculation
  const paperOrders = await pool.query(`
    SELECT side, COUNT(*) as cnt,
           SUM(COALESCE(filled_quantity,0) * COALESCE(filled_price,0))::bigint as total_value
    FROM orders
    WHERE trading_mode = 'paper' AND status = 'FILLED'
      AND stock_code ~ '^[0-9]{6}$'
    GROUP BY side
  `);
  console.log('=== Paper orders (KR domestic) ===');
  console.table(paperOrders.rows);

  // 4. Recent live orders
  const liveOrders = await pool.query(`
    SELECT id, stock_code, side, quantity, filled_quantity, filled_price, status, created_at
    FROM orders
    WHERE trading_mode = 'live'
    ORDER BY created_at DESC
    LIMIT 10
  `);
  console.log('=== Recent live orders ===');
  if (liveOrders.rows.length === 0) console.log('  (없음 — live 주문 0건)');
  else console.table(liveOrders.rows);

  // 5. Portfolio snapshots (latest)
  const snaps = await pool.query(`
    SELECT is_paper,
           ROUND(total_value::numeric) as total_value,
           ROUND(cash_balance::numeric) as cash,
           ROUND(invested_value::numeric) as invested,
           snapshot_at
    FROM portfolio_snapshots
    ORDER BY snapshot_at DESC
    LIMIT 6
  `);
  console.log('=== Latest snapshots ===');
  console.table(snaps.rows);

  // 6. Risk events today
  const risks = await pool.query(`
    SELECT event_type, severity, action_taken,
           details->>'stockCode' as stock,
           details->>'totalAssets' as total_assets,
           created_at
    FROM risk_events
    WHERE created_at >= NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC
    LIMIT 15
  `);
  console.log('=== Risk events (last 24h) ===');
  console.table(risks.rows);

  // 7. AI scores count today
  const scores = await pool.query(`
    SELECT score_date, COUNT(*) as cnt
    FROM ai_scores
    WHERE score_date >= CURRENT_DATE - 1
    GROUP BY score_date
    ORDER BY score_date DESC
  `);
  console.log('=== AI scores by date ===');
  console.table(scores.rows);

  // 8. Vertex AI cost tracking
  const aiCost = await pool.query(`
    SELECT key, value
    FROM overseas_state
    WHERE key LIKE '%vertex%' OR key LIKE '%gemini%' OR key LIKE '%ai_cost%'
    LIMIT 10
  `);
  console.log('=== AI cost state ===');
  if (aiCost.rows.length === 0) console.log('  (별도 비용 추적 없음)');
  else console.table(aiCost.rows);

} catch(e) {
  console.error('DB Error:', e.message);
} finally {
  await pool.end();
}
