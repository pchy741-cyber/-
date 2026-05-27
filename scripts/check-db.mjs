import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: '34.64.217.165',
  port: 5432,
  database: 'quantops',
  user: 'postgres',
  password: 'Quantops2026!Secure',
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('\n=== OPEN CHAINS ===');
    const chains = await client.query(
      `SELECT stock_code, ROUND(avg_buy_price) as avg, total_quantity as qty,
              ROUND(avg_buy_price*total_quantity) as invested, is_paper, status
       FROM transaction_chains
       WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING')
       ORDER BY is_paper, opened_at DESC`
    );
    chains.rows.forEach(r => console.log(JSON.stringify(r)));

    console.log('\n=== OVERSEAS HOLDINGS ===');
    const os = await client.query(
      `SELECT stock_code, quantity, avg_price, last_price, is_paper FROM overseas_holdings WHERE quantity > 0 ORDER BY is_paper`
    );
    os.rows.forEach(r => console.log(JSON.stringify(r)));

    console.log('\n=== OVERSEAS STATE (cash) ===');
    const cash = await client.query(`SELECT key, value FROM overseas_state WHERE key IN ('cash','cash_paper')`);
    cash.rows.forEach(r => console.log(JSON.stringify(r)));
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error(e.message); process.exit(1); });
