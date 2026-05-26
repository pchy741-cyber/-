/**
 * 리스크 통제 엔진 — 모든 국내 주문은 이 엔진을 거쳐야 함
 */
import { config } from '../config/index.js';
import { getOpenChains, getPool, getTodayStartSnapshot, insertRiskEvent, insertSnapshot } from '../db/client.js';
import { getAccountBalance, type AccountBalance } from '../kis/account.js';
import { logger } from '../utils/logger.js';
import { activateKillSwitch, isKillSwitchActive } from './kill-switch.js';
import { getPaperBalance } from './paper-balance.js';
import { calcDailyLossLimit } from './seed-capital.js';
import { getCash as getOverseasCash, getHoldings as getOverseasHoldings } from '../scheduler/overseas/state.js';
import { getFxRate } from '../api/routes/dashboard/helpers.js';

async function getBalance(): Promise<AccountBalance> {
  if (config.isPaper) {
    return getPaperBalance();
  }
  return getAccountBalance();
}

export interface PreTradeCheckResult {
  approved: boolean;
  reason: string;
}

export class RiskEngine {
  async validateOrder(params: {
    stockCode: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    estimatedPrice: number;
  }): Promise<PreTradeCheckResult> {
    const { stockCode, side, quantity, estimatedPrice } = params;
    const orderValue = quantity * estimatedPrice;

    // 매도는 항상 허용 (킬스위치와 무관 — 포지션 탈출은 절대 막으면 안 됨)
    if (side === 'SELL') {
      return { approved: true, reason: '매도 주문 — 리스크 체크 통과' };
    }

    // Kill Switch 확인 (국내 매수만 차단)
    if (isKillSwitchActive('KR')) {
      return { approved: false, reason: '🛑 Kill Switch 활성화 상태 — 국내 매수 차단 (매도는 허용)' };
    }

    // 2. 동시 보유 종목 수 체크 (신규 매수만)
    const concurrentCheck = await this.checkConcurrentPositions(stockCode);
    if (!concurrentCheck.approved) return concurrentCheck;

    // 3. 일일 매매 횟수 체크
    const dailyTradeCheck = await this.checkDailyTradeCount();
    if (!dailyTradeCheck.approved) return dailyTradeCheck;

    // 4. 종목당 최대 투자 한도 체크
    const positionCheck = await this.checkPositionLimit(stockCode, orderValue);
    if (!positionCheck.approved) return positionCheck;

    // 5. 일일 최대 손실 (Drawdown) 체크
    const drawdownCheck = await this.checkDailyDrawdown();
    if (!drawdownCheck.approved) return drawdownCheck;

    // 5-B. 월간 MDD -8% 체크
    const monthlyMddCheck = await this.checkMonthlyMDD();
    if (!monthlyMddCheck.approved) return monthlyMddCheck;

    // 6. 총 투자 비율 체크
    const exposureCheck = await this.checkTotalExposure(orderValue);
    if (!exposureCheck.approved) return exposureCheck;

    // 7. 주문 가능 현금 체크
    const cashCheck = await this.checkCash(orderValue);
    if (!cashCheck.approved) return cashCheck;

    return { approved: true, reason: '✅ 모든 리스크 체크 통과' };
  }

  private async checkConcurrentPositions(stockCode: string): Promise<PreTradeCheckResult> {
    try {
      const chains = await getOpenChains();
      const existingChain = chains.find((c) => c.stock_code === stockCode);

      if (existingChain) {
        return { approved: true, reason: 'OK' };
      }

      const tradingChains = chains;

      if (tradingChains.length >= config.risk.maxConcurrentPositions) {
        const msg = `동시 보유 종목 수 한도: ${tradingChains.length}/${config.risk.maxConcurrentPositions}종목 — 신규 매수 차단`;
        await insertRiskEvent({
          event_type: 'CONCURRENT_LIMIT',
          severity: 'WARNING',
          details: { stockCode, currentPositions: tradingChains.length, limit: config.risk.maxConcurrentPositions },
          action_taken: '주문 거부',
        });
        return { approved: false, reason: msg };
      }

      return { approved: true, reason: 'OK' };
    } catch (err) {
      logger.warn(`⚠️ 동시 보유 수 조회 실패 — 신규 매수 차단: ${err}`, { component: 'RISK' });
      return { approved: false, reason: 'DB 조회 실패 — 동시 보유 수 확인 불가, 신규 매수 차단' };
    }
  }

  private async checkDailyTradeCount(): Promise<PreTradeCheckResult> {
    try {
      const pool = getPool();
      const kstNow = new Date(Date.now() + 9 * 3600_000);
      const today = kstNow.toISOString().split('T')[0];
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM orders WHERE created_at >= $1::date AND created_at < ($1::date + INTERVAL '1 day') AND trading_mode = $2`,
        [today, config.tradingMode],
      );
      const todayCount = Number(rows[0]?.count ?? 0);

      if (todayCount >= config.risk.maxDailyTrades) {
        return {
          approved: false,
          reason: `일일 매매 횟수 한도: ${todayCount}/${config.risk.maxDailyTrades}회 — 과매매 방지`,
        };
      }

      return { approved: true, reason: 'OK' };
    } catch (err) {
      logger.warn(`⚠️ 일일 거래 수 조회 실패 — 신규 매수 차단: ${err}`, { component: 'RISK' });
      return { approved: false, reason: 'DB 조회 실패 — 일일 거래 수 확인 불가, 신규 매수 차단' };
    }
  }

  private async checkPositionLimit(stockCode: string, orderValue: number): Promise<PreTradeCheckResult> {
    const balance = await getBalance();
    const existing = balance.positions.find((p) => p.stockCode === stockCode);
    const currentInvested = existing ? existing.quantity * existing.avgBuyPrice : 0;
    const totalAfter = currentInvested + orderValue;

    const totalAssets = balance.totalEvalAmount ?? 0;
    const dynamicLimit = totalAssets > 0
      ? Math.min(Math.round(totalAssets * 0.25), config.risk.maxPositionKrw)
      : config.risk.maxPositionKrw;

    if (totalAfter > dynamicLimit) {
      const msg = `종목당 한도 초과: ${stockCode} 현재 ${currentInvested.toLocaleString()}원 + 신규 ${orderValue.toLocaleString()}원 = ${totalAfter.toLocaleString()}원 > 한도 ${dynamicLimit.toLocaleString()}원 (총자산 ${totalAssets.toLocaleString()}원의 25%)`;
      await insertRiskEvent({
        event_type: 'POSITION_LIMIT',
        severity: 'WARNING',
        details: { stockCode, currentInvested, orderValue, limit: dynamicLimit, totalAssets },
        action_taken: '주문 거부',
      });
      return { approved: false, reason: msg };
    }

    return { approved: true, reason: 'OK' };
  }

  private async checkDailyDrawdown(): Promise<PreTradeCheckResult> {
    const startSnapshot = await getTodayStartSnapshot();
    if (!startSnapshot) {
      logger.warn('⚠️ 장시작 스냅샷 없음 → 자동 생성 후 매매 허용', { component: 'RISK' });
      try {
        const balance = await getBalance();
        await insertSnapshot({
          total_value: balance.totalDeposit + balance.totalEvalAmount,
          cash_balance: balance.orderableCash,
          invested_value: balance.totalEvalAmount,
          unrealized_pnl: balance.totalProfitLoss,
          daily_pnl: 0,
          daily_pnl_pct: 0,
          positions: balance.positions,
        });
        return { approved: true, reason: '장시작 스냅샷 자동 생성 완료' };
      } catch {
        return { approved: false, reason: '스냅샷 생성 실패 — Drawdown 계산 불가, 매매 차단' };
      }
    }

    const currentBalance = await getBalance();
    const startValue = Number(startSnapshot.total_value);
    const currentValue = currentBalance.totalDeposit + currentBalance.totalEvalAmount;
    const dailyLoss = startValue - currentValue;

    // ── 외부 매도/입출금 감지 ──────────────────────────────────────────
    // 1) 스냅샷 대비 20% 이상 급감 → 외부(KIS 앱 직접) 매도 판단
    // 2) 소자산(20만 미만) → 절대 손실금이 의미 없어 Kill Switch 스킵
    //    (30% of 120K = 36K → Kill Switch 발동하면 12만원짜리 계좌가 영구 차단)
    if (startValue > 0 && currentValue < 200000) {
      logger.warn(`⚠️ 소자산 포트폴리오(${currentValue.toLocaleString()}원) — 일일 Drawdown 체크 스킵`, { component: 'RISK' });
      return { approved: true, reason: '소자산 포트폴리오 — Drawdown 체크 면제' };
    }
    if (startValue > 0 && dailyLoss > startValue * 0.20) {
      logger.warn(
        `⚠️ 외부 매도/입출금 감지: 스냅샷 ${startValue.toLocaleString()}원 → 현재 ${currentValue.toLocaleString()}원 (${((dailyLoss/startValue)*100).toFixed(0)}% 감소) → Kill Switch 스킵, 스냅샷 재설정`,
        { component: 'RISK' },
      );
      // 스냅샷을 현재 잔고로 재설정 (외부 매도 후 기준점 리셋)
      try {
        await insertSnapshot({
          total_value: currentValue,
          cash_balance: currentBalance.orderableCash,
          invested_value: currentBalance.totalEvalAmount,
          unrealized_pnl: currentBalance.totalProfitLoss,
          daily_pnl: 0,
          daily_pnl_pct: 0,
          positions: currentBalance.positions,
        });
      } catch { /* 스냅샷 실패해도 무시 */ }
      return { approved: true, reason: '외부 매도 감지 — 스냅샷 재설정, 매매 허용' };
    }

    // 국내 포트폴리오 기준 30% 손실한도 — startValue를 기준으로 계산 (현재가 아닌 시작가 기준)
    // 현재값이 급감해도 시작값 기준이면 정확한 % 산출
    const basisValue = Math.max(startValue, currentValue); // 더 큰 쪽 기준 (외부 입출금 고려)
    const { basis, pct, limitAmount } = calcDailyLossLimit(basisValue);
    const lossPct = basis > 0 ? ((dailyLoss / basis) * 100).toFixed(1) : '0';

    if (dailyLoss > limitAmount) {
      await activateKillSwitch(
        `일일 손실 한도 초과: ${dailyLoss.toLocaleString()}원(${lossPct}%) > 한도 ${limitAmount.toLocaleString()}원(${pct}%)`,
        false,
        'KR',
      );
      return {
        approved: false,
        reason: `🛑 일일 손실 ${dailyLoss.toLocaleString()}원(${lossPct}%) — 한도 ${limitAmount.toLocaleString()}원(${pct}%) 초과, Kill Switch 발동`,
      };
    }

    if (dailyLoss > limitAmount * 0.7) {
      logger.warn(
        `⚠️ 일일 손실 경고: ${dailyLoss.toLocaleString()}원(${lossPct}%) — 한도의 ${((dailyLoss / limitAmount) * 100).toFixed(0)}%`,
        { component: 'RISK' },
      );
    }

    return { approved: true, reason: 'OK' };
  }

  private async checkTotalExposure(orderValue: number): Promise<PreTradeCheckResult> {
    const balance = await getBalance();
    const totalPortfolio = balance.totalDeposit + balance.totalEvalAmount;
    if (totalPortfolio === 0) return { approved: true, reason: 'OK' };

    const afterExposurePct = ((balance.totalEvalAmount + orderValue) / totalPortfolio) * 100;

    if (afterExposurePct > config.risk.maxTotalInvestedPct) {
      return {
        approved: false,
        reason: `총 투자 비율 한도 초과: ${afterExposurePct.toFixed(1)}% > ${config.risk.maxTotalInvestedPct}%`,
      };
    }

    // 국내 배분 비중 체크 — kr_pct 목표 준수
    // 소자산(200만 미만)은 배분 비중 체크 면제 — 소규모 계좌에서 국내/해외 비율 강제는 의미 없음
    if (totalPortfolio >= 2000000) {
      try {
        const [osCash, osHoldings, fx] = await Promise.all([getOverseasCash(), getOverseasHoldings(), getFxRate()]);
        const osHoldingCostUsd = Array.from(osHoldings.values()).reduce((sum, h) => sum + h.qty * h.avgPrice, 0);
        const osPortfolioKrw = Math.round((osCash + osHoldingCostUsd) * fx);
        const grandTotal = totalPortfolio + osPortfolioKrw;
        if (grandTotal > 0 && osPortfolioKrw > 0) {  // 해외 포트폴리오 없으면 비율 체크 불필요
          const { rows: allocRows } = await getPool().query('SELECT kr_pct FROM portfolio_allocation_config LIMIT 1');
          const targetKrPct = Number(allocRows[0]?.kr_pct ?? 70);
          const currentKrPct = (totalPortfolio / grandTotal) * 100;
          if (currentKrPct > targetKrPct * 1.15) {
            return {
              approved: false,
              reason: `국내 배분 비중 초과: ${currentKrPct.toFixed(0)}% > 목표 ${targetKrPct}% (+15% 여유)`,
            };
          }
        }
      } catch (err) { logger.warn(`⚠️ 포트폴리오 배분 비중 조회 실패 — 기존 로직만 적용: ${err}`, { component: 'RISK' }); }
    }

    return { approved: true, reason: 'OK' };
  }

  private async checkMonthlyMDD(): Promise<PreTradeCheckResult> {
    try {
      // 소자산 포트폴리오(20만 미만)는 월간 MDD 체크 면제
      // 외부 매도/입출금으로 잔고 급감 시 MDD가 -90%+ 되어 영구 차단되는 문제 방지
      const currentBalance = await getBalance();
      const currentTotal = currentBalance.totalDeposit + currentBalance.totalEvalAmount;
      if (currentTotal < 200000) {
        return { approved: true, reason: '소자산 포트폴리오 — 월간 MDD 면제' };
      }

      const pool = getPool();
      const kstMonth = new Date(Date.now() + 9 * 3600_000);
      kstMonth.setUTCDate(1);
      kstMonth.setUTCHours(0, 0, 0, 0);
      const { rows } = await pool.query<{ total_value: string }>(
        `SELECT total_value FROM portfolio_snapshots WHERE snapshot_at >= $1 AND is_paper = $2 ORDER BY snapshot_at ASC`,
        [kstMonth.toISOString(), config.isPaper],
      );
      if (rows.length < 2) return { approved: true, reason: 'OK' };

      const values = rows.map((r) => Number(r.total_value));
      const peakValue = Math.max(...values);
      const latestValue = values[values.length - 1];
      // 외부 입출금 감지: 고점 대비 50% 이상 급감 → 외부 매도/출금, 실제 MDD 아님
      if (peakValue > 0 && latestValue < peakValue * 0.50) {
        logger.warn(`⚠️ 월간 MDD 외부 매도 감지: 고점 ${Math.round(peakValue/10000)}만 → 현재 ${Math.round(latestValue/10000)}만 (${((1-latestValue/peakValue)*100).toFixed(0)}% 감소) → MDD 체크 스킵`, { component: 'RISK' });
        return { approved: true, reason: '외부 매도/입출금 감지 — 월간 MDD 체크 면제' };
      }
      const mddPct = ((peakValue - latestValue) / peakValue) * 100;

      const mddLimit = config.isPaper ? 40 : 8;
      const mddWarn = config.isPaper ? 30 : 6;
      if (mddPct >= mddLimit) {
        await activateKillSwitch(
          `월간 MDD 한도 초과: 고점 대비 -${mddPct.toFixed(1)}% (한도 -${mddLimit}%)`,
          false,
          'KR',
        );
        return {
          approved: false,
          reason: `🛑 월간 MDD -${mddPct.toFixed(1)}% — 이달 고점 대비 ${mddLimit}% 초과 손실, Kill Switch 발동`,
        };
      }

      if (mddPct >= mddWarn) {
        logger.warn(
          `⚠️ 월간 MDD 경고: -${mddPct.toFixed(1)}% (고점 ${Math.round(peakValue / 10000)}만원 → 현재 ${Math.round(latestValue / 10000)}만원)`,
          { component: 'RISK' },
        );
      }

      return { approved: true, reason: 'OK' };
    } catch (err) {
      logger.warn(`⚠️ 월간 MDD 조회 실패 — 안전을 위해 매매 차단: ${err}`, { component: 'RISK' });
      return { approved: false, reason: 'DB 조회 실패 — 월간 MDD 확인 불가, 매매 차단' };
    }
  }

  private async checkCash(orderValue: number): Promise<PreTradeCheckResult> {
    const balance = await getBalance();

    if (orderValue > balance.orderableCash) {
      return {
        approved: false,
        reason: `현금 부족: 주문금액 ${orderValue.toLocaleString()}원 > 가용 ${balance.orderableCash.toLocaleString()}원`,
      };
    }

    return { approved: true, reason: 'OK' };
  }
}

export const riskEngine = new RiskEngine();
