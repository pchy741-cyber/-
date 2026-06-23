/**
 * 리스크 통제 엔진 — 모든 국내 주문은 이 엔진을 거쳐야 함
 */

import { getFxRate } from '../api/routes/dashboard/helpers.js';
import { getCtxIsPaper } from '../config/context.js';
import { config } from '../config/index.js';
import { getAllocRisk } from '../db/alloc-risk-cache.js';
import { getOpenChains, getPool, getTodayStartSnapshot, insertRiskEvent, insertSnapshot } from '../db/client.js';
import { type AccountBalance, getAccountBalance } from '../kis/account.js';
import { computePaperCash, getCash as getOverseasCash, getHoldings as getOverseasHoldings } from '../scheduler/overseas/state.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';
import { activateKillSwitch, isKillSwitchActive } from './kill-switch.js';
import { getMonthlyMddSnapshot } from './mdd-calculator.js';
import { getPaperBalance } from './paper-balance.js';
import { MDD_LIMIT, SECTOR_MAP_KR } from '../config/constants.js';
import { calcDailyLossLimit, WEEKLY_LOSS_PCT_LIVE, WEEKLY_LOSS_PCT_PAPER } from './seed-capital.js';

async function getBalance(isPaper: boolean): Promise<AccountBalance> {
  if (isPaper) {
    return getPaperBalance();
  }
  return getAccountBalance(true); // forceRefresh — stale cache can cause false 414% rejections
}

/**
 * 국내 총자산 계산 — 모든 리스크 체크에서 동일한 공식 사용
 * 총자산 = 주문가능(orderableCash) + 국내증권시가(totalEvalAmount)
 * nass_amt(순자산) 사용 금지 — KIS 앱 표시와 불일치
 */
function getDomesticTotalAssets(balance: AccountBalance): number {
  return (balance.orderableCash ?? 0) + (balance.totalEvalAmount ?? 0);
}

export interface PreTradeCheckResult {
  approved: boolean;
  reason: string;
}

// per-mode mutex: 동시 주문의 TOCTOU 방지
const _validateLock = { paper: Promise.resolve(), live: Promise.resolve() };

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

    // per-mode mutex: 동시 매수 주문의 일일손실/포지션한도 TOCTOU 방지
    const lockKey = isPaper ? 'paper' : 'live';
    let releaseLock: () => void;
    const prev = _validateLock[lockKey];
    _validateLock[lockKey] = new Promise<void>((r) => { releaseLock = r; });
    await prev;
    try {
      return await this._doValidate(stockCode, orderValue, isPaper, params.ceoManual);
    } finally { releaseLock!(); }
  }

  private async _doValidate(
    stockCode: string, orderValue: number, isPaper: boolean, ceoManual?: boolean,
  ): Promise<PreTradeCheckResult> {

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
    // ceoManual: 수동매수 시 -8% 재발동 방지. 단, -15% 하드캡은 절대 우회 불가
    if (!ceoManual) {
      const monthlyMddCheck = await this.checkMonthlyMDD(isPaper);
      if (!monthlyMddCheck.approved) return monthlyMddCheck;
    } else {
      // 하드캡: ceoManual이라도 MDD 한도의 150% 초과 시 절대 차단
      const ceoHardCap = MDD_LIMIT.LIVE * 1.5; // e.g. 8% × 1.5 = 12%
      const snap = await getMonthlyMddSnapshot(isPaper);
      if (snap.samples >= 2 && !snap.externalActivity && snap.mddPct >= ceoHardCap) {
        return {
          approved: false,
          reason: `🛑 월간 MDD 하드캡 초과: -${snap.mddPct.toFixed(1)}% (한도 -${ceoHardCap}%) — ceoManual도 차단`,
        };
      }
    }

    // 5-C. 섹터 비중 한도 체크 (DB 설정 기반)
    const sectorCheck = await this.checkSectorExposure(stockCode, orderValue, isPaper);
    if (!sectorCheck.approved) return sectorCheck;

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
        `SELECT COUNT(*)::text AS count FROM orders WHERE created_at >= $1::date AND created_at < ($1::date + INTERVAL '1 day') AND is_paper = $2 AND trading_mode = $3 AND side = 'BUY' AND (trigger_source IS NULL OR trigger_source != 'OVERSEAS')`,
        [today, isPaper, tradingMode],
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
      logger.warn(`⚠️ 일일 거래 수 조회 실패 — fail-closed 차단: ${err}`, { component: 'RISK' });
      return { approved: false, reason: '일일 거래 수 조회 실패 — fail-closed 차단' };
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

    // 총자산 = 주문가능 + 증권시가 (nass_amt 사용 금지 — KIS 앱 불일치)
    const totalAssets = (balance.orderableCash ?? 0) + (balance.totalEvalAmount ?? 0);
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
          total_value: getDomesticTotalAssets(balance),
          cash_balance: balance.orderableCash,
          invested_value: balance.totalEvalAmount,
          unrealized_pnl: balance.totalEvalAmount - balance.purchaseCost, // 실제 미실현PnL
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
    // v10.10.5c: 스냅샷(total_value)에 해외 포함 → currentValue에도 해외 합산해야 정합
    // 기존 버그: startValue=국내+해외, currentValue=국내만 → 해외 보유액이 "손실"로 잡힘
    let currentValue = getDomesticTotalAssets(currentBalance);
    try {
      const fx = await getFxRate();
      if (fx > 0) {
        const [osHoldings, osCashUsd] = await Promise.all([
          getOverseasHoldings(isPaper), getOverseasCash(isPaper),
        ]);
        const osHoldingsKrw = Math.round(
          Array.from(osHoldings.values()).reduce((s, h) => s + h.qty * h.avgPrice, 0) * fx,
        );
        const osCashKrw = Math.round(osCashUsd * fx);
        currentValue += osHoldingsKrw + osCashKrw;
      }
    } catch { /* 해외 조회 실패 시 국내만으로 폴백 — 보수적(손실 과대평가) */ }

    // 장시작 스냅샷 total_value=0 → Drawdown 보호 무력화 방지
    if (startValue <= 0) {
      logger.warn(`⚠️ 장시작 스냅샷 total_value=0 → Drawdown 계산 불가, 매매 차단 (다음 사이클 재시도)`, { component: 'RISK' });
      return { approved: false, reason: '장시작 스냅샷 비정상(0원) — 매매 차단' };
    }

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
        `⚠️ 외부 매도/입출금 감지: 스냅샷 ${startValue.toLocaleString()}원 → 현재 ${currentValue.toLocaleString()}원 (${((dailyLoss / startValue) * 100).toFixed(0)}% 감소) → Kill Switch 스킵 (스냅샷 유지 — trading P&L만 기준점 변경 가능)`,
        { component: 'RISK' },
      );
      // ⚠️ 스냅샷을 재설정하지 않음 — 외부 입출금/매도로 기준점이 리셋되면
      // 실제 trading 손실이 은폐될 수 있음. 기준점은 trading P&L에 의해서만 변경되어야 함.
      return { approved: true, reason: '외부 매도/입출금 감지 — Kill Switch 스킵, 스냅샷 유지' };
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
        isPaper,
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
      const limitUsedPct = limitAmount > 0 ? ((dailyLoss / limitAmount) * 100).toFixed(0) : '?';
      logger.warn(
        `⚠️ 일일 손실 경고: ${dailyLoss.toLocaleString()}원(${lossPct}%) — 한도의 ${limitUsedPct}%`,
        { component: 'RISK' },
      );
    }

    return { approved: true, reason: 'OK' };
  }

  // 섹터 → DB 컬럼 브릿지
  private static readonly SECTOR_TO_DB_KEY: Record<string, keyof import('../db/alloc-risk-cache.js').AllocRisk> = {
    '반도체': 'sectorSemiconductor',
    '배터리': 'sectorSemiconductor', // 배터리는 반도체/소재 계열로 합산
    '바이오': 'sectorBio',
    '방산': 'sectorDefense',
    '금융': 'sectorFinance',
    '인터넷': 'sectorEtc',
    '전력': 'sectorEtc',
    '조선': 'sectorEtc',
    '가전': 'sectorEtc',
  };

  // SECTOR_MAP: constants.ts SECTOR_MAP_KR SSoT 사용

  private async checkSectorExposure(
    stockCode: string, orderValue: number, isPaper: boolean,
  ): Promise<PreTradeCheckResult> {
    const sector = SECTOR_MAP_KR[stockCode];
    if (!sector) return { approved: true, reason: '섹터 미분류 — 체크 면제' };

    const dbKey = RiskEngine.SECTOR_TO_DB_KEY[sector];
    if (!dbKey) return { approved: true, reason: '섹터 매핑 없음 — 체크 면제' };

    try {
      const balance = await getBalance(isPaper);
      const totalAssets = getDomesticTotalAssets(balance);
      if (totalAssets <= 0) return { approved: true, reason: 'OK' };

      // 같은 섹터 그룹에 속하는 종목들의 투자액 합산
      const sectorGroup = RiskEngine.SECTOR_TO_DB_KEY[sector];
      let sectorInvested = 0;
      for (const pos of balance.positions) {
        const posSector = SECTOR_MAP_KR[pos.stockCode];
        if (posSector && RiskEngine.SECTOR_TO_DB_KEY[posSector] === sectorGroup) {
          sectorInvested += pos.quantity * pos.avgBuyPrice;
        }
      }

      const afterInvested = sectorInvested + orderValue;
      const ar = await getAllocRisk(isPaper);
      const limitPct = Number(ar[dbKey]) || 30;
      const afterPct = (afterInvested / totalAssets) * 100;

      if (afterPct > limitPct) {
        const msg = `섹터 비중 초과: ${sector} ${afterPct.toFixed(0)}% > 한도 ${limitPct}% (현재 ${(sectorInvested / 10000).toFixed(0)}만 + 신규 ${(orderValue / 10000).toFixed(0)}만)`;
        logger.warn(`🚫 ${msg}`, { component: 'RISK' });
        return { approved: false, reason: msg };
      }
      return { approved: true, reason: 'OK' };
    } catch (err) {
      logger.warn(`⚠️ 섹터 비중 조회 실패 — fail-closed 차단: ${err}`, { component: 'RISK' });
      return { approved: false, reason: '섹터 비중 조회 실패 — fail-closed 차단' };
    }
  }

  private async checkTotalExposure(orderValue: number, isPaper: boolean): Promise<PreTradeCheckResult> {
    const balance = await getBalance(isPaper);
    let totalPortfolio = getDomesticTotalAssets(balance);
    let currentInvested = balance.totalEvalAmount;

    // 해외 자산 합산 — KR만 기준 시 투자비중 과다 계산(~100%)으로 매수 차단
    try {
      const fx = await getFxRate();
      if (fx > 0) {
        const [osHoldings, osCashUsd] = await Promise.all([
          getOverseasHoldings(isPaper), getOverseasCash(isPaper),
        ]);
        const osInvestedKrw = Math.round(
          Array.from(osHoldings.values()).reduce((s, h) => s + h.qty * h.avgPrice, 0) * fx,
        );
        const osCashKrw = Math.round(osCashUsd * fx);
        totalPortfolio += osInvestedKrw + osCashKrw;
        currentInvested += osInvestedKrw;
      }
    } catch { /* fallback: KR-only */ }

    // 소자산(100만 미만)은 비율 체크 의미 없음 — cashCheck가 유일한 실질 관문
    if (totalPortfolio === 0 || totalPortfolio < 1_000_000) return { approved: true, reason: 'OK' };

    const afterExposurePct = ((currentInvested + orderValue) / totalPortfolio) * 100;

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

    // 국내 배분 비중 체크 — kr_pct 목표 준수 (Live 전용)
    // ⚠️ 통합증거금: 현금(KRW) 단일 풀 → 배분 비중은 "투자중 금액"(보유액)만 기준
    // v10.9.8: 소자산 면제 제거 + 해외 0포지션 사각지대 제거
    //   기존: totalPortfolio<200만 OR osInvested=0 → 체크 스킵 → 국내가 현금 전부 점유
    //   수정: 해외 보유 없어도 목표비중 기반 현금 예약으로 국내 매수 제한
    if (!isPaper) {
      try {
        const { rows: allocRows } = await getPool().query(
          'SELECT kr_pct, us_pct FROM portfolio_allocation_config WHERE is_paper = $1 LIMIT 1',
          [isPaper],
        );
        const targetKrPct = Number(allocRows[0]?.kr_pct ?? 30);
        const targetUsPct = Number(allocRows[0]?.us_pct ?? 70);

        if (targetUsPct > 0) {
          // 국내 투자가 totalPortfolio 기준 kr_pct 몫(+15% 여유)을 초과하면 차단
          // totalPortfolio = KR잔고+보유 + OS잔고+보유(원화환산) → 해외 포지션 유무 무관
          const domesticInvested = balance.totalEvalAmount;
          const domesticBudgetCeil = totalPortfolio * (targetKrPct / 100);
          if (domesticInvested + orderValue > domesticBudgetCeil * 1.15) {
            return {
              approved: false,
              reason: `국내 예산 한도: 투자 ${Math.round(domesticInvested / 10000)}만 + 주문 ${Math.round(orderValue / 10000)}만 > 한도 ${Math.round(domesticBudgetCeil / 10000)}만 (kr${targetKrPct}%)`,
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
      const now = getKSTNow(); // getUTCX() = KST 값
      const dayOfWeek = now.getUTCDay(); // 0=일, 1=월 ... 6=토
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const mondayKst = new Date(now);
      mondayKst.setUTCDate(now.getUTCDate() - daysFromMonday);
      const mondayDateStr = mondayKst.toISOString().split('T')[0]; // KST 기준 월요일 날짜
      const weekStartIso = `${mondayDateStr}T00:00:00+09:00`; // 월요일 00:00 KST = 일요일 15:00 UTC

      const pool = getPool();
      const { rows } = await pool.query<{ total_value: string }>(
        `SELECT total_value FROM portfolio_snapshots
         WHERE snapshot_at >= $1 AND is_paper = $2
         ORDER BY snapshot_at ASC LIMIT 1`,
        [weekStartIso, isPaper],
      );
      if (rows.length === 0) return { approved: true, reason: 'OK' };

      const weekStartValue = Number(rows[0].total_value);
      if (weekStartValue <= 0) return { approved: true, reason: 'OK' };

      const currentBalance = await getBalance(isPaper);
      const domesticValue = (currentBalance.orderableCash ?? 0) + (currentBalance.totalEvalAmount ?? 0);

      // 해외 포함 총자산 — 스냅샷 저장 산식과 동일 (국내만 쓰면 해외 포함 스냅샷과 불일치 → false -58% 오류)
      let overseasKrwNow = 0;
      try {
        const fxRate = await getFxRate();
        if (fxRate > 0) {
          const { rows: osRows } = await getPool().query<{ quantity: string; last_price: string }>(
            'SELECT quantity, last_price FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1',
            [isPaper],
          );
          const osMarketUsd = osRows.reduce(
            (s: number, h: { quantity: string; last_price: string }) => s + Number(h.quantity) * Number(h.last_price || 0),
            0,
          );
          const paperCashUsd = isPaper ? await computePaperCash(fxRate) : 0;
          overseasKrwNow = Math.round((osMarketUsd + paperCashUsd) * fxRate);
        }
      } catch {
        /* 해외 조회 실패 시 국내만으로 계산 (보수적) */
      }
      const currentValue = domesticValue + overseasKrwNow;

      // 소자산 면제 (20만 미만)
      if (currentValue < 200_000) return { approved: true, reason: '소자산 — 주간 Drawdown 면제' };

      const weeklyLossPct = ((weekStartValue - currentValue) / weekStartValue) * 100;
      const limit = isPaper ? WEEKLY_LOSS_PCT_PAPER : WEEKLY_LOSS_PCT_LIVE;
      const warn = limit * 0.7;

      // 오염 감지: 주초 스냅샷이 현재 총자산의 1.5배 초과 → paper/live 스냅샷 혼합 오염
      // (paper 해외 포함 58M이 live 주초로 오염 → 현재 live 31M과 비교 시 false -47%)
      if (weeklyLossPct >= limit * 0.8 && weekStartValue > currentValue * 1.5) {
        logger.warn(
          `⚠️ 주간 Drawdown 오염 감지: 주초 ${Math.round(weekStartValue / 10000)}만 vs 현재 ${Math.round(currentValue / 10000)}만 (${weeklyLossPct.toFixed(1)}%) — paper/live 스냅샷 불일치로 판단, 주초 스냅샷 재설정`,
          { component: 'RISK' },
        );
        try {
          await getPool().query(
            `DELETE FROM portfolio_snapshots WHERE snapshot_at >= $1 AND snapshot_at < $2 AND is_paper = $3`,
            [weekStartIso, new Date(new Date(weekStartIso).getTime() + 2 * 60 * 60 * 1000).toISOString(), isPaper],
          );
          await insertSnapshot({
            total_value: currentValue,
            cash_balance: currentBalance.orderableCash,
            invested_value: currentBalance.totalEvalAmount,
            unrealized_pnl: currentBalance.totalEvalAmount - currentBalance.purchaseCost, // 실제 미실현PnL
            daily_pnl: 0,
            daily_pnl_pct: 0,
            positions: currentBalance.positions,
            is_paper: isPaper,
          });
        } catch {
          /* 스냅샷 교체 실패해도 이번 차단은 해제 */
        }
        return { approved: true, reason: '주간 Drawdown 스냅샷 오염 감지 — 리셋 후 매수 허용' };
      }

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
      logger.warn(`⚠️ 주간 Drawdown 조회 실패 — 안전을 위해 매매 차단 (fail-closed): ${err}`, { component: 'RISK' });
      return { approved: false, reason: 'DB 조회 실패 — 주간 Drawdown 확인 불가, 매매 차단 (fail-closed)' };
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
      const currentTotal = getDomesticTotalAssets(currentBalance);
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
      const mddLimit = MDD_LIMIT.LIVE;
      const mddWarn = MDD_LIMIT.LIVE * 0.75;
      if (mddPct >= mddLimit) {
        await activateKillSwitch(
          `월간 MDD 한도 초과: 고점 대비 -${mddPct.toFixed(1)}% (한도 -${mddLimit}%)`,
          false,
          'KR',
          isPaper,
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
    let availableCash = balance.orderableCash;

    // Paper 모드: 국내 매수는 국내 현금만 사용 (해외 현금 합산 제거)
    // 기존: 해외 USD를 KRW 환산 후 합산 → 국내 매수 시 해외 현금 미차감 → 무한 매수력 버그
    // 해외 현금은 해외 매수 전용 (overseas-executor에서 별도 관리)

    if (orderValue > availableCash) {
      return {
        approved: false,
        reason: `현금 부족: 주문금액 ${orderValue.toLocaleString()}원 > 가용 ${availableCash.toLocaleString()}원`,
      };
    }

    return { approved: true, reason: 'OK' };
  }
}

export const riskEngine = new RiskEngine();
