import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import { getPool } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// 무시해도 되는 postgres 오류 패턴 (이미 적용된 DDL 재실행)
// ⚠️ 패턴은 최대한 구체적으로 — 'relation', 'does not exist' 등 광범위 패턴은 실제 오류를 은폐함
const IGNORABLE = [
  'already exists',
  'duplicate column',
  'column .* does not exist', // DROP COLUMN 재실행
  'column .* of relation .* does not exist',
  'cannot alter type',
  'cannot change',
  'multiple primary keys',
  'there is no unique constraint',
  'is not a table',
];

function isIgnorable(msg: string): boolean {
  const m = msg.toLowerCase();
  return IGNORABLE.some((p) => p.includes('.*') ? new RegExp(p).test(m) : m.includes(p));
}

/**
 * ';' 구분자로 SQL 파일을 개별 구문으로 분리한다.
 * $$ 달러쿼팅 블록(PL/pgSQL DO/CREATE FUNCTION)은 내부 세미콜론을 보호한다.
 * 빈 구문 및 주석만 있는 청크는 제외한다.
 */
function splitSqlStatements(sql: string): string[] {
  const stmts: string[] = [];
  let current = '';
  let inDollarQuote = false;

  // $$ 블록 안의 세미콜론을 무시하며 분리
  const parts = sql.split('$$');
  for (let i = 0; i < parts.length; i++) {
    if (inDollarQuote) {
      // $$ 블록 내부: 세미콜론 포함 그대로 유지
      current += '$$' + parts[i];
      inDollarQuote = false;
    } else {
      // 일반 SQL: 세미콜론으로 분리
      const subParts = parts[i].split(';');
      for (let j = 0; j < subParts.length; j++) {
        current += subParts[j];
        if (j < subParts.length - 1) {
          // 세미콜론에서 구문 완료
          const trimmed = current.trim();
          if (trimmed) {
            const withoutComments = trimmed.replace(/--[^\n]*/g, '').trim();
            if (withoutComments.length > 0) stmts.push(trimmed);
          }
          current = '';
        }
      }
      if (i < parts.length - 1) {
        current += '$$';
        inDollarQuote = true;
      }
    }
  }
  // 마지막 잔여 구문
  const trimmed = current.trim();
  if (trimmed) {
    const withoutComments = trimmed.replace(/--[^\n]*/g, '').trim();
    if (withoutComments.length > 0) stmts.push(trimmed);
  }
  return stmts;
}

/**
 * 파괴적 SQL 패턴 감지 (DELETE/TRUNCATE/DROP TABLE)
 * -- DESTRUCTIVE_APPROVED 마커 없으면 실행 차단
 */
const DESTRUCTIVE_PATTERN = /^\s*(DELETE\s+FROM|TRUNCATE\s+TABLE|TRUNCATE\s+\w|DROP\s+TABLE)/im;
const DESTRUCTIVE_APPROVAL_MARKER = '-- DESTRUCTIVE_APPROVED';

function hasDestructiveStatements(sql: string): boolean {
  // 주석 제거 후 확인
  const withoutComments = sql.replace(/--[^\n]*/g, '');
  return DESTRUCTIVE_PATTERN.test(withoutComments);
}

/**
 * SQL 마이그레이션 파일을 순서대로 실행한다.
 * - schema_migrations 테이블로 적용 여부 추적
 * - 단일 커넥션 재사용
 * - 각 파일을 구문 단위로 개별 실행 (전체 파일 트랜잭션 금지)
 *   → 한 구문이 롤백돼도 이전 구문의 변경이 유지됨
 * - 이미 적용된 DDL 재실행은 경고로 처리 후 통과
 * - 파괴적 SQL(DELETE/TRUNCATE/DROP) 포함 시 -- DESTRUCTIVE_APPROVED 마커 필수
 *   → 마커 없으면 실행 차단 (데이터 유실 방지)
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

      // 파괴적 SQL 감지 — 승인 마커 없으면 차단 (데이터 유실 방지)
      if (hasDestructiveStatements(sql) && !sql.includes(DESTRUCTIVE_APPROVAL_MARKER)) {
        logger.error(
          `🚫 [DESTRUCTIVE_BLOCKED] ${file}: DELETE/TRUNCATE/DROP 감지 — 파일 상단에 '${DESTRUCTIVE_APPROVAL_MARKER}' 마커 필요. 실행 차단됨.`,
          { component: 'MIGRATE' },
        );
        continue; // schema_migrations에 기록 안 함 → 다음 배포에도 계속 차단
      }

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

      if (errorCount === 0) {
        // 모든 구문 성공 시에만 적용 완료로 표시
        try {
          await client.query(
            'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
            [file],
          );
        } catch {
          /* ignore */
        }
        logger.info(`✅ 마이그레이션 적용: ${file} (${stmts.length}개 구문)`, { component: 'MIGRATE' });
      } else {
        // 오류 발생 시 미기록 → 다음 배포에서 재시도 (부분 적용 상태를 완료로 오인 방지)
        logger.error(
          `❌ 마이그레이션 부분 실패: ${file} (${errorCount}개 오류/${stmts.length}개 구문) — schema_migrations 미기록, 다음 배포에서 재시도됨`,
          { component: 'MIGRATE' },
        );
        try {
          const { sendTelegramMessage } = await import('../notifications/telegram.js');
          sendTelegramMessage(
            `⚠️ 마이그레이션 부분 실패\n파일: ${file}\n오류: ${errorCount}개/${stmts.length}개 구문\n→ 다음 배포에서 재시도됩니다`,
          ).catch(() => {});
        } catch {
          /* ignore */
        }
      }
    }

    logger.info(`📦 마이그레이션 완료 (총 ${files.length}개 파일)`, { component: 'MIGRATE' });
  } finally {
    client.release();
  }
}
