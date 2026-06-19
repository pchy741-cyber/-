import { getCtxIsPaper } from '../../config/context.js';
import { getKSTNow } from '../../utils/time.js';
import { isMemoryMode, queryWithRetry } from '../pool.js';
import { memGetTodayStartSnapshot, memInsertSnapshot } from '../memory-store.js';

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
  if (isMemoryMode()) {
    memInsertSnapshot(snapshot);
    return;
  }
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
      snapshot.is_paper ?? getCtxIsPaper(),
    ],
  );
}

export async function getTodayStartSnapshot(isPaperOverride?: boolean) {
  if (isMemoryMode()) return memGetTodayStartSnapshot();
  const isPaper = isPaperOverride ?? getCtxIsPaper();
  const today = getKSTNow().toISOString().split('T')[0];
  const { rows } = await queryWithRetry(
    `SELECT * FROM portfolio_snapshots WHERE snapshot_at >= $1 AND is_paper = $2
     ORDER BY snapshot_at ASC LIMIT 1`,
    [`${today}T00:00:00`, isPaper],
  );
  return rows[0] ?? null;
}
