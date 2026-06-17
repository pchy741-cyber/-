import { getPool, logSystem, updateOrderByKisOrderNo } from '../db/client.js';
import { cancelOrder, getOrderFills } from '../kis/order.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { notifyAlert } from '../notifications/web-push.js';
import { logger } from '../utils/logger.js';

// 미체결 주문 자동 관리
// - 지정가 주문 후 5분 미체결 → 자동 취소
// - 취소 후 DB 상태 업데이트
const UNFILLED_TIMEOUT_MS = 5 * 60 * 1000; // 5분

export async function runUnfilledOrderCheck(): Promise<void> {
  // Paper 모드는 즉시 체결이므로 불필요
  // getCtxIsPaper(): AsyncLocalStorage 컨텍스트 기반 (runDomesticDual 호환)
  const { getCtxIsPaper } = await import('../config/context.js');
  if (getCtxIsPaper()) return;

  try {
    const pool = getPool();
    const cutoff = new Date(Date.now() - UNFILLED_TIMEOUT_MS).toISOString();

    // PENDING 상태이고, 5분 이상 경과한 지정가 주문 조회
    const { rows } = await pool.query<{
      id: string;
      kis_order_no: string;
      stock_code: string;
      quantity: number;
      side: string;
      order_type: string;
      created_at: string;
    }>(
      `SELECT id, kis_order_no, stock_code, quantity, side, order_type, created_at
       FROM orders
       WHERE status = 'PENDING'
         AND trading_mode = 'live'
         AND created_at < $1
       ORDER BY created_at ASC`,
      [cutoff],
    );

    if (rows.length === 0) return;

    logger.info(`미체결 주문 ${rows.length}건 발견, 자동 취소 시작`, { component: 'UNFILLED' });

    const cancelled: string[] = [];

    for (const order of rows) {
      try {
        const result = await cancelOrder({
          orderNo: order.kis_order_no,
          stockCode: order.stock_code,
          quantity: order.quantity,
        });

        if (result.success) {
          await updateOrderByKisOrderNo(order.kis_order_no, {
            status: 'CANCELLED',
            kis_status: 'CANCELLED',
          });

          cancelled.push(`${order.side === 'BUY' ? '매수' : '매도'} ${order.stock_code} x${order.quantity}`);
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
        const errMsg = String(err);
        // APBK0344: 원주문 없음 = 이미 체결 OR 이미 취소
        // BUY 주문은 체결 여부 확인 후 처리 (체결 시 체인 복구, 아니면 GHOST_CLEANED)
        if (errMsg.includes('APBK0344') || errMsg.includes('원주문정보')) {
          if (order.side === 'BUY') {
            try {
              const fill = await getOrderFills(order.kis_order_no);
              if (fill && fill.filledQty > 0) {
                // 실제 체결됨 — 체인 생성 후 주문 FILLED 처리
                const totalInvested = fill.filledPrice * fill.filledQty;
                const {
                  rows: [chain],
                } = await getPool().query<{ id: string }>(
                  `INSERT INTO transaction_chains
                     (stock_code, status, strategy_mode, avg_buy_price, total_quantity, total_invested, is_paper, opened_at)
                   VALUES ($1, 'OPEN', 'SWING', $2, $3, $4, false, NOW())
                   RETURNING id`,
                  [order.stock_code, fill.filledPrice, fill.filledQty, totalInvested],
                );
                await getPool().query(
                  `UPDATE orders SET status = 'FILLED', filled_quantity = $2, filled_price = $3, chain_id = $4, kis_status = 'FILLED_RECOVERED'
                   WHERE kis_order_no = $1`,
                  [order.kis_order_no, fill.filledQty, fill.filledPrice, chain.id],
                );
                logger.warn(
                  `🔧 체결 복구: ${order.stock_code} BUY ${fill.filledQty}주 @${fill.filledPrice}원 → 체인 #${chain.id.slice(0, 8)} OPEN (APBK0344 복구)`,
                  { component: 'UNFILLED' },
                );
                await sendTelegramMessage(
                  `🔧 미체결 BUY 복구 완료\n종목: ${order.stock_code}\n수량: ${fill.filledQty}주\n체결가: ${fill.filledPrice.toLocaleString()}원\n→ APBK0344 에러 후 체결 확인, 체인 생성 완료`,
                ).catch(() => {});
                continue; // 다음 주문으로
              }
            } catch (fillErr) {
              logger.warn(`APBK0344 체결 확인 실패 [${order.kis_order_no}]: ${fillErr}`, { component: 'UNFILLED' });
            }
          }
          // 체결 안 됨 or SELL 주문 or 체결 확인 실패 → 유령 주문 정리
          await updateOrderByKisOrderNo(order.kis_order_no, {
            status: 'CANCELLED',
            kis_status: 'GHOST_CLEANED',
          });
          logger.warn(`🧹 유령 주문 정리: ${order.kis_order_no} (KIS에 없음 → CANCELLED)`, { component: 'UNFILLED' });
        } else {
          logger.error(`미체결 취소 에러: ${order.kis_order_no} - ${err}`, { component: 'UNFILLED' });
        }
      }
    }

    await logSystem('INFO', 'UNFILLED', `미체결 주문 ${rows.length}건 자동 취소 처리`);

    if (cancelled.length > 0) {
      notifyAlert(`⏱️ 미체결 주문 ${cancelled.length}건 자동 취소`, cancelled.join('\n')).catch(() => {});
    }
  } catch (err) {
    logger.error(`미체결 주문 체크 실패: ${err}`, { component: 'UNFILLED' });
  }
}
