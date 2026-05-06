import { getPendingDomesticOrders, updateOrderByKisOrderNo, logSystem } from '../db/client.js';
import { getOrderFills, cancelOrder } from '../kis/order.js';
import { logger } from '../utils/logger.js';

const PENDING_TIMEOUT_MS = 10 * 60 * 1000; // 10분 초과 미체결 → 취소

/**
 * 미체결 국내 주문 정리
 * - 체결된 것: FILLED 상태로 업데이트
 * - 10분 초과 미체결 지정가: 취소 후 CANCELLED 로 업데이트
 * Track B 사이클 시작마다 호출
 */
export async function reconcilePendingOrders(): Promise<void> {
  let pendingOrders;
  try {
    pendingOrders = await getPendingDomesticOrders();
  } catch (e) {
    logger.warn(`미체결 조회 실패: ${e}`, { component: 'RECONCILER' });
    return;
  }

  if (pendingOrders.length === 0) return;

  logger.info(`🔍 미체결 주문 ${pendingOrders.length}건 조회`, { component: 'RECONCILER' });

  for (const order of pendingOrders) {
    const kisOrderNo = order.kis_order_no!;
    try {
      const fill = await getOrderFills(kisOrderNo);

      if (fill && fill.filledQty > 0) {
        const isFullFill = fill.filledQty >= fill.orderQty;
        await updateOrderByKisOrderNo(kisOrderNo, {
          status: isFullFill ? 'FILLED' : 'PARTIAL',
          filled_quantity: fill.filledQty,
          filled_price: fill.filledPrice,
        });
        logger.info(
          `✅ 체결 확인: ${order.stock_code} ${order.side} ${fill.filledQty}주 @${fill.filledPrice}원 (${isFullFill ? 'FILLED' : 'PARTIAL'})`,
          { component: 'RECONCILER' },
        );
        continue;
      }

      // 10분 초과 미체결 지정가 → 취소
      const ageMs = Date.now() - new Date(order.created_at).getTime();
      if (ageMs > PENDING_TIMEOUT_MS && order.order_type !== '01') {
        const qty = order.quantity ?? 0;
        const cancelResult = await cancelOrder({
          orderNo: kisOrderNo,
          stockCode: order.stock_code,
          quantity: qty,
        });
        if (cancelResult.success) {
          await updateOrderByKisOrderNo(kisOrderNo, { status: 'CANCELLED' });
          logger.warn(
            `⏰ 미체결 취소: ${order.stock_code} ${order.side} ${qty}주 (${Math.round(ageMs / 60000)}분 경과)`,
            { component: 'RECONCILER' },
          );
          await logSystem('WARN', 'RECONCILER', `미체결 취소: ${order.stock_code} ${order.side} ${qty}주 (${Math.round(ageMs / 60000)}분 경과)`);
        } else {
          logger.warn(`취소 실패: ${order.stock_code} ${kisOrderNo} — ${cancelResult.message}`, { component: 'RECONCILER' });
        }
      }
    } catch (e) {
      logger.warn(`주문 정리 오류 [${order.stock_code} ${kisOrderNo}]: ${e}`, { component: 'RECONCILER' });
    }
  }
}
