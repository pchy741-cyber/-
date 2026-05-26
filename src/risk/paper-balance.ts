/**
 * Paper 모드 가상 잔액 관리 (DB 주문 내역 기반 FIFO 원장)
 */
import { KR_FEE } from '../config/constants.js';
import { getPool } from '../db/client.js';
import { type AccountBalance, type Position } from '../kis/account.js';
import { logger } from '../utils/logger.js';

const PAPER_INITIAL_CAPITAL = 10_000_000;
const PAPER_BUY_FEE_PCT = KR_FEE.BUY_FEE_PCT;
const PAPER_SELL_FEE_PCT = KR_FEE.SELL_FEE_PCT;
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

async function getPaperPositions(): Promise<Position[]> {
  try {
    const state = await loadPaperLedger();
    return Object.entries(state.holdings)
      .filter(([, h]) => h.qty > 0)
      .map(([stockCode, h]) => {
      const avgPrice = h.qty > 0 ? h.totalCost / h.qty : 0;
      return {
        stockCode,
        stockName: stockCode,
        quantity: h.qty,
        avgBuyPrice: Math.round(avgPrice),
        currentPrice: Math.round(avgPrice),
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
  const cash = Math.max(0, Math.round(PAPER_INITIAL_CAPITAL + paperRealizedPnl - invested));
  return {
    totalDeposit: cash,
    orderableCash: cash,
    totalEvalAmount: invested,
    totalProfitLoss: paperRealizedPnl,
    totalProfitLossPct: PAPER_INITIAL_CAPITAL > 0 ? (paperRealizedPnl / PAPER_INITIAL_CAPITAL) * 100 : 0,
    netAsset: cash + invested,
    purchaseCost: invested,
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
  const cost = buyAmount ?? sellAmount;
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
