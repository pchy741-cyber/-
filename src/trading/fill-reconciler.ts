import { KR_FEE } from '../config/constants.js';
import { getCtxIsPaper } from '../config/context.js';
import { getOpenChains, getPendingDomesticOrders, getPool, logSystem, updateOrderByKisOrderNo } from '../db/client.js';
import { hardInvalidateDashboardCache } from '../cache/dashboard-cache.js';
import { getAccountBalance, type Position as KisPosition } from '../kis/account.js';
import { getCurrentPrice } from '../kis/market.js';
import { cancelOrder, getOrderFills } from '../kis/order.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

const PENDING_TIMEOUT_MS = 10 * 60 * 1000; // 10분 초과 미체결 → 취소
const EXTERNAL_SELL_COOLDOWN_MS = 5 * 60 * 1000; // 체인 오픈 5분 이내는 체크 스킵 (체결 지연 여유)

// ── KIS_SYNC 포지션 스냅샷 (수동매수, DB 체인 없음) ──
// v10.5: paper/live 모드별 분리 (크로스오염 방지)
interface KisSyncSnap {
  stockCode: string;
  stockName: string;
  avgBuyPrice: number;
  quantity: number;
  seenAt: number;
}
const _kisSyncSnapshots = new Map<string, Map<string, KisSyncSnap>>(); // mode → (stock_code → snap)

function _getKisSyncSnapshot(): Map<string, KisSyncSnap> {
  const mode = getCtxIsPaper() ? 'paper' : 'live';
  if (!_kisSyncSnapshots.has(mode)) _kisSyncSnapshots.set(mode, new Map());
  return _kisSyncSnapshots.get(mode)!;
}

/**
 * 미체결 국내 주문 정리
 * - 체결된 것: FILLED 상태로 업데이트
 * - 10분 초과 미체결 지정가: 취소 후 CANCELLED 로 업데이트
 * Track B 사이클 시작마다 호출
 */
export async function reconcilePendingOrders(): Promise<void> {
  let pendingOrders: Awaited<ReturnType<typeof getPendingDomesticOrders>>;
  try {
    // PENDING + PARTIAL 상태 모두 조회하여 부분체결 주문도 재모니터링
    pendingOrders = await getPendingDomesticOrders();
  } catch (e) {
    logger.warn(`미체결 조회 실패: ${e}`, { component: 'RECONCILER' });
    return;
  }

  if (pendingOrders.length === 0) return;

  logger.info(`🔍 미체결 주문 ${pendingOrders.length}건 조회`, { component: 'RECONCILER' });

  // 1단계: 체결 상태 병렬 조회 (N+1 → 배치)
  const BATCH = 5;
  for (let i = 0; i < pendingOrders.length; i += BATCH) {
    const batch = pendingOrders.slice(i, i + BATCH);
    const fills = await Promise.allSettled(
      batch.map((order) => getOrderFills(order.kis_order_no!)),
    );

    // 2단계: 결과 처리
    for (let j = 0; j < batch.length; j++) {
      const order = batch[j];
      const kisOrderNo = order.kis_order_no!;
      const fillResult = fills[j];

      try {
        const fill = fillResult.status === 'fulfilled' ? fillResult.value : null;

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

          // BUY 전량 체결 + chain_id 없음 → 체인 신규 생성 (지정가 지연 체결 복구, audit P1)
          if (order.side === 'BUY' && isFullFill && !order.chain_id) {
            try {
              const totalInvested = fill.filledPrice * fill.filledQty;
              const {
                rows: [newChain],
              } = await getPool().query<{ id: string }>(
                `INSERT INTO transaction_chains
                   (stock_code, status, strategy_mode, avg_buy_price, total_quantity, total_invested, is_paper, opened_at)
                 VALUES ($1, 'OPEN', 'SWING', $2, $3, $4, $5, NOW())
                 RETURNING id`,
                [order.stock_code, fill.filledPrice, fill.filledQty, totalInvested, getCtxIsPaper()],
              );
              await updateOrderByKisOrderNo(kisOrderNo, { chain_id: newChain.id });
              logger.info(
                `🔗 BUY 체결 지연 복구: ${order.stock_code} ${fill.filledQty}주 @${fill.filledPrice}원 → 체인 #${newChain.id.slice(0, 8)} OPEN`,
                { component: 'RECONCILER' },
              );
            } catch (chainErr) {
              logger.warn(`BUY 체인 자동 생성 실패 [${order.stock_code}]: ${chainErr}`, { component: 'RECONCILER' });
            }
          }

          // SELL 전량 체결 시 chain 정산 — sell-routes.ts에서 fillConfirmed=false로 OPEN 방치된 케이스 복구
          if (order.side === 'SELL' && isFullFill && order.chain_id) {
            try {
              const { rows: chainRows } = await getPool().query(
                `SELECT * FROM transaction_chains WHERE id = $1 AND status != 'CLOSED'`,
                [order.chain_id],
              );
              const ch = chainRows[0];
              if (ch) {
                const fp = fill.filledPrice;
                const avgBuy = Number(ch.avg_buy_price ?? 0);
                const pnlPctNum = avgBuy > 0 && fp > 0 ? ((fp - avgBuy) / avgBuy) * 100 : null;
                await getPool().query(
                  `UPDATE transaction_chains SET status = 'CLOSED', closed_at = NOW(), close_reason = $2, total_quantity = 0,
                    realized_pnl = realized_pnl + CASE WHEN $3 > 0 THEN $3 * (1 - ${KR_FEE.SELL_FEE_PCT}) * total_quantity - avg_buy_price * total_quantity ELSE 0 END,
                    pnl_pct = CASE WHEN $4 IS NOT NULL THEN ROUND($4::numeric, 2) ELSE pnl_pct END
                   WHERE id = $1`,
                  [ch.id, `체결 확인 자동 정산 (KIS주문: ${kisOrderNo})`, fp, pnlPctNum],
                );
                logger.info(
                  `💰 SELL 체결 → 체인 정산: ${order.stock_code} #${ch.id.slice(0, 8)} @${fp}원 (${pnlPctNum?.toFixed(2) ?? '?'}%)`,
                  { component: 'RECONCILER' },
                );
              }
            } catch (chainErr) {
              logger.warn(`체인 정산 실패 [${order.stock_code} #${order.chain_id}]: ${chainErr}`, { component: 'RECONCILER' });
            }
          }
          continue;
        }

        // 10분 초과 미체결/부분체결 지정가 → 잔여 수량 취소
        const ageMs = Date.now() - new Date(order.created_at).getTime();
        if (ageMs > PENDING_TIMEOUT_MS && order.order_type !== '01') {
          const filledQty = order.filled_quantity ?? 0;
          const totalQty = order.quantity ?? 0;
          const remainQty = totalQty - filledQty;
          if (remainQty <= 0) {
            await updateOrderByKisOrderNo(kisOrderNo, { status: 'FILLED' });
            continue;
          }
          const cancelResult = await cancelOrder({
            orderNo: kisOrderNo,
            stockCode: order.stock_code,
            quantity: remainQty,
          });
          if (cancelResult.success) {
            const finalStatus = filledQty > 0 ? 'FILLED' : 'CANCELLED';
            await updateOrderByKisOrderNo(kisOrderNo, { status: finalStatus });
            logger.warn(
              `⏰ 미체결 취소: ${order.stock_code} ${order.side} 잔여${remainQty}주 (체결${filledQty}주, ${Math.round(ageMs / 60000)}분 경과)`,
              { component: 'RECONCILER' },
            );
            await logSystem(
              'WARN',
              'RECONCILER',
              `미체결 취소: ${order.stock_code} ${order.side} 잔여${remainQty}주 (체결${filledQty}주, ${Math.round(ageMs / 60000)}분 경과)`,
            );
          } else {
            logger.warn(`취소 실패: ${order.stock_code} ${kisOrderNo} — ${cancelResult.message}`, {
              component: 'RECONCILER',
            });
          }
        }
      } catch (e) {
        const eMsg = String(e);
        // cancelOrder throws APBK0344 (원주문 없음) — BUY면 체결 여부 재확인 후 체인 복구
        if (order.side === 'BUY' && (eMsg.includes('APBK0344') || eMsg.includes('원주문정보'))) {
          try {
            const latestFill = await getOrderFills(kisOrderNo);
            if (latestFill && latestFill.filledQty > 0) {
              const totalInvested = latestFill.filledPrice * latestFill.filledQty;
              const {
                rows: [chain],
              } = await getPool().query<{ id: string }>(
                `INSERT INTO transaction_chains
                   (stock_code, status, strategy_mode, avg_buy_price, total_quantity, total_invested, is_paper, opened_at)
                 VALUES ($1, 'OPEN', 'SWING', $2, $3, $4, false, NOW())
                 RETURNING id`,
                [order.stock_code, latestFill.filledPrice, latestFill.filledQty, totalInvested],
              );
              await getPool().query(
                `UPDATE orders SET status = 'FILLED', filled_quantity = $2, filled_price = $3, chain_id = $4, kis_status = 'FILLED_RECOVERED'
                 WHERE kis_order_no = $1`,
                [kisOrderNo, latestFill.filledQty, latestFill.filledPrice, chain.id],
              );
              logger.warn(
                `🔧 10분 취소 중 BUY 체결 복구: ${order.stock_code} ${latestFill.filledQty}주 @${latestFill.filledPrice}원 → 체인 OPEN`,
                { component: 'RECONCILER' },
              );
            } else {
              await updateOrderByKisOrderNo(kisOrderNo, { status: 'CANCELLED', kis_status: 'GHOST_CLEANED' });
              logger.warn(`🧹 10분 미체결 유령: ${kisOrderNo} → CANCELLED`, { component: 'RECONCILER' });
            }
          } catch {
            await updateOrderByKisOrderNo(kisOrderNo, { status: 'CANCELLED', kis_status: 'GHOST_CLEANED' });
          }
        } else {
          logger.warn(`주문 정리 오류 [${order.stock_code} ${kisOrderNo}]: ${e}`, { component: 'RECONCILER' });
        }
      }
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
    const chains = await getOpenChains(getCtxIsPaper());

    // KIS 잔고 조회 (실패 시 유령 체인 오닫기 방지 — 스킵)
    // live 컨텍스트에서만 실행됨 (line 96에서 paper 리턴). forceLive=true로 캐시 우회.
    let balance: Awaited<ReturnType<typeof getAccountBalance>>;
    let kisPositions: Map<string, number>;
    try {
      balance = await getAccountBalance(true);
      kisPositions = new Map(balance.positions.map((p) => [p.stockCode, p.quantity]));
    } catch (e) {
      logger.warn(`외부 매도 감지: KIS 잔고 조회 실패 — 스킵 (${e})`, { component: 'RECONCILER' });
      return;
    }

    // ── KIS_SYNC 외부매도 감지 (수동매수 포지션, DB 체인 없음) ──
    await _reconcileKisSyncExternalSells(balance.positions, kisPositions, chains);

    if (chains.length === 0) return;

    const now = Date.now();
    const ghostChains = chains.filter((chain) => {
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
        } catch {
          /* 시세 실패 시 평균매수가로 폴백 */
        }

        const avgBuy = Number(chain.avg_buy_price ?? 0);
        // 가격 조회 실패 시 평균매수가로 폴백 (fillPrice=0 → P&L 오염 방지)
        if (fillPrice <= 0 && avgBuy > 0) fillPrice = avgBuy;
        const pnlPct = avgBuy > 0 && fillPrice > 0 ? (((fillPrice - avgBuy) / avgBuy) * 100).toFixed(2) : '?';
        const pnlPctNum = avgBuy > 0 && fillPrice > 0 ? ((fillPrice - avgBuy) / avgBuy) * 100 : null;

        const ghostOrderNo = `EXT_${Date.now().toString(36)}`;
        await getPool().query(
          `UPDATE transaction_chains SET status = 'CLOSED', closed_at = NOW(), close_reason = $2,
            realized_pnl = CASE WHEN $3 > 0 THEN realized_pnl + $3 * (1 - ${KR_FEE.SELL_FEE_PCT}) * total_quantity - avg_buy_price * total_quantity ELSE realized_pnl END,
            pnl_pct = CASE WHEN $4 IS NOT NULL THEN ROUND($4::numeric, 2) ELSE pnl_pct END
           WHERE id = $1`,
          [chain.id, '외부매도 (KIS 앱 직접 매도)', fillPrice, pnlPctNum],
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
        await logSystem(
          'WARN',
          'RECONCILER',
          `외부매도 감지: ${chain.stock_code} ${chain.total_quantity}주 체인 #${chain.id} CLOSED`,
        );
        hardInvalidateDashboardCache(); // ghost 체인 정리 후 대시보드 즉시 캐시 무효화
        await sendTelegramMessage(
          `🚪 외부 매도 감지\n종목: ${chain.stock_code}\n수량: ${chain.total_quantity}주\n수익률: ${pnlPct}%\n→ KIS 잔고 없음, DB 체인 정리 완료`,
        ).catch(() => {});
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
  const dbChainCodes = new Set(dbChains.map((c) => c.stock_code));
  const now = Date.now();

  // 현재 KIS 잔고로 스냅샷 갱신 (DB 체인 없는 수동매수만)
  for (const pos of currentPositions) {
    if (pos.quantity > 0 && !dbChainCodes.has(pos.stockCode)) {
      _getKisSyncSnapshot().set(pos.stockCode, {
        stockCode: pos.stockCode,
        stockName: pos.stockName || pos.stockCode,
        avgBuyPrice: pos.avgBuyPrice,
        quantity: pos.quantity,
        seenAt: now,
      });
    }
  }

  // 스냅샷에 있었지만 현재 KIS 잔고에서 사라진 종목 탐지
  for (const [stockCode, snap] of _getKisSyncSnapshot()) {
    const kisQty = kisQtyMap.get(stockCode) ?? 0;
    if (kisQty > 0) continue; // 아직 보유 중
    if (dbChainCodes.has(stockCode)) continue; // DB 체인 존재 → 기존 reconciler가 처리

    // 24시간 이상 지난 스냅샷은 만료
    if (now - snap.seenAt > 24 * 60 * 60 * 1000) {
      _getKisSyncSnapshot().delete(stockCode);
      continue;
    }

    // watchlist 존재 여부 확인 (transaction_chains.stock_code FK 제약)
    const { rows: wl } = await getPool().query(`SELECT stock_code, stock_name FROM watchlist WHERE stock_code = $1`, [
      stockCode,
    ]);
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
    try {
      sellPrice = (await getCurrentPrice(stockCode)).currentPrice;
    } catch {
      /* ignore */
    }
    if (sellPrice <= 0) sellPrice = snap.avgBuyPrice;

    const pnl = sellPrice * (1 - KR_FEE.SELL_FEE_PCT) * snap.quantity - snap.avgBuyPrice * snap.quantity;
    const pnlPct = snap.avgBuyPrice > 0 ? (((sellPrice - snap.avgBuyPrice) / snap.avgBuyPrice) * 100).toFixed(2) : '?';
    const pnlPctNum = snap.avgBuyPrice > 0 && sellPrice > 0 ? ((sellPrice - snap.avgBuyPrice) / snap.avgBuyPrice) * 100 : null;
    const invested = snap.avgBuyPrice * snap.quantity;

    try {
      // transaction_chain 생성 (CLOSED, realized_pnl 포함)
      const {
        rows: [chain],
      } = await getPool().query(
        `INSERT INTO transaction_chains
           (stock_code, status, strategy_mode, avg_buy_price, total_quantity, total_invested,
            realized_pnl, pnl_pct, is_paper, opened_at, closed_at, close_reason)
         VALUES ($1, 'CLOSED', 'SWING', $2, $3, $4, $5, $6, false, NOW() - INTERVAL '1 day', NOW(),
                 '외부매도 (KIS 직접 매도/예약매도)')
         RETURNING id`,
        [stockCode, snap.avgBuyPrice, snap.quantity, invested, pnl, pnlPctNum],
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
      await logSystem(
        'INFO',
        'RECONCILER',
        `KIS_SYNC 외부매도 자동 기록: ${stockCode} ${snap.quantity}주 수익률 ${pnlPct}%`,
      );
      await sendTelegramMessage(
        `📋 KIS 외부매도 자동 기록\n종목: ${wlName}(${stockCode})\n수량: ${snap.quantity}주\n평단: ${snap.avgBuyPrice.toLocaleString()}원\n매도가: ${sellPrice.toLocaleString()}원\n수익률: ${pnlPct}%\n손익: ${Math.round(pnl).toLocaleString()}원`,
      ).catch(() => {});

      _getKisSyncSnapshot().delete(stockCode);
    } catch (e) {
      logger.error(`KIS_SYNC 외부매도 기록 실패 [${stockCode}]: ${e}`, { component: 'RECONCILER' });
    }
  }
}
