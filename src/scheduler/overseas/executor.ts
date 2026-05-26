/**
 * 주문 실행 (Paper/Live) & 승자 집중 전략
 */
import { OVERSEAS } from '../../config/constants.js';
import { config } from '../../config/index.js';
import { getPool, insertOrder } from '../../db/client.js';
import { placeOverseasOrder } from '../../kis/overseas.js';
import { logger } from '../../utils/logger.js';
import { updateOrder } from '../../db/client.js';
import { resolveOverseasStockName } from './watchlist.js';
import { updateTradeState } from './state.js';
import { confirmOverseasFillFromBalance } from './order-sync.js';
import type { OverseasExecutionResult } from './analytics.js';

// ── 승자 집중 전략 상수 ──
const CONCENTRATION_CASH_BUFFER  = OVERSEAS.CONCENTRATION_CASH_BUFFER;
const CONCENTRATION_MIN_PNL_PCT  = OVERSEAS.CONCENTRATION_MIN_PNL_PCT;
const CONCENTRATION_MIN_INVEST   = OVERSEAS.CONCENTRATION_MIN_INVEST;

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
  const paperMode = opts?.isPaper ?? config.isPaper;
  const stockName = resolveOverseasStockName(code, exchange);

  if (paperMode) {
    const slippage = side === 'BUY' ? 0.001 : -0.001;
    const fillPrice = price * (1 + slippage);
    const fakeOrderNo = `USP${Date.now().toString(36)}`;

    const paperReasoning = side === 'SELL' && previousAvgPrice > 0
      ? `[avgBuy:${previousAvgPrice.toFixed(4)}] ${reasoning}`
      : reasoning;
    await insertOrder({
      chain_id: null, stock_code: code, side, order_type: '01',
      quantity: qty, price: fillPrice, kis_order_no: fakeOrderNo,
      kis_status: 'PAPER_FILLED', filled_quantity: qty, filled_price: fillPrice,
      status: 'FILLED', trading_mode: 'paper', trigger_source: 'OVERSEAS',
      ai_reasoning: paperReasoning,
      avg_buy_price: side === 'SELL' ? previousAvgPrice : null,
    });

    logger.info(`📝 [US_PAPER] ${side} ${code} x${qty} @$${fillPrice.toFixed(2)} (${fakeOrderNo})`, { component: 'OVERSEAS' });

    const { notifyOverseasBuy: nb, notifyOverseasSell: ns } = await import('../../notifications/web-push.js');
    if (side === 'BUY') {
      nb(code, stockName, qty, fillPrice, reasoning).catch(() => {});
    } else {
      const pnlPct = previousAvgPrice > 0 ? ((fillPrice - previousAvgPrice) / previousAvgPrice) * 100 : 0;
      ns(code, stockName, qty, fillPrice, pnlPct, reasoning).catch(() => {});
    }
    const finalQty = side === 'BUY' ? previousQty + qty : Math.max(0, previousQty - qty);
    const finalAvgPrice = side === 'BUY' && finalQty > 0
      ? (previousAvgPrice * previousQty + fillPrice * qty) / finalQty
      : (finalQty > 0 ? previousAvgPrice : 0);
    return {
      submitted: true,
      filledQty: qty,
      filledPrice: fillPrice,
      finalQty,
      finalAvgPrice,
      orderNo: fakeOrderNo,
    };
  } else {
    try {
      const result = await placeOverseasOrder({ stockCode: code, exchange, side, quantity: qty, price });
      const liveReasoning = side === 'SELL' && previousAvgPrice > 0
        ? `[avgBuy:${previousAvgPrice.toFixed(4)}] ${reasoning}`
        : reasoning;
      const orderId = await insertOrder({
        chain_id: null, stock_code: code, side, order_type: '01',
        quantity: qty, price, kis_order_no: result.orderNo,
        kis_status: result.success ? 'SUBMITTED' : 'FAILED',
        filled_quantity: 0, filled_price: null,
        status: result.success ? 'PENDING' : 'FAILED', trading_mode: paperMode ? 'paper' : 'live',
        trigger_source: 'OVERSEAS', ai_reasoning: liveReasoning,
        avg_buy_price: side === 'SELL' ? previousAvgPrice : null,
      });
      if (result.success) {
        logger.info(`🌍 [LIVE] 주문 접수: ${side} ${code} x${qty} @$${price.toFixed(2)} (${result.orderNo})`, { component: 'OVERSEAS' });
        const confirmed = await confirmOverseasFillFromBalance({
          code, exchange, side,
          requestedQty: qty, previousQty, previousAvgPrice, fallbackPrice: price,
        });

        if (confirmed.filledQty > 0) {
          await updateOrder(orderId, {
            filled_quantity: confirmed.filledQty,
            filled_price: confirmed.filledPrice,
            status: confirmed.filledQty >= qty ? 'FILLED' : 'PARTIAL',
            kis_status: confirmed.filledQty >= qty ? 'FILLED' : 'PARTIAL',
          });
          const { notifyOverseasBuy: nb, notifyOverseasSell: ns } = await import('../../notifications/web-push.js');
          if (side === 'BUY') {
            nb(code, stockName, confirmed.filledQty, confirmed.filledPrice, reasoning).catch(() => {});
          } else {
            const pnlPct = previousAvgPrice > 0 ? ((confirmed.filledPrice - previousAvgPrice) / previousAvgPrice) * 100 : 0;
            ns(code, stockName, confirmed.filledQty, confirmed.filledPrice, pnlPct, reasoning).catch(() => {});
          }
        } else {
          logger.warn(`⏳ 체결 미확인: ${code} (${result.orderNo}) → PENDING 유지`, { component: 'OVERSEAS' });
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
        logger.error(`🌍 주문 실패: ${code} - ${result.message}`, { component: 'OVERSEAS' });
        return {
          submitted: false, filledQty: 0, filledPrice: price,
          finalQty: previousQty, finalAvgPrice: previousAvgPrice, orderNo: result.orderNo,
        };
      }
    } catch (e) {
      logger.error(`🌍 주문 에러: ${code} - ${(e as Error).message}`, { component: 'OVERSEAS' });
      return {
        submitted: false, filledQty: 0, filledPrice: price,
        finalQty: previousQty, finalAvgPrice: previousAvgPrice, orderNo: '',
      };
    }
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

  const investable = cash - CONCENTRATION_CASH_BUFFER;
  if (investable < CONCENTRATION_MIN_INVEST) return { actions: [], cashUsed: 0 };

  let bestCode: string | null = null;
  let bestPnlPct: number = CONCENTRATION_MIN_PNL_PCT;
  let bestPrice = 0;
  let bestExchange = '';
  let bestHolding: { qty: number; avgPrice: number } | null = null;

  for (const [code, holding] of holdings) {
    const tech = techResults.find(t => t.code === code);
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
    await getPool().query(
      `INSERT INTO overseas_state (key, value) VALUES ('concentration_code', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [bestCode],
    ).catch(() => {});

    const qty = Math.floor(investable / (bestPrice * 1.0025));
    if (qty >= 1) {
      const exec = await executeOverseasOrder(
        bestCode, 'BUY', qty, bestPrice, bestExchange,
        `승자집중 +${bestPnlPct.toFixed(1)}% 수익종목 추가매수 (유휴현금 $${investable.toFixed(0)})`,
        bestHolding.qty, bestHolding.avgPrice, { isPaper: params.isPaper },
      );
      if (exec.submitted && exec.filledQty > 0) {
        const cost = exec.filledQty * exec.filledPrice * 1.0025;
        await updateTradeState({ code: bestCode, exchange: bestExchange, qty: exec.finalQty, avgPrice: exec.finalAvgPrice, newCash: cash - cost, isPaper: params.isPaper });
        logger.info(`🎯 승자집중 완료: ${bestCode} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} +${bestPnlPct.toFixed(1)}% (유휴현금 $${investable.toFixed(0)} 투입)`, { component: 'OVERSEAS' });
        return {
          actions: [`🎯 승자집중 ${bestCode} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (+${bestPnlPct.toFixed(1)}% 수익종목, $${investable.toFixed(0)} 추가투입)`],
          cashUsed: cost,
        };
      }
    }
  }

  return { actions: [], cashUsed: 0 };
}
