import { getCtxIsPaper } from '../config/context.js';
import { insertSnapshot } from '../db/client.js';
import { getAccountBalance } from '../kis/account.js';
import { getPaperBalance } from '../risk/engine.js';
import { logger } from '../utils/logger.js';

/**
 * 양쪽 모드(paper + live) 스냅샷 모두 저장
 * — 대시보드 viewMode 전환 시 어떤 모드든 손실한도 기준값 확보
 */
export async function runSnapshotJob(): Promise<void> {
  const isPaper = getCtxIsPaper();
  const modeLabel = isPaper ? 'paper' : 'live';

  // 1) 현재 서버 모드 스냅샷 (기존 로직)
  try {
    const balance = isPaper ? await getPaperBalance() : await getAccountBalance(true);

    // netAsset(순자산) 우선 → 대시보드 builder.ts와 일관된 총자산 산출
    const totalValue = (balance as any).netAsset > 0
      ? (balance as any).netAsset
      : balance.totalDeposit + balance.totalEvalAmount;

    await insertSnapshot({
      total_value: totalValue,
      cash_balance: balance.orderableCash,
      invested_value: balance.totalEvalAmount,
      unrealized_pnl: balance.totalProfitLoss,
      daily_pnl: balance.totalProfitLoss,
      daily_pnl_pct: balance.totalProfitLossPct,
      positions: balance.positions,
      is_paper: isPaper,
    });

    logger.info(
      `📸 스냅샷 저장 [${modeLabel}]: 총 ${totalValue.toLocaleString()}원, 투자 ${balance.totalEvalAmount.toLocaleString()}원, 포지션 ${balance.positions.length}개`,
      {
        component: 'SNAPSHOT',
      },
    );
  } catch (error) {
    logger.error(`스냅샷 실패 [${modeLabel}]: ${error}`, { component: 'SNAPSHOT' });
  }

  // 2) 반대 모드 스냅샷 (뷰 전환용)
  try {
    if (isPaper) {
      // 서버 paper → live 스냅샷 추가 (실계좌 잔고)
      const liveBalance = await getAccountBalance(true);
      // 실계좌 잔고가 0이면 live 자격증명 미설정 → 스킵
      if (liveBalance.totalDeposit > 0 || liveBalance.totalEvalAmount > 0) {
        const liveTotalValue = (liveBalance as any).netAsset > 0
          ? (liveBalance as any).netAsset
          : liveBalance.totalDeposit + liveBalance.totalEvalAmount;
        await insertSnapshot({
          total_value: liveTotalValue,
          cash_balance: liveBalance.orderableCash,
          invested_value: liveBalance.totalEvalAmount,
          unrealized_pnl: liveBalance.totalProfitLoss,
          daily_pnl: liveBalance.totalProfitLoss,
          daily_pnl_pct: liveBalance.totalProfitLossPct,
          positions: liveBalance.positions,
          is_paper: false,
        });
        logger.info(
          `📸 스냅샷 저장 [live 보조]: 총 ${liveTotalValue.toLocaleString()}원`,
          { component: 'SNAPSHOT' },
        );
      }
    } else {
      // 서버 live → paper 스냅샷 추가
      const paperBalance = await getPaperBalance();
      await insertSnapshot({
        total_value: paperBalance.totalDeposit + paperBalance.totalEvalAmount,
        cash_balance: paperBalance.orderableCash,
        invested_value: paperBalance.totalEvalAmount,
        unrealized_pnl: paperBalance.totalProfitLoss,
        daily_pnl: paperBalance.totalProfitLoss,
        daily_pnl_pct: paperBalance.totalProfitLossPct,
        positions: paperBalance.positions,
        is_paper: true,
      });
    }
  } catch (err) {
    // 반대 모드 스냅샷 실패는 경고만 (메인 스냅샷은 이미 저장됨)
    logger.warn(`반대 모드 스냅샷 저장 실패 (무시): ${err}`, { component: 'SNAPSHOT' });
  }
}
