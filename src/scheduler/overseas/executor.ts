/**
 * 주문 실행 (Paper/Live) & 승자 집중 전략
 */

import { hardInvalidateDashboardCache } from '../../cache/dashboard-cache.js';
import { invalidateBalanceCache } from '../../kis/account.js';
import { OVERSEAS, OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { getCtxIsPaper } from '../../config/context.js';
import { getAllocRisk } from '../../db/alloc-risk-cache.js';
import { getPool, insertOrder, updateOrder } from '../../db/client.js';
import { placeOverseasDaytimeOrder, placeOverseasOrder } from '../../kis/overseas.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import type { OverseasExecutionResult } from './analytics.js';
import { confirmOverseasFillFromBalance } from './order-sync.js';
import { updateTradeState } from './state.js';
import { resolveOverseasStockName } from './watchlist.js';

// ── Named constants (magic number extraction) ──
/** Paper order slippage simulation
 * v16.2.1: 0.1%→0.35% (실제 체결 슬리피지에 근접, 연습모드 과대수익 방지)
 * v26: 0.35%→0.15% (sell-logic에서 roundTripFee 0.7% 별도 가산 → 이중차감으로 15연패 원인) */
const PAPER_SLIPPAGE_PCT = 0.0015;
/** Milliseconds per day — used for holding day calculation */
const MS_PER_DAY = 86_400_000;
/** PnL threshold for WIN/LOSS/BREAK_EVEN classification
 * v10.11.3: 0.1% → 0.4%
 * v22-audit: 0.4% → 0.75% (편도 0.35%×2 = 왕복 0.70%, +0.05% 마진)
 * 기존 0.4%: gross 0.4~0.7% 거래가 WIN 분류되지만 실제 net 음수 → 학습 오염
 */
const PNL_BREAKEVEN_THRESHOLD = 0.75;

/** 해외 SELL 체결 후 score_accuracy 기록 */
async function recordOverseasScoreAccuracy(params: {
  stockCode: string;
  orderId: string;
  avgBuyPrice: number;
  fillPrice: number;
  isPaper: boolean;
  reasoning: string;
}): Promise<void> {
  try {
    const { stockCode, orderId, avgBuyPrice, fillPrice, isPaper } = params;
    if (avgBuyPrice <= 0 || fillPrice <= 0) return;
    const pnlPct = ((fillPrice - avgBuyPrice) / avgBuyPrice) * 100;
    const outcome = pnlPct > PNL_BREAKEVEN_THRESHOLD ? 'WIN' : pnlPct < -PNL_BREAKEVEN_THRESHOLD ? 'LOSS' : 'BREAK_EVEN';

    // 보유일수 추정: 가장 최근 BUY 주문 시점 기준
    const pool = getPool();
    const { rows: buyRows } = await pool.query(
      `SELECT created_at FROM orders
       WHERE stock_code = $1 AND side = 'BUY' AND status = 'FILLED'
         AND trigger_source = 'OVERSEAS' AND (trading_mode = $2 OR ($2 = 'paper' AND trading_mode = 'p_arch'))
       ORDER BY created_at DESC LIMIT 1`,
      [stockCode, isPaper ? 'paper' : 'live'],
    );
    const holdingDays = buyRows[0]?.created_at
      ? Math.round((Date.now() - new Date(buyRows[0].created_at).getTime()) / MS_PER_DAY)
      : null;

    // v23-audit: Paper 모드 데이터는 EXPLORE 태깅
    const tradingProfile = isPaper ? 'EXPLORE' : 'LIVE';
    // v29 클린 스플릿: 해외 전략축 = 실제 버킷(overseas_holdings.strategy_bucket: SWING/CORE/TACTICAL/SNIPER).
    //   보유행에서 실제 버킷 조회(추측 아님). 이미 삭제됐으면 청산사유로 폴백(DIP/SCALP→TACTICAL, else SWING).
    let strategyMode = 'SWING';
    try {
      const { rows: bkRows } = await pool.query(
        `SELECT strategy_bucket FROM overseas_holdings WHERE stock_code = $1 AND is_paper = $2 LIMIT 1`,
        [stockCode, isPaper],
      );
      const bk = bkRows[0]?.strategy_bucket;
      if (bk) strategyMode = String(bk);
      else if (/딥바이|dip|스캘핑|scalp|프리마켓|premarket|마감 강제청산|TACTICAL/i.test(params.reasoning ?? ''))
        strategyMode = 'TACTICAL';
    } catch {
      /* 폴백 SWING */
    }
    await pool.query(
      `INSERT INTO score_accuracy
         (stock_code, order_id, market, realized_pnl_pct, outcome, holding_days,
          close_reason, is_paper, trading_profile, strategy_mode)
       VALUES ($1, $2, 'US', $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING`,
      [stockCode, orderId, pnlPct, outcome, holdingDays, params.reasoning, isPaper, tradingProfile, strategyMode],
    );
    logger.info(`📝 해외 스코어 기록: ${stockCode} ${outcome} (${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`, {
      component: 'OVERSEAS',
    });

    // 마이크로 피드백: 최근 6시간 내 5건 중 80%+ 손실 → minBuyScore 임시 상향
    try {
      const { rows: recentRows } = await pool.query(
        `SELECT outcome FROM score_accuracy
         WHERE market = 'US' AND is_paper = $1 AND recorded_at > NOW() - INTERVAL '6 hours'
         ORDER BY recorded_at DESC LIMIT 5`,
        [isPaper],
      );
      if (recentRows.length >= 5) {
        const lossCount = recentRows.filter((r: { outcome: string }) => r.outcome === 'LOSS').length;
        if (lossCount >= 4) {
          const { setOverride } = await import('../../ai/ai-overrides.js');
          await setOverride('threshold', 'minBuyScore', 85, `micro_feedback: ${lossCount}/${recentRows.length} losses in 6h`, 120, isPaper);
          logger.warn(`🛡️ 마이크로 피드백: 최근 ${lossCount}/${recentRows.length} 손실 → minBuyScore=85 (2h TTL)`, { component: 'OVERSEAS' });
        }
      }
    } catch (fbErr) {
      logger.warn(`마이크로 피드백 처리 실패: ${fbErr}`, { component: 'OVERSEAS' });
    }
  } catch (err) {
    logger.warn(`해외 스코어 기록 실패: ${err}`, { component: 'OVERSEAS' });
  }
}

import { getOverseasDynamic } from '../../config/constants.js';

/**
 * 미국주식 주문 실행 (Paper / Live)
 */
export async function executeOverseasOrder(
  code: string,
  side: 'BUY' | 'SELL',
  qty: number,
  price: number,
  exchange: string,
  reasoning: string,
  previousQty: number,
  previousAvgPrice: number,
  opts?: { isPaper?: boolean },
): Promise<OverseasExecutionResult> {
  const paperMode = opts?.isPaper ?? getCtxIsPaper();
  const stockName = resolveOverseasStockName(code, exchange);

  // Zero price 방어 — 잘못된 가격으로 주문 시 avg_price 오염 방지
  if (!price || price <= 0 || !Number.isFinite(price)) {
    logger.error(`🚫 Zero/Invalid price 차단: ${side} ${code} @$${price} — 주문 거부`, { component: 'OVERSEAS' });
    return { submitted: false, filledQty: 0, filledPrice: 0, finalQty: previousQty, finalAvgPrice: previousAvgPrice, orderNo: '' };
  }

  if (paperMode) {
    const slippage = side === 'BUY' ? PAPER_SLIPPAGE_PCT : -PAPER_SLIPPAGE_PCT;
    const fillPrice = price * (1 + slippage);
    const fakeOrderNo = `USP${Date.now().toString(36)}`;

    const paperReasoning =
      side === 'SELL' && previousAvgPrice > 0 ? `[avgBuy:${previousAvgPrice.toFixed(4)}] ${reasoning}` : reasoning;
    const paperOrderId = await insertOrder({
      chain_id: null,
      stock_code: code,
      side,
      order_type: '01',
      quantity: qty,
      price: fillPrice,
      kis_order_no: fakeOrderNo,
      kis_status: 'PAPER_FILLED',
      filled_quantity: qty,
      filled_price: fillPrice,
      status: 'FILLED',
      trading_mode: 'paper',
      trigger_source: 'OVERSEAS',
      ai_reasoning: paperReasoning,
      avg_buy_price: side === 'SELL' ? previousAvgPrice : null,
    });

    logger.info(`📝 [US_PAPER] ${side} ${code} x${qty} @$${fillPrice.toFixed(2)} (${fakeOrderNo})`, {
      component: 'OVERSEAS',
    });
    hardInvalidateDashboardCache();
    invalidateBalanceCache();
    // 해외 스코어 캐시 무효화 — 체결된 종목의 중복 매수 신호 방지
    import('../../cache/overseas-scores.js')
      .then((m) => m.invalidateOverseasScoreForStock(code))
      .catch(() => {});

    const { notifyOverseasBuy: nb, notifyOverseasSell: ns } = await import('../../notifications/web-push.js');
    if (side === 'BUY') {
      nb(code, stockName, qty, fillPrice, reasoning).catch(() => {});
    } else {
      const pnlPct = previousAvgPrice > 0 ? ((fillPrice - previousAvgPrice) / previousAvgPrice) * 100 : 0;
      ns(code, stockName, qty, fillPrice, pnlPct, reasoning).catch(() => {});
      // 해외 SELL score_accuracy 기록
      recordOverseasScoreAccuracy({
        stockCode: code,
        orderId: paperOrderId,
        avgBuyPrice: previousAvgPrice,
        fillPrice,
        isPaper: true,
        reasoning,
      }).catch(() => {});
    }
    const finalQty = side === 'BUY' ? previousQty + qty : Math.max(0, previousQty - qty);
    // NaN 방어: previousAvgPrice가 NaN/Infinity이면 fillPrice로 대체
    const safePrevAvg = Number.isFinite(previousAvgPrice) && previousAvgPrice > 0 ? previousAvgPrice : fillPrice;
    const finalAvgPrice =
      side === 'BUY' && finalQty > 0
        ? (safePrevAvg * previousQty + fillPrice * qty) / finalQty
        : finalQty > 0
          ? safePrevAvg
          : 0;
    return {
      submitted: true,
      filledQty: qty,
      filledPrice: fillPrice,
      finalQty,
      finalAvgPrice,
      orderNo: fakeOrderNo,
    };
  } else {
    // SELL 주문 실패 시 재시도 (손절/익절 실패는 위험 → 최대 2회 재시도)
    const MAX_SELL_RETRIES = side === 'SELL' ? 2 : 0;
    const RETRY_DELAYS = [1000, 2000]; // 1초, 2초 백오프

    // v17: 주문 의도 로그 — API 호출 전 기록하여 유실 방지
    logger.info(`🔜 [LIVE] 주문 시도: ${side} ${code} x${qty} @$${price.toFixed(2)}`, { component: 'OVERSEAS' });

    for (let attempt = 0; attempt <= MAX_SELL_RETRIES; attempt++) {
      try {
        // 주간거래 시간(KST 10:00~18:00) 감지 → Blue Ocean ATS API 자동 라우팅
        const isDaytime = (() => {
          const now = new Date();
          const kstH = (now.getUTCHours() + 9) % 24;
          return kstH >= 10 && kstH < 18;
        })();
        const result = isDaytime
          ? await placeOverseasDaytimeOrder({ stockCode: code, exchange, side, quantity: qty, price })
          : await placeOverseasOrder({ stockCode: code, exchange, side, quantity: qty, price });
        const liveReasoning =
          side === 'SELL' && previousAvgPrice > 0 ? `[avgBuy:${previousAvgPrice.toFixed(4)}] ${reasoning}` : reasoning;
        const orderId = await insertOrder({
          chain_id: null,
          stock_code: code,
          side,
          order_type: '01',
          quantity: qty,
          price,
          kis_order_no: result.orderNo,
          kis_status: result.success ? 'SUBMITTED' : 'FAILED',
          filled_quantity: 0,
          filled_price: null,
          status: result.success ? 'PENDING' : 'FAILED',
          trading_mode: paperMode ? 'paper' : 'live',
          trigger_source: 'OVERSEAS',
          ai_reasoning: attempt > 0 ? `[재시도${attempt}] ${liveReasoning}` : liveReasoning,
          avg_buy_price: side === 'SELL' ? previousAvgPrice : null,
        });
        if (result.success) {
          logger.info(`🌍 [LIVE] 주문 접수: ${side} ${code} x${qty} @$${price.toFixed(2)} (${result.orderNo})${attempt > 0 ? ` [재시도${attempt}]` : ''}`, {
            component: 'OVERSEAS',
          });
          const confirmed = await confirmOverseasFillFromBalance({
            code,
            exchange,
            side,
            requestedQty: qty,
            previousQty,
            previousAvgPrice,
            fallbackPrice: price,
          });

          if (confirmed.filledQty > 0) {
            await updateOrder(orderId, {
              filled_quantity: confirmed.filledQty,
              filled_price: confirmed.filledPrice,
              status: confirmed.filledQty >= qty ? 'FILLED' : 'PARTIAL',
              kis_status: confirmed.filledQty >= qty ? 'FILLED' : 'PARTIAL',
            });
            hardInvalidateDashboardCache();
            invalidateBalanceCache();
            // 해외 스코어 캐시 무효화 — 체결된 종목의 중복 매수 신호 방지
            import('../../cache/overseas-scores.js')
              .then((m) => m.invalidateOverseasScoreForStock(code))
              .catch(() => {});
            const { notifyOverseasBuy: nb, notifyOverseasSell: ns } = await import('../../notifications/web-push.js');
            if (side === 'BUY') {
              nb(code, stockName, confirmed.filledQty, confirmed.filledPrice, reasoning).catch(() => {});
            } else {
              const pnlPct =
                previousAvgPrice > 0 ? ((confirmed.filledPrice - previousAvgPrice) / previousAvgPrice) * 100 : 0;
              ns(code, stockName, confirmed.filledQty, confirmed.filledPrice, pnlPct, reasoning).catch(() => {});
              // 해외 SELL score_accuracy 기록
              recordOverseasScoreAccuracy({
                stockCode: code,
                orderId,
                avgBuyPrice: previousAvgPrice,
                fillPrice: confirmed.filledPrice,
                isPaper: false,
                reasoning,
              }).catch(() => {});
            }
          } else {
            // 체결 미확인: PENDING 유지 + UNCONFIRMED 마킹 → syncPendingOverseasOrders가 15분 후 재조회
            // 기존: FAILED로 전환 → sync가 PENDING만 쿼리하므로 복구 불가 (고아 포지션 발생)
            await updateOrder(orderId, {
              status: 'PENDING',
              kis_status: 'UNCONFIRMED',
            });
            logger.warn(`⏳ 체결 미확인 → PENDING(UNCONFIRMED) 유지: ${code} (${result.orderNo}) — 15분 후 sync 재조회`, { component: 'OVERSEAS' });
          }

          return {
            submitted: true,
            filledQty: confirmed.filledQty,
            filledPrice: confirmed.filledPrice,
            finalQty: confirmed.finalQty,
            finalAvgPrice: confirmed.finalAvgPrice,
            orderNo: result.orderNo,
          };
        } else {
          // SELL 실패 시 재시도 (BUY는 재시도 없음)
          if (attempt < MAX_SELL_RETRIES) {
            logger.warn(`🔄 SELL 재시도 ${attempt + 1}/${MAX_SELL_RETRIES}: ${code} - ${result.message} (${RETRY_DELAYS[attempt]}ms 후)`, { component: 'OVERSEAS' });
            await sleep(RETRY_DELAYS[attempt]);
            continue;
          }
          logger.error(`🌍 주문 실패: ${code} - ${result.message}${attempt > 0 ? ` [${attempt}회 재시도 후]` : ''}`, { component: 'OVERSEAS' });
          return {
            submitted: false,
            filledQty: 0,
            filledPrice: price,
            finalQty: previousQty,
            finalAvgPrice: previousAvgPrice,
            orderNo: result.orderNo,
          };
        }
      } catch (e) {
        // v17: SELL 에러 시 KIS 잔고 확인 후 재시도 (중복 주문 방지)
        // KIS API 성공했지만 네트워크 타임아웃 → exception 발생 가능
        // 이 경우 재시도하면 중복 매도 → 잔고 변동 여부로 판단
        if (side === 'SELL' && attempt < MAX_SELL_RETRIES) {
          try {
            invalidateBalanceCache();
            await sleep(500); // KIS 반영 대기
            const { getOverseasBalance } = await import('../../kis/overseas.js');
            const balItems = await getOverseasBalance(exchange);
            const currentHolding = balItems.find((b: { stockCode: string }) => b.stockCode === code);
            const currentQty = currentHolding ? Number(currentHolding.quantity || 0) : 0;
            if (currentQty < previousQty) {
              // 잔고 이미 줄었음 → 주문이 실제로 체결된 것 → 재시도 금지
              const filledQty = previousQty - currentQty;
              logger.warn(`⚠️ SELL 예외 발생했지만 잔고 감소 확인: ${code} ${previousQty}→${currentQty} (체결${filledQty}주) — 재시도 안함`, { component: 'OVERSEAS' });
              // PENDING으로 기록 → syncPendingOverseasOrders가 후속 정리
              // v23-QA: Date.now() 1회 캡처 (기존: 2회 호출 → DB와 반환값 orderNo 불일치)
              const errTs = Date.now();
              const errorOrderId = await insertOrder({
                chain_id: null, stock_code: code, side, order_type: '01',
                quantity: qty, price, kis_order_no: `ERR_RECOVERED_${errTs}`,
                kis_status: 'UNCONFIRMED', filled_quantity: filledQty,
                filled_price: price, status: 'PENDING',
                trading_mode: 'live', trigger_source: 'OVERSEAS',
                ai_reasoning: `[에러복구] ${reasoning} — ${(e as Error).message}`,
                avg_buy_price: previousAvgPrice,
              });
              logger.info(`🌍 [LIVE] 에러복구 기록: SELL ${code} x${filledQty} @$${price.toFixed(2)} (DB#${errorOrderId})`, { component: 'OVERSEAS' });
              return {
                submitted: true, filledQty, filledPrice: price,
                finalQty: currentQty,
                finalAvgPrice: currentQty > 0 ? previousAvgPrice : 0,
                orderNo: `ERR_RECOVERED_${errTs}`,
              };
            }
            // 잔고 변동 없음 → 진짜 실패 → 재시도 OK
            logger.warn(`🔄 SELL 재시도 ${attempt + 1}/${MAX_SELL_RETRIES}: ${code} - ${(e as Error).message} (잔고 변동 없음, ${RETRY_DELAYS[attempt]}ms 후)`, { component: 'OVERSEAS' });
          } catch (balErr) {
            // 잔고 조회도 실패 → 안전하게 재시도 중단
            logger.error(`🚫 SELL 재시도 중단 (잔고 조회 실패): ${code} - ${(balErr as Error).message}`, { component: 'OVERSEAS' });
            return {
              submitted: false, filledQty: 0, filledPrice: price,
              finalQty: previousQty, finalAvgPrice: previousAvgPrice, orderNo: '',
            };
          }
          await sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        logger.error(`🌍 주문 에러: ${code} - ${(e as Error).message}${attempt > 0 ? ` [${attempt}회 재시도 후]` : ''}`, { component: 'OVERSEAS' });
        return {
          submitted: false,
          filledQty: 0,
          filledPrice: price,
          finalQty: previousQty,
          finalAvgPrice: previousAvgPrice,
          orderNo: '',
        };
      }
    }
    // 도달 불가 (루프 내에서 항상 return)
    return { submitted: false, filledQty: 0, filledPrice: price, finalQty: previousQty, finalAvgPrice: previousAvgPrice, orderNo: '' };
  }
}

/**
 * 유휴현금 → 수익률 1위 보유종목 추가매수 (승자 집중 전략)
 */
export async function deployIdleCash(params: {
  cash: number;
  holdings: Map<string, { qty: number; avgPrice: number; boughtAt: string; exchange: string }>;
  techResults: Array<{ code: string; name: string; exchange: string; price: { currentPrice: number } }>;
  isUSSession: boolean;
  avgScore: number;
  isPaper?: boolean;
}): Promise<{ actions: string[]; cashUsed: number }> {
  const { cash, holdings, techResults, isUSSession, avgScore } = params;
  if (!isUSSession) return { actions: [], cashUsed: 0 };

  // 동적: 포트폴리오 규모 기반 집중전략 파라미터
  // v23-QA: avgPrice→currentPrice (평단가 ≠ 현재가치, 포트규모 과소/과대평가 방지)
  const priceMap = new Map(techResults.map((t) => [t.code, t.price.currentPrice]));
  const holdingValue = Array.from(holdings.entries()).reduce(
    (s, [code, h]) => s + h.qty * (priceMap.get(code) ?? h.avgPrice), 0,
  );
  const isPaperCtx = params.isPaper ?? getCtxIsPaper();
  const allocRisk = await getAllocRisk(isPaperCtx);
  const dynP = getOverseasDynamic(cash + holdingValue, isPaperCtx, allocRisk.positionCapPct / 100);
  const investable = cash - dynP.concentrationCashBuffer;
  if (investable < dynP.concentrationMinInvest) return { actions: [], cashUsed: 0 };

  let bestCode: string | null = null;
  let bestPnlPct: number = OVERSEAS.CONCENTRATION_MIN_PNL_PCT;
  let bestPrice = 0;
  let bestExchange = '';
  let bestHolding: { qty: number; avgPrice: number } | null = null;

  for (const [code, holding] of holdings) {
    const tech = techResults.find((t) => t.code === code);
    if (!tech || tech.price.currentPrice <= 0) continue;
    const pnlPct = ((tech.price.currentPrice - holding.avgPrice) / holding.avgPrice) * 100;
    if (pnlPct > bestPnlPct) {
      bestPnlPct = pnlPct;
      bestCode = code;
      bestPrice = tech.price.currentPrice;
      bestExchange = tech.exchange;
      bestHolding = holding;
    }
  }

  if (bestCode && bestHolding && bestPrice > 0) {
    const concKey = (params.isPaper ?? getCtxIsPaper()) ? 'p_concentration_code' : 'l_concentration_code';
    await getPool()
      .query(
        `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
        [concKey, bestCode],
      )
      .catch(() => {});

    const qty = Math.floor(investable / (bestPrice * (1 + OVERSEAS_FEE_PCT)));
    if (qty >= 1) {
      const exec = await executeOverseasOrder(
        bestCode,
        'BUY',
        qty,
        bestPrice,
        bestExchange,
        `승자집중 +${bestPnlPct.toFixed(1)}% 수익종목 추가매수 (유휴현금 $${investable.toFixed(0)})`,
        bestHolding.qty,
        bestHolding.avgPrice,
        { isPaper: params.isPaper },
      );
      if (exec.submitted && exec.filledQty > 0) {
        const cost = exec.filledQty * exec.filledPrice * (1 + OVERSEAS_FEE_PCT);
        await updateTradeState({
          code: bestCode,
          exchange: bestExchange,
          qty: exec.finalQty,
          avgPrice: exec.finalAvgPrice,
          newCash: cash - cost,
          isPaper: params.isPaper,
        });
        logger.info(
          `🎯 승자집중 완료: ${bestCode} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} +${bestPnlPct.toFixed(1)}% (유휴현금 $${investable.toFixed(0)} 투입)`,
          { component: 'OVERSEAS' },
        );
        return {
          actions: [
            `🎯 승자집중 ${bestCode} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (+${bestPnlPct.toFixed(1)}% 수익종목, $${investable.toFixed(0)} 추가투입)`,
          ],
          cashUsed: cost,
        };
      }
    }
  }

  return { actions: [], cashUsed: 0 };
}
