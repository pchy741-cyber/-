const { Client } = require('pg');
const fs = require('fs');

const sql = fs.readFileSync('src/db/migrations/001_initial.sql', 'utf8');

const client = new Client({
  host: '34.64.217.165',
  port: 5432,
  database: 'quantops',
  user: 'postgres',
  password: 'Quantops2026!Secure',
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();
  console.log('Connected to Cloud SQL!');
  await client.query(sql);
  console.log('Migration complete!');
  const res = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  console.log('Tables:', res.rows.map(r => r.tablename));
  await client.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
