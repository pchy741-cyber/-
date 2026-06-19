import { getCtxIsPaper } from '../../config/context.js';
import { isMemoryMode, queryWithRetry } from '../pool.js';
import { memGetActiveStrategy } from '../memory-store.js';
import type { StrategyConfig } from '../models.js';

export async function getActiveStrategy(): Promise<StrategyConfig | null> {
  if (isMemoryMode()) return memGetActiveStrategy();
  const { rows } = await queryWithRetry(
    `SELECT * FROM strategy_config WHERE is_active = true AND is_paper = $1
     ORDER BY updated_at DESC LIMIT 1`,
    [getCtxIsPaper()],
  );
  return rows[0] ?? null;
}
