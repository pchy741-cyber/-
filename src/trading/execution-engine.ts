/**
 * v28: 스마트 주문 집행 상태머신 + 유동성 게이트
 *
 * 상태: QUOTE → PLACE → WAIT → CHASE → FINALIZE
 * 매도 이원화: 익절·시간청산 → 상태머신 / 방어매도(SL·갭·킬스위치·Lv3) → 기존 시장가 직행
 */
import { getOrderbook, type OrderbookEntry } from '../kis/market.js';
import { cancelOrder, getOrderFills, placeOrder, type OrderResult } from '../kis/order.js';
import { OrderType } from '../config/constants.js';
import type { OrderSide } from '../config/constants.js';
import { adjustToTickSize } from '../utils/money.js';
import { queryWithRetry, isMemoryMode } from '../db/pool.js';
import { logger } from '../utils/logger.js';

// ── 설정 ──
export interface ExecutionConfig {
  chase_wait_sec: number;   // default 30
  max_chases: number;       // default 3
  fallback_market: boolean; // default true (BigMover=false)
}

const DEFAULT_CONFIG: ExecutionConfig = {
  chase_wait_sec: 30,
  max_chases: 3,
  fallback_market: true,
};

// ── 상태머신 결과 ──
export interface ExecutionResult {
  success: boolean;
  orderNo: string;
  filledPrice: number;
  filledQty: number;
  chaseCount: number;
  skippedReason?: 'SPREAD' | 'DEPTH' | 'ORDERBOOK_FAIL';
  elapsed_ms: number;
}

// ── 유동성 게이트 ──
export interface LiquidityGateResult {
  passed: boolean;
  skip_reason?: 'SPREAD' | 'DEPTH';
  adjustedQuantity?: number;
}

/**
 * 유동성 게이트 — QUOTE 단계에서 실행
 * 게이트A (스프레드): (ask1-bid1)/mid > expectedTp * 0.15 → skip
 * 게이트B (깊이): qty > (ask1~3잔량합) * 0.3 → 수량축소 or skip
 */
export function checkLiquidityGate(
  book: OrderbookEntry[],
  quantity: number,
  expectedTpPct: number,
): LiquidityGateResult {
  if (!book.length || !book[0]) {
    return { passed: false, skip_reason: 'SPREAD' };
  }

  const ask1 = book[0].askPrice;
  const bid1 = book[0].bidPrice;
  if (ask1 <= 0 || bid1 <= 0) {
    return { passed: false, skip_reason: 'SPREAD' };
  }

  const mid = (ask1 + bid1) / 2;
  const spreadPct = ((ask1 - bid1) / mid) * 100;

  // 게이트A: 스프레드 vs 기대 TP의 15%
  if (spreadPct > expectedTpPct * 0.15) {
    logger.warn(
      `🚧 유동성 게이트A 차단: spread=${spreadPct.toFixed(2)}% > TP*0.15=${(expectedTpPct * 0.15).toFixed(2)}%`,
      { component: 'LIQUIDITY_GATE' },
    );
    return { passed: false, skip_reason: 'SPREAD' };
  }

  // 게이트B: 주문수량 vs 호가 잔량
  const askDepth =
    (book[0]?.askVolume ?? 0) + (book[1]?.askVolume ?? 0) + (book[2]?.askVolume ?? 0);
  if (askDepth > 0 && quantity > askDepth * 0.3) {
    const adjusted = Math.max(1, Math.floor(askDepth * 0.3));
    if (adjusted <= 0) {
      logger.warn(
        `🚧 유동성 게이트B 차단: qty=${quantity} > depth*0.3=${(askDepth * 0.3).toFixed(0)}`,
        { component: 'LIQUIDITY_GATE' },
      );
      return { passed: false, skip_reason: 'DEPTH' };
    }
    logger.info(
      `📊 유동성 게이트B 수량축소: ${quantity}→${adjusted}주 (depth=${askDepth})`,
      { component: 'LIQUIDITY_GATE' },
    );
    return { passed: true, adjustedQuantity: adjusted };
  }

  return { passed: true };
}

/**
 * 방어 매도 판별 — SL/갭방어/킬스위치/Lv3 키워드가 reasoning에 포함되면 시장가 직행
 */
export function isDefenseSell(reasoning: string): boolean {
  const defensePatterns = [
    /stop.?loss/i,
    /SL/,
    /손절/,
    /갭방어/,
    /갭.?다운/,
    /킬.?스위치/,
    /kill.?switch/i,
    /Lv3/i,
    /Lv\.?3/i,
    /강제.?청산/,
    /FORCE_CLOSE/i,
    /서킷.?브레이커/,
    /circuit.?breaker/i,
    /방어.?매도/,
  ];
  return defensePatterns.some((p) => p.test(reasoning));
}

/**
 * 틱 사이즈 계산 (+1틱)
 */
function addOneTick(price: number, direction: 'up' | 'down'): number {
  const tickSize = getTickSize(price);
  return direction === 'up' ? price + tickSize : price - tickSize;
}

function getTickSize(price: number): number {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

/**
 * 슬리피지 원장 기록
 */
async function recordSlippage(params: {
  orderNo: string;
  stockCode: string;
  side: string;
  signalPrice: number;
  orderbookSnapshot: OrderbookEntry[] | null;
  placedPrice: number;
  filledPrice: number;
  chaseCount: number;
  elapsedMs: number;
  strategyMode?: string;
  isPaper: boolean;
}): Promise<void> {
  if (isMemoryMode()) return;
  try {
    await queryWithRetry(
      `INSERT INTO slippage_ledger (order_no, stock_code, side, signal_price,
         orderbook_snapshot, placed_price, filled_price, chase_count,
         elapsed_ms, strategy_mode, is_paper)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        params.orderNo,
        params.stockCode,
        params.side,
        params.signalPrice,
        params.orderbookSnapshot ? JSON.stringify(params.orderbookSnapshot.slice(0, 5)) : null,
        params.placedPrice,
        params.filledPrice,
        params.chaseCount,
        params.elapsedMs,
        params.strategyMode ?? null,
        params.isPaper,
      ],
    );
  } catch (e) {
    logger.warn(`슬리피지 기록 실패 (non-critical): ${e}`, { component: 'EXEC_ENGINE' });
  }
}

/**
 * 스마트 매수 집행 상태머신
 *
 * QUOTE → PLACE → WAIT → CHASE → FINALIZE
 */
export async function smartExecuteBuy(params: {
  stockCode: string;
  quantity: number;
  estimatedPrice: number;
  isPaper: boolean;
  strategyMode?: string;
  expectedTpPct?: number;
  config?: Partial<ExecutionConfig>;
}): Promise<ExecutionResult> {
  const cfg = { ...DEFAULT_CONFIG, ...params.config };
  const startMs = Date.now();
  let chaseCount = 0;

  // ── QUOTE: 호가 조회 + 유동성 게이트 ──
  let book: OrderbookEntry[];
  try {
    book = await getOrderbook(params.stockCode);
  } catch (e) {
    logger.warn(`호가 조회 실패 → 시장가 폴백: ${params.stockCode} ${e}`, { component: 'EXEC_ENGINE' });
    return fallbackMarketOrder(params, startMs, 0, 'ORDERBOOK_FAIL');
  }

  const gateResult = checkLiquidityGate(book, params.quantity, params.expectedTpPct ?? 5);
  if (!gateResult.passed) {
    logger.warn(
      `🚧 유동성 게이트 차단: ${params.stockCode} reason=${gateResult.skip_reason}`,
      { component: 'EXEC_ENGINE' },
    );
    return {
      success: false,
      orderNo: '',
      filledPrice: 0,
      filledQty: 0,
      chaseCount: 0,
      skippedReason: gateResult.skip_reason,
      elapsed_ms: Date.now() - startMs,
    };
  }

  const effectiveQty = gateResult.adjustedQuantity ?? params.quantity;
  const ask1 = book[0]?.askPrice ?? 0;
  const bid1 = book[0]?.bidPrice ?? 0;

  // ── PLACE: 매수1호가+1틱 지정가 ──
  const placedPrice = adjustToTickSize(addOneTick(bid1, 'up'));
  let lastResult = await placeOrder({
    stockCode: params.stockCode,
    side: 'BUY',
    quantity: effectiveQty,
    price: placedPrice,
    orderType: OrderType.LIMIT,
  });

  if (!lastResult.success) {
    logger.error(`주문 실패: ${params.stockCode} ${lastResult.message}`, { component: 'EXEC_ENGINE' });
    return {
      success: false,
      orderNo: lastResult.orderNo,
      filledPrice: 0,
      filledQty: 0,
      chaseCount: 0,
      elapsed_ms: Date.now() - startMs,
    };
  }

  let currentOrderNo = lastResult.orderNo;

  // ── WAIT + CHASE 루프 ──
  while (chaseCount <= cfg.max_chases) {
    // WAIT
    await sleep(cfg.chase_wait_sec * 1000);

    // 체결 확인
    const fill = await getOrderFills(currentOrderNo);
    if (fill && fill.filledQty >= effectiveQty) {
      // 완전 체결
      const elapsed = Date.now() - startMs;
      await recordSlippage({
        orderNo: currentOrderNo,
        stockCode: params.stockCode,
        side: 'BUY',
        signalPrice: params.estimatedPrice,
        orderbookSnapshot: book,
        placedPrice,
        filledPrice: fill.filledPrice,
        chaseCount,
        elapsedMs: elapsed,
        strategyMode: params.strategyMode,
        isPaper: params.isPaper,
      });
      return {
        success: true,
        orderNo: currentOrderNo,
        filledPrice: fill.filledPrice,
        filledQty: fill.filledQty,
        chaseCount,
        elapsed_ms: elapsed,
      };
    }

    // 미체결 → CHASE
    if (chaseCount >= cfg.max_chases) break;

    chaseCount++;
    logger.info(
      `🔄 Chase ${chaseCount}/${cfg.max_chases}: ${params.stockCode} 미체결 → 가격 갱신`,
      { component: 'EXEC_ENGINE' },
    );

    // 새 호가 조회
    let newBook: OrderbookEntry[];
    try {
      newBook = await getOrderbook(params.stockCode);
    } catch {
      continue; // 호가 실패 → 다음 chase
    }

    const newBid1 = newBook[0]?.bidPrice ?? 0;
    if (newBid1 <= 0) continue;

    const newPrice = adjustToTickSize(addOneTick(newBid1, 'up'));

    // 취소 + 재접수
    try {
      await cancelOrder({ orderNo: currentOrderNo, stockCode: params.stockCode, quantity: effectiveQty });
      const chaseResult = await placeOrder({
        stockCode: params.stockCode,
        side: 'BUY',
        quantity: effectiveQty,
        price: newPrice,
        orderType: OrderType.LIMIT,
      });
      if (chaseResult.success) {
        currentOrderNo = chaseResult.orderNo;
      }
    } catch (e) {
      logger.warn(`Chase 주문 실패: ${params.stockCode} ${e}`, { component: 'EXEC_ENGINE' });
    }
  }

  // ── FINALIZE: max_chases 초과 ──
  if (cfg.fallback_market) {
    // 기존 주문 취소 후 시장가
    try {
      await cancelOrder({ orderNo: currentOrderNo, stockCode: params.stockCode, quantity: effectiveQty });
    } catch {
      /* 이미 체결되었을 수 있음 */
    }
    return fallbackMarketOrder(params, startMs, chaseCount);
  }

  // 포기
  try {
    await cancelOrder({ orderNo: currentOrderNo, stockCode: params.stockCode, quantity: effectiveQty });
  } catch {
    /* ignore */
  }
  logger.warn(`❌ 체결 포기: ${params.stockCode} ${chaseCount}회 chase 후`, { component: 'EXEC_ENGINE' });
  return {
    success: false,
    orderNo: currentOrderNo,
    filledPrice: 0,
    filledQty: 0,
    chaseCount,
    elapsed_ms: Date.now() - startMs,
  };
}

/**
 * 스마트 매도 집행 상태머신 (익절·시간청산 전용)
 * 매도1호가-1틱 지정가 → chase → finalize
 */
export async function smartExecuteSell(params: {
  stockCode: string;
  quantity: number;
  estimatedPrice: number;
  isPaper: boolean;
  strategyMode?: string;
  config?: Partial<ExecutionConfig>;
}): Promise<ExecutionResult> {
  const cfg = { ...DEFAULT_CONFIG, ...params.config };
  const startMs = Date.now();
  let chaseCount = 0;

  let book: OrderbookEntry[];
  try {
    book = await getOrderbook(params.stockCode);
  } catch (e) {
    logger.warn(`매도 호가 조회 실패 → 시장가 폴백: ${params.stockCode} ${e}`, { component: 'EXEC_ENGINE' });
    return fallbackMarketOrderSell(params, startMs, 0);
  }

  const ask1 = book[0]?.askPrice ?? 0;
  if (ask1 <= 0) {
    return fallbackMarketOrderSell(params, startMs, 0);
  }

  // 매도1호가-1틱 지정가
  const placedPrice = adjustToTickSize(addOneTick(ask1, 'down'));
  let lastResult = await placeOrder({
    stockCode: params.stockCode,
    side: 'SELL',
    quantity: params.quantity,
    price: placedPrice,
    orderType: OrderType.LIMIT,
  });

  if (!lastResult.success) {
    return fallbackMarketOrderSell(params, startMs, 0);
  }

  let currentOrderNo = lastResult.orderNo;

  while (chaseCount <= cfg.max_chases) {
    await sleep(cfg.chase_wait_sec * 1000);

    const fill = await getOrderFills(currentOrderNo);
    if (fill && fill.filledQty >= params.quantity) {
      const elapsed = Date.now() - startMs;
      await recordSlippage({
        orderNo: currentOrderNo,
        stockCode: params.stockCode,
        side: 'SELL',
        signalPrice: params.estimatedPrice,
        orderbookSnapshot: book,
        placedPrice,
        filledPrice: fill.filledPrice,
        chaseCount,
        elapsedMs: elapsed,
        strategyMode: params.strategyMode,
        isPaper: params.isPaper,
      });
      return {
        success: true,
        orderNo: currentOrderNo,
        filledPrice: fill.filledPrice,
        filledQty: fill.filledQty,
        chaseCount,
        elapsed_ms: elapsed,
      };
    }

    if (chaseCount >= cfg.max_chases) break;
    chaseCount++;

    let newBook: OrderbookEntry[];
    try {
      newBook = await getOrderbook(params.stockCode);
    } catch {
      continue;
    }
    const newAsk1 = newBook[0]?.askPrice ?? 0;
    if (newAsk1 <= 0) continue;
    const newPrice = adjustToTickSize(addOneTick(newAsk1, 'down'));

    try {
      await cancelOrder({ orderNo: currentOrderNo, stockCode: params.stockCode, quantity: params.quantity });
      const chaseResult = await placeOrder({
        stockCode: params.stockCode,
        side: 'SELL',
        quantity: params.quantity,
        price: newPrice,
        orderType: OrderType.LIMIT,
      });
      if (chaseResult.success) {
        currentOrderNo = chaseResult.orderNo;
      }
    } catch (e) {
      logger.warn(`매도 chase 실패: ${params.stockCode} ${e}`, { component: 'EXEC_ENGINE' });
    }
  }

  // FINALIZE — 시장가 폴백
  try {
    await cancelOrder({ orderNo: currentOrderNo, stockCode: params.stockCode, quantity: params.quantity });
  } catch { /* ignore */ }
  return fallbackMarketOrderSell(params, startMs, chaseCount);
}

// ── 시장가 폴백 (매수) ──
async function fallbackMarketOrder(
  params: { stockCode: string; quantity: number; estimatedPrice: number; isPaper: boolean; strategyMode?: string },
  startMs: number,
  chaseCount: number,
  skippedReason?: 'ORDERBOOK_FAIL',
): Promise<ExecutionResult> {
  const result = await placeOrder({
    stockCode: params.stockCode,
    side: 'BUY',
    quantity: params.quantity,
    orderType: OrderType.MARKET,
  });
  if (!result.success) {
    return {
      success: false,
      orderNo: result.orderNo,
      filledPrice: 0,
      filledQty: 0,
      chaseCount,
      skippedReason,
      elapsed_ms: Date.now() - startMs,
    };
  }
  // 체결 확인
  await sleep(3000);
  const fill = await getOrderFills(result.orderNo);
  const elapsed = Date.now() - startMs;
  await recordSlippage({
    orderNo: result.orderNo,
    stockCode: params.stockCode,
    side: 'BUY',
    signalPrice: params.estimatedPrice,
    orderbookSnapshot: null,
    placedPrice: 0,
    filledPrice: fill?.filledPrice ?? params.estimatedPrice,
    chaseCount,
    elapsedMs: elapsed,
    strategyMode: params.strategyMode,
    isPaper: params.isPaper,
  });
  return {
    success: true,
    orderNo: result.orderNo,
    filledPrice: fill?.filledPrice ?? params.estimatedPrice,
    filledQty: fill?.filledQty ?? params.quantity,
    chaseCount,
    skippedReason,
    elapsed_ms: elapsed,
  };
}

// ── 시장가 폴백 (매도) ──
async function fallbackMarketOrderSell(
  params: { stockCode: string; quantity: number; estimatedPrice: number; isPaper: boolean; strategyMode?: string },
  startMs: number,
  chaseCount: number,
): Promise<ExecutionResult> {
  const result = await placeOrder({
    stockCode: params.stockCode,
    side: 'SELL',
    quantity: params.quantity,
    orderType: OrderType.MARKET,
  });
  if (!result.success) {
    return {
      success: false,
      orderNo: result.orderNo,
      filledPrice: 0,
      filledQty: 0,
      chaseCount,
      elapsed_ms: Date.now() - startMs,
    };
  }
  await sleep(3000);
  const fill = await getOrderFills(result.orderNo);
  const elapsed = Date.now() - startMs;
  await recordSlippage({
    orderNo: result.orderNo,
    stockCode: params.stockCode,
    side: 'SELL',
    signalPrice: params.estimatedPrice,
    orderbookSnapshot: null,
    placedPrice: 0,
    filledPrice: fill?.filledPrice ?? params.estimatedPrice,
    chaseCount,
    elapsedMs: elapsed,
    strategyMode: params.strategyMode,
    isPaper: params.isPaper,
  });
  return {
    success: true,
    orderNo: result.orderNo,
    filledPrice: fill?.filledPrice ?? params.estimatedPrice,
    filledQty: fill?.filledQty ?? params.quantity,
    chaseCount,
    elapsed_ms: elapsed,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
