import { v4 as uuid } from 'uuid';
import { logger } from '../utils/logger.js';
import type { AIScore, Order, StrategyConfig, TransactionChain, WatchlistItem } from './models.js';

/**
 * 인메모리 DB fallback
 * PostgreSQL 미연결 시 자동 전환 — 재시작하면 초기화됨
 * Cloud SQL 연결되면 자동으로 사용 안 함
 */

// ── 기본 감시목록 (한국 대형 우량주) ──
const DEFAULT_WATCHLIST: WatchlistItem[] = [
  { id: uuid(), stock_code: '005930', stock_name: '삼성전자', market: 'KOSPI', is_active: true, added_at: new Date().toISOString(), notes: null },
  { id: uuid(), stock_code: '000660', stock_name: 'SK하이닉스', market: 'KOSPI', is_active: true, added_at: new Date().toISOString(), notes: null },
  { id: uuid(), stock_code: '373220', stock_name: 'LG에너지솔루션', market: 'KOSPI', is_active: true, added_at: new Date().toISOString(), notes: null },
  { id: uuid(), stock_code: '005380', stock_name: '현대차', market: 'KOSPI', is_active: true, added_at: new Date().toISOString(), notes: null },
  { id: uuid(), stock_code: '035420', stock_name: 'NAVER', market: 'KOSPI', is_active: true, added_at: new Date().toISOString(), notes: null },
  { id: uuid(), stock_code: '035720', stock_name: '카카오', market: 'KOSPI', is_active: true, added_at: new Date().toISOString(), notes: null },
  { id: uuid(), stock_code: '051910', stock_name: 'LG화학', market: 'KOSPI', is_active: true, added_at: new Date().toISOString(), notes: null },
];

// ── 스토어 ──
const store = {
  watchlist: [...DEFAULT_WATCHLIST],
  aiScores: [] as AIScore[],
  chains: [] as TransactionChain[],
  orders: [] as Order[],
  snapshots: [] as Array<{ id: string; snapshot_at: string; total_value: number; cash_balance: number; invested_value: number; unrealized_pnl: number; daily_pnl: number; daily_pnl_pct: number; positions: unknown }>,
  strategy: {
    id: uuid(),
    mode: 'SWING' as const,
    is_active: true,
    gemini_prompt: '',
    gpt_prompt: '',
    claude_prompt: '',
    buy_threshold: 60,
    stop_loss_pct: -3,
    take_profit_pct: 5,
    updated_at: new Date().toISOString(),
  } as StrategyConfig,
  systemLogs: [] as Array<{ level: string; component: string; message: string; details: unknown }>,
};

// ── Watchlist ──
export function memGetActiveWatchlist(): WatchlistItem[] {
  return store.watchlist.filter((w) => w.is_active);
}

export function memUpsertWatchlistItem(item: Pick<WatchlistItem, 'stock_code' | 'stock_name' | 'market'>) {
  const existing = store.watchlist.find((w) => w.stock_code === item.stock_code);
  if (existing) {
    existing.stock_name = item.stock_name;
    existing.market = item.market;
  } else {
    store.watchlist.push({
      id: uuid(),
      stock_code: item.stock_code,
      stock_name: item.stock_name,
      market: item.market,
      is_active: true,
      added_at: new Date().toISOString(),
      notes: null,
    });
  }
}

// ── AI Scores ──
export function memUpsertAIScore(score: Omit<AIScore, 'id' | 'created_at'>) {
  const existing = store.aiScores.find(
    (s) => s.stock_code === score.stock_code && s.score_date === score.score_date,
  );
  if (existing) {
    Object.assign(existing, score);
  } else {
    store.aiScores.push({ ...score, id: uuid(), created_at: new Date().toISOString() } as AIScore);
  }
}

export function memGetLatestScores(stockCodes: string[]): AIScore[] {
  const today = new Date().toISOString().split('T')[0];
  return store.aiScores
    .filter((s) => stockCodes.includes(s.stock_code) && s.score_date === today)
    .sort((a, b) => (b.composite_score ?? 0) - (a.composite_score ?? 0));
}

// ── Transaction Chains ──
export function memGetOpenChains(): TransactionChain[] {
  return store.chains.filter((c) => ['OPEN', 'AVERAGING', 'PROFIT_TAKING'].includes(c.status));
}

export function memCreateChain(chain: Omit<TransactionChain, 'id' | 'opened_at' | 'closed_at' | 'close_reason'>): string {
  const id = uuid();
  store.chains.push({
    ...chain,
    id,
    opened_at: new Date().toISOString(),
    closed_at: null,
    close_reason: null,
  } as TransactionChain);
  return id;
}

export function memUpdateChain(id: string, updates: Partial<TransactionChain>) {
  const chain = store.chains.find((c) => c.id === id);
  if (chain) Object.assign(chain, updates);
}

// ── Orders ──
export function memInsertOrder(order: Omit<Order, 'id' | 'created_at' | 'updated_at'>): string {
  const id = uuid();
  const now = new Date().toISOString();
  store.orders.push({ ...order, id, created_at: now, updated_at: now } as Order);
  return id;
}

export function memUpdateOrder(id: string, updates: Partial<Order>) {
  const order = store.orders.find((o) => o.id === id);
  if (order) Object.assign(order, updates, { updated_at: new Date().toISOString() });
}

export function memGetOrdersByChain(chainId: string): Order[] {
  return store.orders.filter((o) => o.chain_id === chainId).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// ── Portfolio Snapshots ──
export function memInsertSnapshot(snapshot: { total_value: number; cash_balance: number; invested_value: number; unrealized_pnl: number; daily_pnl: number; daily_pnl_pct: number; positions: unknown }) {
  store.snapshots.push({ ...snapshot, id: uuid(), snapshot_at: new Date().toISOString() });
}

export function memGetTodayStartSnapshot() {
  const today = new Date().toISOString().split('T')[0];
  return store.snapshots.find((s) => s.snapshot_at >= `${today}T00:00:00`) ?? null;
}

// ── Strategy Config ──
export function memGetActiveStrategy(): StrategyConfig {
  return store.strategy;
}

// ── System Log ──
export function memLogSystem(level: string, component: string, message: string, details?: unknown) {
  store.systemLogs.push({ level, component, message, details: details ?? null });
  // 최대 1000개만 보관
  if (store.systemLogs.length > 1000) store.systemLogs.splice(0, store.systemLogs.length - 500);
}

// ── Risk Events ──
export function memInsertRiskEvent(_event: { event_type: string; severity: string; details?: unknown; action_taken: string }) {
  logger.info(`[MEM_RISK] ${_event.event_type}: ${_event.action_taken}`, { component: 'RISK' });
}

logger.info('📦 인메모리 DB 활성화 (감시목록 7종목 로드)', { component: 'MEM_DB' });
