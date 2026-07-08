const pg = require('pg');
const pool = new pg.Pool({
  host: '34.64.217.165', port: 5432, database: 'quantops',
  user: 'postgres', password: 'Quantops2026!Secure',
  ssl: { rejectUnauthorized: false },
});

async function run() {
  // 12. 연속 승/패 기록
  const streaks = await pool.query(`
    SELECT pnl_pct FROM transaction_chains
    WHERE is_paper=false AND status='CLOSED' AND pnl_pct IS NOT NULL
    ORDER BY closed_at ASC
  `);
  let maxWinStreak=0, maxLossStreak=0, curWin=0, curLoss=0;
  for (const r of streaks.rows) {
    if (Number(r.pnl_pct) > 0.4) { curWin++; curLoss=0; maxWinStreak=Math.max(maxWinStreak,curWin); }
    else { curLoss++; curWin=0; maxLossStreak=Math.max(maxLossStreak,curLoss); }
  }
  console.log('=== 연속 승/패 ===');
  console.log('최대연승:', maxWinStreak, '최대연패:', maxLossStreak);

  // 13. 요일별 실적
  const byDay = await pool.query(`
    SELECT EXTRACT(DOW FROM closed_at) as dow, count(*) as trades,
      sum(CASE WHEN pnl_pct>0.4 THEN 1 ELSE 0 END) as wins, avg(pnl_pct) as avg_pnl
    FROM transaction_chains WHERE is_paper=false AND status='CLOSED' AND pnl_pct IS NOT NULL
    GROUP BY dow ORDER BY dow
  `);
  const days = ['일','월','화','수','목','금','토'];
  console.log('\n=== 요일별 ===');
  byDay.rows.forEach(r => console.log('  ' + days[r.dow] + '요일: ' + r.trades + '건 승률' + ((r.wins/r.trades)*100).toFixed(1) + '% 평균' + Number(r.avg_pnl).toFixed(2) + '%'));

  // 14. 종목별 실적 Top15
  const byStock = await pool.query(`
    SELECT stock_code, stock_name, count(*) as trades,
      sum(CASE WHEN pnl_pct>0.4 THEN 1 ELSE 0 END) as wins,
      avg(pnl_pct) as avg_pnl, sum(realized_pnl) as total_pnl
    FROM transaction_chains WHERE is_paper=false AND status='CLOSED' AND pnl_pct IS NOT NULL
    GROUP BY stock_code, stock_name ORDER BY total_pnl DESC LIMIT 15
  `);
  console.log('\n=== 종목별 실적 Top15 ===');
  byStock.rows.forEach(r => console.log('  ' + (r.stock_name||r.stock_code) + ': ' + r.trades + '건 승률' + ((r.wins/r.trades)*100).toFixed(1) + '% 합계' + Math.round(r.total_pnl).toLocaleString() + '원'));

  // 15. 최대 낙폭 (Drawdown)
  const dd = await pool.query(`
    SELECT closed_at::date as day, sum(realized_pnl) as daily_pnl
    FROM transaction_chains WHERE is_paper=false AND status='CLOSED' AND realized_pnl IS NOT NULL
    GROUP BY day ORDER BY day
  `);
  let cumPnl=0, peak=0, maxDD=0;
  for (const r of dd.rows) {
    cumPnl += Number(r.daily_pnl);
    if (cumPnl > peak) peak = cumPnl;
    const drawdown = peak - cumPnl;
    if (drawdown > maxDD) maxDD = drawdown;
  }
  console.log('\n=== 최대 낙폭 ===');
  console.log('Max Drawdown:', Math.round(maxDD).toLocaleString() + '원');

  // 16. 운영 기간
  const period = await pool.query(`
    SELECT min(opened_at)::date as first_date, max(closed_at)::date as last_date,
      count(DISTINCT closed_at::date) as active_days
    FROM transaction_chains WHERE is_paper=false AND status='CLOSED'
  `);
  const pr = period.rows[0];
  console.log('\n=== 운영 기간 ===');
  console.log('시작:', pr.first_date, '최근:', pr.last_date, '활동일:', pr.active_days + '일');

  // 17. (ai_score 컬럼 없으므로 스킵)

  // 18. 현재 설정
  const cfg = await pool.query(`SELECT * FROM strategy_config WHERE is_active=true`);
  console.log('\n=== 활성 전략 설정 ===');
  cfg.rows.forEach(r => console.log('  ' + (r.is_paper?'PAPER':'LIVE') + ': mode=' + r.mode + ' seed=' + r.seed_capital + ' cap=' + r.position_cap_pct + '%'));

  // 19. 오픈 포지션
  const openPos = await pool.query(`
    SELECT is_paper, stock_code, stock_name, total_quantity, avg_buy_price, total_invested, strategy_mode
    FROM transaction_chains WHERE status='OPEN' ORDER BY is_paper, total_invested DESC
  `);
  console.log('\n=== 오픈 포지션 ===');
  openPos.rows.forEach(r => console.log('  [' + (r.is_paper?'P':'L') + '] ' + (r.stock_name||r.stock_code) + ': ' + r.total_quantity + '주 x' + Math.round(r.avg_buy_price) + '원 = ' + Math.round(r.total_invested).toLocaleString() + '원 (' + r.strategy_mode + ')'));

  // 20. 손절/익절 분포
  const sltp = await pool.query(`
    SELECT
      CASE
        WHEN pnl_pct <= -5 THEN 'A.-5%이하'
        WHEN pnl_pct <= -2.5 THEN 'B.-5~-2.5%'
        WHEN pnl_pct <= -1 THEN 'C.-2.5~-1%'
        WHEN pnl_pct <= 0 THEN 'D.-1~0%'
        WHEN pnl_pct <= 1 THEN 'E.0~1%'
        WHEN pnl_pct <= 2.5 THEN 'F.1~2.5%'
        WHEN pnl_pct <= 5 THEN 'G.2.5~5%'
        ELSE 'H.5%이상'
      END as bracket,
      count(*) as cnt
    FROM transaction_chains WHERE is_paper=false AND status='CLOSED' AND pnl_pct IS NOT NULL
    GROUP BY bracket ORDER BY bracket
  `);
  console.log('\n=== 손익 분포 ===');
  sltp.rows.forEach(r => console.log('  ' + r.bracket + ': ' + r.cnt + '건'));

  // 21. Paper 전략별
  const paperStrat = await pool.query(`
    SELECT strategy_mode, count(*) as trades,
      sum(CASE WHEN pnl_pct>0.4 THEN 1 ELSE 0 END) as wins,
      avg(pnl_pct) as avg_pnl, sum(realized_pnl) as total_pnl
    FROM transaction_chains WHERE is_paper=true AND status='CLOSED' AND pnl_pct IS NOT NULL
    GROUP BY strategy_mode ORDER BY total_pnl DESC
  `);
  console.log('\n=== PAPER 전략별 ===');
  paperStrat.rows.forEach(r => console.log('  ' + (r.strategy_mode||'기본') + ': ' + r.trades + '건 승률' + ((r.wins/r.trades)*100).toFixed(1) + '% 합계' + Math.round(r.total_pnl).toLocaleString() + '원'));

  await pool.end();
}
run().catch(e => { console.error(e.message); process.exit(1); });
