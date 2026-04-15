import { config } from '../config/index.js';
import { getOpenChains, getPool, getTodayStartSnapshot, insertRiskEvent, insertSnapshot } from '../db/client.js';
import { getAccountBalance, type AccountBalance, type Position } from '../kis/account.js';
import { logger } from '../utils/logger.js';
import { activateKillSwitch, isKillSwitchActive } from './kill-switch.js';

// ── Paper 모드 가상 잔액 (DB에서 복원) ──
const PAPER_INITIAL_CAPITAL = 10_000_000;
const PAPER_BUY_FEE_PCT = 0.00015;
const PAPER_SELL_FEE_PCT = 0.00245;
let paperCashUsed = 0;       // 현재 투자 중인 매수 원가 합
let paperRealizedPnl = 0;    // 확정 수익/손실 누적
let paperRestored = false;   // 서버 시작 후 DB에서 복원했는지
let paperLedgerCache: { fetchedAt: number; state: PaperLedgerState } | null = null;

interface PaperHoldingState {
  qty: number;
  totalCost: number;
}

interface PaperLedgerState {
  holdings: Record<string, PaperHoldingState>;
  totalBought: number;
  totalSold: number;
  realizedPnl: number;
}

function applyPaperOrder(
  holdings: Record<string, PaperHoldingState>,
  row: { stock_code: string; side: 'BUY' | 'SELL'; filled_quantity: number; filled_price: number },
): { bought: number; sold: number; realizedPnl: number } {
  const qty = Math.max(0, Number(row.filled_quantity ?? 0));
  const price = Math.max(0, Number(row.filled_price ?? 0));
  if (qty <= 0 || price <= 0) return { bought: 0, sold: 0, realizedPnl: 0 };

  const value = qty * price;
  if (!holdings[row.stock_code]) holdings[row.stock_code] = { qty: 0, totalCost: 0 };
  const h = holdings[row.stock_code];

  if (row.side === 'BUY') {
    const buyFee = Math.round(value * PAPER_BUY_FEE_PCT);
    h.qty += qty;
    h.totalCost += (value + buyFee);
    return { bought: value, sold: 0, realizedPnl: 0 };
  }

  if (h.qty <= 0) return { bought: 0, sold: value, realizedPnl: 0 };

  const matchedQty = Math.min(qty, h.qty);
  const avgCost = h.totalCost / h.qty;
  const costBasis = avgCost * matchedQty;
  const sellValue = price * matchedQty;
  const sellFee = Math.round(sellValue * PAPER_SELL_FEE_PCT);
  const realizedPnl = sellValue - sellFee - costBasis;

  h.qty -= matchedQty;
  h.totalCost -= costBasis;
  if (h.qty <= 0) {
    h.qty = 0;
    h.totalCost = 0;
  }

  return { bought: 0, sold: sellValue, realizedPnl };
}

async function loadPaperLedger(force = false): Promise<PaperLedgerState> {
  const now = Date.now();
  if (!force && paperLedgerCache && now - paperLedgerCache.fetchedAt < 2000) {
    return paperLedgerCache.state;
  }

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT stock_code, side, filled_quantity, filled_price
       FROM orders
      WHERE trading_mode = 'paper'
        AND status = 'FILLED'
      ORDER BY created_at ASC, id ASC`,
  );

  const holdings: Record<string, PaperHoldingState> = {};
  let totalBought = 0;
  let totalSold = 0;
  let realizedPnl = 0;

  for (const row of rows as Array<{ stock_code: string; side: 'BUY' | 'SELL'; filled_quantity: number; filled_price: number }>) {
    const result = applyPaperOrder(holdings, row);
    totalBought += result.bought;
    totalSold += result.sold;
    realizedPnl += result.realizedPnl;
  }

  const state: PaperLedgerState = { holdings, totalBought, totalSold, realizedPnl };
  paperLedgerCache = { fetchedAt: now, state };
  return state;
}

/**
 * 서버 시작 시 DB 주문 내역에서 Paper 포지션/잔액 복원
 * - BUY FILLED: 투자금 차감
 * - SELL FILLED: 투자금 복원 + 실현손익
 */
export async function restorePaperState(): Promise<void> {
  if (paperRestored) return;
  try {
    const state = await loadPaperLedger(true);
    paperRealizedPnl = state.realizedPnl;
    paperCashUsed = Object.values(state.holdings).reduce((sum, h) => sum + h.totalCost, 0);
    paperRestored = true;

    const posCount = Object.values(state.holdings).filter(h => h.qty > 0).length;
    logger.info(`📦 Paper 상태 복원: 총매수 ${state.totalBought.toLocaleString()}원, 총매도 ${state.totalSold.toLocaleString()}원, 보유 ${posCount}종목, 투자중 ${Math.round(paperCashUsed).toLocaleString()}원, 실현PnL ${Math.round(paperRealizedPnl).toLocaleString()}원`, { component: 'PAPER' });
  } catch (err) {
    logger.error(`Paper 상태 복원 실패: ${err}`, { component: 'PAPER' });
  }
}

/**
 * Paper 주문 원장 기반 포지션 목록 조회 (FIFO + 수수료 반영)
 */
async function getPaperPositions(): Promise<Position[]> {
  try {
    const state = await loadPaperLedger();
    return Object.entries(state.holdings)
      .filter(([, h]) => h.qty > 0)
      .map(([stockCode, h]) => {
      const avgPrice = h.qty > 0 ? h.totalCost / h.qty : 0;
      return {
        stockCode,
        stockName: stockCode, // 이름은 시세 조회 시 갱신
        quantity: h.qty,
        avgBuyPrice: Math.round(avgPrice),
        currentPrice: Math.round(avgPrice), // 시세 반영은 스냅샷 Job에서
        evalAmount: Math.round(h.totalCost),
        profitLoss: 0,
        profitLossPct: 0,
      };
    });
  } catch {
    return [];
  }
}

export async function getPaperBalance(): Promise<AccountBalance> {
  await restorePaperState();
  const state = await loadPaperLedger();
  paperRealizedPnl = state.realizedPnl;
  const positions = await getPaperPositions();
  const invested = positions.reduce((s, p) => s + p.evalAmount, 0);
  paperCashUsed = invested;
  // 가용현금 = 초기자본 + 실현손익 - 현재 미회수 원가
  const cash = Math.max(0, Math.round(PAPER_INITIAL_CAPITAL + paperRealizedPnl - invested));
  return {
    totalDeposit: cash,
    orderableCash: cash,
    totalEvalAmount: invested,
    totalProfitLoss: paperRealizedPnl,
    totalProfitLossPct: PAPER_INITIAL_CAPITAL > 0 ? (paperRealizedPnl / PAPER_INITIAL_CAPITAL) * 100 : 0,
    positions,
  };
}

// 매수: 매수 원가만큼 차감
export function addPaperInvestment(amount: number) {
  paperCashUsed += amount;
  paperLedgerCache = null;
}
// 매도: 매수 원가 복원 + 차액을 실현손익에 반영
export function removePaperInvestment(sellAmount: number, buyAmount?: number) {
  const cost = buyAmount ?? sellAmount; // buyAmount가 없으면 동일 금액 가정
  paperRealizedPnl += (sellAmount - cost);
  paperCashUsed = Math.max(0, paperCashUsed - cost);
  paperLedgerCache = null;
}
export function resetPaperBalance() {
  paperCashUsed = 0;
  paperRealizedPnl = 0;
  paperRestored = false;
  paperLedgerCache = null;
}

async function getBalance(): Promise<AccountBalance> {
  if (config.isPaper) {
    // Paper 모드: 가상 원장만 사용 — 실계좌 잔고 절대 혼용 금지
    // (실계좌 잔고 혼용 시 리스크 계산/백테스트 왜곡 발생)
    return getPaperBalance();
  }
  return getAccountBalance();
}

export interface PreTradeCheckResult {
  approved: boolean;
  reason: string;
}

/**
 * 리스크 통제 엔진
 * 모든 주문은 이 엔진을 거쳐야 함 (TradeExecutor가 호출)
 */
export class RiskEngine {
  /**
   * 주문 전 종합 검증
   */
  async validateOrder(params: {
    stockCode: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    estimatedPrice: number;
  }): Promise<PreTradeCheckResult> {
    const { stockCode, side, quantity, estimatedPrice } = params;
    const orderValue = quantity * estimatedPrice;

    // 1. Kill Switch 확인
    if (isKillSwitchActive()) {
      return { approved: false, reason: '🛑 Kill Switch 활성화 상태 — 모든 매매 차단' };
    }

    // 매도는 리스크 체크 생략 (포지션 줄이기는 항상 허용)
    if (side === 'SELL') {
      return { approved: true, reason: '매도 주문 — 리스크 체크 통과' };
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

    // 6. 총 투자 비율 체크
    const exposureCheck = await this.checkTotalExposure(orderValue);
    if (!exposureCheck.approved) return exposureCheck;

    // 7. 주문 가능 현금 체크
    const cashCheck = await this.checkCash(orderValue);
    if (!cashCheck.approved) return cashCheck;

    return { approved: true, reason: '✅ 모든 리스크 체크 통과' };
  }

  /**
   * 동시 보유 종목 수 제한
   * 이미 보유 중인 종목에 대한 물타기는 허용
   * ETF 파킹 종목(KODEX 머니마켓 333940, KODEX200 069500)은 카운트 제외
   */
  private async checkConcurrentPositions(stockCode: string): Promise<PreTradeCheckResult> {
    // ETF 파킹 코드는 포지션 수 제한에서 제외 (운용 목적이 다름)
    const ETF_PARK_CODES = new Set(['333940', '069500']);
    try {
      const chains = await getOpenChains();
      const existingChain = chains.find((c) => c.stock_code === stockCode);

      // 이미 보유 중인 종목은 통과 (물타기)
      if (existingChain) {
        return { approved: true, reason: 'OK' };
      }

      // ETF 파킹 종목 제외한 실제 트레이딩 포지션 수
      const tradingChains = chains.filter((c) => !ETF_PARK_CODES.has(c.stock_code));

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
      // DB 조회 실패 시 Fail-Closed: 신규 매수 차단
      // (체인 수를 알 수 없는 상태에서 매수하면 한도 초과 위험)
      logger.warn(`⚠️ 동시 보유 수 조회 실패 — 신규 매수 차단: ${err}`, { component: 'RISK' });
      return { approved: false, reason: 'DB 조회 실패 — 동시 보유 수 확인 불가, 신규 매수 차단' };
    }
  }

  /**
   * 일일 매매 횟수 제한 (과매매 방지)
   */
  private async checkDailyTradeCount(): Promise<PreTradeCheckResult> {
    try {
      const pool = getPool();
      const today = new Date().toISOString().split('T')[0];
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM orders WHERE created_at::date = $1`,
        [today],
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
      // DB 조회 실패 시 Fail-Closed: 신규 매수 차단
      logger.warn(`⚠️ 일일 거래 수 조회 실패 — 신규 매수 차단: ${err}`, { component: 'RISK' });
      return { approved: false, reason: 'DB 조회 실패 — 일일 거래 수 확인 불가, 신규 매수 차단' };
    }
  }

  /**
   * 종목당 최대 투자 한도 (하드 리밋)
   */
  private async checkPositionLimit(stockCode: string, orderValue: number): Promise<PreTradeCheckResult> {
    const balance = await getBalance();
    const existing = balance.positions.find((p) => p.stockCode === stockCode);
    const currentInvested = existing ? existing.quantity * existing.avgBuyPrice : 0;
    const totalAfter = currentInvested + orderValue;

    if (totalAfter > config.risk.maxPositionKrw) {
      const msg = `종목당 한도 초과: ${stockCode} 현재 ${currentInvested.toLocaleString()}원 + 신규 ${orderValue.toLocaleString()}원 = ${totalAfter.toLocaleString()}원 > 한도 ${config.risk.maxPositionKrw.toLocaleString()}원`;
      await insertRiskEvent({
        event_type: 'POSITION_LIMIT',
        severity: 'WARNING',
        details: { stockCode, currentInvested, orderValue, limit: config.risk.maxPositionKrw },
        action_taken: '주문 거부',
      });
      return { approved: false, reason: msg };
    }

    return { approved: true, reason: 'OK' };
  }

  /**
   * 일일 최대 손실 (Drawdown) 체크
   * 하루 손실이 한도를 초과하면 Kill Switch 자동 발동
   */
  private async checkDailyDrawdown(): Promise<PreTradeCheckResult> {
    const startSnapshot = await getTodayStartSnapshot();
    if (!startSnapshot) {
      // 장시작 스냅샷이 없으면 매매 차단 (기준값 없이 손실 계산 불가)
      // 08:50 스냅샷이 자동 생성되므로, 없다면 시스템 부팅 직후
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

    // 손실 한도 = config 설정값 우선, 없으면 총 포트폴리오의 5% (보수적 기본값)
    const maxDailyDrawdownKrw = config.risk.maxDailyDrawdownKrw > 0
      ? config.risk.maxDailyDrawdownKrw
      : Math.round(startValue * 0.05);

    if (dailyLoss > maxDailyDrawdownKrw) {
      // Kill Switch 자동 발동!
      await activateKillSwitch(
        `일일 손실 한도 초과: ${dailyLoss.toLocaleString()}원 > ${maxDailyDrawdownKrw.toLocaleString()}원 (한도 설정값)`,
      );
      return {
        approved: false,
        reason: `🛑 일일 손실 한도 초과 (${dailyLoss.toLocaleString()}원) — Kill Switch 자동 발동`,
      };
    }

    // 한도의 80% 이상이면 경고
    if (dailyLoss > maxDailyDrawdownKrw * 0.8) {
      logger.warn(
        `⚠️ 일일 손실 경고: ${dailyLoss.toLocaleString()}원 (한도의 ${((dailyLoss / maxDailyDrawdownKrw) * 100).toFixed(0)}% — 설정 한도 ${maxDailyDrawdownKrw.toLocaleString()}원 기준)`,
        { component: 'RISK' },
      );
    }

    return { approved: true, reason: 'OK' };
  }

  /**
   * 총 투자 비율 체크
   */
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

    return { approved: true, reason: 'OK' };
  }

  /**
   * 주문 가능 현금 체크
   */
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
