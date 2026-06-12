import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger.js';

// ── Constants ──

const PROJECT_ID = 'quantops-trading';
const LOCATION = 'asia-northeast3';
const DATASET_ID = 'quantops_analytics';
const COMPONENT = 'BigQueryPipeline';

// ── Types ──

export interface TradeRecord {
  stock_code: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  pnl: number;
  ai_score: number;
  strategy_mode: string;
  timestamp: string; // ISO 8601
}

export interface DailySnapshotRecord {
  total_value: number;
  cash: number;
  invested: number;
  pnl: number;
  positions_count: number;
  timestamp: string;
}

export interface AISignalRecord {
  stock_code: string;
  composite_score: number;
  signal: string;
  investor_flow_trend: string;
  action_taken: string;
  timestamp: string;
}

export interface PerformanceReport {
  total_return: number;
  win_rate: number;
  avg_holding_period_hours: number;
  best_trade: { stock_code: string; pnl: number } | null;
  worst_trade: { stock_code: string; pnl: number } | null;
  total_trades: number;
}

// ── Table Schemas ──

const TRADES_SCHEMA = [
  { name: 'stock_code', type: 'STRING', mode: 'REQUIRED' as const },
  { name: 'side', type: 'STRING', mode: 'REQUIRED' as const },
  { name: 'quantity', type: 'INTEGER', mode: 'REQUIRED' as const },
  { name: 'price', type: 'FLOAT', mode: 'REQUIRED' as const },
  { name: 'pnl', type: 'FLOAT', mode: 'NULLABLE' as const },
  { name: 'ai_score', type: 'FLOAT', mode: 'NULLABLE' as const },
  { name: 'strategy_mode', type: 'STRING', mode: 'NULLABLE' as const },
  { name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED' as const },
];

const DAILY_SNAPSHOTS_SCHEMA = [
  { name: 'total_value', type: 'FLOAT', mode: 'REQUIRED' as const },
  { name: 'cash', type: 'FLOAT', mode: 'REQUIRED' as const },
  { name: 'invested', type: 'FLOAT', mode: 'REQUIRED' as const },
  { name: 'pnl', type: 'FLOAT', mode: 'REQUIRED' as const },
  { name: 'positions_count', type: 'INTEGER', mode: 'REQUIRED' as const },
  { name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED' as const },
];

const AI_SIGNALS_SCHEMA = [
  { name: 'stock_code', type: 'STRING', mode: 'REQUIRED' as const },
  { name: 'composite_score', type: 'FLOAT', mode: 'REQUIRED' as const },
  { name: 'signal', type: 'STRING', mode: 'REQUIRED' as const },
  { name: 'investor_flow_trend', type: 'STRING', mode: 'NULLABLE' as const },
  { name: 'action_taken', type: 'STRING', mode: 'NULLABLE' as const },
  { name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED' as const },
];

// ── Singleton ──

let bq: BigQuery | null = null;
let _initialized = false;

function getClient(): BigQuery | null {
  if (!bq) {
    try {
      bq = new BigQuery({ projectId: PROJECT_ID, location: LOCATION });
    } catch (err) {
      logger.warn(`BigQuery 클라이언트 생성 실패 — 파이프라인 비활성: ${err}`, { component: COMPONENT });
      return null;
    }
  }
  return bq;
}

// ── Init ──

export async function initBigQuery(): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    const dataset = client.dataset(DATASET_ID);
    const [exists] = await dataset.exists();
    if (!exists) {
      await client.createDataset(DATASET_ID, { location: LOCATION });
      logger.info(`데이터셋 ${DATASET_ID} 생성 완료`, { component: COMPONENT });
    }

    // 테이블 생성 (없으면)
    const tables: Array<{ id: string; schema: typeof TRADES_SCHEMA }> = [
      { id: 'trades', schema: TRADES_SCHEMA },
      { id: 'daily_snapshots', schema: DAILY_SNAPSHOTS_SCHEMA },
      { id: 'ai_signals', schema: AI_SIGNALS_SCHEMA },
    ];

    await Promise.all(
      tables.map(async ({ id, schema }) => {
        const table = dataset.table(id);
        const [tableExists] = await table.exists();
        if (!tableExists) {
          await dataset.createTable(id, {
            schema: { fields: schema },
            timePartitioning: { type: 'DAY', field: 'timestamp' },
          });
          logger.info(`테이블 ${DATASET_ID}.${id} 생성 완료`, { component: COMPONENT });
        }
      }),
    );

    _initialized = true;
    logger.info('BigQuery 파이프라인 초기화 완료', { component: COMPONENT });
    return true;
  } catch (err) {
    logger.warn(`BigQuery 초기화 실패 — 파이프라인 비활성: ${err}`, { component: COMPONENT });
    return false;
  }
}

// ── Streaming helpers (fire-and-forget) ──

async function safeInsert(tableId: string, row: Record<string, unknown>): Promise<void> {
  try {
    const client = getClient();
    if (!client) return;

    await client.dataset(DATASET_ID).table(tableId).insert([row]);
  } catch (err) {
    logger.error(`BigQuery ${tableId} 스트리밍 삽입 실패: ${err}`, { component: COMPONENT });
  }
}

/**
 * 거래 기록 스트리밍 — fire-and-forget
 * 호출 측에서 await 하지 않아도 안전함
 */
export function streamTrade(trade: TradeRecord): void {
  void safeInsert('trades', {
    stock_code: trade.stock_code,
    side: trade.side,
    quantity: trade.quantity,
    price: trade.price,
    pnl: trade.pnl ?? 0,
    ai_score: trade.ai_score ?? 0,
    strategy_mode: trade.strategy_mode ?? '',
    timestamp: trade.timestamp,
  });
}

/**
 * 일일 포트폴리오 스냅샷 스트리밍 — fire-and-forget
 */
export function streamDailySnapshot(snapshot: DailySnapshotRecord): void {
  void safeInsert('daily_snapshots', {
    total_value: snapshot.total_value,
    cash: snapshot.cash,
    invested: snapshot.invested,
    pnl: snapshot.pnl,
    positions_count: snapshot.positions_count,
    timestamp: snapshot.timestamp,
  });
}

/**
 * AI 시그널 스트리밍 — fire-and-forget
 */
export function streamAISignal(signal: AISignalRecord): void {
  void safeInsert('ai_signals', {
    stock_code: signal.stock_code,
    composite_score: signal.composite_score,
    signal: signal.signal,
    investor_flow_trend: signal.investor_flow_trend ?? '',
    action_taken: signal.action_taken ?? '',
    timestamp: signal.timestamp,
  });
}

// ── Query ──

const EMPTY_REPORT: PerformanceReport = {
  total_return: 0,
  win_rate: 0,
  avg_holding_period_hours: 0,
  best_trade: null,
  worst_trade: null,
  total_trades: 0,
};

/**
 * 최근 N일간 성과 리포트를 BigQuery에서 조회
 * BigQuery 접근 불가 시 빈 리포트 반환
 */
export async function queryPerformanceReport(days: number): Promise<PerformanceReport> {
  const client = getClient();
  if (!client) return EMPTY_REPORT;

  try {
    const query = `
      WITH period_trades AS (
        SELECT *
        FROM \`${PROJECT_ID}.${DATASET_ID}.trades\`
        WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
      ),
      stats AS (
        SELECT
          COUNT(*) AS total_trades,
          SUM(pnl) AS total_return,
          COUNTIF(pnl > 0) AS winning_trades
        FROM period_trades
        WHERE side = 'SELL'
      ),
      best AS (
        SELECT stock_code, pnl
        FROM period_trades WHERE side = 'SELL'
        ORDER BY pnl DESC LIMIT 1
      ),
      worst AS (
        SELECT stock_code, pnl
        FROM period_trades WHERE side = 'SELL'
        ORDER BY pnl ASC LIMIT 1
      ),
      holding AS (
        SELECT
          AVG(TIMESTAMP_DIFF(s.timestamp, b.timestamp, HOUR)) AS avg_hours
        FROM period_trades b
        JOIN period_trades s
          ON b.stock_code = s.stock_code
          AND b.side = 'BUY' AND s.side = 'SELL'
          AND s.timestamp > b.timestamp
      )
      SELECT
        COALESCE(stats.total_trades, 0) AS total_trades,
        COALESCE(stats.total_return, 0) AS total_return,
        CASE WHEN stats.total_trades > 0
          THEN stats.winning_trades / stats.total_trades * 100
          ELSE 0
        END AS win_rate,
        COALESCE(holding.avg_hours, 0) AS avg_holding_period_hours,
        best.stock_code AS best_stock,
        best.pnl AS best_pnl,
        worst.stock_code AS worst_stock,
        worst.pnl AS worst_pnl
      FROM stats
      CROSS JOIN holding
      LEFT JOIN best ON TRUE
      LEFT JOIN worst ON TRUE
    `;

    const [rows] = await client.query({
      query,
      params: { days },
      location: LOCATION,
    });

    const row = rows[0];
    if (!row) return EMPTY_REPORT;

    return {
      total_trades: Number(row.total_trades),
      total_return: Number(row.total_return),
      win_rate: Number(row.win_rate),
      avg_holding_period_hours: Number(row.avg_holding_period_hours),
      best_trade: row.best_stock ? { stock_code: row.best_stock, pnl: Number(row.best_pnl) } : null,
      worst_trade: row.worst_stock ? { stock_code: row.worst_stock, pnl: Number(row.worst_pnl) } : null,
    };
  } catch (err) {
    logger.error(`BigQuery 성과 리포트 쿼리 실패: ${err}`, { component: COMPONENT });
    return EMPTY_REPORT;
  }
}
