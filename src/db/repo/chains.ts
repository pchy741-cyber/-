import { getCtxIsPaper } from '../../config/context.js';
import { cacheSet } from '../../cache/memory.js';
import { isMemoryMode, queryWithRetry } from '../pool.js';
import { memCreateChain, memGetOpenChains, memUpdateChain } from '../memory-store.js';
import type { TransactionChain } from '../models.js';

/** 체인 캐시 즉시 무효화 — fire-and-forget import().then() 대신 동기 호출 */
function invalidateChainCache(): void {
  cacheSet('db:chains:open:true', null, 0);
  cacheSet('db:chains:open:false', null, 0);
}

export async function getOpenChains(isPaperOverride?: boolean): Promise<TransactionChain[]> {
  if (isMemoryMode()) return memGetOpenChains();
  const isPaper = isPaperOverride ?? getCtxIsPaper();
  // 60초 캐시 — Track B 3분 간격이므로 충분, 매매 발생 시 invalidateChainCache()로 즉시 무효화
  const { cacheGet } = await import('../../cache/memory.js');
  const cacheKey = `db:chains:open:${isPaper}`;
  const cached = cacheGet<TransactionChain[]>(cacheKey);
  if (cached) return cached;
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
  cacheSet(cacheKey, rows, 60); // 60초 TTL
  return rows;
}

export async function createChain(
  chain: Omit<TransactionChain, 'id' | 'opened_at' | 'closed_at' | 'close_reason'>,
): Promise<string> {
  if (isMemoryMode()) return memCreateChain(chain);
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
  // 체인 캐시 즉시 무효화 — TOCTOU 방지 (이전: fire-and-forget import().then()으로 60초 캐시 갱신 지연)
  invalidateChainCache();
  return rows[0].id;
}

const CHAIN_ALLOWED_COLS = new Set([
  'status',
  'strategy_mode',
  'avg_buy_price',
  'total_quantity',
  'total_invested',
  'realized_pnl',
  'pnl_pct',
  'sell_reason',
  'target_profit_pct',
  'stop_loss_pct',
  'max_averaging_count',
  'current_averaging_count',
  'peak_price',
  'peak_price_since_open',
  'opened_at',
  'closed_at',
  'close_reason',
]);

export async function updateChain(id: string, updates: Partial<TransactionChain>) {
  if (isMemoryMode()) {
    memUpdateChain(id, updates);
    return;
  }
  const keys = Object.keys(updates).filter((k) => CHAIN_ALLOWED_COLS.has(k));
  if (keys.length === 0) return;
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`);
  const values = keys.map((k) => (updates as Record<string, unknown>)[k]);
  await queryWithRetry(`UPDATE transaction_chains SET ${setClauses.join(', ')} WHERE id = $1`, [id, ...values]);
  // 체인 캐시 즉시 무효화
  invalidateChainCache();
}
