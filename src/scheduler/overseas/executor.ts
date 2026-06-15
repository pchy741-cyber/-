/**
 * 주문 실행 (Paper/Live) & 승자 집중 전략
 */

import { hardInvalidateDashboardCache } from '../../cache/dashboard-cache.js';
import { invalidateBalanceCache } from '../../kis/account.js';
import { OVERSEAS, OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { getCtxIsPaper } from '../../config/context.js';
import { getAllocRisk } from '../../db/alloc-risk-cache.js';
import { getPool, insertOrder, updateOrder } from '../../db/client.js';
import { placeOverseasOrder } from '../../kis/overseas.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import type { OverseasExecutionResult } from './analytics.js';
import { confirmOverseasFillFromBalance } from './order-sync.js';
import { updateTradeState } from './state.js';
import { resolveOverseasStockName } from './watchlist.js';

/** 해외 SELL 체결 후 score_accuracy 기록 */
async function recordOverseasScoreAccuracy(params: {
  stockCode: string;
  orderId: string;
  avgBuyPrice: number;
  fillPrice: number;
  isPaper: boolean;
  reasoning: string;
}): Promise<void> {
  try {
    const { stockCode, orderId, avgBuyPrice, fillPrice, isPaper } = params;
    if (avgBuyPrice <= 0 || fillPrice <= 0) return;
    const pnlPct = ((fillPrice - avgBuyPrice) / avgBuyPrice) * 100;
    const outcome = pnlPct > 0.1 ? 'WIN' : pnlPct < -0.1 ? 'LOSS' : 'BREAK_EVEN';

    // 보유일수 추정: 가장 최근 BUY 주문 시점 기준
    const pool = getPool();
    const { rows: buyRows } = await pool.query(
      `SELECT created_at FROM orders
       WHERE stock_code = $1 AND side = 'BUY' AND status = 'FILLED'
         AND trigger_source = 'OVERSEAS' AND trading_mode = $2
       ORDER BY created_at DESC LIMIT 1`,
      [stockCode, isPaper ? 'paper' : 'live'],
    );
    const holdingDays = buyRows[0]?.created_at
      ? Math.round((Date.now() - new Date(buyRows[0].created_at).getTime()) / 86400000)
      : null;

    await pool.query(
      `INSERT INTO score_accuracy
         (stock_code, order_id, market, realized_pnl_pct, outcome, holding_days,
          close_reason, is_paper)
       VALUES ($1, $2, 'US', $3, $4, $5, $6, $7)
       ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING`,
      [stockCode, orderId, pnlPct, outcome, holdingDays, params.reasoning, isPaper],
    );
    logger.info(`📝 해외 스코어 기록: ${stockCode} ${outcome} (${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`, {
      component: 'OVERSEAS',
    });
  } catch (err) {
    logger.warn(`해외 스코어 기록 실패: ${err}`, { component: 'OVERSEAS' });
  }
}

import { getOverseasDynamic } from '../../config/constants.js';

/**
 * 미국주식 주문 실행 (Paper / Live)
 */
export async function executeOverseasOrder(
  code: string,
  side: 'BUY' | 'SELL',
  qty: number,
  price: number,
  exchange: string,
  reasoning: string,
  previousQty: number,
  previousAvgPrice: number,
  opts?: { isPaper?: boolean },
): Promise<OverseasExecutionResult> {
  const paperMode = opts?.isPaper ?? getCtxIsPaper();
  const stockName = resolveOverseasStockName(code, exchange);

  // Zero price 방어 — 잘못된 가격으로 주문 시 avg_price 오염 방지
  if (!price || price <= 0 || !Number.isFinite(price)) {
    logger.error(`🚫 Zero/Invalid price 차단: ${side} ${code} @$${price} — 주문 거부`, { component: 'OVERSEAS' });
    return { submitted: false, filledQty: 0, filledPrice: 0, finalQty: previousQty, finalAvgPrice: previousAvgPrice, orderNo: '' };
  }

  if (paperMode) {
    const slippage = side === 'BUY' ? 0.001 : -0.001;
    const fillPrice = price * (1 + slippage);
    const fakeOrderNo = `USP${Date.now().toString(36)}`;

    const paperReasoning =
      side === 'SELL' && previousAvgPrice > 0 ? `[avgBuy:${previousAvgPrice.toFixed(4)}] ${reasoning}` : reasoning;
    const paperOrderId = await insertOrder({
      chain_id: null,
      stock_code: code,
      side,
      order_type: '01',
      quantity: qty,
      price: fillPrice,
      kis_order_no: fakeOrderNo,
      kis_status: 'PAPER_FILLED',
      filled_quantity: qty,
      filled_price: fillPrice,
      status: 'FILLED',
      trading_mode: 'paper',
      trigger_source: 'OVERSEAS',
      ai_reasoning: paperReasoning,
      avg_buy_price: side === 'SELL' ? previousAvgPrice : null,
    });

    logger.info(`📝 [US_PAPER] ${side} ${code} x${qty} @$${fillPrice.toFixed(2)} (${fakeOrderNo})`, {
      component: 'OVERSEAS',
    });
    hardInvalidateDashboardCache();
    invalidateBalanceCache();
    // 해외 스코어 캐시 무효화 — 체결된 종목의 중복 매수 신호 방지
    import('../../cache/overseas-scores.js')
      .then((m) => m.invalidateOverseasScoreForStock(code))
      .catch(() => {});

    const { notifyOverseasBuy: nb, notifyOverseasSell: ns } = await import('../../notifications/web-push.js');
    if (side === 'BUY') {
      nb(code, stockName, qty, fillPrice, reasoning).catch(() => {});
    } else {
      const pnlPct = previousAvgPrice > 0 ? ((fillPrice - previousAvgPrice) / previousAvgPrice) * 100 : 0;
      ns(code, stockName, qty, fillPrice, pnlPct, reasoning).catch(() => {});
      // 해외 SELL score_accuracy 기록
      recordOverseasScoreAccuracy({
        stockCode: code,
        orderId: paperOrderId,
        avgBuyPrice: previousAvgPrice,
        fillPrice,
        isPaper: true,
        reasoning,
      }).catch(() => {});
    }
    const finalQty = side === 'BUY' ? previousQty + qty : Math.max(0, previousQty - qty);
    const finalAvgPrice =
      side === 'BUY' && finalQty > 0
        ? (previousAvgPrice * previousQty + fillPrice * qty) / finalQty
        : finalQty > 0
          ? previousAvgPrice
          : 0;
    return {
      submitted: true,
      filledQty: qty,
      filledPrice: fillPrice,
      finalQty,
      finalAvgPrice,
      orderNo: fakeOrderNo,
    };
  } else {
    // SELL 주문 실패 시 재시도 (손절/익절 실패는 위험 → 최대 2회 재시도)
    const MAX_SELL_RETRIES = side === 'SELL' ? 2 : 0;
    const RETRY_DELAYS = [1000, 2000]; // 1초, 2초 백오프

    for (let attempt = 0; attempt <= MAX_SELL_RETRIES; attempt++) {
      try {
        const result = await placeOverseasOrder({ stockCode: code, exchange, side, quantity: qty, price });
        const liveReasoning =
          side === 'SELL' && previousAvgPrice > 0 ? `[avgBuy:${previousAvgPrice.toFixed(4)}] ${reasoning}` : reasoning;
        const orderId = await insertOrder({
          chain_id: null,
          stock_code: code,
          side,
          order_type: '01',
          quantity: qty,
          price,
          kis_order_no: result.orderNo,
          kis_status: result.success ? 'SUBMITTED' : 'FAILED',
          filled_quantity: 0,
          filled_price: null,
          status: result.success ? 'PENDING' : 'FAILED',
          trading_mode: paperMode ? 'paper' : 'live',
          trigger_source: 'OVERSEAS',
          ai_reasoning: attempt > 0 ? `[재시도${attempt}] ${liveReasoning}` : liveReasoning,
          avg_buy_price: side === 'SELL' ? previousAvgPrice : null,
        });
        if (result.success) {
          logger.info(`🌍 [LIVE] 주문 접수: ${side} ${code} x${qty} @$${price.toFixed(2)} (${result.orderNo})${attempt > 0 ? ` [재시도${attempt}]` : ''}`, {
            component: 'OVERSEAS',
          });
          const confirmed = await confirmOverseasFillFromBalance({
            code,
            exchange,
            side,
            requestedQty: qty,
            previousQty,
            previousAvgPrice,
            fallbackPrice: price,
          });

          if (confirmed.filledQty > 0) {
            await updateOrder(orderId, {
              filled_quantity: confirmed.filledQty,
              filled_price: confirmed.filledPrice,
              status: confirmed.filledQty >= qty ? 'FILLED' : 'PARTIAL',
              kis_status: confirmed.filledQty >= qty ? 'FILLED' : 'PARTIAL',
            });
            hardInvalidateDashboardCache();
            invalidateBalanceCache();
            // 해외 스코어 캐시 무효화 — 체결된 종목의 중복 매수 신호 방지
            import('../../cache/overseas-scores.js')
              .then((m) => m.invalidateOverseasScoreForStock(code))
              .catch(() => {});
            const { notifyOverseasBuy: nb, notifyOverseasSell: ns } = await import('../../notifications/web-push.js');
            if (side === 'BUY') {
              nb(code, stockName, confirmed.filledQty, confirmed.filledPrice, reasoning).catch(() => {});
            } else {
              const pnlPct =
                previousAvgPrice > 0 ? ((confirmed.filledPrice - previousAvgPrice) / previousAvgPrice) * 100 : 0;
              ns(code, stockName, confirmed.filledQty, confirmed.filledPrice, pnlPct, reasoning).catch(() => {});
              // 해외 SELL score_accuracy 기록
              recordOverseasScoreAccuracy({
                stockCode: code,
                orderId,
                avgBuyPrice: previousAvgPrice,
                fillPrice: confirmed.filledPrice,
                isPaper: false,
                reasoning,
              }).catch(() => {});
            }
          } else {
            // PENDING 주문 stuck 방지: 체결 미확인 시 UNCONFIRMED로 전환 (fill-reconciler가 추후 처리)
            await updateOrder(orderId, {
              status: 'FAILED',
              kis_status: 'UNCONFIRMED',
            });
            logger.warn(`⏳ 체결 미확인 → FAILED(UNCONFIRMED) 전환: ${code} (${result.orderNo})`, { component: 'OVERSEAS' });
          }

          return {
            submitted: true,
            filledQty: confirmed.filledQty,
            filledPrice: confirmed.filledPrice,
            finalQty: confirmed.finalQty,
            finalAvgPrice: confirmed.finalAvgPrice,
            orderNo: result.orderNo,
          };
        } else {
          // SELL 실패 시 재시도 (BUY는 재시도 없음)
          if (attempt < MAX_SELL_RETRIES) {
            logger.warn(`🔄 SELL 재시도 ${attempt + 1}/${MAX_SELL_RETRIES}: ${code} - ${result.message} (${RETRY_DELAYS[attempt]}ms 후)`, { component: 'OVERSEAS' });
            await sleep(RETRY_DELAYS[attempt]);
            continue;
          }
          logger.error(`🌍 주문 실패: ${code} - ${result.message}${attempt > 0 ? ` [${attempt}회 재시도 후]` : ''}`, { component: 'OVERSEAS' });
          return {
            submitted: false,
            filledQty: 0,
            filledPrice: price,
            finalQty: previousQty,
            finalAvgPrice: previousAvgPrice,
            orderNo: result.orderNo,
          };
        }
      } catch (e) {
        // SELL 에러 시 재시도
        if (attempt < MAX_SELL_RETRIES) {
          logger.warn(`🔄 SELL 재시도 ${attempt + 1}/${MAX_SELL_RETRIES}: ${code} - ${(e as Error).message} (${RETRY_DELAYS[attempt]}ms 후)`, { component: 'OVERSEAS' });
          await sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        logger.error(`🌍 주문 에러: ${code} - ${(e as Error).message}${attempt > 0 ? ` [${attempt}회 재시도 후]` : ''}`, { component: 'OVERSEAS' });
        return {
          submitted: false,
          filledQty: 0,
          filledPrice: price,
          finalQty: previousQty,
          finalAvgPrice: previousAvgPrice,
          orderNo: '',
        };
      }
    }
    // 도달 불가 (루프 내에서 항상 return)
    return { submitted: false, filledQty: 0, filledPrice: price, finalQty: previousQty, finalAvgPrice: previousAvgPrice, orderNo: '' };
  }
}

/**
 * 유휴현금 → 수익률 1위 보유종목 추가매수 (승자 집중 전략)
 */
export async function deployIdleCash(params: {
  cash: number;
  holdings: Map<string, { qty: number; avgPrice: number; boughtAt: string; exchange: string }>;
  techResults: Array<{ code: string; name: string; exchange: string; price: { currentPrice: number } }>;
  isUSSession: boolean;
  avgScore: number;
  isPaper?: boolean;
}): Promise<{ actions: string[]; cashUsed: number }> {
  const { cash, holdings, techResults, isUSSession, avgScore } = params;
  if (!isUSSession) return { actions: [], cashUsed: 0 };

  // 동적: 포트폴리오 규모 기반 집중전략 파라미터
  const holdingValue = Array.from(holdings.values()).reduce((s, h) => s + h.qty * h.avgPrice, 0);
  const isPaperCtx = params.isPaper ?? getCtxIsPaper();
  const allocRisk = await getAllocRisk(isPaperCtx);
  const dynP = getOverseasDynamic(cash + holdingValue, isPaperCtx, allocRisk.positionCapPct / 100);
  const investable = cash - dynP.concentrationCashBuffer;
  if (investable < dynP.concentrationMinInvest) return { actions: [], cashUsed: 0 };

  let bestCode: string | null = null;
  let bestPnlPct: number = OVERSEAS.CONCENTRATION_MIN_PNL_PCT;
  let bestPrice = 0;
  let bestExchange = '';
  let bestHolding: { qty: number; avgPrice: number } | null = null;

  for (const [code, holding] of holdings) {
    const tech = techResults.find((t) => t.code === code);
    if (!tech || tech.price.currentPrice <= 0) continue;
    const pnlPct = ((tech.price.currentPrice - holding.avgPrice) / holding.avgPrice) * 100;
    if (pnlPct > bestPnlPct) {
      bestPnlPct = pnlPct;
      bestCode = code;
      bestPrice = tech.price.currentPrice;
      bestExchange = tech.exchange;
      bestHolding = holding;
    }
  }

  if (bestCode && bestHolding && bestPrice > 0) {
    const concKey = (params.isPaper ?? getCtxIsPaper()) ? 'p_concentration_code' : 'l_concentration_code';
    await getPool()
      .query(
        `INSERT INTO overseas_state (key, value) VALUES ($2, $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
        [bestCode, concKey],
      )
      .catch(() => {});

    const qty = Math.floor(investable / (bestPrice * (1 + OVERSEAS_FEE_PCT)));
    if (qty >= 1) {
      const exec = await executeOverseasOrder(
        bestCode,
        'BUY',
        qty,
        bestPrice,
        bestExchange,
        `승자집중 +${bestPnlPct.toFixed(1)}% 수익종목 추가매수 (유휴현금 $${investable.toFixed(0)})`,
        bestHolding.qty,
        bestHolding.avgPrice,
        { isPaper: params.isPaper },
      );
      if (exec.submitted && exec.filledQty > 0) {
        const cost = exec.filledQty * exec.filledPrice * (1 + OVERSEAS_FEE_PCT);
        await updateTradeState({
          code: bestCode,
          exchange: bestExchange,
          qty: exec.finalQty,
          avgPrice: exec.finalAvgPrice,
          newCash: cash - cost,
          isPaper: params.isPaper,
        });
        logger.info(
          `🎯 승자집중 완료: ${bestCode} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} +${bestPnlPct.toFixed(1)}% (유휴현금 $${investable.toFixed(0)} 투입)`,
          { component: 'OVERSEAS' },
        );
        return {
          actions: [
            `🎯 승자집중 ${bestCode} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (+${bestPnlPct.toFixed(1)}% 수익종목, $${investable.toFixed(0)} 추가투입)`,
          ],
          cashUsed: cost,
        };
      }
    }
  }

  return { actions: [], cashUsed: 0 };
}
