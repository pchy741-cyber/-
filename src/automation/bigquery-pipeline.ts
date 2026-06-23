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

// v10.11.4: streamTrade, streamDailySnapshot, streamAISignal, queryPerformanceReport,
// safeInsert, EMPTY_REPORT 삭제 (미사용 데드코드)
