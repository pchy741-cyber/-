const pg = require('pg');
const pool = new pg.Pool({
  host: '34.64.217.165', port: 5432, database: 'quantops',
  user: 'postgres', password: 'Quantops2026!Secure',
  ssl: { rejectUnauthorized: false },
});

async function run() {
  // 1. 전체 실적 (Live)
  const overall = await pool.query(`
    SELECT
      count(*) as total_trades,
      sum(CASE WHEN pnl_pct > 0.4 THEN 1 ELSE 0 END) as wins,
      avg(pnl_pct) as avg_pnl,
      sum(realized_pnl) as total_pnl,
      avg(CASE WHEN pnl_pct > 0 THEN pnl_pct END) as avg_win_pct,
      avg(CASE WHEN pnl_pct <= 0 THEN pnl_pct END) as avg_loss_pct,
      max(pnl_pct) as best_trade,
      min(pnl_pct) as worst_trade,
      avg(total_invested) as avg_position_size
    FROM transaction_chains
    WHERE is_paper=false AND status='CLOSED' AND pnl_pct IS NOT NULL
  `);
  const o = overall.rows[0];
  console.log('=== LIVE 전체 실적 ===');
  console.log(`총거래: ${o.total_trades}건, 승: ${o.wins}건, 승률: ${((o.wins/o.total_trades)*100).toFixed(1)}%`);
  console.log(`평균수익률: ${Number(o.avg_pnl).toFixed(2)}%, 총손익: ${Math.round(o.total_pnl).toLocaleString()}원`);
  console.log(`평균승리: +${Number(o.avg_win_pct).toFixed(2)}%, 평균패배: ${Number(o.avg_loss_pct).toFixed(2)}%`);
  console.log(`최고: +${Number(o.best_trade).toFixed(2)}%, 최악: ${Number(o.worst_trade).toFixed(2)}%`);
  console.log(`평균포지션: ${Math.round(o.avg_position_size).toLocaleString()}원`);

  // 2. 최근 14일
  const recent = await pool.query(`
    SELECT count(*) as trades, sum(CASE WHEN pnl_pct > 0.4 THEN 1 ELSE 0 END) as wins,
      avg(pnl_pct) as avg_pnl, sum(realized_pnl) as total_pnl
    FROM transaction_chains
    WHERE is_paper=false AND status='CLOSED' AND closed_at >= NOW()-INTERVAL '14 days' AND pnl_pct IS NOT NULL
  `);
  const r = recent.rows[0];
  console.log(`\n=== 최근14일 ===`);
  console.log(`${r.trades}건, 승률${((r.wins/r.trades)*100).toFixed(1)}%, 합계${Math.round(r.total_pnl).toLocaleString()}원`);

  // 3. 전략별
  const byStrategy = await pool.query(`
    SELECT strategy_mode, count(*) as trades,
      sum(CASE WHEN pnl_pct > 0.4 THEN 1 ELSE 0 END) as wins,
      avg(pnl_pct) as avg_pnl, sum(realized_pnl) as total_pnl
    FROM transaction_chains WHERE is_paper=false AND status='CLOSED' AND pnl_pct IS NOT NULL
    GROUP BY strategy_mode ORDER BY total_pnl DESC
  `);
  console.log(`\n=== 전략별 실적 ===`);
  byStrategy.rows.forEach(r => console.log(`  ${r.strategy_mode||'기본'}: ${r.trades}건 승률${((r.wins/r.trades)*100).toFixed(1)}% 평균${Number(r.avg_pnl).toFixed(2)}% 합계${Math.round(r.total_pnl).toLocaleString()}원`));

  // 4. 보유기간별
  const byHold = await pool.query(`
    SELECT
      CASE
        WHEN EXTRACT(EPOCH FROM closed_at-opened_at)/3600 < 2 THEN '0-2h'
        WHEN EXTRACT(EPOCH FROM closed_at-opened_at)/3600 < 8 THEN '2-8h'
        WHEN EXTRACT(EPOCH FROM closed_at-opened_at)/86400 < 2 THEN '1일'
        WHEN EXTRACT(EPOCH FROM closed_at-opened_at)/86400 < 4 THEN '2-3일'
        ELSE '4일+'
      END as hold,
      count(*) as trades, sum(CASE WHEN pnl_pct>0.4 THEN 1 ELSE 0 END) as wins,
      avg(pnl_pct) as avg_pnl, sum(realized_pnl) as total_pnl
    FROM transaction_chains WHERE is_paper=false AND status='CLOSED' AND pnl_pct IS NOT NULL AND opened_at IS NOT NULL
    GROUP BY hold ORDER BY avg_pnl DESC
  `);
  console.log(`\n=== 보유기간별 ===`);
  byHold.rows.forEach(r => console.log(`  ${r.hold}: ${r.trades}건 승률${((r.wins/r.trades)*100).toFixed(1)}% 평균${Number(r.avg_pnl).toFixed(2)}%`));

  // 5. 포지션크기별
  const bySize = await pool.query(`
    SELECT
      CASE
        WHEN total_invested < 500000 THEN 'A.50만미만'
        WHEN total_invested < 1000000 THEN 'B.50-100만'
        WHEN total_invested < 2000000 THEN 'C.100-200만'
        ELSE 'D.200만+'
      END as bucket,
      count(*) as trades, sum(CASE WHEN pnl_pct>0.4 THEN 1 ELSE 0 END) as wins,
      avg(pnl_pct) as avg_pnl, sum(realized_pnl) as total_pnl
    FROM transaction_chains WHERE is_paper=false AND status='CLOSED' AND pnl_pct IS NOT NULL
    GROUP BY bucket ORDER BY bucket
  `);
  console.log(`\n=== 포지션크기별 ===`);
  bySize.rows.forEach(r => console.log(`  ${r.bucket}: ${r.trades}건 승률${((r.wins/r.trades)*100).toFixed(1)}% 평균${Number(r.avg_pnl).toFixed(2)}% 합계${Math.round(r.total_pnl).toLocaleString()}원`));

  // 6. 시간대별
  const byHour = await pool.query(`
    SELECT EXTRACT(HOUR FROM opened_at+INTERVAL '9 hours') as h,
      count(*) as trades, sum(CASE WHEN pnl_pct>0.4 THEN 1 ELSE 0 END) as wins, avg(pnl_pct) as avg_pnl
    FROM transaction_chains WHERE is_paper=false AND status='CLOSED' AND pnl_pct IS NOT NULL AND opened_at IS NOT NULL
    GROUP BY h ORDER BY h
  `);
  console.log(`\n=== 시간대별 매수 ===`);
  byHour.rows.forEach(r => console.log(`  ${r.h}시: ${r.trades}건 승률${((r.wins/r.trades)*100).toFixed(1)}% 평균${Number(r.avg_pnl).toFixed(2)}%`));

  // 7. 청산사유별
  const byReason = await pool.query(`
    SELECT close_reason, count(*) as trades,
      sum(CASE WHEN pnl_pct>0.4 THEN 1 ELSE 0 END) as wins, avg(pnl_pct) as avg_pnl
    FROM transaction_chains WHERE is_paper=false AND status='CLOSED' AND pnl_pct IS NOT NULL AND close_reason IS NOT NULL
    GROUP BY close_reason ORDER BY trades DESC LIMIT 10
  `);
  console.log(`\n=== 청산사유별 ===`);
  byReason.rows.forEach(r => console.log(`  ${r.close_reason}: ${r.trades}건 승률${((r.wins/r.trades)*100).toFixed(1)}% 평균${Number(r.avg_pnl).toFixed(2)}%`));

  // 8. 해외 실적
  const os = await pool.query(`
    SELECT count(*) as trades,
      sum(CASE WHEN (filled_price-(regexp_match(ai_reasoning, '\\[avgBuy:([0-9]+\\.?[0-9]*)\\]'))[1]::numeric)>0 THEN 1 ELSE 0 END) as wins,
      avg((filled_price-(regexp_match(ai_reasoning, '\\[avgBuy:([0-9]+\\.?[0-9]*)\\]'))[1]::numeric)/NULLIF((regexp_match(ai_reasoning, '\\[avgBuy:([0-9]+\\.?[0-9]*)\\]'))[1]::numeric,0)*100) as avg_pnl
    FROM orders WHERE trading_mode='live' AND side='SELL' AND status='FILLED' AND trigger_source='OVERSEAS'
      AND filled_price IS NOT NULL AND (regexp_match(ai_reasoning, '\\[avgBuy:([0-9]+\\.?[0-9]*)\\]'))[1] IS NOT NULL
  `);
  console.log(`\n=== 해외 실적 ===`);
  const osR = os.rows[0];
  if (osR.trades > 0) console.log(`${osR.trades}건, 승률${((osR.wins/osR.trades)*100).toFixed(1)}%, 평균${Number(osR.avg_pnl).toFixed(2)}%`);

  // 9. Paper 실적
  const paper = await pool.query(`
    SELECT count(*) as trades, sum(CASE WHEN pnl_pct>0.4 THEN 1 ELSE 0 END) as wins,
      avg(pnl_pct) as avg_pnl, sum(realized_pnl) as total_pnl
    FROM transaction_chains WHERE is_paper=true AND status='CLOSED' AND pnl_pct IS NOT NULL
  `);
  const p = paper.rows[0];
  console.log(`\n=== PAPER 실적 ===`);
  console.log(`${p.trades}건, 승률${((p.wins/p.trades)*100).toFixed(1)}%, 합계${Math.round(p.total_pnl).toLocaleString()}원`);

  // 10. 일별 추이
  const daily = await pool.query(`
    SELECT closed_at::date as day, count(*) as trades,
      sum(CASE WHEN pnl_pct>0.4 THEN 1 ELSE 0 END) as wins, sum(realized_pnl) as pnl
    FROM transaction_chains WHERE is_paper=false AND status='CLOSED' AND closed_at>=NOW()-INTERVAL '14 days' AND pnl_pct IS NOT NULL
    GROUP BY day ORDER BY day
  `);
  console.log(`\n=== 일별 추이 (14일) ===`);
  daily.rows.forEach(r => console.log(`  ${r.day}: ${r.trades}건 ${r.wins}승 PnL=${Math.round(r.pnl).toLocaleString()}원`));

  // 11. 손익비 (Profit Factor)
  const pf = await pool.query(`
    SELECT
      sum(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE 0 END) as gross_profit,
      abs(sum(CASE WHEN realized_pnl < 0 THEN realized_pnl ELSE 0 END)) as gross_loss
    FROM transaction_chains WHERE is_paper=false AND status='CLOSED' AND realized_pnl IS NOT NULL
  `);
  const pfR = pf.rows[0];
  console.log(`\n=== 손익비 ===`);
  console.log(`총이익: ${Math.round(pfR.gross_profit).toLocaleString()}원, 총손실: ${Math.round(pfR.gross_loss).toLocaleString()}원`);
  console.log(`Profit Factor: ${(pfR.gross_profit / pfR.gross_loss).toFixed(2)}`);

  await pool.end();
}
run().catch(e => { console.error(e.message); process.exit(1); });
