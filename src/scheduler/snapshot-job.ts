import { getCtxIsPaper } from '../config/context.js';
import { FALLBACK_FX_RATE } from '../config/constants.js';
import { getPool, getTodayStartSnapshot, insertSnapshot } from '../db/client.js';
import { getAccountBalance } from '../kis/account.js';
import { getPaperBalance } from '../risk/engine.js';
import { logger } from '../utils/logger.js';

/**
 * 양쪽 모드(paper + live) 스냅샷 모두 저장
 * — 대시보드 viewMode 전환 시 어떤 모드든 손실한도 기준값 확보
 *
 * Paper 총자산: 국내(현금+증권) + 해외(현금+증권) 포함
 */

/** Paper 해외 포트폴리오 KRW 합산 (스냅샷용 — 대시보드 calc와 동일 산식) */
async function getOverseasValueKrw(isPaper: boolean): Promise<number> {
  try {
    const { fetchExchangeRate } = await import('../automation/macro-data.js');
    const fxRate = await fetchExchangeRate().catch(() => FALLBACK_FX_RATE);
    const rate = fxRate > 0 ? fxRate : FALLBACK_FX_RATE;

    // 해외 보유종목 시가
    const { rows: holdings } = await getPool().query(
      'SELECT quantity, last_price FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1',
      [isPaper],
    );
    const marketValueUsd = holdings.reduce(
      (sum: number, h: any) => sum + (Number(h.quantity) * Number(h.last_price || 0)),
      0,
    );

    // 해외 현금
    let cashUsd = 0;
    if (isPaper) {
      const { computePaperCash } = await import('./overseas/state.js');
      cashUsd = await computePaperCash(rate);
    }
    // Live: 해외 현금은 통합증거금이므로 국내 잔고에 포함 → 0

    return Math.round((marketValueUsd + cashUsd) * rate);
  } catch (err) {
    logger.warn(`해외 포트폴리오 조회 실패 (스냅샷): ${err}`, { component: 'SNAPSHOT' });
    return 0;
  }
}

export async function runSnapshotJob(): Promise<void> {
  const isPaper = getCtxIsPaper();
  const modeLabel = isPaper ? 'paper' : 'live';

  // 1) 현재 서버 모드 스냅샷
  try {
    const balance = isPaper ? await getPaperBalance() : await getAccountBalance(true);

    // 국내 총자산: 주문가능 + 증권시가 (nass_amt 사용 금지 — KIS 앱 불일치)
    const domesticValue = balance.orderableCash + balance.totalEvalAmount;

    // 해외 포함 총자산 (Paper: 국내+해외, Live: 국내만 — 통합증거금)
    const overseasKrw = await getOverseasValueKrw(isPaper);
    const totalValue = domesticValue + overseasKrw;

    // 일일 손익 = 현재 총자산 - 오늘 첫 스냅샷 총자산 (미평가 포함)
    let dailyPnl = balance.totalProfitLoss; // 폴백: 미실현 손익
    let dailyPnlPct = balance.totalProfitLossPct;
    try {
      const todayStart = await getTodayStartSnapshot(isPaper);
      if (todayStart && todayStart.total_value > 0) {
        dailyPnl = totalValue - Number(todayStart.total_value);
        dailyPnlPct = (dailyPnl / Number(todayStart.total_value)) * 100;
      }
    } catch { /* 첫 스냅샷 조회 실패 시 폴백 유지 */ }

    await insertSnapshot({
      total_value: totalValue,
      cash_balance: balance.orderableCash,
      invested_value: balance.totalEvalAmount,
      unrealized_pnl: balance.totalProfitLoss,
      daily_pnl: dailyPnl,
      daily_pnl_pct: dailyPnlPct,
      positions: balance.positions,
      is_paper: isPaper,
    });

    logger.info(
      `📸 스냅샷 저장 [${modeLabel}]: 총 ${totalValue.toLocaleString()}원 (국내 ${domesticValue.toLocaleString()} + 해외 ${overseasKrw.toLocaleString()})`,
      { component: 'SNAPSHOT' },
    );
  } catch (error) {
    logger.error(`스냅샷 실패 [${modeLabel}]: ${error}`, { component: 'SNAPSHOT' });
  }

  // 2) 반대 모드 스냅샷 (뷰 전환용)
  try {
    if (isPaper) {
      // 서버 paper → live 스냅샷 추가 (실계좌 잔고)
      const liveBalance = await getAccountBalance(true);
      if (liveBalance.totalDeposit > 0 || liveBalance.totalEvalAmount > 0) {
        const liveDomestic = liveBalance.orderableCash + liveBalance.totalEvalAmount;
        const liveOverseasKrw = await getOverseasValueKrw(false);
        const liveTotalValue = liveDomestic + liveOverseasKrw;
        let liveDailyPnl = liveBalance.totalProfitLoss;
        let liveDailyPnlPct = liveBalance.totalProfitLossPct;
        try {
          const liveStart = await getTodayStartSnapshot(false);
          if (liveStart && liveStart.total_value > 0) {
            liveDailyPnl = liveTotalValue - Number(liveStart.total_value);
            liveDailyPnlPct = (liveDailyPnl / Number(liveStart.total_value)) * 100;
          }
        } catch { /* ignore */ }
        await insertSnapshot({
          total_value: liveTotalValue,
          cash_balance: liveBalance.orderableCash,
          invested_value: liveBalance.totalEvalAmount,
          unrealized_pnl: liveBalance.totalProfitLoss,
          daily_pnl: liveDailyPnl,
          daily_pnl_pct: liveDailyPnlPct,
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
      const paperDomestic = paperBalance.orderableCash + paperBalance.totalEvalAmount;
      const paperOverseasKrw = await getOverseasValueKrw(true);
      const paperTotalValue = paperDomestic + paperOverseasKrw;
      let paperDailyPnl = paperBalance.totalProfitLoss;
      let paperDailyPnlPct = paperBalance.totalProfitLossPct;
      try {
        const paperStart = await getTodayStartSnapshot(true);
        if (paperStart && paperStart.total_value > 0) {
          paperDailyPnl = paperTotalValue - Number(paperStart.total_value);
          paperDailyPnlPct = (paperDailyPnl / Number(paperStart.total_value)) * 100;
        }
      } catch { /* ignore */ }
      await insertSnapshot({
        total_value: paperTotalValue,
        cash_balance: paperBalance.orderableCash,
        invested_value: paperBalance.totalEvalAmount,
        unrealized_pnl: paperBalance.totalProfitLoss,
        daily_pnl: paperDailyPnl,
        daily_pnl_pct: paperDailyPnlPct,
        positions: paperBalance.positions,
        is_paper: true,
      });
    }
  } catch (err) {
    logger.warn(`반대 모드 스냅샷 저장 실패 (무시): ${err}`, { component: 'SNAPSHOT' });
  }
}
