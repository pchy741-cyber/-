import pg from 'pg';
import { config } from '../config/index.js';
import { getCtxIsPaper } from '../config/context.js';
import { logger } from '../utils/logger.js';
import {
  memCreateChain,
  memGetActiveStrategy,
  memGetActiveWatchlist,
  memGetLatestScores,
  memGetOpenChains,
  memGetOrdersByChain,
  memGetTodayStartSnapshot,
  memInsertOrder,
  memInsertRiskEvent,
  memInsertSnapshot,
  memLogSystem,
  memUpdateChain,
  memUpdateOrder,
  memUpdateOrderByKisOrderNo,
  memUpsertAIScore,
  memUpsertWatchlistItem,
} from './memory-store.js';
import type { AIScore, Order, StrategyConfig, TransactionChain, WatchlistItem } from './models.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let useMemory = false;
let _poolErrorCount = 0;

// 재시도 대상 에러 코드 (일시적 연결 문제)
const RETRIABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'CONNECTION_LOST', 'PROTOCOL_CONNECTION_LOST',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now (DB restarting)
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
]);

function isRetriableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  const code = String(e.code ?? '');
  if (RETRIABLE_CODES.has(code)) return true;
  const msg = String(e.message ?? '').toLowerCase();
  return msg.includes('connection terminated') ||
    msg.includes('connection refused') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('cannot connect') ||
    msg.includes('server closed the connection');
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
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
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
        await new Promise(r => setTimeout(r, delayMs));
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
        logger.warn(
          `DB 쿼리 재시도 ${attempt + 1}/${maxRetries}: ${String((err as Error).message).slice(0, 80)}`,
          { component: 'DB' },
        );
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
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

// ── Watchlist ──

export async function getActiveWatchlist(): Promise<WatchlistItem[]> {
  if (useMemory) return memGetActiveWatchlist();
  const { rows } = await queryWithRetry('SELECT * FROM watchlist WHERE is_active = true ORDER BY added_at ASC');
  return rows;
}

// 종목명 깨짐 감지 (특수문자 ◆ 등)
function isGarbledStockName(name: string): boolean {
  if (!name) return true;
  return /[^\w\s\uAC00-\uD7A3\u3131-\u318E\u1100-\u11FF().,·\-+%$]/.test(name);
}

export async function upsertWatchlistItem(
  item: Pick<WatchlistItem, 'stock_code' | 'stock_name' | 'market'>,
  source: 'MANUAL' | 'KIS_SYNC' | 'AUTO' = 'MANUAL',
) {
  if (useMemory) { memUpsertWatchlistItem(item); return; }
  // 깨진 종목명으로 기존 정상 이름을 덮어쓰지 않음
  const nameIsGarbled = isGarbledStockName(item.stock_name);
  if (nameIsGarbled) {
    await queryWithRetry(
      `INSERT INTO watchlist (stock_code, stock_name, market, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (stock_code) DO UPDATE SET market = $3
         WHERE watchlist.stock_name IS NULL OR watchlist.stock_name = watchlist.stock_code`,
      [item.stock_code, item.stock_code, item.market, source],
    );
  } else {
    await queryWithRetry(
      `INSERT INTO watchlist (stock_code, stock_name, market, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (stock_code) DO UPDATE SET stock_name = $2, market = $3`,
      [item.stock_code, item.stock_name, item.market, source],
    );
  }
}

// ── AI Scores ──

export async function upsertAIScore(score: Omit<AIScore, 'id' | 'created_at'>) {
  if (useMemory) { memUpsertAIScore(score); return; }
  await queryWithRetry(
    `INSERT INTO ai_scores (stock_code, score_date, gemini_summary, composite_score,
       fundamental_score, technical_score, sentiment_score, confidence, reasoning,
       signal, target_price, stop_loss_price)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (stock_code, score_date) DO UPDATE SET
       gemini_summary=$3, composite_score=$4, fundamental_score=$5,
       technical_score=$6, sentiment_score=$7, confidence=$8, reasoning=$9,
       signal=$10, target_price=$11, stop_loss_price=$12`,
    [
      score.stock_code,
      score.score_date,
      JSON.stringify(score.gemini_summary),
      score.composite_score,
      score.fundamental_score,
      score.technical_score,
      score.sentiment_score,
      score.confidence,
      score.reasoning,
      score.signal,
      score.target_price,
      score.stop_loss_price,
    ],
  );
}

export async function getLatestScores(stockCodes: string[]): Promise<AIScore[]> {
  if (!stockCodes || stockCodes.length === 0) return [];
  const validCodes = stockCodes.filter((c) => c != null && c.length > 0);
  if (validCodes.length === 0) return [];
  if (useMemory) return memGetLatestScores(validCodes);

  const today = new Date().toISOString().split('T')[0];
  const placeholders = validCodes.map((_, i) => `$${i + 1}`).join(',');

  // 오늘 스코어 먼저 조회
  const { rows } = await queryWithRetry(
    `SELECT * FROM ai_scores WHERE stock_code IN (${placeholders}) AND score_date = $${validCodes.length + 1}
     AND composite_score > 0
     ORDER BY composite_score DESC`,
    [...validCodes, today],
  );

  if (rows.length > 0) return rows;

  // 오늘 없으면 최근 7일 이내 스코어 fallback (주말/공휴일 대비)
  const twoDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const { rows: fallbackRows } = await queryWithRetry(
    `SELECT DISTINCT ON (stock_code) * FROM ai_scores
     WHERE stock_code IN (${placeholders}) AND score_date >= $${validCodes.length + 1}
     AND composite_score > 0
     ORDER BY stock_code, score_date DESC, composite_score DESC`,
    [...validCodes, twoDaysAgo],
  );

  return fallbackRows;
}

/** 오늘(또는 최근 7일) 채점된 전체 종목 점수 조회 — 워치리스트 범위 불일치 해결 */
export async function getAllRecentScores(): Promise<AIScore[]> {
  if (useMemory) return [];
  const today = new Date().toISOString().split('T')[0];
  const { rows } = await queryWithRetry(
    `SELECT * FROM ai_scores WHERE score_date = $1 AND composite_score > 0 ORDER BY composite_score DESC`,
    [today],
  );
  if (rows.length > 0) return rows;
  // 오늘 없으면 최근 2일 fallback
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const { rows: fallback } = await queryWithRetry(
    `SELECT DISTINCT ON (stock_code) * FROM ai_scores WHERE score_date >= $1 AND composite_score > 0 ORDER BY stock_code, score_date DESC`,
    [twoDaysAgo],
  );
  return fallback;
}

// ── Market Sources (CEO 참고 소스) ──

export async function getRecentSources(limit = 20): Promise<Array<{ title: string; url: string; source_type: string; memo: string | null }>> {
  if (useMemory) return [];
  try {
    const { rows } = await queryWithRetry(
      'SELECT title, url, source_type, memo FROM market_sources ORDER BY is_pinned DESC, added_at DESC LIMIT $1',
      [limit],
    );
    return rows;
  } catch {
    return [];
  }
}

// ── DB 트랜잭션 헬퍼 ──

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Transaction Chains ──

export async function getOpenChains(isPaperOverride?: boolean): Promise<TransactionChain[]> {
  if (useMemory) return memGetOpenChains();
  const isPaper = isPaperOverride ?? getCtxIsPaper();
  const { rows } = await queryWithRetry(
    `SELECT tc.*, w.stock_name, tc.peak_price_since_open,
       (SELECT trigger_source FROM orders WHERE chain_id = tc.id AND side = 'BUY' ORDER BY created_at ASC LIMIT 1) AS trigger_source
     FROM transaction_chains tc
     LEFT JOIN watchlist w ON tc.stock_code = w.stock_code
     WHERE tc.status IN ('OPEN','AVERAGING','PROFIT_TAKING')
       AND tc.is_paper = $1
     ORDER BY tc.opened_at DESC`,
    [isPaper],
  );
  return rows;
}

export async function createChain(
  chain: Omit<TransactionChain, 'id' | 'opened_at' | 'closed_at' | 'close_reason'>,
): Promise<string> {
  if (useMemory) return memCreateChain(chain);
  const { rows } = await queryWithRetry(
    `INSERT INTO transaction_chains (stock_code, status, strategy_mode, avg_buy_price,
       total_quantity, total_invested, realized_pnl, target_profit_pct, stop_loss_pct,
       max_averaging_count, current_averaging_count, is_paper)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      chain.stock_code,
      chain.status,
      chain.strategy_mode,
      chain.avg_buy_price,
      chain.total_quantity,
      chain.total_invested,
      chain.realized_pnl,
      chain.target_profit_pct,
      chain.stop_loss_pct,
      chain.max_averaging_count,
      chain.current_averaging_count,
      chain.is_paper ?? getCtxIsPaper(),
    ],
  );
  return rows[0].id;
}

const CHAIN_ALLOWED_COLS = new Set([
  'status', 'strategy_mode', 'avg_buy_price', 'total_quantity', 'total_invested',
  'realized_pnl', 'target_profit_pct', 'stop_loss_pct', 'max_averaging_count',
  'current_averaging_count', 'peak_price', 'peak_price_since_open',
  'opened_at', 'closed_at', 'close_reason',
]);

export async function updateChain(id: string, updates: Partial<TransactionChain>) {
  if (useMemory) { memUpdateChain(id, updates); return; }
  const keys = Object.keys(updates).filter((k) => CHAIN_ALLOWED_COLS.has(k));
  if (keys.length === 0) return;
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`);
  const values = keys.map((k) => (updates as Record<string, unknown>)[k]);
  await queryWithRetry(`UPDATE transaction_chains SET ${setClauses.join(', ')} WHERE id = $1`, [id, ...values]);
}

// ── Orders ──

export async function insertOrder(order: Omit<Order, 'id' | 'created_at' | 'updated_at'>): Promise<string> {
  if (useMemory) return memInsertOrder(order);
  const { rows } = await queryWithRetry(
    `INSERT INTO orders (chain_id, stock_code, side, order_type, quantity, price,
       kis_order_no, kis_status, filled_quantity, filled_price, status, trading_mode,
       trigger_source, ai_reasoning, avg_buy_price)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [
      order.chain_id,
      order.stock_code,
      order.side,
      order.order_type,
      order.quantity,
      order.price,
      order.kis_order_no,
      order.kis_status,
      order.filled_quantity,
      order.filled_price,
      order.status,
      order.trading_mode,
      order.trigger_source,
      order.ai_reasoning,
      order.avg_buy_price ?? null,
    ],
  );
  return rows[0].id;
}

const ORDER_ALLOWED_COLS = new Set([
  'chain_id', 'stock_code', 'side', 'order_type', 'quantity', 'price',
  'kis_order_no', 'kis_status', 'filled_quantity', 'filled_price', 'status',
  'trading_mode', 'trigger_source', 'ai_reasoning', 'avg_buy_price',
]);

export async function updateOrder(id: string, updates: Partial<Order>) {
  if (useMemory) { memUpdateOrder(id, updates); return; }
  const keys = Object.keys(updates).filter((k) => ORDER_ALLOWED_COLS.has(k));
  if (keys.length === 0) return;
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`);
  setClauses.push(`updated_at = NOW()`);
  const values = keys.map((k) => (updates as Record<string, unknown>)[k]);
  await queryWithRetry(`UPDATE orders SET ${setClauses.join(', ')} WHERE id = $1`, [id, ...values]);
}

export async function updateOrderByKisOrderNo(kisOrderNo: string, updates: Partial<Order>) {
  if (useMemory) { memUpdateOrderByKisOrderNo(kisOrderNo, updates); return; }
  const keys = Object.keys(updates).filter((k) => ORDER_ALLOWED_COLS.has(k));
  if (keys.length === 0) return;
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`);
  setClauses.push(`updated_at = NOW()`);
  const values = keys.map((k) => (updates as Record<string, unknown>)[k]);
  await queryWithRetry(`UPDATE orders SET ${setClauses.join(', ')} WHERE kis_order_no = $1`, [kisOrderNo, ...values]);
}

export async function getOrdersByChain(chainId: string): Promise<Order[]> {
  if (useMemory) return memGetOrdersByChain(chainId);
  const { rows } = await queryWithRetry('SELECT * FROM orders WHERE chain_id = $1 ORDER BY created_at ASC', [chainId]);
  return rows;
}

export async function getPendingDomesticOrders(): Promise<Order[]> {
  if (useMemory) return [];
  const { rows } = await queryWithRetry(
    `SELECT * FROM orders
     WHERE status IN ('PENDING', 'PARTIAL')
       AND (trigger_source IS NULL OR trigger_source != 'OVERSEAS')
       AND created_at >= NOW() - INTERVAL '2 hours'
       AND kis_order_no IS NOT NULL
       AND trading_mode = $1
     ORDER BY created_at ASC`,
    [config.tradingMode],
  );
  return rows;
}

// ── Portfolio Snapshots ──

export async function insertSnapshot(snapshot: {
  total_value: number;
  cash_balance: number;
  invested_value: number;
  unrealized_pnl: number;
  daily_pnl: number;
  daily_pnl_pct: number;
  positions: unknown;
  is_paper?: boolean;
}) {
  if (useMemory) { memInsertSnapshot(snapshot); return; }
  await queryWithRetry(
    `INSERT INTO portfolio_snapshots (total_value, cash_balance, invested_value,
       unrealized_pnl, daily_pnl, daily_pnl_pct, positions, is_paper)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      snapshot.total_value,
      snapshot.cash_balance,
      snapshot.invested_value,
      snapshot.unrealized_pnl,
      snapshot.daily_pnl,
      snapshot.daily_pnl_pct,
      JSON.stringify(snapshot.positions),
      snapshot.is_paper ?? config.isPaper,
    ],
  );
}

export async function getTodayStartSnapshot(isPaperOverride?: boolean) {
  if (useMemory) return memGetTodayStartSnapshot();
  const isPaper = isPaperOverride ?? getCtxIsPaper();
  const today = new Date().toISOString().split('T')[0];
  const { rows } = await queryWithRetry(
    `SELECT * FROM portfolio_snapshots WHERE snapshot_at >= $1 AND is_paper = $2
     ORDER BY snapshot_at ASC LIMIT 1`,
    [`${today}T00:00:00`, isPaper],
  );
  return rows[0] ?? null;
}

// ── Strategy Config ──

export async function getActiveStrategy(): Promise<StrategyConfig | null> {
  if (useMemory) return memGetActiveStrategy();
  const { rows } = await queryWithRetry(
    `SELECT * FROM strategy_config WHERE is_active = true AND is_paper = $1
     ORDER BY updated_at DESC LIMIT 1`,
    [getCtxIsPaper()],
  );
  return rows[0] ?? null;
}

// ── System Log ──

export async function logSystem(
  level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE',
  component: string,
  message: string,
  details?: unknown,
) {
  if (useMemory) { memLogSystem(level, component, message, details); return; }
  try {
    await getPool().query('INSERT INTO system_log (level, component, message, details) VALUES ($1,$2,$3,$4)', [
      level,
      component,
      message,
      details ? JSON.stringify(details) : null,
    ]);
  } catch (err) {
    // DB 미연결 시 에러 스팸 방지: 60초에 1번만 경고
    const now = Date.now();
    if (now - _lastLogErrorAt > 60_000) {
      _lastLogErrorAt = now;
      logger.error(`시스템 로그 DB 기록 실패 (60초 스로틀): ${err}`);
    }
  }
}
let _lastLogErrorAt = 0;

// ── 손실 종목 쿨다운 ──

/** CEO 수동 매도 후 N시간 이내 재진입 금지 종목 반환 */
export async function getRecentManuallySoldStocks(hoursBack = 24): Promise<Set<string>> {
  if (useMemory) return new Set();
  try {
    const { rows } = await queryWithRetry(
      `SELECT DISTINCT stock_code FROM transaction_chains
       WHERE status = 'CLOSED'
         AND close_reason = 'CEO 수동 매도'
         AND is_paper = $1
         AND closed_at > NOW() - ($2 || ' hours')::interval`,
      [getCtxIsPaper(), hoursBack],
    );
    return new Set(rows.map((r: { stock_code: string }) => r.stock_code));
  } catch {
    return new Set();
  }
}

/** 최근 매도(CLOSED) 종목 쿨다운 — 매도 후 재진입 방지 (삼성 반복매수 등) */
export async function getRecentlySoldStocks(hoursBack = 2): Promise<Set<string>> {
  if (useMemory) return new Set();
  try {
    const { rows } = await queryWithRetry(
      `SELECT DISTINCT stock_code FROM transaction_chains
       WHERE status = 'CLOSED'
         AND is_paper = $1
         AND closed_at > NOW() - ($2 || ' hours')::interval`,
      [getCtxIsPaper(), hoursBack],
    );
    return new Set(rows.map((r: { stock_code: string }) => r.stock_code));
  } catch {
    return new Set();
  }
}

/** 최근 손절 종목 코드 반환 (졸업식 재진입 방지)
 *  - 일반 손실(>5000원): 7일 차단
 *  - 대손실(>50000원): 14일 차단
 *  - ATR/손절 사유 매도: 7일 차단 (같은 패턴 반복 방지)
 */
export async function getRecentLossStocks(daysBack = 14): Promise<Set<string>> {
  if (useMemory) return new Set();
  try {
    // 1) 일반 손실 7일 + 대손실 14일 졸업식 차단
    const { rows } = await queryWithRetry(
      `SELECT DISTINCT stock_code FROM transaction_chains
       WHERE status = 'CLOSED'
         AND is_paper = $1
         AND (
           (realized_pnl < -5000  AND closed_at > NOW() - INTERVAL '7 days')
           OR
           (realized_pnl < -50000 AND closed_at > NOW() - INTERVAL '14 days')
         )`,
      [getCtxIsPaper()],
    );
    const blocked = new Set(rows.map((r: { stock_code: string }) => r.stock_code));

    // 2) ATR/손절 사유로 매도된 종목 7일 추가 차단
    const { rows: slRows } = await queryWithRetry(
      `SELECT DISTINCT o.stock_code FROM orders o
       WHERE o.side = 'SELL' AND o.status = 'FILLED'
         AND o.trading_mode = $1
         AND o.created_at > NOW() - INTERVAL '7 days'
         AND (o.ai_reasoning LIKE '%손절%' OR o.ai_reasoning LIKE '%ATR트레일%'
              OR o.ai_reasoning LIKE '%FORCE_CLOSE%' OR o.ai_reasoning LIKE '%시간 손절%')`,
      [config.tradingMode],
    );
    for (const r of slRows) blocked.add(r.stock_code);

    return blocked;
  } catch {
    return new Set();
  }
}

/**
 * 5% 초과 손실 매도 종목 — 30일 절대 차단 (CEO allowRebuy override 없이 재매수 불가)
 * AI 점수와 무관하게 차단. 손해보고 판 걸 또 사는 건 금지.
 */
export async function getBigLossBlockedStocks(): Promise<Set<string>> {
  if (useMemory) return new Set();
  try {
    const { rows } = await queryWithRetry(
      `SELECT DISTINCT stock_code FROM transaction_chains
       WHERE status = 'CLOSED'
         AND is_paper = $1
         AND pnl_pct < -5.0
         AND closed_at > NOW() - INTERVAL '30 days'`,
      [getCtxIsPaper()],
    );
    return new Set(rows.map((r: { stock_code: string }) => r.stock_code));
  } catch {
    return new Set();
  }
}

/**
 * 당일 손절 2회 이상 종목 — 재진입 금지 (당일 한정)
 */
export async function getTodayRepeatStopCodes(minStops = 2): Promise<Set<string>> {
  if (useMemory) return new Set();
  try {
    const { rows } = await queryWithRetry(
      `SELECT stock_code, COUNT(*) AS stop_count
         FROM transaction_chains
        WHERE status = 'CLOSED'
          AND realized_pnl < 0
          AND is_paper = $1
          AND closed_at >= CURRENT_DATE AT TIME ZONE 'Asia/Seoul'
        GROUP BY stock_code
       HAVING COUNT(*) >= $2`,
      [getCtxIsPaper(), minStops],
    );
    return new Set(rows.map((r: { stock_code: string }) => r.stock_code));
  } catch {
    return new Set();
  }
}

// ── Risk Events ──

export async function insertRiskEvent(event: {
  event_type: string;
  severity: 'WARNING' | 'CRITICAL';
  details?: unknown;
  action_taken: string;
}) {
  if (useMemory) { memInsertRiskEvent(event); return; }
  try {
    await queryWithRetry(
      'INSERT INTO risk_events (event_type, severity, details, action_taken) VALUES ($1,$2,$3,$4)',
      [event.event_type, event.severity, event.details ? JSON.stringify(event.details) : null, event.action_taken],
    );
  } catch (err) {
    logger.error(`리스크 이벤트 기록 실패: ${err}`);
  }
}
