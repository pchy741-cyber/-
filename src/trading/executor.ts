import { OrderType, STRATEGY_PARAMS, type StrategyMode } from '../config/constants.js';
import { config } from '../config/index.js';
import { insertOrder, logSystem, updateOrder, upsertWatchlistItem } from '../db/client.js';
import type { TradeDecision } from '../db/models.js';
import { getCurrentPrice, getDailyChart } from '../kis/market.js';
import { getOrderFills, type OrderResult, placeOrder } from '../kis/order.js';
import { riskEngine } from '../risk/engine.js';
import { reportError, reportSuccess } from '../risk/kill-switch.js';
import { notifyBuy, notifySell } from '../notifications/web-push.js';
import { runTradeGates, type GateInput } from '../risk/trade-gate.js';
import { paperTradeOrder } from '../risk/paper.js';
import { acquireLock } from '../utils/lock.js';
import { logger } from '../utils/logger.js';
import { roundKrw } from '../utils/money.js';
import { invalidateStockCache } from '../cache/redis.js';
import { chainManager } from './chain.js';

/**
 * 매매 실행기 (Trade Executor)
 * - 모든 매매의 단일 진입점
 * - AI 판단 → 리스크 검증 → 주문 → 체결 확인 → 체인 업데이트
 */
export class TradeExecutor {
  /**
   * AI 결정 배열을 일괄 처리
   */
  async processDecisions(decisions: TradeDecision[], mode: StrategyMode): Promise<void> {
    for (const decision of decisions) {
      try {
        await this.executeDecision(decision, mode);
        reportSuccess();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`주문 실행 실패 [${decision.stock_code}]: ${msg}`, { component: 'EXECUTOR' });
        await reportError('EXECUTOR', msg);
        await logSystem('ERROR', 'EXECUTOR', `실행 실패: ${decision.stock_code} - ${msg}`);
      }
    }
  }

  /**
   * 개별 결정 실행
   */
  private async executeDecision(decision: TradeDecision, mode: StrategyMode): Promise<void> {
    const { action, stock_code, quantity, price_type, limit_price, reasoning } = decision;

    // 수량 0 이하 방어
    if (!quantity || quantity <= 0) {
      logger.warn(`⛔ 수량 0 → 스킵: ${action} ${stock_code}`, { component: 'EXECUTOR' });
      await logSystem('WARN', 'EXECUTOR', `수량 0 스킵: ${action} ${stock_code}`);
      return;
    }

    // 종목별 락 획득 (중복 주문 방지)
    const unlock = await acquireLock(stock_code, `${action}-${Date.now()}`);
    if (!unlock) {
      logger.warn(`⏳ 락 대기 중: ${stock_code} (다른 주문 처리 중) → 스킵`, { component: 'EXECUTOR' });
      return;
    }

    try {
      logger.info(`▶ 실행: ${action} ${stock_code} x${quantity}`, { component: 'EXECUTOR' });

      switch (action) {
        case 'BUY':
          await this.executeBuy(stock_code, quantity, price_type, limit_price, mode, reasoning);
          break;
        case 'AVERAGE_DOWN':
          await this.executeAverageDown(stock_code, quantity, price_type, limit_price, reasoning);
          break;
        case 'PARTIAL_SELL':
          await this.executePartialSell(stock_code, quantity, reasoning);
          break;
        case 'SELL':
        case 'FORCE_CLOSE':
          await this.executeClose(stock_code, reasoning, action);
          break;
        default:
          logger.warn(`알 수 없는 액션: ${action}`, { component: 'EXECUTOR' });
      }
    } finally {
      unlock();
    }
  }

  /**
   * 신규 매수 (체인 생성)
   */
  private async executeBuy(
    stockCode: string,
    quantity: number,
    priceType: string,
    limitPrice: number | undefined,
    mode: StrategyMode,
    reasoning: string,
  ): Promise<void> {
    // 이미 열린 체인이 있으면 물타기로 전환
    const existingChain = await chainManager.findOpenChain(stockCode);
    if (existingChain) {
      logger.info(`이미 열린 체인 존재 → 물타기로 전환`, { component: 'EXECUTOR' });
      await this.executeAverageDown(stockCode, quantity, priceType, limitPrice, reasoning);
      return;
    }

    // 가격 우선순위: limit_price(파이프라인) → KIS API → 메모리캐시 → Redis캐시
    let estimatedPrice = limitPrice ?? 0;
    if (!estimatedPrice) {
      const priceData = await getCurrentPrice(stockCode).catch(() => null);
      estimatedPrice = priceData?.currentPrice ?? 0;

      // KIS 실패 → 캐시 fallback
      if (!estimatedPrice || estimatedPrice <= 0) {
        const { getCachedPriceMemory } = await import('../cache/memory.js');
        const { getLastKnownPrice } = await import('../cache/redis.js');
        estimatedPrice = getCachedPriceMemory(stockCode) ?? await getLastKnownPrice(stockCode) ?? 0;
        if (estimatedPrice > 0) {
          logger.info(`💰 캐시 가격 사용: ${stockCode} = ${estimatedPrice}원`, { component: 'EXECUTOR' });
        }
      }
    }

    if (!estimatedPrice || estimatedPrice <= 0) {
      logger.warn(`⛔ 현재가+캐시 모두 0 → 매수 스킵: ${stockCode}`, { component: 'EXECUTOR' });
      await logSystem('WARN', 'EXECUTOR', `매수 스킵: ${stockCode} - 현재가 조회 실패 (0원)`);
      return;
    }

    // 🚦 매매 게이트 (차트검수 + 확률교정 + 변동성사이징 + 레짐필터 + 쿨다운)
    const params = STRATEGY_PARAMS[mode];
    let gatedQuantity = quantity;
    try {
      const candles = await getDailyChart(stockCode, 65).catch(() => []);
      const gateInput: GateInput = {
        stockCode,
        action: 'BUY',
        quantity,
        estimatedPrice,
        candles: candles.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
        strategyMode: mode,
        stopLossPct: params.stopLossPct,
        takeProfitPct: params.takeProfitPct,
        budgetKrw: estimatedPrice * quantity,
      };
      const gateResult = await runTradeGates(gateInput);
      if (!gateResult.passed) {
        logger.warn(`🚦 게이트 차단 [${stockCode}]: ${gateResult.reason}`, { component: 'EXECUTOR' });
        await logSystem('WARN', 'TRADE_GATE', `매수 차단: ${stockCode} - ${gateResult.reason}`);
        return;
      }
      gatedQuantity = gateResult.adjustedQuantity ?? quantity;
    } catch (e) {
      const errMsg = (e as Error).message;
      logger.warn(`게이트 에러 (통과 처리): ${errMsg}`, { component: 'EXECUTOR' });
      await logSystem('WARN', 'EXECUTOR', `게이트 오류 (통과): ${stockCode} - ${errMsg}`);
    }

    // 리스크 체크
    const riskCheck = await riskEngine.validateOrder({
      stockCode,
      side: 'BUY',
      quantity: gatedQuantity,
      estimatedPrice,
    });

    if (!riskCheck.approved) {
      logger.warn(`❌ 매수 거부 [${stockCode}]: ${riskCheck.reason}`, { component: 'EXECUTOR' });
      await logSystem('WARN', 'EXECUTOR', `매수 거부: ${stockCode} - ${riskCheck.reason}`);
      return;
    }

    // 주문 실행
    const result = await this.executeOrder({
      stockCode,
      side: 'BUY',
      quantity: gatedQuantity,
      price: priceType === 'LIMIT' ? limitPrice : undefined,
      triggerSource: 'TRACK_B',
      aiReasoning: reasoning,
    });

    if (result.success) {
      const fillPrice = await this.confirmFill(result.orderNo, stockCode, estimatedPrice);
      if (fillPrice < 0) {
        logger.error(`체결 미확인 → 체인 생성 보류: ${stockCode}`, { component: 'EXECUTOR' });
        return;
      }

      await chainManager.openChain({
        stockCode,
        mode,
        buyPrice: fillPrice,
        quantity: gatedQuantity,
        targetProfitPct: params.takeProfitPct,
        stopLossPct: params.stopLossPct,
        maxAveragingCount: params.maxAveragingCount,
      });

      // 감시목록 자동 등록 + 종목명 즉시 보정 (코드 저장 후 KRX API로 이름 조회)
      upsertWatchlistItem({ stock_code: stockCode, stock_name: stockCode, market: 'KOSPI' })
        .then(() => import('../kis/interest-group.js').then((m) => m.fixWatchlistNames()))
        .catch(() => {});

      // 캐시 무효화 + 푸시 알림
      invalidateStockCache(stockCode).catch(() => {});
      notifyBuy(stockCode, gatedQuantity, fillPrice, reasoning).catch(() => {});
    }
  }

  /**
   * 물타기 (기존 체인에 추가 매수)
   */
  private async executeAverageDown(
    stockCode: string,
    quantity: number,
    priceType: string,
    limitPrice: number | undefined,
    reasoning: string,
  ): Promise<void> {
    const chain = await chainManager.findOpenChain(stockCode);
    if (!chain) {
      logger.warn(`물타기 실패: ${stockCode} 열린 체인 없음`, { component: 'EXECUTOR' });
      return;
    }

    // 물타기 횟수 확인
    if (chain.current_averaging_count >= chain.max_averaging_count) {
      logger.warn(`물타기 한도 도달: ${stockCode} (${chain.current_averaging_count}/${chain.max_averaging_count})`, {
        component: 'EXECUTOR',
      });
      return;
    }

    const price = await getCurrentPrice(stockCode);
    const estimatedPrice = limitPrice ?? price.currentPrice;

    const riskCheck = await riskEngine.validateOrder({
      stockCode,
      side: 'BUY',
      quantity,
      estimatedPrice,
    });

    if (!riskCheck.approved) {
      logger.warn(`❌ 물타기 거부 [${stockCode}]: ${riskCheck.reason}`, { component: 'EXECUTOR' });
      return;
    }

    const result = await this.executeOrder({
      stockCode,
      side: 'BUY',
      quantity,
      price: priceType === 'LIMIT' ? limitPrice : undefined,
      chainId: chain.id,
      triggerSource: 'TRACK_B',
      aiReasoning: reasoning,
    });

    if (result.success) {
      const fillPrice = await this.confirmFill(result.orderNo, stockCode, estimatedPrice);
      if (fillPrice < 0) {
        logger.error(`체결 미확인 → 물타기 체인 업데이트 보류: ${stockCode}`, { component: 'EXECUTOR' });
        return;
      }
      await chainManager.addAveraging(chain.id, fillPrice, quantity);
    }
  }

  /**
   * 부분 익절
   */
  private async executePartialSell(stockCode: string, quantity: number, reasoning: string): Promise<void> {
    const chain = await chainManager.findOpenChain(stockCode);
    if (!chain) return;

    // 보유 수량 초과 방어 — 보유량 이내로 클램핑
    const safeQty = Math.min(quantity, chain.total_quantity);
    if (safeQty <= 0) {
      logger.warn(`⛔ 보유 0주 → 매도 스킵: ${stockCode}`, { component: 'EXECUTOR' });
      return;
    }

    const result = await this.executeOrder({
      stockCode,
      side: 'SELL',
      quantity: safeQty,
      chainId: chain.id,
      triggerSource: 'TRACK_B',
      aiReasoning: reasoning,
    });

    if (result.success) {
      const price = await getCurrentPrice(stockCode);
      const avgBuy = Number(chain.avg_buy_price) || 0;
      const pnlPct = avgBuy > 0 ? ((price.currentPrice - avgBuy) / avgBuy) * 100 : 0;
      await chainManager.partialProfit(chain.id, safeQty, price.currentPrice, chain);
      invalidateStockCache(stockCode).catch(() => {});
      notifySell(stockCode, safeQty, price.currentPrice, pnlPct, reasoning).catch(() => {});
    }
  }

  /**
   * 전량 청산 (손절/강제)
   */
  private async executeClose(stockCode: string, reasoning: string, action: string): Promise<void> {
    const chain = await chainManager.findOpenChain(stockCode);
    if (!chain || chain.total_quantity === 0) return;

    const result = await this.executeOrder({
      stockCode,
      side: 'SELL',
      quantity: chain.total_quantity,
      chainId: chain.id,
      triggerSource: 'TRACK_B',
      aiReasoning: reasoning,
    });

    if (result.success) {
      const price = await getCurrentPrice(stockCode);
      const closeReason = action === 'FORCE_CLOSE' ? `강제 청산: ${reasoning}` : `매도: ${reasoning}`;
      const avgBuy = Number(chain.avg_buy_price) || 0;
      const pnlPct = avgBuy > 0 ? ((price.currentPrice - avgBuy) / avgBuy) * 100 : 0;
      await chainManager.closeChain(chain.id, price.currentPrice, chain, closeReason);
      invalidateStockCache(stockCode).catch(() => {});
      notifySell(stockCode, chain.total_quantity, price.currentPrice, pnlPct, closeReason).catch(() => {});
    }
  }

  /**
   * 실제 주문 실행 (Paper / Live 분기)
   */
  private async executeOrder(params: {
    stockCode: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    price?: number;
    chainId?: string;
    triggerSource?: string;
    aiReasoning?: string;
  }): Promise<OrderResult> {
    if (config.isPaper) {
      return paperTradeOrder(params);
    }

    // 실거래 주문
    const result = await placeOrder({
      stockCode: params.stockCode,
      side: params.side,
      quantity: params.quantity,
      price: params.price,
      orderType: params.price ? OrderType.LIMIT : OrderType.MARKET,
    });

    // DB 기록
    await insertOrder({
      chain_id: params.chainId ?? null,
      stock_code: params.stockCode,
      side: params.side,
      order_type: params.price ? '00' : '01',
      quantity: params.quantity,
      price: params.price ?? null,
      kis_order_no: result.orderNo,
      kis_status: result.success ? 'SUBMITTED' : 'FAILED',
      filled_quantity: 0,
      filled_price: null,
      status: result.success ? 'PENDING' : 'FAILED',
      trading_mode: 'live',
      trigger_source: params.triggerSource ?? null,
      ai_reasoning: params.aiReasoning ?? null,
    });

    await logSystem(
      'TRADE',
      'EXECUTOR',
      `${params.side} ${params.stockCode} x${params.quantity} → ${result.success ? '주문 접수' : '실패'}: ${result.message}`,
    );

    return result;
  }

  /**
   * 체결 확인 (Triple Check)
   *
   * 실거래에서 가장 중요한 로직:
   * 1. 주문 후 2초 대기 → 체결 확인
   * 2. 미체결이면 3초 후 재확인
   * 3. 그래도 미체결이면 5초 후 최종 확인
   * 4. 체결 확인되면 DB 주문 상태도 업데이트
   */
  private confirmedOrders = new Set<string>();

  private async confirmFill(orderNo: string, stockCode: string, fallbackPrice: number): Promise<number> {
    if (config.isPaper) return roundKrw(fallbackPrice);

    // 멱등성: 이미 확인된 주문이면 중복 확인 방지
    if (this.confirmedOrders.has(orderNo)) {
      logger.warn(`⚠️ 이미 확인된 주문: ${orderNo} → 스킵`, { component: 'EXECUTOR' });
      return -1;
    }

    const retryDelays = [2000, 3000, 5000]; // 2초, 3초, 5초

    for (let i = 0; i < retryDelays.length; i++) {
      await new Promise((r) => setTimeout(r, retryDelays[i]));

      try {
        const fill = await getOrderFills(orderNo);
        if (fill && fill.filledQty > 0) {
          logger.info(`✅ 체결 확인 (시도 ${i + 1}): ${stockCode} ${fill.filledQty}주 @${fill.filledPrice}`, {
            component: 'EXECUTOR',
          });

          // DB 주문 상태 업데이트 + 멱등성 등록
          this.confirmedOrders.add(orderNo);
          await updateOrder(orderNo, {
            filled_quantity: fill.filledQty,
            filled_price: fill.filledPrice,
            status: fill.filledQty >= fill.orderQty ? 'FILLED' : 'PARTIAL',
            kis_status: 'FILLED',
          });

          return roundKrw(fill.filledPrice);
        }

        logger.info(`⏳ 체결 대기 (시도 ${i + 1}/${retryDelays.length}): ${orderNo}`, {
          component: 'EXECUTOR',
        });
      } catch (error) {
        logger.warn(`체결 확인 에러 (시도 ${i + 1}): ${error}`, { component: 'EXECUTOR' });
      }
    }

    // 최종 실패: 추정가 사용하지 않고 -1 반환 → 호출측에서 체인 업데이트 보류
    logger.error(`🛑 체결 미확인 (${retryDelays.length}회 시도): ${orderNo} → 매매 중단, 수동 확인 필요`, {
      component: 'EXECUTOR',
    });
    await logSystem('ERROR', 'EXECUTOR', `체결 미확인: ${orderNo}. 해당 종목 매매 일시 중단. 수동 확인 필요.`);

    const { sendTelegramMessage } = await import('../notifications/telegram.js');
    await sendTelegramMessage(`🛑 체결 미확인 경고!\n주문번호: ${orderNo}\n종목: ${stockCode}\n수동 확인 후 조치 필요`);

    return -1; // 체결 실패 시그널
  }
}

export const tradeExecutor = new TradeExecutor();
