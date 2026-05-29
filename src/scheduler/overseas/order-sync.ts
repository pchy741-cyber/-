/**
 * 주문 동기화 — PENDING 재처리, 마감 취소, 인사이트, 손절 쿨다운
 */
import { config } from '../../config/index.js';
import { getPool, updateOrder } from '../../db/client.js';
import { cancelOverseasOrder, getOverseasBalance } from '../../kis/overseas.js';
import { logger } from '../../utils/logger.js';
import { GLOBAL_WATCHLIST } from './watchlist.js';
import type { OverseasExecutionResult } from './analytics.js';

/**
 * PENDING 해외주문 재동기화 — 매 사이클 실행
 */
export async function syncPendingOverseasOrders(): Promise<void> {
  try {
    const { rows } = await getPool().query(`
      SELECT id, stock_code, side, quantity, price,
             EXTRACT(EPOCH FROM (NOW() - created_at)) / 60 AS age_minutes,
             kis_order_no
      FROM orders
      WHERE trigger_source = 'OVERSEAS'
        AND trading_mode = 'live'
        AND status = 'PENDING'
        AND created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY created_at ASC
    `);
    if (rows.length === 0) return;
    logger.info(`🔄 PENDING 해외주문 재동기화: ${rows.length}건`, { component: 'OVERSEAS' });

    for (const order of rows) {
      const ageMin = Number(order.age_minutes);

      if (ageMin >= 240) {
        await updateOrder(order.id, { status: 'CANCELLED', kis_status: 'TIMEOUT' });
        logger.info(`⏰ ${order.stock_code} PENDING 타임아웃 (${ageMin.toFixed(0)}분) → CANCELLED`, { component: 'OVERSEAS' });
        continue;
      }

      if (ageMin >= 15) {
        try {
          const stock = GLOBAL_WATCHLIST.find((s) => s.code === order.stock_code);
          const exchange = stock?.exchange ?? 'NASDAQ';
          const balances = await getOverseasBalance(exchange);
          const position = balances.find((b) => b.stockCode === order.stock_code);
          const currentQty = position?.quantity ?? 0;

          if (order.side === 'BUY' && currentQty > 0) {
            await updateOrder(order.id, {
              filled_quantity: Math.min(Number(order.quantity), currentQty),
              filled_price: position?.avgBuyPrice ?? Number(order.price),
              status: 'FILLED',
              kis_status: 'FILLED',
            });
            logger.info(`✅ ${order.stock_code} BUY PENDING→FILLED (잔고 확인: ${currentQty}주)`, { component: 'OVERSEAS' });
          } else if (order.side === 'SELL' && currentQty === 0) {
            await updateOrder(order.id, {
              filled_quantity: Number(order.quantity),
              filled_price: Number(order.price),
              status: 'FILLED',
              kis_status: 'FILLED',
            });
            logger.info(`✅ ${order.stock_code} SELL PENDING→FILLED (잔고 0 확인)`, { component: 'OVERSEAS' });
          }
        } catch (e) {
          logger.warn(`PENDING 재동기화 실패 (${order.stock_code}): ${(e as Error).message}`, { component: 'OVERSEAS' });
        }
      }
    }
  } catch (e) {
    logger.warn(`PENDING 재동기화 전체 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
}

/**
 * KIS 잔고 기반 체결 확인 — 주문 후 잔고 변화로 체결 추정
 */
export async function confirmOverseasFillFromBalance(params: {
  code: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  requestedQty: number;
  previousQty: number;
  previousAvgPrice: number;
  fallbackPrice: number;
}): Promise<Pick<OverseasExecutionResult, 'filledQty' | 'filledPrice' | 'finalQty' | 'finalAvgPrice'>> {
  const { code, exchange, side, requestedQty, previousQty, previousAvgPrice, fallbackPrice } = params;
  const retryDelays = [2000, 4000, 7000];

  for (let i = 0; i < retryDelays.length; i++) {
    await new Promise((r) => setTimeout(r, retryDelays[i]));
    try {
      const balances = await getOverseasBalance(exchange);
      const position = balances.find((b) => b.stockCode === code);
      const currentQty = position?.quantity ?? 0;
      const currentAvg = position?.avgBuyPrice ?? previousAvgPrice;

      if (side === 'BUY' && currentQty > previousQty) {
        const deltaQty = Math.min(requestedQty, currentQty - previousQty);
        let inferredPrice = fallbackPrice;
        if (deltaQty > 0 && currentAvg > 0) {
          if (previousQty > 0) {
            const numer = currentAvg * currentQty - previousAvgPrice * previousQty;
            const avgFromDelta = numer / deltaQty;
            if (Number.isFinite(avgFromDelta) && avgFromDelta > 0) inferredPrice = avgFromDelta;
          } else {
            inferredPrice = currentAvg;
          }
        }
        return { filledQty: deltaQty, filledPrice: inferredPrice, finalQty: currentQty, finalAvgPrice: currentAvg };
      }

      if (side === 'SELL' && currentQty < previousQty) {
        const deltaQty = Math.min(requestedQty, previousQty - currentQty);
        return { filledQty: deltaQty, filledPrice: fallbackPrice, finalQty: currentQty, finalAvgPrice: currentAvg };
      }
    } catch (e) {
      logger.warn(`해외 체결 확인 실패 (${code}, 시도 ${i + 1}): ${(e as Error).message}`, { component: 'OVERSEAS' });
    }
  }

  return { filledQty: 0, filledPrice: fallbackPrice, finalQty: previousQty, finalAvgPrice: previousAvgPrice };
}

/**
 * 미국장 마감 시 모든 PENDING 해외주문 강제 취소
 */
export async function cancelAllPendingOverseasOrders(isPaper?: boolean): Promise<void> {
  const mode = (isPaper ?? config.isPaper) ? 'paper' : 'live';
  try {
    const { rows } = await getPool().query(`
      SELECT id, stock_code, exchange, quantity, kis_order_no
      FROM orders
      WHERE trigger_source = 'OVERSEAS'
        AND trading_mode = $1
        AND status = 'PENDING'
        AND created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY created_at ASC
    `, [mode]);

    if (rows.length === 0) {
      logger.info('🇺🇸 미국장 마감: 취소할 PENDING 주문 없음', { component: 'OVERSEAS' });
      return;
    }

    logger.info(`🇺🇸 미국장 마감: PENDING 주문 ${rows.length}건 강제 취소`, { component: 'OVERSEAS' });
    for (const order of rows) {
      if (!order.kis_order_no) {
        await getPool().query(`UPDATE orders SET status = 'CANCELLED', kis_status = 'MARKET_CLOSED' WHERE id = $1`, [order.id]);
        continue;
      }
      const result = await cancelOverseasOrder({
        stockCode: order.stock_code,
        exchange: order.exchange ?? 'NASDAQ',
        orderNo: order.kis_order_no,
        quantity: Number(order.quantity),
      }).catch(() => ({ success: false, message: 'cancel failed' }));

      await getPool().query(
        `UPDATE orders SET status = 'CANCELLED', kis_status = $1 WHERE id = $2`,
        [result.success ? 'MARKET_CLOSED_CANCEL' : 'CANCEL_FAILED', order.id],
      );
      logger.info(
        `  ${result.success ? '✅' : '⚠️'} ${order.stock_code} 취소 ${result.success ? '성공' : '실패'}: ${result.message}`,
        { component: 'OVERSEAS' },
      );
    }
  } catch (e) {
    logger.error(`미국장 마감 PENDING 취소 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
}

// ── 사용자 인사이트 ──
export async function getUserInsights(): Promise<string> {
  try {
    const { rows } = await getPool().query(
      "SELECT value FROM overseas_state WHERE key = 'user_insights'",
    );
    return rows.length > 0 ? String(rows[0].value) : '';
  } catch { return ''; }
}

export async function setUserInsights(text: string): Promise<void> {
  await getPool().query(
    `INSERT INTO overseas_state (key, value) VALUES ('user_insights', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [text],
  );
}

/**
 * 손절 이후 재매수 쿨다운 — 24시간 이내 손실 매도된 종목 Set 반환
 */
export async function getLossCooldownStocks(isPaper?: boolean): Promise<Set<string>> {
  const mode = (isPaper ?? config.isPaper) ? 'paper' : 'live';
  try {
    const { rows } = await getPool().query(`
      SELECT DISTINCT stock_code
      FROM orders
      WHERE side = 'SELL'
        AND trigger_source = 'OVERSEAS'
        AND trading_mode = $1
        AND status = 'FILLED'
        AND created_at >= NOW() - INTERVAL '24 hours'
        AND (
          ai_reasoning LIKE '%손절%'
          OR ai_reasoning LIKE '%stopLoss%'
          OR ai_reasoning LIKE '%보유기한 초과%'
          OR (
            REGEXP_REPLACE(ai_reasoning, '.*\\[avgBuy:([0-9.]+)\\].*', '\\1') ~ '^[0-9.]+$'
            AND filled_price::numeric < REGEXP_REPLACE(ai_reasoning, '.*\\[avgBuy:([0-9.]+)\\].*', '\\1')::numeric
          )
        )
    `, [mode]);
    return new Set(rows.map((r: any) => String(r.stock_code)));
  } catch { return new Set(); }
}

/**
 * 7일 이내 손실 매도 종목 — 24h 쿨다운 이후에도 AI 고확신(>=0.80) 없이 재진입 금지
 */
export async function getRecentLossStocks(isPaper?: boolean): Promise<Set<string>> {
  const mode = (isPaper ?? config.isPaper) ? 'paper' : 'live';
  try {
    const { rows } = await getPool().query(`
      SELECT DISTINCT stock_code
      FROM orders
      WHERE side = 'SELL'
        AND trigger_source = 'OVERSEAS'
        AND trading_mode = $1
        AND status = 'FILLED'
        AND created_at >= NOW() - INTERVAL '7 days'
        AND created_at < NOW() - INTERVAL '24 hours'
        AND (
          ai_reasoning LIKE '%손절%'
          OR ai_reasoning LIKE '%stopLoss%'
          OR ai_reasoning LIKE '%보유기한 초과%'
          OR (
            REGEXP_REPLACE(ai_reasoning, '.*\\[avgBuy:([0-9.]+)\\].*', '\\1') ~ '^[0-9.]+$'
            AND filled_price::numeric < REGEXP_REPLACE(ai_reasoning, '.*\\[avgBuy:([0-9.]+)\\].*', '\\1')::numeric
          )
        )
    `, [mode]);
    return new Set(rows.map((r: any) => String(r.stock_code)));
  } catch { return new Set(); }
}

/**
 * 수동매도 쿨다운 종목 조회 (live only)
 * 사용자가 KIS 앱에서 직접 매도한 종목은 2시간 동안 자동 재매수 금지
 * — 의도적 매도를 시스템이 즉시 되돌리는 상황 방지
 */
export async function getManualSellCooldownStocks(): Promise<Set<string>> {
  try {
    const cutoff = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const { rows } = await getPool().query(`
      SELECT key FROM overseas_state
      WHERE key LIKE 'manual_sell_cd_%'
        AND value::jsonb->>'at' > $1
    `, [cutoff]);
    return new Set(rows.map((r: any) => String(r.key).replace('manual_sell_cd_', '')));
  } catch { return new Set(); }
}
