import { v4 as uuid } from 'uuid';
import { logger } from '../utils/logger.js';
import type { AIScore, Order, StrategyConfig, TransactionChain, WatchlistItem } from './models.js';

/**
 * 인메모리 DB fallback
 * PostgreSQL 미연결 시 자동 전환 — 재시작하면 초기화됨
 * Cloud SQL 연결되면 자동으로 사용 안 함
 */

// ── 기본 감시목록 (테마별 엄선) ──
const DEFAULT_WATCHLIST: WatchlistItem[] = [
  // AI·반도체 핵심
  {
    id: uuid(),
    stock_code: '005930',
    stock_name: '삼성전자',
    market: 'KOSPI',
    is_active: true,
    added_at: new Date().toISOString(),
    notes: 'AI반도체',
    source: 'MANUAL',
  },
  {
    id: uuid(),
    stock_code: '000660',
    stock_name: 'SK하이닉스',
    market: 'KOSPI',
    is_active: true,
    added_at: new Date().toISOString(),
    notes: 'HBM/AI반도체',
    source: 'MANUAL',
  },
  {
    id: uuid(),
    stock_code: '042700',
    stock_name: '한미반도체',
    market: 'KOSDAQ',
    is_active: true,
    added_at: new Date().toISOString(),
    notes: 'AI반도체패키징',
    source: 'MANUAL',
  },
  {
    id: uuid(),
    stock_code: '403870',
    stock_name: 'HPSP',
    market: 'KOSDAQ',
    is_active: true,
    added_at: new Date().toISOString(),
    notes: '반도체공정장비',
    source: 'MANUAL',
  },
  // 반도체 소재·원자재
  {
    id: uuid(),
    stock_code: '357780',
    stock_name: '솔브레인',
    market: 'KOSDAQ',
    is_active: true,
    added_at: new Date().toISOString(),
    notes: '반도체소재',
    source: 'MANUAL',
  },
  {
    id: uuid(),
    stock_code: '005290',
    stock_name: '동진쎄미켐',
    market: 'KOSDAQ',
    is_active: true,
    added_at: new Date().toISOString(),
    notes: '반도체소재',
    source: 'MANUAL',
  },
  // 로봇·자동화
  {
    id: uuid(),
    stock_code: '277810',
    stock_name: '레인보우로보틱스',
    market: 'KOSDAQ',
    is_active: true,
    added_at: new Date().toISOString(),
    notes: '협동로봇',
    source: 'MANUAL',
  },
  {
    id: uuid(),
    stock_code: '454910',
    stock_name: '두산로보틱스',
    market: 'KOSPI',
    is_active: true,
    added_at: new Date().toISOString(),
    notes: '협동로봇',
    source: 'MANUAL',
  },
  // 방산·인프라 (트럼프 테마)
  {
    id: uuid(),
    stock_code: '012450',
    stock_name: '한화에어로스페이스',
    market: 'KOSPI',
    is_active: true,
    added_at: new Date().toISOString(),
    notes: '방산/우주',
    source: 'MANUAL',
  },
  {
    id: uuid(),
    stock_code: '009540',
    stock_name: 'HD한국조선해양',
    market: 'KOSPI',
    is_active: true,
    added_at: new Date().toISOString(),
    notes: '조선/LNG',
    source: 'MANUAL',
  },
  // 바이오·제약
  {
    id: uuid(),
    stock_code: '068270',
    stock_name: '셀트리온',
    market: 'KOSPI',
    is_active: true,
    added_at: new Date().toISOString(),
    notes: '바이오시밀러',
    source: 'MANUAL',
  },
  {
    id: uuid(),
    stock_code: '207940',
    stock_name: '삼성바이오로직스',
    market: 'KOSPI',
    is_active: true,
    added_at: new Date().toISOString(),
    notes: 'CMO바이오',
    source: 'MANUAL',
  },
  // 원자재 (알래스카/광물)
  {
    id: uuid(),
    stock_code: '010130',
    stock_name: '고려아연',
    market: 'KOSPI',
    is_active: true,
    added_at: new Date().toISOString(),
    notes: '비철금속',
    source: 'MANUAL',
  },
  {
    id: uuid(),
    stock_code: '247540',
    stock_name: '에코프로비엠',
    market: 'KOSDAQ',
    is_active: true,
    added_at: new Date().toISOString(),
    notes: '2차전지소재',
    source: 'MANUAL',
  },
];

// ── 스토어 ──
const store = {
  watchlist: [...DEFAULT_WATCHLIST],
  aiScores: [] as AIScore[],
  chains: [] as TransactionChain[],
  orders: [] as Order[],
  snapshots: [] as Array<{
    id: string;
    snapshot_at: string;
    total_value: number;
    cash_balance: number;
    invested_value: number;
    unrealized_pnl: number;
    daily_pnl: number;
    daily_pnl_pct: number;
    positions: unknown;
  }>,
  strategy: {
    id: uuid(),
    mode: 'SWING' as const,
    is_active: true,
    notebooklm_prompt: '',
    gemini_prompt: '',
    gpt_prompt: '',
    claude_prompt: '',
    buy_threshold: 55,
    stop_loss_pct: -2,
    take_profit_pct: 4,
    ai_scoring_mode: 'fallback' as const,
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
      source: 'MANUAL',
    });
  }
}

// ── AI Scores ──
export function memUpsertAIScore(score: Omit<AIScore, 'id' | 'created_at'>) {
  const existing = store.aiScores.find((s) => s.stock_code === score.stock_code && s.score_date === score.score_date);
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

export function memCreateChain(
  chain: Omit<TransactionChain, 'id' | 'opened_at' | 'closed_at' | 'close_reason'>,
): string {
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

export function memUpdateOrderByKisOrderNo(kisOrderNo: string, updates: Partial<Order>) {
  const order = store.orders.find((o) => o.kis_order_no === kisOrderNo);
  if (order) Object.assign(order, updates, { updated_at: new Date().toISOString() });
}

export function memGetOrdersByChain(chainId: string): Order[] {
  return store.orders.filter((o) => o.chain_id === chainId).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// ── Portfolio Snapshots ──
export function memInsertSnapshot(snapshot: {
  total_value: number;
  cash_balance: number;
  invested_value: number;
  unrealized_pnl: number;
  daily_pnl: number;
  daily_pnl_pct: number;
  positions: unknown;
}) {
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

export function memSetActiveStrategy(updates: Partial<StrategyConfig>): StrategyConfig {
  store.strategy = { ...store.strategy, ...updates, is_active: true, updated_at: new Date().toISOString() };
  return store.strategy;
}

// ── System Log ──
export function memLogSystem(level: string, component: string, message: string, details?: unknown) {
  store.systemLogs.push({ level, component, message, details: details ?? null });
  // 최대 1000개만 보관
  if (store.systemLogs.length > 1000) store.systemLogs.splice(0, store.systemLogs.length - 500);
}

// ── Risk Events ──
export function memInsertRiskEvent(_event: {
  event_type: string;
  severity: string;
  details?: unknown;
  action_taken: string;
}) {
  logger.info(`[MEM_RISK] ${_event.event_type}: ${_event.action_taken}`, { component: 'RISK' });
}

logger.info('📦 인메모리 DB 활성화 (감시목록 7종목 로드)', { component: 'MEM_DB' });
