import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import { getPool } from './client.js';

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
  return IGNORABLE.some((p) => m.includes(p));
}

/**
 * ';' 구분자로 SQL 파일을 개별 구문으로 분리한다.
 * 빈 구문 및 주석만 있는 청크는 제외한다.
 */
function splitSqlStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      // 주석 제거 후 실제 SQL이 있는지 확인
      const withoutComments = s.replace(/--[^\n]*/g, '').trim();
      return withoutComments.length > 0;
    });
}

/**
 * SQL 마이그레이션 파일을 순서대로 실행한다.
 * - schema_migrations 테이블로 적용 여부 추적
 * - 단일 커넥션 재사용
 * - 각 파일을 구문 단위로 개별 실행 (전체 파일 트랜잭션 금지)
 *   → 한 구문이 롤백돼도 이전 구문의 변경이 유지됨
 * - 이미 적용된 DDL 재실행은 경고로 처리 후 통과
 * - 마이그레이션은 모든 구문 시도 후 항상 적용 완료로 표시
 *   (서버 시작 블로킹 방지)
 */
export async function runMigrations(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const { rows: applied } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    const appliedSet = new Set(applied.map((r) => r.filename));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (appliedSet.has(file)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      const stmts = splitSqlStatements(sql);
      let errorCount = 0;

      for (const stmt of stmts) {
        try {
          await client.query(stmt);
        } catch (err: any) {
          const msg = String(err?.message ?? '');
          if (isIgnorable(msg)) {
            logger.warn(`⚠️ ${file} 구문 건너뜀: ${stmt.slice(0, 60).replace(/\n/g, ' ')} — ${msg.slice(0, 100)}`, {
              component: 'MIGRATE',
            });
          } else {
            errorCount++;
            logger.error(`❌ ${file} 구문 오류: ${stmt.slice(0, 60).replace(/\n/g, ' ')} — ${msg}`, {
              component: 'MIGRATE',
            });
          }
        }
      }

      // 모든 구문 시도 후 항상 적용 완료로 표시 (서버 시작 블로킹 방지)
      try {
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING', [
          file,
        ]);
      } catch {
        /* ignore */
      }

      if (errorCount === 0) {
        logger.info(`✅ 마이그레이션 적용: ${file} (${stmts.length}개 구문)`, { component: 'MIGRATE' });
      } else {
        logger.warn(`⚠️ 마이그레이션 부분 적용: ${file} (${errorCount}개 오류, ${stmts.length}개 구문)`, {
          component: 'MIGRATE',
        });
      }
    }

    logger.info(`📦 마이그레이션 완료 (총 ${files.length}개 파일)`, { component: 'MIGRATE' });
  } finally {
    client.release();
  }
}
