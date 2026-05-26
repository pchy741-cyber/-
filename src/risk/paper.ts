import { KR_FEE } from '../config/constants.js';
import { insertOrder } from '../db/client.js';
import { getCurrentPrice } from '../kis/market.js';
import type { OrderResult } from '../kis/order.js';
import { logger } from '../utils/logger.js';

// 순환 참조 방지: engine.ts에서 직접 import 하지 않고 lazy import
let _addPaper: ((n: number) => void) | null = null;
let _removePaper: ((sellAmount: number, buyAmount?: number) => void) | null = null;
async function getPaperFns() {
  if (!_addPaper) {
    const m = await import('./engine.js');
    _addPaper = m.addPaperInvestment;
    _removePaper = m.removePaperInvestment;
  }
  return { add: _addPaper!, remove: _removePaper! };
}

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
  let basePrice = price ?? 0;
  if (!basePrice) {
    try {
      const currentPrice = await getCurrentPrice(stockCode);
      basePrice = currentPrice?.currentPrice ?? 0;
    } catch { /* 시세 조회 실패 시 0 → 아래에서 에러 처리 */ }
  }
  if (basePrice <= 0) {
    return { success: false, orderNo: '', message: `[모의투자] 현재가 조회 실패: ${stockCode}` };
  }
  // 슬리피지: 시가총액 기반 (연구 근거: 대형주 0.05-0.1%, 중소형주 0.3-0.5%)
  // 가격 50만원 이상 = 대형주 추정, 미만 = 중소형주
  const isLargeCap = basePrice >= 500000;
  const slippagePct = price ? 0 : side === 'BUY'
    ? (isLargeCap ? 0.001 : 0.003)   // 매수: 대형주 0.1%, 중소형주 0.3%
    : (isLargeCap ? -0.001 : -0.003); // 매도: 역방향
  const filledPrice = Math.round(basePrice * (1 + slippagePct));
  const fakeOrderNo = `P${Date.now().toString(36)}`;

  // ── 수수료 계산 (실거래와 동일, 2025 세율 기준) ──
  // 매수: 증권사 수수료 0.015%
  // 매도: 증권사 0.015% + 거래세 0.18% = 0.195%
  const BUY_FEE_PCT = KR_FEE.BUY_FEE_PCT;
  const SELL_FEE_PCT = KR_FEE.SELL_FEE_PCT;
  const orderValue = filledPrice * quantity;
  const feeRate = side === 'BUY' ? BUY_FEE_PCT : SELL_FEE_PCT;
  const fee = Math.round(orderValue * feeRate);

  // DB에 가상 주문 기록
  await insertOrder({
    chain_id: chainId ?? null,
    stock_code: stockCode,
    side,
    order_type: price ? '00' : '01',
    quantity,
    price: filledPrice,
    kis_order_no: fakeOrderNo,
    kis_status: 'PAPER_FILLED',
    filled_quantity: quantity,
    filled_price: filledPrice,
    status: 'FILLED',
    trading_mode: 'paper',
    trigger_source: triggerSource ?? null,
    ai_reasoning: `${aiReasoning ?? ''} [수수료 ${fee.toLocaleString()}원 (${(feeRate * 100).toFixed(3)}%)]`,
  });

  // Paper 현금 추적: 매수 시 차감(+수수료), 매도 시 복원(-수수료+실현손익)
  try {
    const fns = await getPaperFns();
    if (side === 'BUY') {
      fns.add(orderValue + fee); // 매수원가 + 수수료
    } else {
      // 매도: 매도금액(수수료 차감)과 매수원가를 따로 전달
      const { chainManager } = await import('../trading/chain.js');
      const chain = chainId ? await chainManager.findOpenChain(stockCode) : null;
      const avgBuy = chain ? Number(chain.avg_buy_price) : filledPrice;
      const costBasis = avgBuy * quantity;
      fns.remove(orderValue - fee, costBasis); // 매도 순수익, 매수원가
    }
  } catch { /* paper cash tracking 실패해도 주문은 진행 */ }

  logger.info(`📝 [PAPER] ${side} ${stockCode} x${quantity} @${filledPrice.toLocaleString()} (${fakeOrderNo}) | 금액${orderValue.toLocaleString()} 수수료${fee.toLocaleString()}원`, {
    component: 'PAPER_TRADE',
  });

  return {
    success: true,
    orderNo: fakeOrderNo,
    message: `[모의투자] ${side} 가상 체결 완료`,
  };
}
