import { getPool, logSystem, updateOrder } from '../db/client.js';
import { cancelOrder } from '../kis/order.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

// 미체결 주문 자동 관리
// - 지정가 주문 후 5분 미체결 → 자동 취소
// - 취소 후 DB 상태 업데이트
const UNFILLED_TIMEOUT_MS = 5 * 60 * 1000; // 5분

export async function runUnfilledOrderCheck(): Promise<void> {
  if (config.isPaper) return; // Paper 모드는 즉시 체결이므로 불필요

  try {
    const pool = getPool();
    const cutoff = new Date(Date.now() - UNFILLED_TIMEOUT_MS).toISOString();

    // PENDING 상태이고, 5분 이상 경과한 지정가 주문 조회
    const { rows } = await pool.query<{
      kis_order_no: string;
      stock_code: string;
      quantity: number;
      side: string;
      order_type: string;
      created_at: string;
    }>(
      `SELECT kis_order_no, stock_code, quantity, side, order_type, created_at
       FROM orders
       WHERE status = 'PENDING'
         AND order_type = '00'
         AND trading_mode = 'live'
         AND created_at < $1
       ORDER BY created_at ASC`,
      [cutoff],
    );

    if (rows.length === 0) return;

    logger.info(`미체결 주문 ${rows.length}건 발견, 자동 취소 시작`, { component: 'UNFILLED' });

    for (const order of rows) {
      try {
        const result = await cancelOrder({
          orderNo: order.kis_order_no,
          stockCode: order.stock_code,
          quantity: order.quantity,
        });

        if (result.success) {
          await updateOrder(order.kis_order_no, {
            status: 'CANCELLED',
            kis_status: 'CANCELLED',
          });

          logger.info(
            `미체결 자동 취소: ${order.side} ${order.stock_code} x${order.quantity} (주문번호: ${order.kis_order_no})`,
            { component: 'UNFILLED' },
          );
        } else {
          logger.warn(`미체결 취소 실패: ${order.kis_order_no} - ${result.message}`, {
            component: 'UNFILLED',
          });
        }
      } catch (err) {
        logger.error(`미체결 취소 에러: ${order.kis_order_no} - ${err}`, { component: 'UNFILLED' });
      }
    }

    await logSystem(
      'INFO',
      'UNFILLED',
      `미체결 주문 ${rows.length}건 자동 취소 처리`,
    );
  } catch (err) {
    logger.error(`미체결 주문 체크 실패: ${err}`, { component: 'UNFILLED' });
  }
}
