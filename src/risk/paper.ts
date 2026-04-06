import { insertOrder } from '../db/client.js';
import { getCurrentPrice } from '../kis/market.js';
import type { OrderResult } from '../kis/order.js';
import { logger } from '../utils/logger.js';

/**
 * Paper Trading 어댑터
 * - KIS 실주문 대신 현재 시세로 가상 체결
 * - DB에 trading_mode='paper'로 기록
 */
export async function paperTradeOrder(params: {
  stockCode: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price?: number;
  chainId?: string;
  triggerSource?: string;
  aiReasoning?: string;
}): Promise<OrderResult> {
  const { stockCode, side, quantity, price, chainId, triggerSource, aiReasoning } = params;

  // 현재 시세 + 슬리피지 시뮬레이션 (실거래 시 실제로 발생)
  const currentPrice = await getCurrentPrice(stockCode);
  const basePrice = price ?? currentPrice.currentPrice;
  // 시장가: 0.1~0.3% 슬리피지, 지정가: 0%
  const slippagePct = price ? 0 : side === 'BUY' ? 0.002 : -0.002; // 매수 시 비싸게, 매도 시 싸게
  const filledPrice = Math.round(basePrice * (1 + slippagePct));
  const fakeOrderNo = `P${Date.now().toString(36)}`;

  // DB에 가상 주문 기록
  await insertOrder({
    chain_id: chainId ?? null,
    stock_code: stockCode,
    side,
    order_type: price ? '00' : '01', // LIMIT : MARKET
    quantity,
    price: filledPrice,
    kis_order_no: fakeOrderNo,
    kis_status: 'PAPER_FILLED',
    filled_quantity: quantity,
    filled_price: filledPrice,
    status: 'FILLED',
    trading_mode: 'paper',
    trigger_source: triggerSource ?? null,
    ai_reasoning: aiReasoning ?? null,
  });

  logger.info(`📝 [PAPER] ${side} ${stockCode} x${quantity} @${filledPrice.toLocaleString()} (${fakeOrderNo})`, {
    component: 'PAPER_TRADE',
  });

  return {
    success: true,
    orderNo: fakeOrderNo,
    message: `[모의투자] ${side} 가상 체결 완료`,
  };
}
