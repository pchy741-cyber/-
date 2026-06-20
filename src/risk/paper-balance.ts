/**
 * Paper 모드 가상 잔액 관리 (DB 주문 내역 기반 FIFO 원장)
 */
import { KR_FEE } from '../config/constants.js';
import { getPool } from '../db/client.js';
import type { AccountBalance, Position } from '../kis/account.js';
import { logger } from '../utils/logger.js';

const _rawPaperCapital = Number(process.env.PAPER_INITIAL_CAPITAL_KRW);
export const PAPER_INITIAL_CAPITAL = Number.isFinite(_rawPaperCapital) && _rawPaperCapital > 0
  ? _rawPaperCapital
  : 30_000_000;
const PAPER_BUY_FEE_PCT = KR_FEE.BUY_FEE_PCT;
const PAPER_SELL_FEE_PCT = KR_FEE.SELL_FEE_PCT;
let paperCashUsed = 0; // 현재 투자 중인 매수 원가 합
let paperRealizedPnl = 0; // 확정 수익/손실 누적
let paperRestored = false; // 서버 시작 후 DB에서 복원했는지
let paperLedgerCache: { fetchedAt: number; state: PaperLedgerState } | null = null;

// ── 간단한 mutex: 동시 잔액 변경 방지 (race condition 보호) ──
let _balanceLock: Promise<void> = Promise.resolve();

function withBalanceLock<T>(fn: () => T): Promise<T> {
  let release: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const prev = _balanceLock;
  _balanceLock = next;
  return prev.then(() => {
    try {
      const result = fn();
      return result;
    } finally {
      release!();
    }
  });
}

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
    h.totalCost += value + buyFee;
    return { bought: value, sold: 0, realizedPnl: 0 };
  }

  if (h.qty <= 0) return { bought: 0, sold: value, realizedPnl: 0 };

  const matchedQty = Math.min(qty, h.qty);
  const avgCost = h.qty > 0 ? h.totalCost / h.qty : 0;
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
  if (!force && paperLedgerCache && now - paperLedgerCache.fetchedAt < 30_000) {
    return paperLedgerCache.state;
  }

  const pool = getPool();
  // 해외 주문(알파벳 종목코드)은 overseas_state['cash_paper'] USD 풀에서 별도 관리 — KRW 원장 제외
  const { rows } = await pool.query(
    `SELECT stock_code, side, filled_quantity, filled_price
       FROM orders
      WHERE trading_mode = 'paper'
        AND status = 'FILLED'
        AND stock_code ~ '^[0-9]{6}$'
      ORDER BY created_at ASC, id ASC`,
  );

  const holdings: Record<string, PaperHoldingState> = {};
  let totalBought = 0;
  let totalSold = 0;
  let realizedPnl = 0;

  for (const row of rows as Array<{
    stock_code: string;
    side: 'BUY' | 'SELL';
    filled_quantity: number;
    filled_price: number;
  }>) {
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

    const posCount = Object.values(state.holdings).filter((h) => h.qty > 0).length;
    logger.info(
      `📦 Paper 상태 복원: 총매수 ${state.totalBought.toLocaleString()}원, 총매도 ${state.totalSold.toLocaleString()}원, 보유 ${posCount}종목, 투자중 ${Math.round(paperCashUsed).toLocaleString()}원, 실현PnL ${Math.round(paperRealizedPnl).toLocaleString()}원`,
      { component: 'PAPER' },
    );
  } catch (err) {
    logger.error(`Paper 상태 복원 실패: ${err}`, { component: 'PAPER' });
  }
}

async function getPaperPositions(): Promise<Position[]> {
  try {
    const state = await loadPaperLedger();
    const entries = Object.entries(state.holdings).filter(([, h]) => h.qty > 0);
    if (entries.length === 0) return [];

    // 실시간 시세 조회 (useRealUrl=true → live 서버에서 가격 가져옴)
    const priceMap = new Map<string, number>();
    try {
      const { getBatchPrices } = await import('../kis/market.js');
      const codes = entries.map(([code]) => code);
      const batchResult = await Promise.race([
        getBatchPrices(codes),
        new Promise<Map<string, any>>((res) => setTimeout(() => res(new Map()), 5000)),
      ]);
      for (const [code, quote] of batchResult) {
        if (quote.currentPrice > 0) priceMap.set(code, quote.currentPrice);
      }
    } catch {
      /* 시세 실패 시 캐시 폴백 */
    }

    // KIS 시세 실패 시 인메모리 캐시 폴백 (dashboard builder와 동일 가격 소스)
    if (priceMap.size < entries.length) {
      try {
        const { getCachedPriceMemory, getLastKnownPricesMemory } = await import('../cache/memory.js');
        for (const [code] of entries) {
          if (priceMap.has(code)) continue;
          const cached = getCachedPriceMemory(code);
          if (cached && cached > 0) { priceMap.set(code, cached); continue; }
          const last = getLastKnownPricesMemory([code]).get(code);
          if (last && last > 0) priceMap.set(code, last);
        }
      } catch { /* 캐시 모듈 로드 실패 시 무시 */ }
    }

    return entries.map(([stockCode, h]) => {
      const avgPrice = h.totalCost / h.qty; // h.qty > 0 guaranteed by filter above
      const livePrice = priceMap.get(stockCode) ?? Math.round(avgPrice);
      const evalAmount = livePrice * h.qty;
      const profitLoss = evalAmount - Math.round(h.totalCost);
      const profitLossPct = avgPrice > 0 ? ((livePrice - avgPrice) / avgPrice) * 100 : 0;
      return {
        stockCode,
        stockName: stockCode,
        quantity: h.qty,
        avgBuyPrice: Math.round(avgPrice),
        currentPrice: livePrice,
        evalAmount,
        profitLoss,
        profitLossPct,
      };
    });
  } catch {
    return [];
  }
}

export async function getPaperBalance(): Promise<AccountBalance> {
  const state = await loadPaperLedger();
  paperRealizedPnl = state.realizedPnl;

  // 매수원가 기준 (시가평가액이 아님) — 현금은 체결시에만 변동, 주가 변동과 무관
  const holdingsCost = Object.values(state.holdings)
    .filter((h) => h.qty > 0)
    .reduce((s, h) => s + h.totalCost, 0);
  paperCashUsed = holdingsCost;

  const cash = Math.max(0, Math.round(PAPER_INITIAL_CAPITAL + paperRealizedPnl - holdingsCost));

  // 시가평가액은 UI 표시 전용 (현금 계산과 분리)
  const positions = await getPaperPositions();
  const marketValue = positions.reduce((s, p) => s + p.evalAmount, 0);

  return {
    totalDeposit: cash,
    d2Deposit: cash,
    orderableCash: cash,
    cashSource: 'd2_deposit',
    totalEvalAmount: marketValue,
    totalProfitLoss: paperRealizedPnl,
    totalProfitLossPct: (paperRealizedPnl / PAPER_INITIAL_CAPITAL) * 100,
    netAsset: cash + marketValue,
    purchaseCost: Math.round(holdingsCost),
    positions,
  };
}

// 매수: 매수 원가만큼 차감 (mutex 보호)
export function addPaperInvestment(amount: number) {
  return withBalanceLock(() => {
    paperCashUsed += amount;
    paperLedgerCache = null;
  });
}
// 매도: 매수 원가 복원 + 차액을 실현손익에 반영 (mutex 보호)
export function removePaperInvestment(sellAmount: number, buyAmount?: number) {
  return withBalanceLock(() => {
    const cost = buyAmount ?? sellAmount;
    paperRealizedPnl += sellAmount - cost;
    paperCashUsed = Math.max(0, paperCashUsed - cost);
    paperLedgerCache = null;
  });
}
export function resetPaperBalance() {
  return withBalanceLock(() => {
    paperCashUsed = 0;
    paperRealizedPnl = 0;
    paperRestored = false;
    paperLedgerCache = null;
  });
}

// ── Paper 자금 자동 리필 (자율학습 모드) ──────────────────────────────
// 현금이 최소 주문금액 미만이면 리필 (자유롭게 거래 지속)
let lastRefillCheck = 0;

/**
 * Paper 자금 고갈 시 자동 리필
 * - 남은 현금 < 50,000원 (1종목 매수 불가) + 보유종목 2건 이하 → 리필 트리거
 * - 기존 paper 주문을 archived로 표시 (학습 데이터 보존)
 * - 순수 현금 시드로 리셋
 * @returns true if refill happened
 */
export async function checkAndRefillPaper(): Promise<boolean> {
  const now = Date.now();
  // 10분에 1번만 체크 (30분→10분 단축)
  if (now - lastRefillCheck < 10 * 60 * 1000) return false;
  lastRefillCheck = now;

  try {
    const balance = await getPaperBalance();
    const hasPositions = balance.positions.length > 0;

    // 리필 조건: 현금 5만원 미만 + 보유종목 3건 이하 (거의 신규매수 불가 상태)
    const isCashDepleted = balance.orderableCash < 50_000;
    const fewPositions = balance.positions.length <= 3;
    if (!isCashDepleted || (hasPositions && !fewPositions)) return false;

    const pool = getPool();
    // 세대 번호 부여 (몇 번째 리필인지 추적)
    const { rows: genRows } = await pool.query(
      `SELECT COALESCE(MAX(CAST(NULLIF(regexp_replace(value, '[^0-9]', '', 'g'), '') AS int)), 0) + 1 as next_gen
       FROM overseas_state WHERE key LIKE 'paper_kr_gen_%'`,
    );
    const gen = genRows[0]?.next_gen ?? 1;

    // 기존 paper 주문을 아카이브 (학습 데이터 보존: trading_mode → paper_archived_N)
    const { rowCount } = await pool.query(
      `UPDATE orders SET trading_mode = $1
       WHERE trading_mode = 'paper' AND stock_code ~ '^[0-9]{6}$' AND status = 'FILLED'`,
      [`paper_archived_${gen}`],
    );

    // 리셋
    resetPaperBalance();

    // 세대 기록
    await pool.query(
      `INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [
        `paper_kr_gen_${gen}`,
        JSON.stringify({
          archivedAt: new Date().toISOString(),
          ordersArchived: rowCount,
          finalCash: balance.orderableCash,
          finalPnl: balance.totalProfitLoss,
          winRate: null, // 일일학습에서 계산
        }),
      ],
    );

    logger.info(
      `🔄 [PAPER-REFILL] 국내 모의자금 리필 (세대 #${gen}): ${balance.orderableCash.toLocaleString()}원 → ${PAPER_INITIAL_CAPITAL.toLocaleString()}원 (${rowCount}건 아카이브, 누적PnL ${Math.round(balance.totalProfitLoss).toLocaleString()}원)`,
      { component: 'PAPER' },
    );
    return true;
  } catch (e) {
    logger.warn(`Paper 리필 체크 실패: ${e}`, { component: 'PAPER' });
    return false;
  }
}
