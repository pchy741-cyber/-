/**
 * Cloud SQL 마이그레이션 실행기
 * 사용: node scripts/migrate-cloudsql.cjs [파일명 | all]
 * 예시: node scripts/migrate-cloudsql.cjs all
 *       node scripts/migrate-cloudsql.cjs 004_performance_indexes.sql
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '../src/db/migrations');

// 비밀번호는 환경변수 우선, 없으면 직접 입력 필요
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

async function runFile(filename) {
  const filepath = path.join(MIGRATIONS_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.error(`파일 없음: ${filepath}`);
    return false;
  }
  const sql = fs.readFileSync(filepath, 'utf8');
  console.log(`\n▶ 실행 중: ${filename}`);
  await client.query(sql);
  console.log(`✅ 완료: ${filename}`);
  return true;
}

async function main() {
  const target = process.argv[2] || 'all';

  await client.connect();
  console.log('✅ Cloud SQL 연결 성공');

  if (target === 'all') {
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();
    console.log(`총 ${files.length}개 마이그레이션 파일 실행`);
    for (const file of files) {
      await runFile(file);
    }
  } else {
    await runFile(target);
  }

  const res = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
  );
  console.log('\n📋 현재 테이블:', res.rows.map(r => r.tablename).join(', '));
  await client.end();
}

main().catch(e => {
  console.error('❌ 마이그레이션 실패:', e.message);
  client.end().catch(() => {});
  process.exit(1);
});
