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
  : 60_000_000;
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

  // 매칭 BUY 없는 SELL (아카이브 누락, 외부 편입 등):
  // costBasis=0 처리 → 매도 대금 전액을 실현손익에 반영 (현금 누락 방지)
  if (h.qty <= 0) {
    const sellFee = Math.round(value * PAPER_SELL_FEE_PCT);
    return { bought: 0, sold: value, realizedPnl: value - sellFee };
  }

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
  if (!force && paperLedgerCache && now - paperLedgerCache.fetchedAt < 10_000) {
    return paperLedgerCache.state;
  }

  const pool = getPool();
  // 해외 주문(알파벳 종목코드)은 overseas_state['cash_paper'] USD 풀에서 별도 관리 — KRW 원장 제외
  const { rows } = await pool.query(
    `SELECT stock_code, side, filled_quantity, filled_price
       FROM orders
      WHERE trading_mode IN ('paper', 'p_arch')
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
    const pool = getPool();
    const state = await loadPaperLedger(true);
    paperRealizedPnl = state.realizedPnl;

    // paperCashUsed: avg_buy_price * total_quantity 기반 (total_invested는 구 partialProfit 버그로 과대계상 가능)
    const { rows: chainCostRows } = await pool.query(
      `SELECT COALESCE(SUM(ROUND(avg_buy_price::numeric * total_quantity::numeric)), 0)::numeric AS cost
       FROM transaction_chains
       WHERE is_paper = true
         AND status IN ('OPEN','AVERAGING','PROFIT_TAKING')
         AND stock_code ~ '^[0-9]{6}$'
         AND total_quantity > 0`,
    );
    paperCashUsed = Number(chainCostRows[0]?.cost ?? 0);

    // 과대계상 total_invested DB 값 일괄 정정 (partialProfit 구 버그 잔재 치유)
    const { rowCount: fixedCount } = await pool.query(
      `UPDATE transaction_chains
       SET total_invested = ROUND(avg_buy_price::numeric * total_quantity::numeric)
       WHERE is_paper = true
         AND status IN ('OPEN','AVERAGING','PROFIT_TAKING')
         AND total_quantity > 0
         AND total_invested > ROUND(avg_buy_price::numeric * total_quantity::numeric) * 1.05`,
    );
    if ((fixedCount ?? 0) > 0) {
      logger.info(
        `🔧 total_invested 과대계상 ${fixedCount}건 정정 완료 (avg_buy_price × total_quantity 기준)`,
        { component: 'PAPER' },
      );
    }

    // Ghost chains 자동 정리: holdingsCost > 시드 + 실현손익 → FILLED orders 없는 유령 chain 제거
    if (paperCashUsed > PAPER_INITIAL_CAPITAL + paperRealizedPnl) {
      const { rowCount: ghostClosed } = await pool.query(
        `UPDATE transaction_chains
         SET status = 'CLOSED', close_reason = 'ghost_cleanup', closed_at = NOW()
         WHERE is_paper = true
           AND status IN ('OPEN','AVERAGING','PROFIT_TAKING')
           AND stock_code ~ '^[0-9]{6}$'
           AND NOT EXISTS (
             SELECT 1 FROM orders o
             WHERE o.chain_id = transaction_chains.id
               AND o.status = 'FILLED'
               AND o.trading_mode = 'paper'
           )`,
      );
      if ((ghostClosed ?? 0) > 0) {
        const { rows: recalc } = await pool.query(
          `SELECT COALESCE(SUM(ROUND(avg_buy_price::numeric * total_quantity::numeric)), 0)::numeric AS cost
           FROM transaction_chains
           WHERE is_paper = true
             AND status IN ('OPEN','AVERAGING','PROFIT_TAKING')
             AND stock_code ~ '^[0-9]{6}$'
             AND total_quantity > 0`,
        );
        paperCashUsed = Number(recalc[0]?.cost ?? 0);
        paperLedgerCache = null;
        logger.info(
          `🔧 Ghost chains ${ghostClosed}건 자동 정리 → holdingsCost: ${Math.round(paperCashUsed).toLocaleString()}원`,
          { component: 'PAPER' },
        );
      }
    }

    paperRestored = true;

    const posCount = Object.values(state.holdings).filter((h) => h.qty > 0).length;
    logger.info(
      `📦 Paper 상태 복원: 총매수 ${state.totalBought.toLocaleString()}원, 총매도 ${state.totalSold.toLocaleString()}원, 보유 ${posCount}종목, 투자중(chains) ${Math.round(paperCashUsed).toLocaleString()}원, 실현PnL ${Math.round(paperRealizedPnl).toLocaleString()}원`,
      { component: 'PAPER' },
    );
  } catch (err) {
    logger.error(`Paper 상태 복원 실패: ${err}`, { component: 'PAPER' });
  }
}

async function getPaperPositions(): Promise<Position[]> {
  // FIFO 원장 대신 transaction_chains OPEN 기반 — ghost 포지션 시가 합산 방지
  const pool = getPool();
  try {
    const { rows: chainRows } = await pool.query(
      `SELECT stock_code, total_quantity AS qty, avg_buy_price AS avg_price, total_invested
       FROM transaction_chains
       WHERE is_paper = true
         AND status IN ('OPEN','AVERAGING','PROFIT_TAKING')
         AND stock_code ~ '^[0-9]{6}$'
         AND total_quantity > 0`,
    );
    if (chainRows.length === 0) return [];

    const priceMap = new Map<string, number>();
    try {
      const { getBatchPrices } = await import('../kis/market.js');
      const codes = chainRows.map((r: any) => r.stock_code);
      const batchResult = await Promise.race([
        getBatchPrices(codes),
        new Promise<Map<string, any>>((res) => setTimeout(() => res(new Map()), 5000)),
      ]);
      for (const [code, quote] of batchResult) {
        if (quote.currentPrice > 0) priceMap.set(code, quote.currentPrice);
      }
    } catch { /* 시세 실패 시 캐시 폴백 */ }

    if (priceMap.size < chainRows.length) {
      try {
        const { getCachedPriceMemory, getLastKnownPricesMemory } = await import('../cache/memory.js');
        for (const row of chainRows as any[]) {
          if (priceMap.has(row.stock_code)) continue;
          const cached = getCachedPriceMemory(row.stock_code);
          if (cached && cached > 0) { priceMap.set(row.stock_code, cached); continue; }
          const last = getLastKnownPricesMemory([row.stock_code]).get(row.stock_code);
          if (last && last > 0) priceMap.set(row.stock_code, last);
        }
      } catch { /* 캐시 모듈 로드 실패 시 무시 */ }
    }

    return (chainRows as any[]).map((row) => {
      const avgPrice = Number(row.avg_price) || 0;
      const qty = Number(row.qty) || 0;
      const costBasis = Math.round(avgPrice * qty); // total_invested는 partialProfit 버그로 과대계상 가능 → avgPrice 기반 사용
      const livePrice = priceMap.get(row.stock_code) ?? Math.round(avgPrice);
      const evalAmount = livePrice * qty;
      const profitLoss = evalAmount - costBasis;
      const profitLossPct = avgPrice > 0 ? ((livePrice - avgPrice) / avgPrice) * 100 : 0;
      return {
        stockCode: row.stock_code,
        stockName: row.stock_code,
        quantity: qty,
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
  const pool = getPool();
  const state = await loadPaperLedger();
  paperRealizedPnl = state.realizedPnl;

  // holdingsCost: avg_buy_price * total_quantity 기반 (total_invested는 partialProfit 구 버그로 과대계상 가능)
  const { rows: chainCostRows } = await pool.query(
    `SELECT COALESCE(SUM(ROUND(avg_buy_price::numeric * total_quantity::numeric)), 0)::numeric AS cost
     FROM transaction_chains
     WHERE is_paper = true
       AND status IN ('OPEN','AVERAGING','PROFIT_TAKING')
       AND stock_code ~ '^[0-9]{6}$'
       AND total_quantity > 0`,
  );
  const holdingsCost = Number(chainCostRows[0]?.cost ?? 0);
  paperCashUsed = holdingsCost;

  const holdingsCount = Object.values(state.holdings).filter((h) => h.qty > 0).length;

  const cash = Math.max(0, Math.round(PAPER_INITIAL_CAPITAL + paperRealizedPnl - holdingsCost));

  // 진단 로그 (주문가능금액 불일치 추적용)
  if (holdingsCount === 0 && Math.abs(cash - PAPER_INITIAL_CAPITAL) > 100_000) {
    logger.info(
      `📊 [PAPER-DIAG] 보유0건 현금=${cash.toLocaleString()} = 시드${PAPER_INITIAL_CAPITAL.toLocaleString()} + 실현PnL${Math.round(paperRealizedPnl).toLocaleString()} | 총매수${state.totalBought.toLocaleString()} 총매도${state.totalSold.toLocaleString()}`,
      { component: 'PAPER' },
    );
  }

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
let _cashDepletedSince = 0; // 현금 고갈 시작 시점 (stagnation 감지용)

/**
 * Paper 자금 고갈 시 자동 리필
 * - 남은 현금 < 50,000원 + 보유종목 3건 이하 → 즉시 리필
 * - 남은 현금 < 50,000원 + 2시간 이상 고갈 지속 → 보유종목 무관 강제 리필 (교착 방지)
 * - 실현손익 누적 손실로 현금 영구 0 → 감지 후 리필 (gambler's ruin 탈출)
 * - 기존 paper 주문을 archived로 표시 (학습 데이터 보존)
 * - 순수 현금 시드로 리셋
 * @returns true if refill happened
 */
export async function checkAndRefillPaper(): Promise<boolean> {
  const now = Date.now();
  // 3분에 1번 체크 (10분→3분 단축 — 현금 고갈 시 빠른 복구)
  if (now - lastRefillCheck < 3 * 60 * 1000) return false;
  lastRefillCheck = now;

  try {
    const balance = await getPaperBalance();
    const hasPositions = balance.positions.length > 0;
    const isCashDepleted = balance.orderableCash < 50_000;
    const fewPositions = balance.positions.length <= 3;

    // 현금 고갈 시작 시점 추적 (stagnation 감지)
    if (isCashDepleted) {
      if (_cashDepletedSince === 0) _cashDepletedSince = now;
    } else {
      _cashDepletedSince = 0; // 현금 복구 시 리셋
    }

    // 영구 고갈 감지: 실현손익 누적 손실이 시드를 초과 → 포지션 0이어도 현금 0
    const isPermanentlyDepleted = !hasPositions && balance.orderableCash === 0
      && (PAPER_INITIAL_CAPITAL + paperRealizedPnl) <= 0;

    // 교착 감지: 2시간 이상 현금 고갈 지속 (보유종목이 많아 리필 안 되는 케이스)
    const stagnationMs = 2 * 60 * 60 * 1000; // 2시간
    const isStagnant = _cashDepletedSince > 0 && (now - _cashDepletedSince) >= stagnationMs;

    // 리필 조건:
    //   1) 현금 부족 + 보유종목 적음 (기존)
    //   2) 현금 부족 + 2시간 이상 교착 (신규 — deadlock 방지)
    //   3) 영구 고갈 (신규 — 누적 손실로 현금 불가능)
    if (!isCashDepleted && !isPermanentlyDepleted) return false;
    if (isCashDepleted && hasPositions && !fewPositions && !isStagnant && !isPermanentlyDepleted) return false;

    const pool = getPool();
    // 세대 번호 부여 (몇 번째 리필인지 추적)
    const { rows: genRows } = await pool.query(
      `SELECT COALESCE(MAX(CAST(NULLIF(regexp_replace(value, '[^0-9]', '', 'g'), '') AS int)), 0) + 1 as next_gen
       FROM overseas_state WHERE key LIKE 'paper_kr_gen_%'`,
    );
    const gen = genRows[0]?.next_gen ?? 1;

    // 기존 paper 주문을 아카이브 (학습 데이터 보존: trading_mode → p_arch)
    // varchar(10) + CHECK 제약 → 'p_arch' 사용 (해외 overseas/state.ts와 동일 패턴)
    // 세대번호는 overseas_state.paper_kr_gen_N에서 추적
    const { rowCount } = await pool.query(
      `UPDATE orders SET trading_mode = 'p_arch'
       WHERE trading_mode = 'paper' AND stock_code ~ '^[0-9]{6}$' AND status = 'FILLED'`,
    );

    // transaction_chains도 CLOSED 처리 — 미처리 시 holdingsCost에 유령으로 누적됨
    await pool.query(
      `UPDATE transaction_chains
       SET status = 'CLOSED', close_reason = 'paper_refill', closed_at = NOW()
       WHERE is_paper = true
         AND status IN ('OPEN','AVERAGING','PROFIT_TAKING')
         AND stock_code ~ '^[0-9]{6}$'`,
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

    const refillReason = isPermanentlyDepleted ? '누적손실 영구고갈' : isStagnant ? `${Math.round((now - _cashDepletedSince) / 60_000)}분 교착` : '현금부족';
    _cashDepletedSince = 0; // 리필 후 stagnation 리셋
    logger.info(
      `🔄 [PAPER-REFILL] 국내 모의자금 리필 (세대 #${gen}): ${balance.orderableCash.toLocaleString()}원 → ${PAPER_INITIAL_CAPITAL.toLocaleString()}원 (사유: ${refillReason}, ${rowCount}건 아카이브, 누적PnL ${Math.round(balance.totalProfitLoss).toLocaleString()}원)`,
      { component: 'PAPER' },
    );
    return true;
  } catch (e) {
    logger.warn(`Paper 리필 체크 실패: ${e}`, { component: 'PAPER' });
    return false;
  }
}
