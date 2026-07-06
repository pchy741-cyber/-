/**
 * Vision Scalp TP/SL 자동 청산 모니터링
 * 스캘핑 포지션의 목표가/손절가 도달 시 자동 매도
 */

import { hardInvalidateDashboardCache } from '../../cache/dashboard-cache.js';
import { OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { getPool, insertOrder } from '../../db/client.js';
import { getOverseasPrice, placeOverseasOrder } from '../../kis/overseas.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';
import { cleanupPositionState, getCash, updateTradeState } from './state.js';

const DAILY_SCALP_CAP = 3; // 하루 최대 3회 청산 (수수료 드래그 억제)
const _errorCooldown = new Map<string, number>(); // code → 에러 발생 timestamp (1h 재시도 차단)
const ERROR_COOLDOWN_MS = 60 * 60_000; // 1시간

export async function monitorVisionScalp(isPaper: boolean): Promise<void> {
  try {
    // 일일 Vision Scalp 청산 횟수 체크 — 4회 초과 시 스킵
    const { rows: capRows } = await getPool()
      .query(
        `
      SELECT COUNT(*) AS cnt FROM orders
      WHERE (trading_mode = $1 OR ($1 = 'paper' AND trading_mode = 'p_arch'))
        AND trigger_source = 'OVERSEAS'
        AND ai_reasoning LIKE '%Vision단타%'
        AND created_at >= CURRENT_DATE
    `,
        [isPaper ? 'paper' : 'live'],
      )
      .catch(() => ({ rows: [{ cnt: 0 }] }));
    const todayScalpCount = Number(capRows[0]?.cnt ?? 0);
    if (todayScalpCount >= DAILY_SCALP_CAP) {
      logger.info(`[VisionScalp] 일일 한도 도달 (${todayScalpCount}/${DAILY_SCALP_CAP}) — 스킵`, {
        component: 'OVERSEAS',
      });
      return;
    }

    const { rows: scalpRows } = await getPool()
      .query(
        `
      SELECT stock_code, exchange, quantity, avg_price, scalp_tp, scalp_sl
      FROM overseas_holdings
      WHERE is_scalp = TRUE AND quantity > 0 AND scalp_tp IS NOT NULL AND is_paper = $1
    `,
        [isPaper],
      )
      .catch(() => ({
        rows: [] as Array<{
          stock_code: string;
          exchange: string;
          quantity: string;
          avg_price: string;
          scalp_tp: string | null;
          scalp_sl: string | null;
        }>,
      }));

    for (const row of scalpRows) {
      const code = String(row.stock_code);
      const exch = String(row.exchange);
      const qty = Number(row.quantity);
      const avgBuy = Number(row.avg_price);
      const tpPrice = Number(row.scalp_tp);
      const slPrice = Number(row.scalp_sl);

      try {
        const priceData = await getOverseasPrice(code, exch);
        const cur = priceData.currentPrice;
        if (cur <= 0) continue;

        const pnlPct = ((cur - avgBuy) / avgBuy) * 100;
        const hitTP = cur >= tpPrice;
        const hitSL = cur <= slPrice;

        if (hitTP || hitSL) {
          const label = hitTP ? 'TP' : 'SL';

          // v26: 에러 쿨다운 — KIS 주문 실패 시 1시간 재시도 차단 (무한 반복 방지)
          const cooldownKey = `${isPaper ? 'P' : 'L'}:${code}`;
          const lastError = _errorCooldown.get(cooldownKey);
          if (lastError && Date.now() - lastError < ERROR_COOLDOWN_MS) {
            logger.debug(`[VisionScalp] ${code} 에러 쿨다운 중 (${Math.round((ERROR_COOLDOWN_MS - (Date.now() - lastError)) / 60_000)}분 남음) — 스킵`, {
              component: 'OVERSEAS',
            });
            continue;
          }

          logger.info(`[VisionScalp] ${label} 청산 ${code} @ $${cur} (PnL: ${pnlPct.toFixed(2)}%)`, {
            component: 'OVERSEAS',
          });

          let orderNo = `VSP${Date.now().toString(36)}`;
          let kisStatus = 'PAPER_FILLED';

          if (!isPaper) {
            try {
              const result = await placeOverseasOrder({
                stockCode: code,
                exchange: exch,
                side: 'SELL',
                quantity: qty,
                price: 0,
              });
              if (result.success) {
                orderNo = result.orderNo ?? orderNo;
                kisStatus = 'PENDING';
                _errorCooldown.delete(cooldownKey); // 성공 시 쿨다운 해제
              } else {
                logger.error(`[VisionScalp] LIVE ${label} 매도 실패: ${code} (exch=${exch} qty=${qty}) — ${result.message}`, {
                  component: 'OVERSEAS',
                });
                _errorCooldown.set(cooldownKey, Date.now());
                continue;
              }
            } catch (orderErr: any) {
              logger.error(`[VisionScalp] LIVE ${label} 주문 예외: ${code} (exch=${exch} qty=${qty}) — ${orderErr.message}`, {
                component: 'OVERSEAS',
              });
              _errorCooldown.set(cooldownKey, Date.now());
              continue;
            }
          }

          const isFilled = isPaper || kisStatus === 'PAPER_FILLED';
          await insertOrder({
            chain_id: null,
            stock_code: code,
            side: 'SELL',
            order_type: '01',
            quantity: qty,
            price: cur,
            kis_order_no: orderNo,
            kis_status: kisStatus,
            filled_quantity: isFilled ? qty : 0,
            filled_price: isFilled ? cur : 0,
            status: isFilled ? 'FILLED' : 'PENDING',
            trading_mode: isPaper ? 'paper' : 'live',
            trigger_source: 'OVERSEAS',
            ai_reasoning: `[avgBuy:${avgBuy.toFixed(4)}] Vision단타 ${label} 청산 ${pnlPct.toFixed(2)}%`,
            avg_buy_price: avgBuy,
          });

          const recovered = qty * cur * (1 - OVERSEAS_FEE_PCT);
          const newCash = (await getCash(isPaper)) + recovered;
          await updateTradeState({ code, exchange: exch, qty: 0, avgPrice: 0, newCash, isPaper });
          await cleanupPositionState(code, isPaper);
          hardInvalidateDashboardCache();
          sendTelegramMessage(
            `🎯 Vision단타 ${label} 청산\n${code} ${qty}주 @ $${cur.toFixed(2)}\nPnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%\n회수: $${recovered.toFixed(0)}`,
          ).catch(() => {});
        }
      } catch {
        /* 개별 종목 오류 무시 */
      }
    }
  } catch {
    /* scalp 모니터링 전체 오류 무시 */
  }
}
