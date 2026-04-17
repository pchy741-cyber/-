import pg from 'pg';
import { config } from '../config/index.js';
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

/** DB 사용 불가 시 인메모리 모드 전환 */
export function isMemoryMode(): boolean {
  return useMemory;
}
export function enableMemoryMode(): void {
  useMemory = true;
  logger.warn('⚡ 인메모리 DB 모드 활성화 (PostgreSQL 미연결)', { component: 'DB' });
}

export function getPool(): pg.Pool {
  if (!pool) {
    const poolDefaults = {
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    };

    if (config.db.unixSocket) {
      // Cloud Run → Cloud SQL (Unix socket)
      pool = new Pool({
        ...poolDefaults,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
        host: config.db.unixSocket,
      });
    } else if (config.db.databaseUrl) {
      pool = new Pool({ ...poolDefaults, connectionString: config.db.databaseUrl });
    } else {
      pool = new Pool({
        ...poolDefaults,
        host: config.db.host,
        port: config.db.port,
        database: config.db.database,
        user: config.db.user,
        password: config.db.password,
        ssl: config.env === 'production' ? { rejectUnauthorized: false } : false,
      });
    }

    pool.on('error', (err) => {
      logger.error(`PostgreSQL pool 에러: ${err.message}`, { component: 'DB' });
    });
  }
  return pool;
}

/** health check용 — DB 연결 확인 */
export async function checkDb(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// ── Watchlist ──

export async function getActiveWatchlist(): Promise<WatchlistItem[]> {
  if (useMemory) return memGetActiveWatchlist();
  const { rows } = await getPool().query('SELECT * FROM watchlist WHERE is_active = true ORDER BY added_at ASC');
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
    await getPool().query(
      `INSERT INTO watchlist (stock_code, stock_name, market, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (stock_code) DO UPDATE SET market = $3
         WHERE watchlist.stock_name IS NULL OR watchlist.stock_name = watchlist.stock_code`,
      [item.stock_code, item.stock_code, item.market, source],
    );
  } else {
    await getPool().query(
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
  await getPool().query(
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
  const { rows } = await getPool().query(
    `SELECT * FROM ai_scores WHERE stock_code IN (${placeholders}) AND score_date = $${validCodes.length + 1}
     AND composite_score > 0
     ORDER BY composite_score DESC`,
    [...validCodes, today],
  );

  if (rows.length > 0) return rows;

  // 오늘 없으면 최근 7일 이내 스코어 fallback (주말/공휴일 대비)
  const twoDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const { rows: fallbackRows } = await getPool().query(
    `SELECT DISTINCT ON (stock_code) * FROM ai_scores
     WHERE stock_code IN (${placeholders}) AND score_date >= $${validCodes.length + 1}
     AND composite_score > 0
     ORDER BY stock_code, score_date DESC, composite_score DESC`,
    [...validCodes, twoDaysAgo],
  );

  return fallbackRows;
}

// ── Market Sources (CEO 참고 소스) ──

export async function getRecentSources(limit = 20): Promise<Array<{ title: string; url: string; source_type: string; memo: string | null }>> {
  if (useMemory) return [];
  try {
    const { rows } = await getPool().query(
      'SELECT title, url, source_type, memo FROM market_sources ORDER BY is_pinned DESC, added_at DESC LIMIT $1',
      [limit],
    );
    return rows;
  } catch {
    return [];
  }
}

// ── Transaction Chains ──

export async function getOpenChains(): Promise<TransactionChain[]> {
  if (useMemory) return memGetOpenChains();
  const { rows } = await getPool().query(
    `SELECT tc.*, w.stock_name FROM transaction_chains tc
     LEFT JOIN watchlist w ON tc.stock_code = w.stock_code
     WHERE tc.status IN ('OPEN','AVERAGING','PROFIT_TAKING')
     ORDER BY tc.opened_at DESC`,
  );
  return rows;
}

export async function createChain(
  chain: Omit<TransactionChain, 'id' | 'opened_at' | 'closed_at' | 'close_reason'>,
): Promise<string> {
  if (useMemory) return memCreateChain(chain);
  const { rows } = await getPool().query(
    `INSERT INTO transaction_chains (stock_code, status, strategy_mode, avg_buy_price,
       total_quantity, total_invested, realized_pnl, target_profit_pct, stop_loss_pct,
       max_averaging_count, current_averaging_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
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
    ],
  );
  return rows[0].id;
}

const CHAIN_ALLOWED_COLS = new Set([
  'status', 'strategy_mode', 'avg_buy_price', 'total_quantity', 'total_invested',
  'realized_pnl', 'target_profit_pct', 'stop_loss_pct', 'max_averaging_count',
  'current_averaging_count', 'opened_at', 'closed_at', 'close_reason',
]);

export async function updateChain(id: string, updates: Partial<TransactionChain>) {
  if (useMemory) { memUpdateChain(id, updates); return; }
  const keys = Object.keys(updates).filter((k) => CHAIN_ALLOWED_COLS.has(k));
  if (keys.length === 0) return;
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`);
  const values = keys.map((k) => (updates as Record<string, unknown>)[k]);
  await getPool().query(`UPDATE transaction_chains SET ${setClauses.join(', ')} WHERE id = $1`, [id, ...values]);
}

// ── Orders ──

export async function insertOrder(order: Omit<Order, 'id' | 'created_at' | 'updated_at'>): Promise<string> {
  if (useMemory) return memInsertOrder(order);
  const { rows } = await getPool().query(
    `INSERT INTO orders (chain_id, stock_code, side, order_type, quantity, price,
       kis_order_no, kis_status, filled_quantity, filled_price, status, trading_mode,
       trigger_source, ai_reasoning)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
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
    ],
  );
  return rows[0].id;
}

const ORDER_ALLOWED_COLS = new Set([
  'chain_id', 'stock_code', 'side', 'order_type', 'quantity', 'price',
  'kis_order_no', 'kis_status', 'filled_quantity', 'filled_price', 'status',
  'trading_mode', 'trigger_source', 'ai_reasoning',
]);

export async function updateOrder(id: string, updates: Partial<Order>) {
  if (useMemory) { memUpdateOrder(id, updates); return; }
  const keys = Object.keys(updates).filter((k) => ORDER_ALLOWED_COLS.has(k));
  if (keys.length === 0) return;
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`);
  setClauses.push(`updated_at = NOW()`);
  const values = keys.map((k) => (updates as Record<string, unknown>)[k]);
  await getPool().query(`UPDATE orders SET ${setClauses.join(', ')} WHERE id = $1`, [id, ...values]);
}

export async function updateOrderByKisOrderNo(kisOrderNo: string, updates: Partial<Order>) {
  if (useMemory) { memUpdateOrderByKisOrderNo(kisOrderNo, updates); return; }
  const keys = Object.keys(updates).filter((k) => ORDER_ALLOWED_COLS.has(k));
  if (keys.length === 0) return;
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`);
  setClauses.push(`updated_at = NOW()`);
  const values = keys.map((k) => (updates as Record<string, unknown>)[k]);
  await getPool().query(`UPDATE orders SET ${setClauses.join(', ')} WHERE kis_order_no = $1`, [kisOrderNo, ...values]);
}

export async function getOrdersByChain(chainId: string): Promise<Order[]> {
  if (useMemory) return memGetOrdersByChain(chainId);
  const { rows } = await getPool().query('SELECT * FROM orders WHERE chain_id = $1 ORDER BY created_at ASC', [chainId]);
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
}) {
  if (useMemory) { memInsertSnapshot(snapshot); return; }
  await getPool().query(
    `INSERT INTO portfolio_snapshots (total_value, cash_balance, invested_value,
       unrealized_pnl, daily_pnl, daily_pnl_pct, positions)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      snapshot.total_value,
      snapshot.cash_balance,
      snapshot.invested_value,
      snapshot.unrealized_pnl,
      snapshot.daily_pnl,
      snapshot.daily_pnl_pct,
      JSON.stringify(snapshot.positions),
    ],
  );
}

export async function getTodayStartSnapshot() {
  if (useMemory) return memGetTodayStartSnapshot();
  const today = new Date().toISOString().split('T')[0];
  const { rows } = await getPool().query(
    `SELECT * FROM portfolio_snapshots WHERE snapshot_at >= $1
     ORDER BY snapshot_at ASC LIMIT 1`,
    [`${today}T00:00:00`],
  );
  return rows[0] ?? null;
}

// ── Strategy Config ──

export async function getActiveStrategy(): Promise<StrategyConfig | null> {
  if (useMemory) return memGetActiveStrategy();
  const { rows } = await getPool().query(
    `SELECT * FROM strategy_config WHERE is_active = true
     ORDER BY updated_at DESC LIMIT 1`,
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
    logger.error(`시스템 로그 DB 기록 실패: ${err}`);
  }
}

// ── 손실 종목 쿨다운 ──

/** CEO 수동 매도 후 N시간 이내 재진입 금지 종목 반환 */
export async function getRecentManuallySoldStocks(hoursBack = 24): Promise<Set<string>> {
  if (useMemory) return new Set();
  try {
    const { rows } = await getPool().query(
      `SELECT DISTINCT stock_code FROM transaction_chains
       WHERE status = 'CLOSED'
         AND close_reason = 'CEO 수동 매도'
         AND closed_at > NOW() - INTERVAL '${hoursBack} hours'`,
    );
    return new Set(rows.map((r: { stock_code: string }) => r.stock_code));
  } catch {
    return new Set();
  }
}

/** 최근 N일 이내 손절 청산된 종목 코드 반환 (재진입 방지) */
export async function getRecentLossStocks(daysBack = 14): Promise<Set<string>> {
  if (useMemory) return new Set();
  try {
    const { rows } = await getPool().query(
      `SELECT DISTINCT stock_code FROM transaction_chains
       WHERE status = 'CLOSED'
         AND realized_pnl < -5000
         AND closed_at > NOW() - INTERVAL '${daysBack} days'`,
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
    await getPool().query(
      'INSERT INTO risk_events (event_type, severity, details, action_taken) VALUES ($1,$2,$3,$4)',
      [event.event_type, event.severity, event.details ? JSON.stringify(event.details) : null, event.action_taken],
    );
  } catch (err) {
    logger.error(`리스크 이벤트 기록 실패: ${err}`);
  }
}
