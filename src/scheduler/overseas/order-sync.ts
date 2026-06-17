/**
 * 주문 동기화 — PENDING 재처리, 마감 취소, 인사이트, 손절 쿨다운
 */

import { getCtxIsPaper } from '../../config/context.js';
import { getPool, updateOrder } from '../../db/client.js';
import { cancelOverseasOrder, getOverseasBalance } from '../../kis/overseas.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import type { OverseasExecutionResult } from './analytics.js';
import { GLOBAL_WATCHLIST } from './watchlist.js';

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

    // v10.8: 동일 종목 복수 BUY PENDING 중복 체결 방지
    const reconciledBuyQty = new Map<string, number>(); // code → 이미 체결 처리된 수량 합계
    for (const order of rows) {
      const ageMin = Number(order.age_minutes);

      if (ageMin >= 240) {
        await updateOrder(order.id, { status: 'CANCELLED', kis_status: 'TIMEOUT' });
        logger.info(`⏰ ${order.stock_code} PENDING 타임아웃 (${ageMin.toFixed(0)}분) → CANCELLED`, {
          component: 'OVERSEAS',
        });
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
            // 이미 체결 처리된 수량 차감 후 남은 잔고로 판단
            const alreadyReconciled = reconciledBuyQty.get(order.stock_code) ?? 0;
            const remainingQty = currentQty - alreadyReconciled;
            if (remainingQty <= 0) {
              logger.info(`⚠️ ${order.stock_code} BUY PENDING 스킵 (잔고 이미 다른 주문에 할당됨)`, { component: 'OVERSEAS' });
              continue;
            }
            const filledQty = Math.min(Number(order.quantity), remainingQty);
            reconciledBuyQty.set(order.stock_code, alreadyReconciled + filledQty);
            const fillPrice = position?.avgBuyPrice ?? Number(order.price);
            await updateOrder(order.id, {
              filled_quantity: filledQty,
              filled_price: fillPrice,
              status: 'FILLED',
              kis_status: 'FILLED',
            });
            // overseas_holdings 동기화 — order만 FILLED 처리하면 holdings 불일치 (P1 #3)
            await getPool().query(
              `INSERT INTO overseas_holdings (stock_code, exchange, quantity, avg_price, bought_at, is_paper)
               VALUES ($1, $2, $3, $4, NOW(), false)
               ON CONFLICT (exchange, stock_code, is_paper) DO UPDATE SET quantity=$3, avg_price=$4`,
              [order.stock_code, exchange, currentQty, fillPrice],
            ).catch((e: unknown) =>
              logger.warn(`PENDING BUY 홀딩 동기화 실패 (${order.stock_code}): ${(e as Error).message}`, { component: 'OVERSEAS' })
            );
            logger.info(`✅ ${order.stock_code} BUY PENDING→FILLED (잔고: ${currentQty}주, 할당: ${filledQty}주)`, {
              component: 'OVERSEAS',
            });
          } else if (order.side === 'SELL' && currentQty === 0) {
            await updateOrder(order.id, {
              filled_quantity: Number(order.quantity),
              filled_price: Number(order.price),
              status: 'FILLED',
              kis_status: 'FILLED',
            });
            // overseas_holdings 동기화 — qty=0 → 행 삭제 (P1 #3)
            await getPool().query(
              `DELETE FROM overseas_holdings WHERE stock_code=$1 AND exchange=$2 AND is_paper=false`,
              [order.stock_code, exchange],
            ).catch((e: unknown) =>
              logger.warn(`PENDING SELL 홀딩 동기화 실패 (${order.stock_code}): ${(e as Error).message}`, { component: 'OVERSEAS' })
            );
            logger.info(`✅ ${order.stock_code} SELL PENDING→FILLED (잔고 0 확인)`, { component: 'OVERSEAS' });
          }
        } catch (e) {
          logger.warn(`PENDING 재동기화 실패 (${order.stock_code}): ${(e as Error).message}`, {
            component: 'OVERSEAS',
          });
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
    await sleep(retryDelays[i]);
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
  const mode = (isPaper ?? getCtxIsPaper()) ? 'paper' : 'live';
  try {
    const { rows } = await getPool().query(
      `
      SELECT id, stock_code, exchange, quantity, kis_order_no
      FROM orders
      WHERE trigger_source = 'OVERSEAS'
        AND trading_mode = $1
        AND status = 'PENDING'
        AND created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY created_at ASC
    `,
      [mode],
    );

    if (rows.length === 0) {
      logger.info('🇺🇸 미국장 마감: 취소할 PENDING 주문 없음', { component: 'OVERSEAS' });
      return;
    }

    logger.info(`🇺🇸 미국장 마감: PENDING 주문 ${rows.length}건 강제 취소`, { component: 'OVERSEAS' });
    for (const order of rows) {
      if (!order.kis_order_no) {
        await getPool().query(`UPDATE orders SET status = 'CANCELLED', kis_status = 'MARKET_CLOSED' WHERE id = $1`, [
          order.id,
        ]);
        continue;
      }
      const result = await cancelOverseasOrder({
        stockCode: order.stock_code,
        exchange: order.exchange ?? 'NASDAQ',
        orderNo: order.kis_order_no,
        quantity: Number(order.quantity),
      }).catch(() => ({ success: false, message: 'cancel failed' }));

      await getPool().query(`UPDATE orders SET status = 'CANCELLED', kis_status = $1 WHERE id = $2`, [
        result.success ? 'MARKET_CLOSED_CANCEL' : 'CANCEL_FAILED',
        order.id,
      ]);
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
    const { rows } = await getPool().query("SELECT value FROM overseas_state WHERE key = 'user_insights'");
    return rows.length > 0 ? String(rows[0].value) : '';
  } catch {
    return '';
  }
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
  const mode = (isPaper ?? getCtxIsPaper()) ? 'paper' : 'live';
  try {
    const { rows } = await getPool().query(
      `
      SELECT DISTINCT stock_code
      FROM orders
      WHERE side = 'SELL'
        AND trigger_source = 'OVERSEAS'
        AND trading_mode = $1
        AND status = 'FILLED'
        AND created_at >= NOW() - INTERVAL '24 hours'
        AND ai_reasoning NOT LIKE '%집중도 캡%'
        AND ai_reasoning NOT LIKE '%집중캡%'
        AND ai_reasoning NOT LIKE '%강제 분산%'
        AND (
          ai_reasoning LIKE '%손절%'
          OR ai_reasoning LIKE '%stopLoss%'
          OR ai_reasoning LIKE '%보유기한 초과%'
          OR (
            REGEXP_REPLACE(ai_reasoning, '.*\\[avgBuy:([0-9.]+)\\].*', '\\1') ~ '^[0-9.]+$'
            AND filled_price::numeric < REGEXP_REPLACE(ai_reasoning, '.*\\[avgBuy:([0-9.]+)\\].*', '\\1')::numeric
          )
        )
    `,
      [mode],
    );
    return new Set(rows.map((r: { stock_code: string }) => String(r.stock_code)));
  } catch {
    return new Set();
  }
}

/**
 * 7일 이내 손실 매도 종목 — 24h 쿨다운 이후에도 AI 고확신(>=0.80) 없이 재진입 금지
 */
export async function getRecentLossStocks(isPaper?: boolean): Promise<Set<string>> {
  const mode = (isPaper ?? getCtxIsPaper()) ? 'paper' : 'live';
  try {
    const { rows } = await getPool().query(
      `
      SELECT DISTINCT stock_code
      FROM orders
      WHERE side = 'SELL'
        AND trigger_source = 'OVERSEAS'
        AND trading_mode = $1
        AND status = 'FILLED'
        AND created_at >= NOW() - INTERVAL '7 days'
        AND created_at < NOW() - INTERVAL '24 hours'
        AND ai_reasoning NOT LIKE '%집중도 캡%'
        AND ai_reasoning NOT LIKE '%집중캡%'
        AND ai_reasoning NOT LIKE '%강제 분산%'
        AND (
          ai_reasoning LIKE '%손절%'
          OR ai_reasoning LIKE '%stopLoss%'
          OR ai_reasoning LIKE '%보유기한 초과%'
          OR (
            REGEXP_REPLACE(ai_reasoning, '.*\\[avgBuy:([0-9.]+)\\].*', '\\1') ~ '^[0-9.]+$'
            AND filled_price::numeric < REGEXP_REPLACE(ai_reasoning, '.*\\[avgBuy:([0-9.]+)\\].*', '\\1')::numeric
          )
        )
    `,
      [mode],
    );
    return new Set(rows.map((r: { stock_code: string }) => String(r.stock_code)));
  } catch {
    return new Set();
  }
}

/**
 * -5% 초과 손실 매도 종목 — 30일 절대 차단 (CEO allowRebuy override만 해제)
 * 손해보고 판 종목을 승인 없이 재매수하지 않음
 */
export async function getBigLossBlockedOverseas(isPaperMode?: boolean): Promise<Set<string>> {
  const mode = (isPaperMode ?? getCtxIsPaper()) ? 'paper' : 'live';
  try {
    // filled_price < avg_buy_price * 0.95 → 5% 초과 손실 매도
    const { rows } = await getPool().query(
      `
      SELECT DISTINCT o.stock_code
      FROM orders o
      WHERE o.side = 'SELL'
        AND o.trigger_source = 'OVERSEAS'
        AND o.trading_mode = $1
        AND o.status = 'FILLED'
        AND o.created_at >= NOW() - INTERVAL '30 days'
        AND o.filled_price > 0
        AND o.ai_reasoning ~ '\\[avgBuy:[0-9.]+'
        AND o.filled_price::numeric < REGEXP_REPLACE(o.ai_reasoning, '.*\\[avgBuy:([0-9.]+)\\].*', '\\1')::numeric * 0.95
    `,
      [mode],
    );
    return new Set(rows.map((r: { stock_code: string }) => String(r.stock_code)));
  } catch {
    return new Set();
  }
}

/**
 * 수동매도 쿨다운 종목 조회 (live only)
 * 사용자가 KIS 앱에서 직접 매도한 종목은 2시간 동안 자동 재매수 금지
 * — 의도적 매도를 시스템이 즉시 되돌리는 상황 방지
 */
export async function getManualSellCooldownStocks(): Promise<Set<string>> {
  // paper 모드는 KIS 앱 수동매도가 없으므로 쿨다운 없음 (live 키 크로스오염 방지)
  if (getCtxIsPaper()) return new Set();
  try {
    const cutoff = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const { rows } = await getPool().query(
      `
      SELECT key FROM overseas_state
      WHERE key LIKE 'manual_sell_cd_%'
        AND value::jsonb->>'at' > $1
    `,
      [cutoff],
    );
    return new Set(rows.map((r: { key: string }) => String(r.key).replace('manual_sell_cd_', '')));
  } catch {
    return new Set();
  }
}
