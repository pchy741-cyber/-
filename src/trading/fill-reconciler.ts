import { getPendingDomesticOrders, updateOrderByKisOrderNo, logSystem, getOpenChains, getPool } from '../db/client.js';
import { getOrderFills, cancelOrder } from '../kis/order.js';
import { getAccountBalance, type Position as KisPosition } from '../kis/account.js';
import { getCurrentPrice } from '../kis/market.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { KR_FEE } from '../config/constants.js';

const PENDING_TIMEOUT_MS = 10 * 60 * 1000; // 10분 초과 미체결 → 취소
const EXTERNAL_SELL_COOLDOWN_MS = 5 * 60 * 1000; // 체인 오픈 5분 이내는 체크 스킵 (체결 지연 여유)

// ── KIS_SYNC 포지션 스냅샷 (수동매수, DB 체인 없음) ──
// 프로세스 메모리에 유지 — 리콘실러 주기(3분)마다 갱신
interface KisSyncSnap {
  stockCode: string;
  stockName: string;
  avgBuyPrice: number;
  quantity: number;
  seenAt: number;
}
const _kisSyncSnapshot = new Map<string, KisSyncSnap>();

/**
 * 미체결 국내 주문 정리
 * - 체결된 것: FILLED 상태로 업데이트
 * - 10분 초과 미체결 지정가: 취소 후 CANCELLED 로 업데이트
 * Track B 사이클 시작마다 호출
 */
export async function reconcilePendingOrders(): Promise<void> {
  let pendingOrders;
  try {
    // PENDING + PARTIAL 상태 모두 조회하여 부분체결 주문도 재모니터링
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

      // 10분 초과 미체결/부분체결 지정가 → 잔여 수량 취소
      const ageMs = Date.now() - new Date(order.created_at).getTime();
      if (ageMs > PENDING_TIMEOUT_MS && order.order_type !== '01') {
        const filledQty = order.filled_quantity ?? 0;
        const totalQty = order.quantity ?? 0;
        const remainQty = totalQty - filledQty;
        if (remainQty <= 0) {
          // 이미 전량 체결 — 상태만 FILLED로 보정
          await updateOrderByKisOrderNo(kisOrderNo, { status: 'FILLED' });
          continue;
        }
        const cancelResult = await cancelOrder({
          orderNo: kisOrderNo,
          stockCode: order.stock_code,
          quantity: remainQty,
        });
        if (cancelResult.success) {
          // 부분체결 + 취소: filledQty > 0이면 FILLED(부분체결분 기록), 아니면 CANCELLED
          const finalStatus = filledQty > 0 ? 'FILLED' : 'CANCELLED';
          await updateOrderByKisOrderNo(kisOrderNo, { status: finalStatus });
          logger.warn(
            `⏰ 미체결 취소: ${order.stock_code} ${order.side} 잔여${remainQty}주 (체결${filledQty}주, ${Math.round(ageMs / 60000)}분 경과)`,
            { component: 'RECONCILER' },
          );
          await logSystem('WARN', 'RECONCILER', `미체결 취소: ${order.stock_code} ${order.side} 잔여${remainQty}주 (체결${filledQty}주, ${Math.round(ageMs / 60000)}분 경과)`);
        } else {
          logger.warn(`취소 실패: ${order.stock_code} ${kisOrderNo} — ${cancelResult.message}`, { component: 'RECONCILER' });
        }
      }
    } catch (e) {
      logger.warn(`주문 정리 오류 [${order.stock_code} ${kisOrderNo}]: ${e}`, { component: 'RECONCILER' });
    }
  }
}

/**
 * 외부 매도 감지 — KIS 실제 잔고 vs DB 오픈 체인 비교
 *
 * 사용자가 KIS 앱에서 직접 매도하거나 출금하면 DB에 OPEN 체인이 남는다.
 * KIS 잔고에 해당 종목이 없으면 체인을 CLOSED 처리해 유령 포지션을 제거한다.
 *
 * holding-check-job에서 10분마다 호출
 */
export async function reconcileExternalSells(): Promise<void> {
  // Paper 모드: 체인이 KIS에 없는 게 정상 → 외부매도 감지 불필요
  // getCtxIsPaper(): AsyncLocalStorage 컨텍스트 기반 (runWithMode 호환)
  const { getCtxIsPaper } = await import('../config/context.js');
  if (getCtxIsPaper()) return;

  try {
    const chains = await getOpenChains();

    // KIS 잔고 조회 (실패 시 유령 체인 오닫기 방지 — 스킵)
    // live 컨텍스트에서만 실행됨 (line 96에서 paper 리턴). forceLive=true로 캐시 우회.
    let balance: Awaited<ReturnType<typeof getAccountBalance>>;
    let kisPositions: Map<string, number>;
    try {
      balance = await getAccountBalance(true);
      kisPositions = new Map(balance.positions.map(p => [p.stockCode, p.quantity]));
    } catch (e) {
      logger.warn(`외부 매도 감지: KIS 잔고 조회 실패 — 스킵 (${e})`, { component: 'RECONCILER' });
      return;
    }

    // ── KIS_SYNC 외부매도 감지 (수동매수 포지션, DB 체인 없음) ──
    await _reconcileKisSyncExternalSells(balance.positions, kisPositions, chains);

    if (chains.length === 0) return;

    const now = Date.now();
    const ghostChains = chains.filter(chain => {
      // 오픈 직후는 체결 지연 여유 제공
      const ageMs = now - new Date(chain.opened_at).getTime();
      if (ageMs < EXTERNAL_SELL_COOLDOWN_MS) return false;
      // KIS에 해당 종목이 없으면 외부 매도로 판단 (total_quantity=0 유령체인도 포함)
      const kisQty = kisPositions.get(chain.stock_code) ?? 0;
      return kisQty === 0; // getOpenChains() 결과는 이미 status='OPEN' 보장
    });

    if (ghostChains.length === 0) return;

    logger.warn(`🔍 외부 매도 감지: ${ghostChains.length}건 유령 체인 발견`, { component: 'RECONCILER' });

    for (const chain of ghostChains) {
      try {
        let fillPrice = 0;
        try {
          const px = await getCurrentPrice(chain.stock_code);
          fillPrice = px.currentPrice;
        } catch { /* 시세 실패 시 평균매수가로 폴백 */ }

        const avgBuy = Number(chain.avg_buy_price ?? 0);
        // 가격 조회 실패 시 평균매수가로 폴백 (fillPrice=0 → P&L 오염 방지)
        if (fillPrice <= 0 && avgBuy > 0) fillPrice = avgBuy;
        const pnlPct = avgBuy > 0 && fillPrice > 0
          ? (((fillPrice - avgBuy) / avgBuy) * 100).toFixed(2)
          : '?';

        const ghostOrderNo = `EXT_${Date.now().toString(36)}`;
        await getPool().query(
          `UPDATE transaction_chains SET status = 'CLOSED', closed_at = NOW(), close_reason = $2,
            realized_pnl = CASE WHEN $3 > 0 THEN ($3 * (1 - ${KR_FEE.SELL_FEE_PCT}) - avg_buy_price) * total_quantity ELSE realized_pnl END
           WHERE id = $1`,
          [chain.id, '외부매도 (KIS 앱 직접 매도)', fillPrice],
        );
        // 체인의 is_paper에서 trading_mode 결정 (config.tradingMode은 글로벌 값이라 불일치 위험)
        const chainMode = chain.is_paper ? 'paper' : 'live';
        await getPool().query(
          `INSERT INTO orders (chain_id, stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning)
           VALUES ($1, $2, 'SELL', 'MARKET', $3, $4, $3, $4, $5, 'FILLED', $6, 'EXTERNAL', '외부 매도 감지')`,
          [chain.id, chain.stock_code, chain.total_quantity, fillPrice, ghostOrderNo, chainMode],
        );

        logger.warn(
          `🚪 유령 체인 정리: ${chain.stock_code} ${chain.total_quantity}주 → CLOSED (외부매도, ${pnlPct}%)`,
          { component: 'RECONCILER' },
        );
        await logSystem('WARN', 'RECONCILER', `외부매도 감지: ${chain.stock_code} ${chain.total_quantity}주 체인 #${chain.id} CLOSED`);
        await sendTelegramMessage(`🚪 외부 매도 감지\n종목: ${chain.stock_code}\n수량: ${chain.total_quantity}주\n수익률: ${pnlPct}%\n→ KIS 잔고 없음, DB 체인 정리 완료`);
      } catch (e) {
        logger.error(`외부 매도 처리 오류 [${chain.stock_code} #${chain.id}]: ${e}`, { component: 'RECONCILER' });
      }
    }
  } catch (e) {
    logger.error(`외부 매도 감지 전체 실패: ${e}`, { component: 'RECONCILER' });
  }
}

/**
 * KIS_SYNC 포지션(수동매수, DB 체인 없음) 외부매도 감지
 * - 스냅샷에 있었지만 현재 KIS 잔고에 없는 종목 → 외부매도
 * - transaction_chain + order INSERT → journal에 자동 반영
 */
async function _reconcileKisSyncExternalSells(
  currentPositions: KisPosition[],
  kisQtyMap: Map<string, number>,
  dbChains: Array<{ stock_code: string }>,
): Promise<void> {
  const dbChainCodes = new Set(dbChains.map(c => c.stock_code));
  const now = Date.now();

  // 현재 KIS 잔고로 스냅샷 갱신 (DB 체인 없는 수동매수만)
  for (const pos of currentPositions) {
    if (pos.quantity > 0 && !dbChainCodes.has(pos.stockCode)) {
      _kisSyncSnapshot.set(pos.stockCode, {
        stockCode: pos.stockCode,
        stockName: pos.stockName || pos.stockCode,
        avgBuyPrice: pos.avgBuyPrice,
        quantity: pos.quantity,
        seenAt: now,
      });
    }
  }

  // 스냅샷에 있었지만 현재 KIS 잔고에서 사라진 종목 탐지
  for (const [stockCode, snap] of _kisSyncSnapshot) {
    const kisQty = kisQtyMap.get(stockCode) ?? 0;
    if (kisQty > 0) continue; // 아직 보유 중
    if (dbChainCodes.has(stockCode)) continue; // DB 체인 존재 → 기존 reconciler가 처리

    // 24시간 이상 지난 스냅샷은 만료
    if (now - snap.seenAt > 24 * 60 * 60 * 1000) {
      _kisSyncSnapshot.delete(stockCode);
      continue;
    }

    // watchlist 존재 여부 확인 (transaction_chains.stock_code FK 제약)
    const { rows: wl } = await getPool().query(
      `SELECT stock_code, stock_name FROM watchlist WHERE stock_code = $1`,
      [stockCode],
    );
    const wlName: string = wl[0]?.stock_name || snap.stockName;

    // watchlist에 없으면 INSERT 후 진행
    if (wl.length === 0) {
      try {
        await getPool().query(
          `INSERT INTO watchlist (stock_code, stock_name, market, is_active) VALUES ($1, $2, 'KOSPI', false) ON CONFLICT (stock_code) DO NOTHING`,
          [stockCode, snap.stockName || stockCode],
        );
      } catch (e) {
        logger.warn(`KIS_SYNC 외부매도: watchlist INSERT 실패 [${stockCode}]: ${e}`, { component: 'RECONCILER' });
        continue;
      }
    }

    // 매도 체결가 추정 (현재 시세 → 폴백 평단)
    let sellPrice = 0;
    try { sellPrice = (await getCurrentPrice(stockCode)).currentPrice; } catch { /* ignore */ }
    if (sellPrice <= 0) sellPrice = snap.avgBuyPrice;

    const pnl = (sellPrice - snap.avgBuyPrice) * snap.quantity;
    const pnlPct = snap.avgBuyPrice > 0
      ? (((sellPrice - snap.avgBuyPrice) / snap.avgBuyPrice) * 100).toFixed(2)
      : '?';
    const invested = snap.avgBuyPrice * snap.quantity;

    try {
      // transaction_chain 생성 (CLOSED, realized_pnl 포함)
      const { rows: [chain] } = await getPool().query(
        `INSERT INTO transaction_chains
           (stock_code, status, strategy_mode, avg_buy_price, total_quantity, total_invested,
            realized_pnl, is_paper, opened_at, closed_at, close_reason)
         VALUES ($1, 'CLOSED', 'SWING', $2, $3, $4, $5, false, NOW() - INTERVAL '1 day', NOW(),
                 '외부매도 (KIS 직접 매도/예약매도)')
         RETURNING id`,
        [stockCode, snap.avgBuyPrice, snap.quantity, invested, pnl],
      );

      const ghostOrderNo = `EXT_KS_${Date.now().toString(36)}`;
      await getPool().query(
        `INSERT INTO orders
           (chain_id, stock_code, side, order_type, quantity, price,
            filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning)
         VALUES ($1, $2, 'SELL', 'MARKET', $3, $4, $3, $4, $5, 'FILLED', 'live', 'EXTERNAL',
                 'KIS 외부 매도 자동 기록 (직접 매도/예약매도 체결)')`,
        [chain.id, stockCode, snap.quantity, sellPrice, ghostOrderNo],
      );

      logger.info(
        `✅ KIS_SYNC 외부매도 기록: ${wlName}(${stockCode}) ${snap.quantity}주 @${sellPrice}원 수익률 ${pnlPct}%`,
        { component: 'RECONCILER' },
      );
      await logSystem('INFO', 'RECONCILER', `KIS_SYNC 외부매도 자동 기록: ${stockCode} ${snap.quantity}주 수익률 ${pnlPct}%`);
      await sendTelegramMessage(
        `📋 KIS 외부매도 자동 기록\n종목: ${wlName}(${stockCode})\n수량: ${snap.quantity}주\n평단: ${snap.avgBuyPrice.toLocaleString()}원\n매도가: ${sellPrice.toLocaleString()}원\n수익률: ${pnlPct}%\n손익: ${Math.round(pnl).toLocaleString()}원`,
      );

      _kisSyncSnapshot.delete(stockCode);
    } catch (e) {
      logger.error(`KIS_SYNC 외부매도 기록 실패 [${stockCode}]: ${e}`, { component: 'RECONCILER' });
    }
  }
}
