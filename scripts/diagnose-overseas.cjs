/**
 * 해외주식 데이터 정합성 진단 스크립트
 * overseas_state, overseas_holdings, orders 테이블 교차 검증
 *
 * 사용: node scripts/diagnose-overseas.cjs
 */
const { Client } = require('pg');

const DB_PASSWORD = process.env.DB_PASSWORD || 'Quantops2026!Secure';

const client = new Client({
  host: process.env.DB_HOST || '34.64.217.165',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'quantops',
  user: process.env.DB_USER || 'postgres',
  password: DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

async function main() {
  await client.connect();
  console.log('✅ Cloud SQL 연결 성공\n');

  // ── 1. overseas_state 전체 조회 ──
  console.log('═══════════════════════════════════════');
  console.log('  1. overseas_state (현금 등 상태값)');
  console.log('═══════════════════════════════════════');
  const { rows: stateRows } = await client.query('SELECT * FROM overseas_state ORDER BY key');
  for (const r of stateRows) {
    console.log(`  key="${r.key}"  value="${r.value}"`);
  }
  if (stateRows.length === 0) console.log('  (비어있음)');

  // ── 2. overseas_holdings 전체 조회 ──
  console.log('\n═══════════════════════════════════════');
  console.log('  2. overseas_holdings (보유종목)');
  console.log('═══════════════════════════════════════');
  const { rows: holdRows } = await client.query(
    'SELECT stock_code, exchange, quantity, avg_price, is_paper, is_scalp, last_price, bought_at FROM overseas_holdings ORDER BY is_paper, stock_code'
  );
  for (const r of holdRows) {
    const mode = r.is_paper ? 'PAPER' : 'LIVE';
    const scalp = r.is_scalp ? ' [SCALP]' : '';
    console.log(`  [${mode}] ${r.stock_code} (${r.exchange}) qty=${r.quantity} avg=$${Number(r.avg_price).toFixed(2)} last=$${Number(r.last_price ?? 0).toFixed(2)} bought=${r.bought_at}${scalp}`);
  }
  if (holdRows.length === 0) console.log('  (비어있음)');

  // ── 3. 해외 관련 orders 전체 (trigger_source='OVERSEAS') ──
  console.log('\n═══════════════════════════════════════');
  console.log('  3. 해외 주문 내역 (orders WHERE trigger_source=OVERSEAS)');
  console.log('═══════════════════════════════════════');
  const { rows: orderRows } = await client.query(
    `SELECT id, stock_code, side, quantity, price, filled_price, status, trading_mode, trigger_source, ai_reasoning, avg_buy_price, created_at
     FROM orders WHERE trigger_source = 'OVERSEAS' ORDER BY created_at ASC`
  );
  let paperBuyCost = 0, paperSellRevenue = 0;
  let liveBuyCost = 0, liveSellRevenue = 0;
  for (const r of orderRows) {
    const mode = r.trading_mode?.toUpperCase() ?? '?';
    const fp = Number(r.filled_price ?? r.price ?? 0);
    const qty = Number(r.quantity);
    console.log(`  [${mode}] ${r.created_at} ${r.side} ${r.stock_code} qty=${qty} price=$${fp.toFixed(2)} status=${r.status} reason=${(r.ai_reasoning ?? '').substring(0, 60)}`);
    if (r.status === 'FILLED') {
      if (r.trading_mode === 'paper') {
        if (r.side === 'BUY') paperBuyCost += fp * qty;
        else paperSellRevenue += fp * qty;
      } else {
        if (r.side === 'BUY') liveBuyCost += fp * qty;
        else liveSellRevenue += fp * qty;
      }
    }
  }
  if (orderRows.length === 0) console.log('  (비어있음)');

  // ── 4. 정합성 분석 ──
  console.log('\n═══════════════════════════════════════');
  console.log('  4. 정합성 분석');
  console.log('═══════════════════════════════════════');

  // 현금 키 분석
  const cashVal = stateRows.find(r => r.key === 'cash')?.value;
  const cashPaperVal = stateRows.find(r => r.key === 'cash_paper')?.value;
  console.log(`  overseas_state 'cash' = ${cashVal ?? '(없음)'}`);
  console.log(`  overseas_state 'cash_paper' = ${cashPaperVal ?? '(없음)'}`);

  // 보유종목 분석
  const liveHoldings = holdRows.filter(r => !r.is_paper);
  const paperHoldings = holdRows.filter(r => r.is_paper);
  console.log(`\n  Live 보유: ${liveHoldings.length}종목`);
  for (const h of liveHoldings) console.log(`    ${h.stock_code} qty=${h.quantity}`);
  console.log(`  Paper 보유: ${paperHoldings.length}종목`);
  for (const h of paperHoldings) console.log(`    ${h.stock_code} qty=${h.quantity}`);

  // 주문 통계
  console.log(`\n  Paper 주문 통계: BUY $${paperBuyCost.toFixed(2)} / SELL $${paperSellRevenue.toFixed(2)}`);
  console.log(`  Live 주문 통계:  BUY $${liveBuyCost.toFixed(2)} / SELL $${liveSellRevenue.toFixed(2)}`);

  // 기대 현금 (초기 $10,000 기준)
  const expectedPaperCash = 10000 - paperBuyCost + paperSellRevenue;
  // 현재 paper 보유종목 원가
  const paperHoldingsCost = paperHoldings.reduce((s, h) => s + Number(h.avg_price) * Number(h.quantity), 0);
  const expectedPaperCashWithHoldings = expectedPaperCash; // holdings은 이미 BUY에 반영

  console.log(`\n  Paper 기대 현금 (=$10000 - BUY + SELL): $${expectedPaperCash.toFixed(2)}`);
  console.log(`  Paper 보유종목 원가 합: $${paperHoldingsCost.toFixed(2)}`);
  console.log(`  Paper 총자산 기대: $${(expectedPaperCash + paperHoldingsCost).toFixed(2)}`);

  // 오염 판단
  console.log('\n  ── 오염 판단 ──');
  if (cashVal && Number(cashVal) > 0 && liveBuyCost === 0) {
    console.log(`  ⚠️  cash 키에 $${cashVal} 있으나 Live 해외매수 이력 없음 → PAPER 현금이 cash에 오염!`);
    console.log(`  → cash_paper로 이동 필요`);
  }
  if (liveHoldings.length > 0 && liveBuyCost === 0) {
    console.log(`  ⚠️  Live 보유종목 ${liveHoldings.length}개 있으나 Live 매수 이력 없음 → PAPER 종목이 Live로 잘못 기록!`);
    console.log(`  → is_paper=true로 교정 필요`);
  }

  // ── 5. 국내 주문(OVERSEAS 아닌) 통계 ──
  console.log('\n═══════════════════════════════════════');
  console.log('  5. 국내 주문 현황');
  console.log('═══════════════════════════════════════');
  const { rows: krOrders } = await client.query(
    `SELECT trading_mode, side, COUNT(*) as cnt, SUM(COALESCE(filled_price,price) * quantity) as total_amount
     FROM orders WHERE trigger_source != 'OVERSEAS' OR trigger_source IS NULL
     GROUP BY trading_mode, side ORDER BY trading_mode, side`
  );
  for (const r of krOrders) {
    console.log(`  [${(r.trading_mode ?? '?').toUpperCase()}] ${r.side}: ${r.cnt}건, 합산 ₩${Math.round(Number(r.total_amount ?? 0)).toLocaleString()}`);
  }

  // ── 6. KIS 계좌 잔고 비교 기준값 ──
  console.log('\n═══════════════════════════════════════');
  console.log('  6. transaction_chains 요약');
  console.log('═══════════════════════════════════════');
  const { rows: chainSummary } = await client.query(
    `SELECT is_paper, status, COUNT(*) as cnt,
            SUM(total_invested) as total_inv, SUM(realized_pnl) as total_rpnl
     FROM transaction_chains GROUP BY is_paper, status ORDER BY is_paper, status`
  );
  for (const r of chainSummary) {
    const mode = r.is_paper ? 'PAPER' : 'LIVE';
    console.log(`  [${mode}] ${r.status}: ${r.cnt}건, 투자원가 ₩${Math.round(Number(r.total_inv ?? 0)).toLocaleString()}, 실현손익 ₩${Math.round(Number(r.total_rpnl ?? 0)).toLocaleString()}`);
  }

  // ── 7. daily_snapshots 최근 ──
  console.log('\n═══════════════════════════════════════');
  console.log('  7. daily_snapshots 최근 5건');
  console.log('═══════════════════════════════════════');
  const { rows: snapRows } = await client.query(
    `SELECT snapshot_date, is_paper, total_value, cash, invested, pnl
     FROM daily_snapshots ORDER BY snapshot_date DESC, is_paper LIMIT 10`
  );
  for (const r of snapRows) {
    const mode = r.is_paper ? 'PAPER' : 'LIVE';
    console.log(`  [${mode}] ${r.snapshot_date} 총자산=${Math.round(Number(r.total_value)).toLocaleString()} 현금=${Math.round(Number(r.cash)).toLocaleString()} 투자=${Math.round(Number(r.invested)).toLocaleString()} 손익=${Math.round(Number(r.pnl)).toLocaleString()}`);
  }

  console.log('\n✅ 진단 완료');
  await client.end();
}

main().catch(e => {
  console.error('❌ 진단 실패:', e.message);
  client.end().catch(() => {});
  process.exit(1);
});
