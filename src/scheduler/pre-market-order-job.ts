/**
 * 동시호가 선제 주문 (08:57 KST 실행)
 *
 * 흐름:
 *   1. AI 점수 DB에서 오늘 고점수(85+) 종목 조회
 *   2. 이미 보유 중인 종목 제외
 *   3. 전일 종가 + 2% 상한 지정가로 동시호가 매수 주문
 *   4. 09:00 시초가 결정 시 체결 (지정가 이하면 체결, 초과면 미체결)
 *   5. 체결 확인은 09:01 Track B의 fill-reconciler가 처리
 *
 * KIS API: 동시호가 주문 = 일반 지정가 주문 (ORD_DVSN='00')을 08:30~09:00에 전송
 */

import { getAllRecentScores } from '../db/repo/ai-scores.js';
import { getCtxIsPaper } from '../config/context.js';
import { getActiveStrategy, getOpenChains, getPool, insertOrder } from '../db/client.js';
import { STRATEGY_PARAMS, OrderType, type StrategyMode } from '../config/constants.js';
import { getAccountBalance, invalidateBalanceCache } from '../kis/account.js';
import { getCurrentPrice } from '../kis/market.js';
import { placeOrder } from '../kis/order.js';
import { getAllocRisk } from '../db/alloc-risk-cache.js';
import { isKillSwitchActive } from '../risk/kill-switch.js';
import { paperTradeOrder } from '../risk/paper.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { adjustToTickSize } from '../utils/money.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';

// ── 설정 ──
const MIN_SCORE = 85; // 동시호가 진입 최소 AI 점수
const MAX_PREMARKET_ORDERS = 2; // 동시호가 최대 주문 종목 수
const PRICE_PREMIUM_PCT = 2.0; // 전일 종가 대비 +2% 상한 지정가 (시초가 > 102%면 미체결 → 안전)
const MIN_ORDER_KRW = 100_000; // 최소 주문금액 (10만원)

/** 동시호가 주문 결과 */
interface PreMarketResult {
  ordered: number;
  skipped: number;
  details: string[];
}

/** 동시호가 선제 주문 실행 — 08:57 KST cron에서 호출 */
export async function runPreMarketOrders(): Promise<PreMarketResult> {
  const isPaper = getCtxIsPaper();
  const modeLabel = isPaper ? 'PAPER' : 'LIVE';
  const result: PreMarketResult = { ordered: 0, skipped: 0, details: [] };

  // Kill Switch 활성 시 매수 차단
  if (isKillSwitchActive('KR')) {
    logger.info(`🛑 [동시호가][${modeLabel}] Kill Switch 활성 → 스킵`, { component: 'PRE_MARKET_ORDER' });
    result.details.push('Kill Switch 활성 → 스킵');
    return result;
  }

  // 1. 오늘 AI 점수 조회 → 고점수 필터
  const allScores = await getAllRecentScores();
  const highScores = allScores
    .filter((s) => (s.composite_score ?? 0) >= MIN_SCORE && s.signal !== 'SELL')
    .sort((a, b) => (b.composite_score ?? 0) - (a.composite_score ?? 0));

  if (highScores.length === 0) {
    logger.info(`[동시호가][${modeLabel}] 고점수(${MIN_SCORE}+) 종목 없음 → 스킵`, { component: 'PRE_MARKET_ORDER' });
    result.details.push(`${MIN_SCORE}점+ 종목 없음`);
    return result;
  }

  // 2. 이미 보유 종목 제외
  const openChains = await getOpenChains(isPaper);
  const heldCodes = new Set(openChains.filter((c) => c.total_quantity > 0).map((c) => c.stock_code));
  const candidates = highScores.filter((s) => !heldCodes.has(s.stock_code));

  if (candidates.length === 0) {
    logger.info(`[동시호가][${modeLabel}] 고점수 종목 전부 이미 보유 → 스킵`, { component: 'PRE_MARKET_ORDER' });
    result.details.push('고점수 종목 전부 이미 보유');
    return result;
  }

  // 3. 포지션 한도 확인
  const allocRisk = await getAllocRisk(isPaper);
  const availableSlots = allocRisk.maxPositions - openChains.filter((c) => c.total_quantity > 0).length;
  if (availableSlots <= 0) {
    logger.info(`[동시호가][${modeLabel}] 포지션 한도 도달 → 스킵`, { component: 'PRE_MARKET_ORDER' });
    result.details.push('포지션 한도 도달');
    return result;
  }

  // 4. 잔고 확인
  const balance = await getAccountBalance();
  const orderableCash = balance.orderableCash;
  if (orderableCash < MIN_ORDER_KRW) {
    logger.info(`[동시호가][${modeLabel}] 주문가능금액 부족 (${orderableCash.toLocaleString()}) → 스킵`, {
      component: 'PRE_MARKET_ORDER',
    });
    result.details.push(`주문가능금액 부족: ${orderableCash.toLocaleString()}원`);
    return result;
  }

  // 5. 전략 파라미터
  const strategy = await getActiveStrategy();
  const mode = (strategy?.mode ?? 'SWING') as StrategyMode;
  const params = STRATEGY_PARAMS[mode] ?? STRATEGY_PARAMS.SWING;

  // 포지션 사이즈: 포트폴리오의 positionCapPct% (최대)
  const netAsset = balance.netAsset || orderableCash;
  const maxPositionKrw = netAsset * (allocRisk.positionCapPct / 100);

  // 6. 상위 N종목 순회하며 주문
  const orderCount = Math.min(candidates.length, MAX_PREMARKET_ORDERS, availableSlots);
  let remainingCash = orderableCash;

  for (let i = 0; i < orderCount; i++) {
    const score = candidates[i];
    const stockCode = score.stock_code;

    try {
      // 전일 종가 조회 (08:57에 호출 → KIS에서 전일 종가 반환)
      const priceData = await getCurrentPrice(stockCode).catch(() => null);
      const prevClose = priceData?.prevClosePrice ?? priceData?.currentPrice ?? 0;
      if (prevClose <= 0) {
        logger.warn(`[동시호가] ${stockCode} 전일종가 조회 실패 → 스킵`, { component: 'PRE_MARKET_ORDER' });
        result.skipped++;
        continue;
      }

      // 지정가 = 전일 종가 + PRICE_PREMIUM_PCT% (호가단위 맞춤)
      const limitPrice = adjustToTickSize(prevClose * (1 + PRICE_PREMIUM_PCT / 100));

      // 수량 계산: min(positionCap, remainingCash) / limitPrice
      const budgetKrw = Math.min(maxPositionKrw, remainingCash * 0.95); // 5% 여유 (수수료)
      const quantity = Math.floor(budgetKrw / limitPrice);
      if (quantity <= 0 || limitPrice * quantity < MIN_ORDER_KRW) {
        logger.info(`[동시호가] ${stockCode} 수량 부족 (예산 ${budgetKrw.toLocaleString()}, 가격 ${limitPrice}) → 스킵`, {
          component: 'PRE_MARKET_ORDER',
        });
        result.skipped++;
        continue;
      }

      // ScaleIn 1/3 분할: 동시호가는 1차 트랜치만 (나머지는 장중 Track B에서)
      const tranche1 = Math.max(1, Math.ceil(quantity / 3));
      const orderAmount = tranche1 * limitPrice;

      logger.info(
        `📋 [동시호가][${modeLabel}] ${stockCode} 주문 준비: AI=${score.composite_score}점, ` +
          `지정가=${limitPrice.toLocaleString()}원(전일종가+${PRICE_PREMIUM_PCT}%), ` +
          `수량=${tranche1}주, 금액=${orderAmount.toLocaleString()}원`,
        { component: 'PRE_MARKET_ORDER' },
      );

      // Paper 모드: 가상 체결
      if (isPaper) {
        await paperTradeOrder({
          stockCode,
          side: 'BUY',
          quantity: tranche1,
          price: limitPrice,
        });
        await insertOrder({
          chain_id: null,
          stock_code: stockCode,
          side: 'BUY',
          order_type: OrderType.LIMIT,
          quantity: tranche1,
          price: limitPrice,
          kis_order_no: `PMO_P_${Date.now().toString(36)}`,
          kis_status: 'PAPER_FILLED',
          filled_quantity: tranche1,
          filled_price: prevClose, // Paper: 전일종가로 체결 가정
          status: 'FILLED',
          trading_mode: 'paper',
          trigger_source: 'PRE_MARKET_ORDER',
          ai_reasoning: `[동시호가][AI:${score.composite_score}] ${score.reasoning?.slice(0, 100) ?? ''}`,
        });
        result.ordered++;
        remainingCash -= orderAmount;
        result.details.push(`✅ ${stockCode} ${tranche1}주 @${limitPrice.toLocaleString()} (Paper)`);
        continue;
      }

      // Live 모드: KIS 동시호가 주문 (지정가)
      const orderResult = await placeOrder({
        stockCode,
        side: 'BUY',
        quantity: tranche1,
        price: limitPrice,
        orderType: OrderType.LIMIT,
      });

      if (!orderResult.success) {
        logger.error(`[동시호가] ${stockCode} 주문 실패: ${orderResult.message}`, { component: 'PRE_MARKET_ORDER' });
        result.skipped++;
        result.details.push(`❌ ${stockCode} 주문 실패: ${orderResult.message}`);
        continue;
      }

      // DB 기록 — PENDING 상태 (09:00 시초가 결정 후 체결 확인)
      await insertOrder({
        chain_id: null,
        stock_code: stockCode,
        side: 'BUY',
        order_type: OrderType.LIMIT,
        quantity: tranche1,
        price: limitPrice,
        kis_order_no: orderResult.orderNo,
        kis_status: 'PENDING',
        filled_quantity: 0,
        filled_price: 0,
        status: 'PENDING',
        trading_mode: 'live',
        trigger_source: 'PRE_MARKET_ORDER',
        ai_reasoning: `[동시호가][AI:${score.composite_score}] ${score.reasoning?.slice(0, 100) ?? ''}`,
      });

      result.ordered++;
      remainingCash -= orderAmount;
      result.details.push(
        `✅ ${stockCode} ${tranche1}주 @${limitPrice.toLocaleString()} (주문번호: ${orderResult.orderNo})`,
      );

      logger.info(
        `✅ [동시호가][LIVE] ${stockCode} 주문 완료: ${tranche1}주 @${limitPrice.toLocaleString()} (KIS: ${orderResult.orderNo})`,
        { component: 'PRE_MARKET_ORDER' },
      );
    } catch (err: any) {
      logger.error(`[동시호가] ${stockCode} 예외: ${err.message}`, { component: 'PRE_MARKET_ORDER' });
      result.skipped++;
      result.details.push(`❌ ${stockCode} 에러: ${err.message}`);
    }
  }

  // 7. 텔레그램 알림
  if (result.ordered > 0) {
    const msg =
      `📋 동시호가 선제주문 [${modeLabel}]\n` +
      `주문 ${result.ordered}건 / 스킵 ${result.skipped}건\n` +
      result.details.join('\n');
    sendTelegramMessage(msg).catch(() => {});
  }

  // 잔고 캐시 무효화 (주문 후 반영)
  invalidateBalanceCache();

  logger.info(
    `[동시호가][${modeLabel}] 완료: ${result.ordered}건 주문, ${result.skipped}건 스킵`,
    { component: 'PRE_MARKET_ORDER' },
  );
  return result;
}
