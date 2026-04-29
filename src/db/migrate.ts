import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from './client.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * SQL 마이그레이션 파일을 순서대로 실행한다.
 * 이미 실행된 파일은 schema_migrations 테이블로 추적하여 재실행하지 않는다.
 */
export async function runMigrations(): Promise<void> {
  const pool = getPool();

  // 마이그레이션 추적 테이블
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
    try {
      await pool.query(sql);
      await pool.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [file]
      );
      logger.info(`✅ 마이그레이션 적용: ${file}`, { component: 'MIGRATE' });
    } catch (err: any) {
      // ALTER TABLE / CREATE INDEX 중 이미 존재하는 경우 무시
      const msg = String(err?.message ?? '');
      if (
        msg.includes('already exists') ||
        msg.includes('duplicate column') ||
        msg.includes('does not exist')
      ) {
        await pool.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
          [file]
        );
        logger.warn(`⚠️ 마이그레이션 경고(무시): ${file} — ${msg}`, { component: 'MIGRATE' });
      } else {
        logger.error(`❌ 마이그레이션 실패: ${file} — ${msg}`, { component: 'MIGRATE' });
        throw err;
      }
    }
  }

  logger.info(`📦 마이그레이션 완료 (총 ${files.length}개 파일)`, { component: 'MIGRATE' });
}
