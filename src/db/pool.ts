/**
 * DB 풀 관리 — 연결, 재시도, 메모리 모드, 트랜잭션
 * (db/client.ts에서 추출)
 */
import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

// DATE(1082) → 문자열 그대로 반환 ("2026-06-04")
// pg-types v2의 기본 동작은 new Date(year, month, day)로 로컬 타임존 Date 객체 생성
// → .toISOString()하면 UTC 변환 시 날짜가 하루 밀리는 버그 발생
pg.types.setTypeParser(1082, (val: string) => val);

// NUMERIC/DECIMAL(1700) → number 변환
// pg 드라이버 기본: string 반환 → Zod z.number() 검증 시 실패 방지
pg.types.setTypeParser(1700, (val: string) => parseFloat(val));

// INT8/BIGINT(20) → number 변환
// JS Number.MAX_SAFE_INTEGER(2^53) 이하 범위에서 안전 (이 프로젝트의 BIGINT 사용처에 해당)
pg.types.setTypeParser(20, (val: string) => parseInt(val, 10));

let pool: pg.Pool | null = null;
let useMemory = false;
let _poolErrorCount = 0;

// 재시도 대상 에러 코드 (일시적 연결 문제)
const RETRIABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'CONNECTION_LOST',
  'PROTOCOL_CONNECTION_LOST',
  '57P01', // admin_shutdown
  '57P02', // database_admin_shutdown (Cloud SQL auto-suspend)
  '57P03', // cannot_connect_now (DB restarting)
  '57P04', // database_shutting_down
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08S01', // protocol_violation / connection reset
]);

function isRetriableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  const code = String(e.code ?? '');
  if (RETRIABLE_CODES.has(code)) return true;
  const msg = String(e.message ?? '').toLowerCase();
  return (
    msg.includes('connection terminated') ||
    msg.includes('connection refused') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('cannot connect') ||
    msg.includes('server closed the connection')
  );
}

/** DB 사용 불가 시 인메모리 모드 전환 */
export function isMemoryMode(): boolean {
  return useMemory;
}
export function enableMemoryMode(): void {
  useMemory = true;
  logger.warn('⚡ 인메모리 DB 모드 활성화 (PostgreSQL 미연결)', { component: 'DB' });
}

export function disableMemoryMode(): void {
  useMemory = false;
  logger.info('✅ DB 복구 확인 — 인메모리 모드 해제', { component: 'DB' });
}

/** 기존 Pool 파괴 후 새로 생성 — DB 복구 시 stale 커넥션 제거 */
export async function resetPool(): Promise<void> {
  if (pool) {
    try {
      await pool.end();
    } catch (err) {
      logger.warn(`Pool 종료 중 에러 (무시): ${err}`, { component: 'DB' });
    }
    pool = null;
  }
  _poolErrorCount = 0;
  logger.info('🔄 DB Pool 리셋 완료 — 새 커넥션으로 재연결', { component: 'DB' });
}

function createPool(): pg.Pool {
  const poolDefaults = {
    max: 8, // v10.11: Cloud Run 인스턴스당 커넥션 제한 (기존 20 → Cloud SQL 100 한도 초과 위험)
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
  };

  let newPool: pg.Pool;

  if (config.db.unixSocket) {
    newPool = new Pool({
      ...poolDefaults,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      host: config.db.unixSocket,
    });
  } else if (config.db.databaseUrl) {
    newPool = new Pool({ ...poolDefaults, connectionString: config.db.databaseUrl });
  } else {
    newPool = new Pool({
      ...poolDefaults,
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      ssl: config.env === 'production' ? { rejectUnauthorized: true } : false,
    });
  }

  newPool.on('error', (err) => {
    _poolErrorCount++;
    logger.error(`PostgreSQL pool 에러 (#${_poolErrorCount}): ${err.message}`, { component: 'DB' });
    // 연속 에러 5회 이상 → pool 폐기 (다음 getPool()에서 새로 생성)
    if (_poolErrorCount >= 5) {
      logger.warn('⚠️ Pool 에러 5회 초과 → pool 폐기 (다음 요청 시 재생성)', { component: 'DB' });
      newPool.end().catch(() => {});
      if (pool === newPool) pool = null;
      _poolErrorCount = 0;
    }
  });

  return newPool;
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = createPool();
    _poolErrorCount = 0;
  }
  return pool;
}

/** health check용 — DB 연결 확인 */
export async function checkDb(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    _poolErrorCount = 0;
    return true;
  } catch {
    return false;
  }
}

/**
 * 부팅 시 DB 연결 — 최대 retries회 재시도 (delayMs 간격)
 * Cloud SQL 기상 직후 연결 지연 대비, 매 실패마다 풀 리셋
 */
export async function checkDbWithRetry(retries = 4, delayMs = 5_000): Promise<boolean> {
  for (let i = 1; i <= retries; i++) {
    try {
      await getPool().query('SELECT 1');
      _poolErrorCount = 0;
      if (i > 1) logger.info(`✅ DB 연결 성공 (${i}/${retries}번째 시도)`, { component: 'DB' });
      return true;
    } catch (err) {
      logger.warn(`DB 연결 시도 ${i}/${retries} 실패: ${err}`, { component: 'DB' });
      if (i < retries) {
        await resetPool();
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  return false;
}

/** 메모리 모드 안전 쿼리 — 메모리 모드면 빈 결과 반환, 아니면 queryWithRetry */
export async function safeQuery<T extends pg.QueryResultRow = any>(
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<T>> {
  if (useMemory) return { rows: [] as T[], command: '', rowCount: 0, oid: 0, fields: [] };
  return queryWithRetry<T>(text, values);
}

/**
 * 쿼리 실행 + 일시적 에러 자동 재시도 (최대 2회)
 * - 연결 끊김, 타임아웃 등 일시적 에러만 재시도
 * - 쿼리 문법 에러 등은 즉시 throw
 */
export async function queryWithRetry<T extends pg.QueryResultRow = any>(
  text: string,
  values?: unknown[],
  maxRetries = 2,
): Promise<pg.QueryResult<T>> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await getPool().query<T>(text, values);
      if (attempt > 0) _poolErrorCount = 0;
      return result;
    } catch (err) {
      if (attempt < maxRetries && isRetriableError(err)) {
        logger.warn(`DB 쿼리 재시도 ${attempt + 1}/${maxRetries}: ${String((err as Error).message).slice(0, 80)}`, {
          component: 'DB',
        });
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        if (_poolErrorCount >= 3) {
          await resetPool();
        }
        continue;
      }
      throw err;
    }
  }
  throw new Error('queryWithRetry: unreachable');
}

// ── DB 트랜잭션 헬퍼 ──

const TRANSACTION_TIMEOUT_MS = 30_000; // 30초 트랜잭션 타임아웃 (커넥션 풀 leak 방지)

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  isolation: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' = 'REPEATABLE READ',
): Promise<T> {
  const client = await getPool().connect();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    // 커넥션 풀 leak guard: 트랜잭션 30초 초과 시 강제 롤백
    const result = await Promise.race([
      fn(client),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Transaction timeout (${TRANSACTION_TIMEOUT_MS}ms)`)), TRANSACTION_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    clearTimeout(timer);
    try { await client.query('ROLLBACK'); } catch { /* rollback 실패 시 무시 — finally에서 release */ }
    throw err;
  } finally {
    client.release();
  }
}
