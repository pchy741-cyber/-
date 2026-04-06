import { insertSnapshot } from '../db/client.js';
import { getAccountBalance } from '../kis/account.js';
import { logger } from '../utils/logger.js';

export async function runSnapshotJob(): Promise<void> {
  try {
    const balance = await getAccountBalance();

    await insertSnapshot({
      total_value: balance.totalDeposit + balance.totalEvalAmount,
      cash_balance: balance.orderableCash,
      invested_value: balance.totalEvalAmount,
      unrealized_pnl: balance.totalProfitLoss,
      daily_pnl: balance.totalProfitLoss,
      daily_pnl_pct: balance.totalProfitLossPct,
      positions: balance.positions,
    });

    logger.info(`📸 스냅샷 저장: 총 ${(balance.totalDeposit + balance.totalEvalAmount).toLocaleString()}원`, {
      component: 'SNAPSHOT',
    });
  } catch (error) {
    logger.error(`스냅샷 실패: ${error}`, { component: 'SNAPSHOT' });
  }
}
