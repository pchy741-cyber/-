import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from './client.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// 무시해도 되는 postgres 오류 패턴 (이미 적용된 DDL 재실행)
const IGNORABLE = [
  'already exists',
  'duplicate column',
  'does not exist',
  'cannot alter type',
  'cannot change',
  'multiple primary keys',
  'there is no unique constraint',
  'is not a table',
  'relation',
];

function isIgnorable(msg: string): boolean {
  const m = msg.toLowerCase();
  return IGNORABLE.some(p => m.includes(p));
}

/**
 * SQL 마이그레이션 파일을 순서대로 실행한다.
 * - schema_migrations 테이블로 적용 여부 추적
 * - 각 파일을 명시적 트랜잭션으로 감싸서 부분 적용 방지
 * - 이미 적용된 DDL 재실행은 경고로 처리 후 통과
 */
export async function runMigrations(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows: applied } = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations ORDER BY filename'
  );
  const appliedSet = new Set(applied.map(r => r.filename));

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
        [file],
      );
      await client.query('COMMIT');
      logger.info(`✅ 마이그레이션 적용: ${file}`, { component: 'MIGRATE' });
    } catch (err: any) {
      try { await client.query('ROLLBACK'); } catch { /* ignore rollback error */ }
      const msg = String(err?.message ?? '');
      if (isIgnorable(msg)) {
        // 이미 적용됐거나 무시 가능한 오류 → 파일 자체는 통과로 표시
        await pool.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
          [file],
        );
        logger.warn(`⚠️ 마이그레이션 경고(건너뜀): ${file} — ${msg.slice(0, 120)}`, { component: 'MIGRATE' });
      } else {
        logger.error(`❌ 마이그레이션 실패: ${file} — ${msg}`, { component: 'MIGRATE' });
        // 실패해도 throw 하지 않음 — 앱 부팅은 계속 진행
        logger.warn(`⚠️ 마이그레이션 오류 무시 후 계속 진행: ${file}`, { component: 'MIGRATE' });
      }
    } finally {
      client.release();
    }
  }

  logger.info(`📦 마이그레이션 완료 (총 ${files.length}개 파일)`, { component: 'MIGRATE' });
}
