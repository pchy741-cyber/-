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

    // 해외 보유종목 시가 (last_price: KIS sync 시 업데이트, 장외 시간에는 stale 가능)
    const { rows: holdings } = await getPool().query(
      'SELECT quantity, last_price, last_price_at FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1',
      [isPaper],
    );
    // stale 가격 감지: last_price_at이 8시간 이상 된 종목 경고
    const staleCount = holdings.filter((h: any) => {
      if (!h.last_price_at) return true;
      return Date.now() - new Date(h.last_price_at).getTime() > 8 * 3600_000;
    }).length;
    if (staleCount > 0) {
      logger.warn(`⚠️ 해외 스냅샷: ${staleCount}종목 시세 8h 이상 미갱신 (장외시간 정상, 장중 지속 시 KIS sync 확인)`, { component: 'SNAPSHOT' });
    }
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

    // 일일 손익: P&L 기반 계산 (입금/출금 영향 제거)
    // 기존: totalValue - todayStart.total_value → 입금 시 이익으로 잡히는 버그
    // 수정: (현재 미실현PnL - 당일시작 미실현PnL) + 당일 실현손익
    let dailyPnl = balance.totalProfitLoss; // 폴백: 미실현 손익
    let dailyPnlPct = balance.totalProfitLossPct;
    try {
      const todayStart = await getTodayStartSnapshot(isPaper);
      if (todayStart && todayStart.total_value > 0) {
        const prevUnrealized = Number(todayStart.unrealized_pnl ?? 0);
        const unrealizedChange = balance.totalProfitLoss - prevUnrealized;
        // 당일 실현손익 (국내 트랜잭션 체인에서 조회)
        let todayRealizedPnl = 0;
        try {
          const { rows: realizedRows } = await getPool().query(
            `SELECT COALESCE(SUM(realized_pnl), 0)::numeric AS total
             FROM transaction_chains
             WHERE status = 'CLOSED' AND is_paper = $1
               AND closed_at >= (NOW() AT TIME ZONE 'Asia/Seoul')::DATE`,
            [isPaper],
          );
          todayRealizedPnl = Number(realizedRows[0]?.total ?? 0);
        } catch { /* realized PnL 조회 실패 시 0 유지 */ }
        dailyPnl = unrealizedChange + todayRealizedPnl;
        dailyPnlPct = Number(todayStart.total_value) > 0
          ? (dailyPnl / Number(todayStart.total_value)) * 100
          : 0;
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
            const prevUnrealized = Number(liveStart.unrealized_pnl ?? 0);
            const unrealizedChange = liveBalance.totalProfitLoss - prevUnrealized;
            let todayRealizedPnl = 0;
            try {
              const { rows: realizedRows } = await getPool().query(
                `SELECT COALESCE(SUM(realized_pnl), 0)::numeric AS total
                 FROM transaction_chains
                 WHERE status = 'CLOSED' AND is_paper = false AND closed_at >= (NOW() AT TIME ZONE 'Asia/Seoul')::DATE`,
              );
              todayRealizedPnl = Number(realizedRows[0]?.total ?? 0);
            } catch { /* ignore */ }
            liveDailyPnl = unrealizedChange + todayRealizedPnl;
            liveDailyPnlPct = Number(liveStart.total_value) > 0
              ? (liveDailyPnl / Number(liveStart.total_value)) * 100
              : 0;
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
          const prevUnrealized = Number(paperStart.unrealized_pnl ?? 0);
          const unrealizedChange = paperBalance.totalProfitLoss - prevUnrealized;
          let todayRealizedPnl = 0;
          try {
            const { rows: realizedRows } = await getPool().query(
              `SELECT COALESCE(SUM(realized_pnl), 0)::numeric AS total
               FROM transaction_chains
               WHERE status = 'CLOSED' AND is_paper = true AND closed_at >= (NOW() AT TIME ZONE 'Asia/Seoul')::DATE`,
            );
            todayRealizedPnl = Number(realizedRows[0]?.total ?? 0);
          } catch { /* ignore */ }
          paperDailyPnl = unrealizedChange + todayRealizedPnl;
          paperDailyPnlPct = Number(paperStart.total_value) > 0
            ? (paperDailyPnl / Number(paperStart.total_value)) * 100
            : 0;
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
