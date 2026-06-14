/**
 * 리스크 통제 엔진 — 모든 국내 주문은 이 엔진을 거쳐야 함
 */

import { getFxRate } from '../api/routes/dashboard/helpers.js';
import { getCtxIsPaper } from '../config/context.js';
import { config } from '../config/index.js';
import { getAllocRisk } from '../db/alloc-risk-cache.js';
import { getOpenChains, getPool, getTodayStartSnapshot, insertRiskEvent, insertSnapshot } from '../db/client.js';
import { type AccountBalance, getAccountBalance } from '../kis/account.js';
import { getCash as getOverseasCash, getHoldings as getOverseasHoldings } from '../scheduler/overseas/state.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';
import { activateKillSwitch, isKillSwitchActive } from './kill-switch.js';
import { getMonthlyMddSnapshot } from './mdd-calculator.js';
import { getPaperBalance } from './paper-balance.js';
import { calcDailyLossLimit, WEEKLY_LOSS_PCT_LIVE, WEEKLY_LOSS_PCT_PAPER } from './seed-capital.js';

async function getBalance(isPaper: boolean): Promise<AccountBalance> {
  if (isPaper) {
    return getPaperBalance();
  }
  return getAccountBalance(true); // forceRefresh — stale cache can cause false 414% rejections
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
    isPaper?: boolean;
    ceoManual?: boolean; // CEO 수동매수: 월간 MDD 킬스위치 재발동 루프 우회
  }): Promise<PreTradeCheckResult> {
    const { stockCode, side, quantity, estimatedPrice } = params;
    const isPaper = typeof params.isPaper === 'boolean' ? params.isPaper : getCtxIsPaper();
    const orderValue = quantity * estimatedPrice;

    // 매도는 항상 허용 (킬스위치와 무관 — 포지션 탈출은 절대 막으면 안 됨)
    if (side === 'SELL') {
      return { approved: true, reason: '매도 주문 — 리스크 체크 통과' };
    }

    // Kill Switch 확인 (국내 매수만 차단)
    // CEO 수동매수는 킬스위치 해제 후 진입 허용 — MDD 체크에서 재발동하지 않음
    if (isKillSwitchActive('KR')) {
      return { approved: false, reason: '🛑 Kill Switch 활성화 상태 — 국내 매수 차단 (매도는 허용)' };
    }

    // 연습모드: 킬스위치(80% 일일 손실)와 현금 체크만 → 나머지 전부 스킵
    // 백테스팅 데이터를 최대한 쌓아 실전 튜닝에 활용
    if (isPaper) {
      const drawdownCheck = await this.checkDailyDrawdown(isPaper);
      if (!drawdownCheck.approved) return drawdownCheck;
      const cashCheck = await this.checkCash(orderValue, isPaper);
      if (!cashCheck.approved) return cashCheck;
      return { approved: true, reason: '✅ 연습모드 — 손실한도+현금만 체크' };
    }

    // ── 실전모드 전체 체크 ──

    // 2. 동시 보유 종목 수 체크 (신규 매수만)
    const concurrentCheck = await this.checkConcurrentPositions(stockCode, isPaper);
    if (!concurrentCheck.approved) return concurrentCheck;

    // 3. 일일 매매 횟수 체크
    const dailyTradeCheck = await this.checkDailyTradeCount(isPaper);
    if (!dailyTradeCheck.approved) return dailyTradeCheck;

    // 4. 종목당 최대 투자 한도 체크
    const positionCheck = await this.checkPositionLimit(stockCode, orderValue, isPaper);
    if (!positionCheck.approved) return positionCheck;

    // 5. 일일 최대 손실 (Drawdown) 체크
    const drawdownCheck = await this.checkDailyDrawdown(isPaper);
    if (!drawdownCheck.approved) return drawdownCheck;

    // 5-A. 주간 손실 한도 체크
    const weeklyCheck = await this.checkWeeklyDrawdown(isPaper);
    if (!weeklyCheck.approved) return weeklyCheck;

    // 5-B. 월간 MDD -8% 체크
    if (!params.ceoManual) {
      const monthlyMddCheck = await this.checkMonthlyMDD(isPaper);
      if (!monthlyMddCheck.approved) return monthlyMddCheck;
    }

    // 6. 총 투자 비율 체크
    const exposureCheck = await this.checkTotalExposure(orderValue, isPaper);
    if (!exposureCheck.approved) return exposureCheck;

    // 7. 주문 가능 현금 체크
    const cashCheck = await this.checkCash(orderValue, isPaper);
    if (!cashCheck.approved) return cashCheck;

    return { approved: true, reason: '✅ 모든 리스크 체크 통과' };
  }

  private async checkConcurrentPositions(stockCode: string, isPaper: boolean): Promise<PreTradeCheckResult> {
    try {
      const chains = await getOpenChains(isPaper);
      const existingChain = chains.find((c) => c.stock_code === stockCode);

      if (existingChain) {
        return { approved: true, reason: 'OK' };
      }

      const tradingChains = chains;

      const ar = await getAllocRisk(isPaper);
      const maxPos = ar.maxPositions;
      if (tradingChains.length >= maxPos) {
        const msg = `동시 보유 종목 수 한도: ${tradingChains.length}/${maxPos}종목 — 신규 매수 차단`;
        await insertRiskEvent({
          event_type: 'CONCURRENT_LIMIT',
          severity: 'WARNING',
          details: { stockCode, currentPositions: tradingChains.length, limit: maxPos },
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

  private async checkDailyTradeCount(isPaper: boolean): Promise<PreTradeCheckResult> {
    try {
      const pool = getPool();
      const kstNow = getKSTNow();
      const today = kstNow.toISOString().split('T')[0];
      const tradingMode = isPaper ? 'paper' : 'live';
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM orders WHERE created_at >= $1::date AND created_at < ($1::date + INTERVAL '1 day') AND trading_mode = $2 AND side = 'BUY' AND (trigger_source IS NULL OR trigger_source != 'OVERSEAS')`,
        [today, tradingMode],
      );
      const todayCount = Number(rows[0]?.count ?? 0);

      const ar2 = await getAllocRisk(isPaper);
      const maxTrades = ar2.maxDailyTrades;
      if (todayCount >= maxTrades) {
        return {
          approved: false,
          reason: `일일 매매 횟수 한도: ${todayCount}/${maxTrades}회 — 과매매 방지`,
        };
      }

      return { approved: true, reason: 'OK' };
    } catch (err) {
      logger.warn(`⚠️ 일일 거래 수 조회 실패 — 신규 매수 차단: ${err}`, { component: 'RISK' });
      return { approved: false, reason: 'DB 조회 실패 — 일일 거래 수 확인 불가, 신규 매수 차단' };
    }
  }

  private async checkPositionLimit(
    stockCode: string,
    orderValue: number,
    isPaper: boolean,
  ): Promise<PreTradeCheckResult> {
    const balance = await getBalance(isPaper);
    const existing = balance.positions.find((p) => p.stockCode === stockCode);
    const currentInvested = existing ? existing.quantity * existing.avgBuyPrice : 0;
    const totalAfter = currentInvested + orderValue;

    // 총자산 = 순자산(주식평가 + 현금 - 미수금) — totalEvalAmount만 쓰면 현금 미포함 버그
    const totalAssets = balance.netAsset ?? (balance.totalEvalAmount ?? 0) + Math.max(0, balance.orderableCash ?? 0);
    // 연습모드 — 종목당 한도 없음
    if (isPaper) return { approved: true, reason: '연습모드 종목당 한도 없음' };
    // fail-closed: 총자산 0 이하면 잔고 조회 실패 → 매수 차단 (글로벌 한도 폴백 제거)
    if (totalAssets <= 0) {
      logger.warn(`⚠️ 총자산 0원 — 잔고 조회 실패 가능성, 매수 차단 (fail-closed)`, { component: 'RISK' });
      return { approved: false, reason: '총자산 0원 — 잔고 조회 실패 가능성, 매수 차단 (fail-closed)' };
    }
    // Hard Cap: Live 25% (DB 설정 기반) — 소액계좌(3M 미만)는 40% 완화
    const ar3 = await getAllocRisk(isPaper);
    const baseCapRatio = totalAssets < 3_000_000 ? 0.4 : ar3.positionCapPct / 100;
    const canDiv3 = totalAssets * baseCapRatio >= 30_000;
    const capRatio = !canDiv3 ? 0.5 : baseCapRatio;
    // Paper: simulated money → no live KRW hard cap (19.4M @ 40% allowed)
    // Live: hard cap (3M) protects real account from oversized single positions
    const dynamicLimit = isPaper
      ? Math.round(totalAssets * capRatio)
      : Math.min(Math.round(totalAssets * capRatio), config.risk.maxPositionKrw);

    if (totalAfter > dynamicLimit) {
      const capPct = Math.round(capRatio * 100);
      const msg = `종목당 한도 초과: ${stockCode} 현재 ${currentInvested.toLocaleString()}원 + 신규 ${orderValue.toLocaleString()}원 = ${totalAfter.toLocaleString()}원 > 한도 ${dynamicLimit.toLocaleString()}원 (총자산 ${totalAssets.toLocaleString()}원의 ${capPct}%)`;
      await insertRiskEvent({
        event_type: 'POSITION_LIMIT',
        severity: 'WARNING',
        details: { stockCode, currentInvested, orderValue, limit: dynamicLimit, totalAssets, capRatio },
        action_taken: '주문 거부',
      });
      return { approved: false, reason: msg };
    }

    return { approved: true, reason: 'OK' };
  }

  private async checkDailyDrawdown(isPaper: boolean): Promise<PreTradeCheckResult> {
    const startSnapshot = await getTodayStartSnapshot(isPaper);
    if (!startSnapshot) {
      logger.warn('⚠️ 장시작 스냅샷 없음 → 자동 생성 후 매매 허용', { component: 'RISK' });
      try {
        const balance = await getBalance(isPaper);
        await insertSnapshot({
          total_value: balance.totalDeposit + balance.totalEvalAmount,
          cash_balance: balance.orderableCash,
          invested_value: balance.totalEvalAmount,
          unrealized_pnl: balance.totalProfitLoss,
          daily_pnl: 0,
          daily_pnl_pct: 0,
          positions: balance.positions,
          is_paper: isPaper,
        });
        return { approved: true, reason: '장시작 스냅샷 자동 생성 완료' };
      } catch {
        return { approved: false, reason: '스냅샷 생성 실패 — Drawdown 계산 불가, 매매 차단' };
      }
    }

    const currentBalance = await getBalance(isPaper);
    const startValue = Number(startSnapshot.total_value);
    const currentValue = currentBalance.totalDeposit + currentBalance.totalEvalAmount;
    const dailyLoss = startValue - currentValue;

    // ── 외부 매도/입출금 감지 ──────────────────────────────────────────
    // 1) 스냅샷 대비 20% 이상 급감 → 외부(KIS 앱 직접) 매도 판단
    // 2) 소자산(20만 미만) → 절대 손실금이 의미 없어 Kill Switch 스킵
    //    (30% of 120K = 36K → Kill Switch 발동하면 12만원짜리 계좌가 영구 차단)
    if (startValue > 0 && currentValue < 200000) {
      logger.warn(`⚠️ 소자산 포트폴리오(${currentValue.toLocaleString()}원) — 일일 Drawdown 체크 스킵`, {
        component: 'RISK',
      });
      return { approved: true, reason: '소자산 포트폴리오 — Drawdown 체크 면제' };
    }
    if (startValue > 0 && dailyLoss > startValue * 0.2) {
      logger.warn(
        `⚠️ 외부 매도/입출금 감지: 스냅샷 ${startValue.toLocaleString()}원 → 현재 ${currentValue.toLocaleString()}원 (${((dailyLoss / startValue) * 100).toFixed(0)}% 감소) → Kill Switch 스킵, 스냅샷 재설정`,
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
          is_paper: isPaper,
        });
      } catch {
        /* 스냅샷 실패해도 무시 */
      }
      return { approved: true, reason: '외부 매도 감지 — 스냅샷 재설정, 매매 허용' };
    }

    // 일일 손실한도: Live 25% / Paper 80% — max(시작, 현재) 기준
    const basisValue = Math.max(startValue, currentValue); // 더 큰 쪽 기준 (외부 입출금 고려)
    const { basis, pct, limitAmount } = calcDailyLossLimit(basisValue, isPaper);
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

    // 소프트 리밋: Live에서 한도의 80%(=20%) 도달 시 신규 진입 차단
    // (슬리피지로 한도 초과 체결 방지 — 킬스위치 발동 전 선제 방어)
    if (!isPaper && dailyLoss > limitAmount * 0.8) {
      return {
        approved: false,
        reason: `⚠️ 소프트 리밋: 일일 손실 ${dailyLoss.toLocaleString()}원(${lossPct}%) — 한도 80% 도달, 신규 진입 차단`,
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

  private async checkTotalExposure(orderValue: number, isPaper: boolean): Promise<PreTradeCheckResult> {
    const balance = await getBalance(isPaper);
    const totalPortfolio = balance.totalDeposit + balance.totalEvalAmount;
    // 소자산(100만 미만)은 비율 체크 의미 없음 — cashCheck가 유일한 실질 관문
    if (totalPortfolio === 0 || totalPortfolio < 1_000_000) return { approved: true, reason: 'OK' };

    const afterExposurePct = ((balance.totalEvalAmount + orderValue) / totalPortfolio) * 100;

    // 레짐 기반 동적 투자비율 캡 — 장 좋으면 적극 집행, 나쁘면 보수적
    // Paper 모드: 97% 고정 (거의 전액 집행, 로그 축적 극대화)
    const ar4 = await getAllocRisk(isPaper);
    let dynamicCap = isPaper ? ar4.maxInvestedPct : config.risk.maxTotalInvestedPct;
    if (!isPaper) {
      try {
        const { rows } = await getPool().query(
          `SELECT buy_threshold FROM strategy_config WHERE is_active = true AND is_paper = $1 LIMIT 1`,
          [isPaper],
        );
        const bt = Number(rows[0]?.buy_threshold ?? 80);
        dynamicCap = bt <= 65 ? 95 : bt <= 75 ? 92 : bt <= 85 ? 88 : 80;
      } catch {
        /* DB 실패 시 기본값 유지 */
      }
    }

    if (afterExposurePct > dynamicCap) {
      return {
        approved: false,
        reason: `총 투자 비율 한도 초과: ${afterExposurePct.toFixed(1)}% > ${dynamicCap}% (레짐 동적)`,
      };
    }

    // 국내 배분 비중 체크 — kr_pct 목표 준수
    // 소자산(200만 미만) 또는 연습모드(해외 상태 미분리)는 배분 비중 체크 면제
    // ⚠️ 통합증거금: 현금(KRW) 단일 풀 → 현금을 특정 시장에 귀속시키지 않음
    //   배분 비중은 "투자중 금액"(주식 보유액)만 기준으로 계산
    //   이전 로직은 totalDeposit(전체 현금)을 국내 쪽에 포함 + 해외 현금도 합산 → 현금 이중 계산
    if (!isPaper && totalPortfolio >= 2000000) {
      try {
        const [, osHoldings, fx] = await Promise.all([getOverseasCash(), getOverseasHoldings(), getFxRate()]);
        const osHoldingCostUsd = Array.from(osHoldings.values()).reduce((sum, h) => sum + h.qty * h.avgPrice, 0);
        const osInvestedKrw = Math.round(osHoldingCostUsd * fx); // 해외 주식 보유액만 (현금 제외)
        const domesticInvested = balance.totalEvalAmount; // 국내 주식 보유액만 (현금 제외)
        const totalInvested = domesticInvested + osInvestedKrw;
        if (totalInvested > 0 && osInvestedKrw > 0) {
          // 해외 투자 없으면 비율 체크 불필요
          const { rows: allocRows } = await getPool().query(
            'SELECT kr_pct FROM portfolio_allocation_config WHERE is_paper = $1 LIMIT 1',
            [getCtxIsPaper()],
          );
          const targetKrPct = Number(allocRows[0]?.kr_pct ?? 30);
          const currentKrPct = (domesticInvested / totalInvested) * 100;
          if (currentKrPct > targetKrPct * 1.15) {
            return {
              approved: false,
              reason: `국내 배분 비중 초과: ${currentKrPct.toFixed(0)}% > 목표 ${targetKrPct}% (+15% 여유)`,
            };
          }
        }
      } catch (err) {
        logger.warn(`⚠️ 포트폴리오 배분 비중 조회 실패 — 기존 로직만 적용: ${err}`, { component: 'RISK' });
      }
    }

    return { approved: true, reason: 'OK' };
  }

  private async checkWeeklyDrawdown(isPaper: boolean): Promise<PreTradeCheckResult> {
    try {
      // 이번 주 월요일 00:00 KST 계산
      const now = getKSTNow();
      const dayOfWeek = now.getUTCDay(); // 0=일, 1=월 ... 6=토
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const weekStart = new Date(now);
      weekStart.setUTCDate(now.getUTCDate() - daysFromMonday);
      weekStart.setUTCHours(0, 0, 0, 0);

      const pool = getPool();
      const { rows } = await pool.query<{ total_value: string }>(
        `SELECT total_value FROM portfolio_snapshots
         WHERE snapshot_at >= $1 AND is_paper = $2
         ORDER BY snapshot_at ASC LIMIT 1`,
        [weekStart.toISOString(), isPaper],
      );
      if (rows.length === 0) return { approved: true, reason: 'OK' };

      const weekStartValue = Number(rows[0].total_value);
      if (weekStartValue <= 0) return { approved: true, reason: 'OK' };

      const currentBalance = await getBalance(isPaper);
      const currentValue =
        currentBalance.netAsset ??
        (currentBalance.totalEvalAmount ?? 0) + Math.max(0, currentBalance.orderableCash ?? 0);

      // 소자산 면제 (20만 미만)
      if (currentValue < 200_000) return { approved: true, reason: '소자산 — 주간 Drawdown 면제' };

      const weeklyLossPct = ((weekStartValue - currentValue) / weekStartValue) * 100;
      const limit = isPaper ? WEEKLY_LOSS_PCT_PAPER : WEEKLY_LOSS_PCT_LIVE;
      const warn = limit * 0.7;

      if (weeklyLossPct >= limit) {
        logger.warn(
          `🛑 주간 손실 한도 초과: -${weeklyLossPct.toFixed(1)}% (주초 ${Math.round(weekStartValue / 10000)}만 → 현재 ${Math.round(currentValue / 10000)}만)`,
          { component: 'RISK' },
        );
        return {
          approved: false,
          reason: `🛑 주간 손실 -${weeklyLossPct.toFixed(1)}% — 이번 주 한도 ${limit}% 초과, 신규 매수 차단`,
        };
      }
      if (weeklyLossPct >= warn) {
        logger.warn(`⚠️ 주간 손실 경고: -${weeklyLossPct.toFixed(1)}% (한도 ${limit}%)`, { component: 'RISK' });
      }
      return { approved: true, reason: 'OK' };
    } catch (err) {
      logger.warn(`⚠️ 주간 Drawdown 조회 실패 — 일시 장애로 간주, 매매 허용 (fail-open): ${err}`, { component: 'RISK' });
      return { approved: true, reason: 'OK (주간 Drawdown DB 조회 실패 — 일시 허용)' };
    }
  }

  private async checkMonthlyMDD(isPaper: boolean): Promise<PreTradeCheckResult> {
    // 연습모드: 킬스위치(hard block) 없음 — MDD Guard(soft block, mdd-guard.ts)가 대신 관리
    // MDD Guard가 config.paperRisk.mddLimit(60%)에서 minBuyScore 올려서 소프트 차단
    if (isPaper) return { approved: true, reason: '연습모드 MDD 킬스위치 면제 (MDD Guard가 소프트 관리)' };
    try {
      // 소자산 포트폴리오(20만 미만)는 월간 MDD 체크 면제
      // 외부 매도/입출금으로 잔고 급감 시 MDD가 -90%+ 되어 영구 차단되는 문제 방지
      const currentBalance = await getBalance(isPaper);
      const currentTotal = currentBalance.totalDeposit + currentBalance.totalEvalAmount;
      if (currentTotal < 200000) {
        return { approved: true, reason: '소자산 포트폴리오 — 월간 MDD 면제' };
      }

      const snap = await getMonthlyMddSnapshot(isPaper);
      if (snap.samples < 2) return { approved: true, reason: 'OK' };

      const { peak: peakValue, latest: latestValue, externalActivity, mddPct } = snap;
      // 외부 입출금 감지: 고점 대비 50% 이상 급감 → 외부 매도/출금, 실제 MDD 아님
      if (externalActivity) {
        logger.warn(
          `⚠️ 월간 MDD 외부 매도 감지: 고점 ${Math.round(peakValue / 10000)}만 → 현재 ${Math.round(latestValue / 10000)}만 (${((1 - latestValue / peakValue) * 100).toFixed(0)}% 감소) → MDD 체크 스킵`,
          { component: 'RISK' },
        );
        return { approved: true, reason: '외부 매도/입출금 감지 — 월간 MDD 체크 면제' };
      }

      // Paper는 위에서 이미 return → 여기는 Live 전용
      const mddLimit = 8;
      const mddWarn = 6;
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

  private async checkCash(orderValue: number, isPaper: boolean): Promise<PreTradeCheckResult> {
    const balance = await getBalance(isPaper);

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
