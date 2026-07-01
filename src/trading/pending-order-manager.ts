/**
 * Pending Order Manager — 지지선 지정가 미체결 주문 관리
 *
 * 근거:
 * - 기존 confirmFill 30초 타임아웃 → 지지선 도달 전 취소됨
 * - NautilusTrader, MMR 등 주요 프레임워크의 pending order 관리 표준 패턴
 * - 앱 레이어에서 미체결 주문 추적 + 체결 확인 + 지지선 재계산
 *
 * 동작:
 * 1. 지정가 매수 미체결 → system_state에 등록
 * 2. Track B 사이클마다 managePendingOrders() 호출
 * 3. 체결 확인 → 체인 생성 + 워치독 시작
 * 4. 10분 미체결 → 지지선 재계산 → 취소 후 새 주문 (최대 3회)
 * 5. 현재가 +3% 이상 이탈 → 즉시 포기
 */
import { getCtxIsPaper } from '../config/context.js';
import { getDynamicDomesticTpSl, OrderType, type StrategyMode } from '../config/constants.js';
import { getActiveStrategy, getPool, updateOrderByKisOrderNo } from '../db/client.js';
import { getCurrentPrice, getOrderbook } from '../kis/market.js';
import { cancelOrder, getOrderFills, placeOrder } from '../kis/order.js';
import { adjustToTickSize, roundKrw } from '../utils/money.js';
import { logger } from '../utils/logger.js';
import { chainManager } from './chain.js';
import { startWatchdog } from './post-fill-watchdog.js';
import { calculateATR } from '../automation/position-sizer.js';

// ── Types ──

interface PendingOrder {
  orderNo: string;
  stockCode: string;
  quantity: number;
  limitPrice: number;
  supportReasoning: string;
  mode: StrategyMode;
  isPaper: boolean;
  createdAt: number;
  repositionCount: number;
  aiScore?: number;
  tpSlHints?: Record<string, number>;
  maxAveragingCount?: number;
}

// ── Constants ──

const REPOSITION_INTERVAL_MS = 10 * 60_000; // 10분마다 재배치
const MAX_REPOSITIONS = 3; // 최대 3회 재배치 후 포기
const ABANDON_DRIFT_PCT = 3.0; // 현재가가 지지선에서 +3% 이상 이탈 시 포기

// ── State ──

const _pendingOrders = new Map<string, PendingOrder>();

// ── Public API ──

/**
 * 미체결 지정가 매수 등록
 * executor.ts의 confirmFill 타임아웃 후 호출
 */
export async function registerPendingOrder(params: {
  orderNo: string;
  stockCode: string;
  quantity: number;
  limitPrice: number;
  supportReasoning: string;
  mode: StrategyMode;
  isPaper: boolean;
  aiScore?: number;
  tpSlHints?: Record<string, number>;
  maxAveragingCount?: number;
}): Promise<void> {
  const pending: PendingOrder = {
    ...params,
    createdAt: Date.now(),
    repositionCount: 0,
  };

  _pendingOrders.set(params.orderNo, pending);
  await saveState(pending);

  logger.info(
    `📋 예약주문 등록: ${params.stockCode} ${params.limitPrice.toLocaleString()}원 ${params.quantity}주 [${params.supportReasoning}]`,
    { component: 'PENDING_MGR' },
  );
}

/**
 * Track B 사이클마다 호출 — 미체결 주문 관리
 */
export async function managePendingOrders(): Promise<void> {
  if (_pendingOrders.size === 0) return;

  const toRemove: string[] = [];

  for (const [orderNo, pending] of _pendingOrders) {
    try {
      // 1. 체결 확인
      if (!pending.isPaper) {
        const fill = await getOrderFills(orderNo).catch(() => null);
        if (fill && fill.filledQty > 0) {
          logger.info(
            `✅ 예약주문 체결: ${pending.stockCode} ${fill.filledQty}주 @${fill.filledPrice}`,
            { component: 'PENDING_MGR' },
          );

          await updateOrderByKisOrderNo(orderNo, {
            filled_quantity: fill.filledQty,
            filled_price: fill.filledPrice,
            status: fill.filledQty >= pending.quantity ? 'FILLED' : 'PARTIAL',
            kis_status: 'FILLED',
          });

          await createChainFromFill(pending, fill.filledQty, roundKrw(fill.filledPrice || pending.limitPrice));
          toRemove.push(orderNo);
          continue;
        }
      }

      // 2. 현재가 확인 — 지지선 이탈 체크
      const priceInfo = await getCurrentPrice(pending.stockCode).catch(() => null);
      if (!priceInfo || priceInfo.currentPrice <= 0) continue;

      const driftPct = ((priceInfo.currentPrice - pending.limitPrice) / pending.limitPrice) * 100;

      // 현재가가 지지선보다 +3% 이상 → 포기 (되돌아올 가능성 낮음)
      if (driftPct >= ABANDON_DRIFT_PCT) {
        logger.info(
          `📋 예약주문 포기: ${pending.stockCode} drift=${driftPct.toFixed(1)}% ≥ ${ABANDON_DRIFT_PCT}%`,
          { component: 'PENDING_MGR' },
        );
        if (!pending.isPaper) {
          await cancelOrder({ orderNo, stockCode: pending.stockCode, quantity: pending.quantity }).catch(() => {});
          await updateOrderByKisOrderNo(orderNo, { status: 'CANCELLED' }).catch(() => {});
        }
        toRemove.push(orderNo);
        continue;
      }

      // 3. 10분 경과 → 재배치
      const elapsed = Date.now() - pending.createdAt;
      if (elapsed >= REPOSITION_INTERVAL_MS && pending.repositionCount < MAX_REPOSITIONS) {
        await repositionOrder(pending, priceInfo.currentPrice);
        continue;
      }

      // 4. 최대 재배치 횟수 초과 → 포기
      if (pending.repositionCount >= MAX_REPOSITIONS) {
        logger.info(
          `📋 예약주문 포기: ${pending.stockCode} 재배치 ${MAX_REPOSITIONS}회 초과`,
          { component: 'PENDING_MGR' },
        );
        if (!pending.isPaper) {
          await cancelOrder({ orderNo, stockCode: pending.stockCode, quantity: pending.quantity }).catch(() => {});
          await updateOrderByKisOrderNo(orderNo, { status: 'CANCELLED' }).catch(() => {});
        }
        toRemove.push(orderNo);
        continue;
      }
    } catch (e) {
      logger.warn(`📋 예약주문 관리 오류: ${pending.stockCode} ${(e as Error).message}`, {
        component: 'PENDING_MGR',
      });
    }
  }

  // 정리
  for (const orderNo of toRemove) {
    _pendingOrders.delete(orderNo);
    await removeState(orderNo).catch(() => {});
  }
}

/**
 * 서버 재시작 후 복구
 */
export async function recoverPendingOrders(): Promise<void> {
  try {
    const { rows } = await getPool().query<{ key: string; value: string }>(
      `SELECT key, value FROM system_state WHERE key LIKE 'pending_%'`,
    );

    let recovered = 0;
    for (const row of rows) {
      try {
        const pending = JSON.parse(row.value) as PendingOrder;
        const elapsed = Date.now() - pending.createdAt;

        // 30분 이상 경과 → 만료 정리
        if (elapsed >= 30 * 60_000) {
          if (!pending.isPaper) {
            await cancelOrder({
              orderNo: pending.orderNo,
              stockCode: pending.stockCode,
              quantity: pending.quantity,
            }).catch(() => {});
          }
          await removeState(pending.orderNo);
          continue;
        }

        _pendingOrders.set(pending.orderNo, pending);
        recovered++;
      } catch {
        await getPool()
          .query(`DELETE FROM system_state WHERE key = $1`, [row.key])
          .catch(() => {});
      }
    }

    if (recovered > 0) {
      logger.info(`📋 예약주문 복구: ${recovered}개 재시작`, { component: 'PENDING_MGR' });
    }
  } catch (e) {
    logger.warn(`📋 예약주문 복구 실패: ${(e as Error).message}`, { component: 'PENDING_MGR' });
  }
}

// ── Internal ──

/**
 * 지지선 재계산 후 주문 재배치
 */
async function repositionOrder(pending: PendingOrder, currentPrice: number): Promise<void> {
  // 기존 주문 취소
  if (!pending.isPaper) {
    await cancelOrder({
      orderNo: pending.orderNo,
      stockCode: pending.stockCode,
      quantity: pending.quantity,
    }).catch(() => {});
    await updateOrderByKisOrderNo(pending.orderNo, { status: 'CANCELLED' }).catch(() => {});
  }

  // 새 지지선 계산 (executor의 calcSupportBuyPrice 로직 재활용은 순환 참조 → 간소화)
  const book = await getOrderbook(pending.stockCode).catch(() => []);
  const bid1 = book[0]?.bidPrice ?? 0;
  const ask1 = book[0]?.askPrice ?? 0;
  if (bid1 <= 0 || ask1 <= 0) {
    logger.warn(`📋 재배치 실패 (호가없음): ${pending.stockCode}`, { component: 'PENDING_MGR' });
    return;
  }

  const newPrice = adjustToTickSize(Math.floor((bid1 + ask1) / 2));

  // 새 주문
  if (!pending.isPaper) {
    try {
      const result = await placeOrder({
        stockCode: pending.stockCode,
        side: 'BUY',
        quantity: pending.quantity,
        price: newPrice,
        orderType: OrderType.LIMIT,
      });

      if (!result.success) {
        logger.warn(`📋 재배치 주문 실패: ${pending.stockCode}`, { component: 'PENDING_MGR' });
        return;
      }

      // 기존 엔트리 삭제, 새 주문번호로 재등록
      _pendingOrders.delete(pending.orderNo);
      await removeState(pending.orderNo);

      const newPending: PendingOrder = {
        ...pending,
        orderNo: result.orderNo,
        limitPrice: newPrice,
        createdAt: Date.now(),
        repositionCount: pending.repositionCount + 1,
      };
      _pendingOrders.set(result.orderNo, newPending);
      await saveState(newPending);

      logger.info(
        `📋 예약주문 재배치 (${pending.repositionCount + 1}/${MAX_REPOSITIONS}): ${pending.stockCode} ${pending.limitPrice.toLocaleString()} → ${newPrice.toLocaleString()}원`,
        { component: 'PENDING_MGR' },
      );
    } catch (e) {
      logger.warn(`📋 재배치 실패: ${pending.stockCode} ${(e as Error).message}`, { component: 'PENDING_MGR' });
    }
  } else {
    // Paper: 현재가 ≤ 새 지지선 → 체결 처리
    if (currentPrice <= newPrice) {
      await createChainFromFill(pending, pending.quantity, currentPrice);
      _pendingOrders.delete(pending.orderNo);
      await removeState(pending.orderNo);
    } else {
      pending.limitPrice = newPrice;
      pending.createdAt = Date.now();
      pending.repositionCount++;
      await saveState(pending);
    }
  }
}

/**
 * 체결 후 체인 생성 + 워치독 시작
 */
async function createChainFromFill(
  pending: PendingOrder,
  filledQty: number,
  filledPrice: number,
): Promise<void> {
  const dbStrategy = await getActiveStrategy().catch(() => null);
  const dyn = getDynamicDomesticTpSl({
    score: pending.aiScore ?? 70,
    learnedTp: dbStrategy?.take_profit_pct,
    learnedSl: dbStrategy?.stop_loss_pct,
    ...(pending.tpSlHints ?? {}),
  });

  let targetProfitPct = dyn.takeProfitPct;
  let stopLossPct = dyn.stopLossPct;

  // ATR 기반 동적 손절
  try {
    const atr = await calculateATR(pending.stockCode);
    if (atr > 0 && filledPrice > 0) {
      const atrStopPct = -((atr * 2.0) / filledPrice) * 100;
      stopLossPct = Math.max(stopLossPct, Math.min(-2, atrStopPct));
    }
  } catch { /* 기본값 유지 */ }

  // 1:2 손익비 보장
  const minTp = 2 * Math.abs(stopLossPct);
  if (targetProfitPct < minTp) targetProfitPct = minTp;

  try {
    const chainId = await chainManager.openChain({
      stockCode: pending.stockCode,
      mode: pending.mode,
      buyPrice: filledPrice,
      quantity: filledQty,
      targetProfitPct,
      stopLossPct,
      maxAveragingCount: pending.maxAveragingCount ?? 0,
      isPaper: pending.isPaper,
    });

    // 워치독 시작
    await startWatchdog({
      chainId,
      stockCode: pending.stockCode,
      avgBuyPrice: filledPrice,
      quantity: filledQty,
      stopLossPct,
      takeProfitPct: targetProfitPct,
      isPaper: pending.isPaper,
      strategyMode: pending.mode,
    }).catch((e) =>
      logger.warn(`워치독 시작 실패 (예약주문): ${pending.stockCode} ${(e as Error).message}`, {
        component: 'PENDING_MGR',
      }),
    );

    logger.info(
      `📋 예약주문 → 체인 생성: ${pending.stockCode} ${filledQty}주 @${filledPrice.toLocaleString()} TP=${targetProfitPct.toFixed(1)}% SL=${stopLossPct.toFixed(1)}%`,
      { component: 'PENDING_MGR' },
    );
  } catch (e) {
    logger.error(`📋 예약주문 체인 생성 실패: ${pending.stockCode} ${(e as Error).message}`, {
      component: 'PENDING_MGR',
    });
  }
}

async function saveState(pending: PendingOrder): Promise<void> {
  await getPool()
    .query(
      `INSERT INTO system_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`pending_${pending.orderNo}`, JSON.stringify(pending)],
    )
    .catch((e) => logger.debug(`예약주문 상태 저장 실패: ${(e as Error).message}`, { component: 'PENDING_MGR' }));
}

async function removeState(orderNo: string): Promise<void> {
  await getPool()
    .query(`DELETE FROM system_state WHERE key = $1`, [`pending_${orderNo}`])
    .catch(() => {});
}
