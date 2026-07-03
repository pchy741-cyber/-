/**
 * DB 클라이언트 배럴 — 기존 import 경로 역호환 유지
 * 실제 구현은 pool.ts + repo/*.ts로 분해됨
 */

// ── Pool / 연결 관리 ──
export {
  checkDb,
  checkDbWithRetry,
  disableMemoryMode,
  enableMemoryMode,
  getPool,
  isMemoryMode,
  queryWithRetry,
  resetPool,
  safeQuery,
  withTransaction,
} from './pool.js';

// ── Watchlist ──
export { getActiveWatchlist, upsertWatchlistItem } from './repo/watchlist.js';

// ── AI Scores ──
export { getAllRecentScores, getLatestScores, upsertAIScore } from './repo/ai-scores.js';

// ── Transaction Chains ──
export { createChain, getOpenChains, updateChain } from './repo/chains.js';

// ── Orders ──
export {
  getOrdersByChain,
  getPendingDomesticOrders,
  insertOrder,
  updateOrder,
  updateOrderByKisOrderNo,
} from './repo/orders.js';

// ── Portfolio Snapshots ──
export { getTodayStartSnapshot, insertSnapshot } from './repo/snapshots.js';

// ── Strategy Config ──
export { getActiveStrategy } from './repo/strategy.js';

// ── Cooldowns ──
export {
  getBigLossBlockedStocks,
  getLossHistory,
  getRecentLossStocks,
  getRecentManuallySoldStocks,
  getRecentlySoldStocks,
  getRepeatLoserBlacklist,
  getTodayRepeatStopCodes,
} from './repo/cooldowns.js';
export type { LossRecord } from './repo/cooldowns.js';

// ── System Log ──
export { logSystem } from './repo/system-log.js';

// ── Risk Events ──
export { insertRiskEvent } from './repo/risk-events.js';

// ── Market Sources ──
export { getRecentSources } from './repo/market-sources.js';
