import { config } from '../config/index.js';
import { insertSnapshot } from '../db/client.js';
import { getAccountBalance } from '../kis/account.js';
import { getPaperBalance } from '../risk/engine.js';
import { logger } from '../utils/logger.js';

export async function runSnapshotJob(): Promise<void> {
  try {
    let balance;
    if (config.isPaper) {
      // Paper 모드: DB 주문 내역 기반 포지션 반영
      balance = await getPaperBalance();
    } else {
      balance = await getAccountBalance();
    }

    await insertSnapshot({
      total_value: balance.totalDeposit + balance.totalEvalAmount,
      cash_balance: balance.orderableCash,
      invested_value: balance.totalEvalAmount,
      unrealized_pnl: balance.totalProfitLoss,
      daily_pnl: balance.totalProfitLoss,
      daily_pnl_pct: balance.totalProfitLossPct,
      positions: balance.positions,
    });

    logger.info(`📸 스냅샷 저장: 총 ${(balance.totalDeposit + balance.totalEvalAmount).toLocaleString()}원, 투자 ${balance.totalEvalAmount.toLocaleString()}원, 포지션 ${balance.positions.length}개`, {
      component: 'SNAPSHOT',
    });
  } catch (error) {
    logger.error(`스냅샷 실패: ${error}`, { component: 'SNAPSHOT' });
  }
}
