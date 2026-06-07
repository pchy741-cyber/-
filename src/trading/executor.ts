import { OrderType, STRATEGY_PARAMS, getScoreBasedParams, type StrategyMode } from '../config/constants.js';
import { config } from '../config/index.js';
import { getCtxIsPaper } from '../config/context.js';
import { getActiveStrategy, getOpenChains, insertOrder, logSystem, updateOrderByKisOrderNo, upsertWatchlistItem } from '../db/client.js';
import type { TradeDecision } from '../db/models.js';
import { getCurrentPrice, getDailyChart } from '../kis/market.js';
import { cancelOrder, getOrderFills, type OrderResult, placeOrder } from '../kis/order.js';
import { riskEngine } from '../risk/engine.js';
import { reportError, reportSuccess } from '../risk/kill-switch.js';
import { notifyBuy, notifySell } from '../notifications/web-push.js';
import { runTradeGates, type GateInput } from '../risk/trade-gate.js';
import { paperTradeOrder } from '../risk/paper.js';
import { acquireLock } from '../utils/lock.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';
import { roundKrw } from '../utils/money.js';
import { invalidateStockCache } from '../cache/redis.js';
import { invalidateDashboardCache, hardInvalidateDashboardCache } from '../cache/dashboard-cache.js';
import { invalidateBalanceCache } from '../kis/account.js';
import { chainManager } from './chain.js';
import { registerBuyIntent, releaseBuyIntent } from './buy-intent.js';

/**
 * 매매 실행기 (Trade Executor)
 * - 모든 매매의 단일 진입점
 * - AI 판단 → 리스크 검증 → 주문 → 체결 확인 → 체인 업데이트
 */
export class TradeExecutor {
  // (종목코드)-(YYYYMMDDHHMM) 키로 분당 1회 중복 주문 방지
  private readonly _recentOrderKeys = new Set<string>();

  private _minuteKey(stockCode: string, action: string): string {
    const now = new Date();
    const ymd = now.toISOString().slice(0, 16).replace(/[-:T]/g, ''); // YYYYMMDDHHmm
    return `${stockCode}-${action}-${ymd}`;
  }

  /**
   * AI 결정 배열을 일괄 처리
   * @param source 매수 출처 라벨 (TRACK_B, SNIPER, OPENING_BELL, AFTER_HOURS 등)
   */
  async processDecisions(decisions: TradeDecision[], mode: StrategyMode, source?: string): Promise<void> {
    for (const decision of decisions) {
      const isBuyAction = decision.action === 'BUY' || decision.action === 'AVERAGE_DOWN';
      const intentSource = decision.trigger_source ?? source ?? mode;

      // 🔒 매수 의도 레지스트리: 전 전략 교차 중복 매수 방지
      if (isBuyAction && !registerBuyIntent(decision.stock_code, intentSource)) {
        continue; // 다른 전략이 이미 매수 진행 중 → 스킵
      }

      try {
        await this.executeDecision(decision, mode);
        reportSuccess();
      } catch (error) {
        if (isBuyAction) releaseBuyIntent(decision.stock_code);
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`주문 실행 실패 [${decision.stock_code}]: ${msg}`, { component: 'EXECUTOR' });
        await reportError('EXECUTOR', msg);
        await logSystem('ERROR', 'EXECUTOR', `실행 실패: ${decision.stock_code} - ${msg}`);
      }
    }
    // 오래된 키 정리 — 현재 분 키만 남기고 이전 분 삭제 (전체 삭제 시 동일 분 중복 허용 버그 방지)
    if (this._recentOrderKeys.size > 200) {
      const currentMinute = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      for (const key of this._recentOrderKeys) {
        if (!key.endsWith(currentMinute)) this._recentOrderKeys.delete(key);
      }
    }
  }

  /**
   * 개별 결정 실행
   */
  private async executeDecision(decision: TradeDecision, mode: StrategyMode): Promise<void> {
    const { action, stock_code, quantity, price_type, limit_price, reasoning, trigger_source } = decision;

    // 수량 0 이하 방어
    if (!quantity || quantity <= 0) {
      logger.warn(`⛔ 수량 0 → 스킵: ${action} ${stock_code}`, { component: 'EXECUTOR' });
      await logSystem('WARN', 'EXECUTOR', `수량 0 스킵: ${action} ${stock_code}`);
      return;
    }

    // 분당 1회 중복 주문 가드 (같은 종목 같은 분에 매수/매도 2번 방지)
    const minuteKey = this._minuteKey(stock_code, action);
    if (this._recentOrderKeys.has(minuteKey)) {
      logger.warn(`⏳ 분당 중복 주문 차단: ${action} ${stock_code} (이미 이 분에 처리됨)`, { component: 'EXECUTOR' });
      return;
    }
    this._recentOrderKeys.add(minuteKey);

    // 종목별 락 획득 (중복 주문 방지)
    const unlock = await acquireLock(stock_code, `${action}-${Date.now()}`);
    if (!unlock) {
      logger.warn(`⏳ 락 대기 중: ${stock_code} (다른 주문 처리 중) → 스킵`, { component: 'EXECUTOR' });
      return;
    }

    try {
      logger.info(`▶ 실행: ${action} ${stock_code} x${quantity}`, { component: 'EXECUTOR' });

      // per-decision 모드 오버라이드 (BOTTOM_FISHING 등)
      const effectiveMode = (decision.strategy_mode && decision.strategy_mode in STRATEGY_PARAMS)
        ? decision.strategy_mode as StrategyMode
        : mode;

      const tpSlHints: import('../config/constants.js').DomesticTpSlHints | undefined =
        decision.ai_score ? {
          score: decision.ai_score,
          confidence: decision.confidence,
          rsi: decision.rsi,
          volumeRatio: decision.volume_ratio,
          pullbackSignal: decision.pullback_signal,
          envelopePos: decision.envelope_pos,
        } : undefined;

      switch (action) {
        case 'BUY':
          await this.executeBuy(stock_code, quantity, price_type, limit_price, effectiveMode, reasoning, decision.ai_score, tpSlHints, trigger_source);
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
    aiScore?: number,
    tpSlHints?: import('../config/constants.js').DomesticTpSlHints,
    triggerSource?: string,
  ): Promise<void> {
    const isPaperSnapshot = getCtxIsPaper();

    // 이미 열린 체인이 있으면 물타기로 전환 (intent는 유지 — 물타기도 매수)
    const existingChain = await chainManager.findOpenChain(stockCode);
    if (existingChain) {
      logger.info(`이미 열린 체인 존재 → 물타기로 전환`, { component: 'EXECUTOR' });
      await this.executeAverageDown(stockCode, quantity, priceType, limitPrice, reasoning);
      return;
    }

    // 동시 포지션 한도 확인 (신규 매수만 해당 — 물타기/청산은 제외)
    const allOpenChains = await getOpenChains();
    if (allOpenChains.length >= config.risk.maxConcurrentPositions) {
      releaseBuyIntent(stockCode);
      logger.warn(
        `⛔ 동시 포지션 한도 초과 (${allOpenChains.length}/${config.risk.maxConcurrentPositions}) → 신규 매수 차단: ${stockCode}`,
        { component: 'EXECUTOR' },
      );
      await logSystem('WARN', 'EXECUTOR', `포지션 한도 초과: ${allOpenChains.length}/${config.risk.maxConcurrentPositions} — ${stockCode} 신규 매수 차단`);
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
      releaseBuyIntent(stockCode);
      logger.warn(`⛔ 현재가+캐시 모두 0 → 매수 스킵: ${stockCode}`, { component: 'EXECUTOR' });
      await logSystem('WARN', 'EXECUTOR', `매수 스킵: ${stockCode} - 현재가 조회 실패 (0원)`);
      return;
    }

    // 🚦 매매 게이트 (차트검수 + 확률교정 + 변동성사이징 + 레짐필터 + 쿨다운)
    // ETF 파킹 / 바닥낚시 종목은 게이트 생략 (스캐너가 이미 검증 or 차트 분석 불필요)
    const ETF_PARK_CODES = ['333940', '069500', '161510', '114800']; // 파킹ETF: KODEX인버스,KODEX200,TIGER고배당,KODEX200인버스
    const skipGates = ETF_PARK_CODES.includes(stockCode) || mode === 'BOTTOM_FISHING';
    const params = STRATEGY_PARAMS[mode];
    let gatedQuantity = quantity;
    if (skipGates) {
      logger.info(`⏭️ 게이트 생략 (${mode === 'BOTTOM_FISHING' ? '바닥낚시' : 'ETF파킹'}): ${stockCode} → 직접 주문`, { component: 'EXECUTOR' });
    } else
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
        releaseBuyIntent(stockCode);
        logger.warn(`🚦 게이트 차단 [${stockCode}]: ${gateResult.reason}`, { component: 'EXECUTOR' });
        await logSystem('WARN', 'TRADE_GATE', `매수 차단: ${stockCode} - ${gateResult.reason}`);
        return;
      }
      gatedQuantity = gateResult.adjustedQuantity ?? quantity;
    } catch (e) {
      const errMsg = (e as Error).message;
      // fail-closed: 게이트 장애 시 매수 허용하면 리스크 통제 우회 — 차단이 안전
      releaseBuyIntent(stockCode);
      logger.warn(`게이트 에러 (매수 차단): ${errMsg}`, { component: 'EXECUTOR' });
      await logSystem('WARN', 'EXECUTOR', `게이트 오류 (차단): ${stockCode} - ${errMsg}`);
      return;
    }

    // 리스크 체크 (ETF 파킹/바닥낚시는 Kill Switch만 확인 — 포지션/한도 체크 제외)
    if (skipGates) {
      const { isKillSwitchActive } = await import('../risk/kill-switch.js');
      if (isKillSwitchActive()) {
        releaseBuyIntent(stockCode);
        logger.warn(`🛑 Kill Switch 활성 → ETF 파킹 스킵: ${stockCode}`, { component: 'EXECUTOR' });
        return;
      }
    } else {
      const riskCheck = await riskEngine.validateOrder({
        stockCode,
        side: 'BUY',
        quantity: gatedQuantity,
        estimatedPrice,
        isPaper: isPaperSnapshot,
      });

      if (!riskCheck.approved) {
        releaseBuyIntent(stockCode);
        logger.warn(`❌ 매수 거부 [${stockCode}]: ${riskCheck.reason}`, { component: 'EXECUTOR' });
        await logSystem('WARN', 'EXECUTOR', `매수 거부: ${stockCode} - ${riskCheck.reason}`);
        return;
      }
    }

    // 🎯 대형 주문 진입타이밍 AI 검토 (100만원 이상, ETF 파킹/바닥낚시 제외)
    const orderAmountKrw = estimatedPrice * gatedQuantity;
    if (!skipGates && orderAmountKrw >= 1_000_000) {
      try {
        const { checkLargeOrderEntryTiming } = await import('../ai/entry-timing.js');
        const entryCandles = await getDailyChart(stockCode, 20).catch(() => []);
        const entryCheck = await checkLargeOrderEntryTiming(stockCode, estimatedPrice, orderAmountKrw, entryCandles, reasoning);
        if (!entryCheck.approved) {
          releaseBuyIntent(stockCode);
          logger.warn(`🎯 진입타이밍 AI 거부 [${stockCode} ${Math.round(orderAmountKrw / 10000)}만원]: ${entryCheck.reason}`, { component: 'EXECUTOR' });
          await logSystem('WARN', 'ENTRY_TIMING', `대형주문 진입거부: ${stockCode} ${Math.round(orderAmountKrw / 10000)}만원 — ${entryCheck.reason}`);
          return;
        }
      } catch { /* fail-open: AI 오류 시 기존 게이트 결과 존중 */ }
    }

    // 호가 진입 타이밍 — ask2 이하일 때만 매수 (ETF 파킹/바닥낚시 제외 — 시간외 단일가는 호가 무의미)
    // + 스마트 매수: ask1 지정가 주문으로 시장가 슬리피지 방지
    let smartBuyPrice: number | undefined;
    if (!skipGates) {
      try {
        const { getOrderbook } = await import('../kis/market.js');
        const book = await getOrderbook(stockCode);
        const ask1 = book[0]?.askPrice ?? 0;
        const ask2 = book[1]?.askPrice ?? 0;
        if (ask1 > 0 && ask2 > 0 && estimatedPrice > ask2) {
          releaseBuyIntent(stockCode);
          logger.warn(`⏸️ 호가 진입 보류: ${stockCode} 현재가 ${estimatedPrice} > ask2 ${ask2} — 스킵`, { component: 'EXECUTOR' });
          await logSystem('WARN', 'EXECUTOR', `호가 진입 보류: ${stockCode} 현재가=${estimatedPrice} ask2=${ask2}`);
          return;
        }
        // 스마트 매수: ask1(매도1호가) 지정가 → 시장가 대비 슬리피지 차단
        if (ask1 > 0) {
          smartBuyPrice = ask1;
          logger.info(`💰 스마트 매수: ${stockCode} ask1=${ask1.toLocaleString()} → 지정가 주문`, { component: 'EXECUTOR' });
        }
      } catch { /* 호가 조회 실패 시 시장가 폴백 (fail-open) */ }
    }

    // 주문 실행 (지정가 우선 → 호가 없으면 시장가 폴백)
    const result = await this.executeOrder({
      stockCode,
      side: 'BUY',
      quantity: gatedQuantity,
      price: priceType === 'LIMIT' ? limitPrice : smartBuyPrice,
      triggerSource: triggerSource ?? 'TRACK_B',
      aiReasoning: reasoning,
    });

    if (!result.success) {
      releaseBuyIntent(stockCode);
      return;
    }

    {
      const fill = await this.confirmFill(result.orderNo, stockCode, gatedQuantity, estimatedPrice);
      if (!fill) {
        releaseBuyIntent(stockCode);
        logger.error(`체결 미확인 → 체인 생성 보류: ${stockCode}`, { component: 'EXECUTOR' });
        return;
      }
      if (fill.filledQty <= 0) {
        releaseBuyIntent(stockCode);
        logger.error(`매수 체결 수량 0 → 체인 생성 보류 (주문 거부 또는 미체결): ${stockCode}`, { component: 'EXECUTOR' });
        return;
      }
      const filledQty = Math.min(gatedQuantity, fill.filledQty);
      if (filledQty < gatedQuantity) {
        logger.warn(`⚠️ 매수 부분체결 반영: ${stockCode} 요청 ${gatedQuantity}주 → 체결 ${filledQty}주`, { component: 'EXECUTOR' });
      }

      // 동적 TP/SL: 항상 다팩터 엔진 사용 (v4: 플래그 폐지 → 해외와 동등)
      // 팩터: AI score + ADX + ATR + RSI + 거래량 + 시장레짐 + 수급
      const dbStrategy = await getActiveStrategy().catch(() => null);
      let scoreParams: { takeProfitPct: number; stopLossPct: number } | null = null;
      if (mode !== 'SCALPING' && aiScore && aiScore >= 60) {
        const { getDynamicDomesticTpSl } = await import('../config/constants.js');
        // 자기학습 피드백: strategy_config에 학습된 TP/SL → 30% 블렌딩
        const learnedTp = (dbStrategy as any)?.take_profit_pct as number | undefined;
        const learnedSl = (dbStrategy as any)?.stop_loss_pct as number | undefined;
        const dyn = getDynamicDomesticTpSl({ ...tpSlHints, score: aiScore, learnedTp, learnedSl });
        scoreParams = { takeProfitPct: dyn.takeProfitPct, stopLossPct: dyn.stopLossPct };
        logger.info(`🎯 동적 TP/SL [${dyn.label}]: score=${aiScore} → TP ${dyn.takeProfitPct}% / SL ${dyn.stopLossPct}%`, { component: 'EXECUTOR' });
      }
      const targetProfitPct = scoreParams?.takeProfitPct ?? (dbStrategy as any)?.take_profit_pct ?? params.takeProfitPct;
      let stopLossPct = scoreParams?.stopLossPct ?? (dbStrategy as any)?.stop_loss_pct ?? params.stopLossPct;

      // ATR 기반 동적 손절 — 전략 손절폭보다 넓어지지 않도록 캡 적용
      try {
        const { calculateATR } = await import('../automation/position-sizer.js');
        const atr = await calculateATR(stockCode);
        if (atr > 0 && fill.filledPrice > 0) {
          const atrStopPct = -((atr * 2.0) / fill.filledPrice) * 100;
          // 전략 설정(stopLossPct)보다 넓어지는 것 방지: -2% ~ stopLossPct 범위
          stopLossPct = Math.max(stopLossPct, Math.min(-2, atrStopPct));
          logger.info(`ATR 동적 손절: ${stockCode} ATR=${atr.toFixed(0)} → 손절 ${stopLossPct.toFixed(1)}%`, { component: 'EXECUTOR' });
        }
      } catch { /* ATR 실패 시 기본값 유지 */ }

      try {
        await chainManager.openChain({
          stockCode,
          mode,
          buyPrice: fill.filledPrice,
          quantity: filledQty,
          targetProfitPct,
          stopLossPct,
          maxAveragingCount: params.maxAveragingCount,
          isPaper: isPaperSnapshot,
        });
      } catch (chainErr) {
        // 체인 생성 실패 = 포지션 추적 불가 → 즉시 경고 (체결은 이미 완료됨)
        logger.error(`🚨 체인 생성 실패 (체결은 완료됨): ${stockCode} ${filledQty}주 @${fill.filledPrice} err=${chainErr}`, { component: 'EXECUTOR' });
        await logSystem('ERROR', 'EXECUTOR', `체인 생성 실패: ${stockCode} ${filledQty}주 @${fill.filledPrice} — fill-reconciler가 복구 필요`);
      }

      // 감시목록 자동 등록 + 종목명 즉시 보정 (코드 저장 후 KRX API로 이름 조회)
      upsertWatchlistItem({ stock_code: stockCode, stock_name: stockCode, market: 'KOSPI' }, 'AUTO')
        .then(() => import('../kis/interest-group.js').then((m) => m.fixWatchlistNames()))
        .catch(() => {});

      // 캐시 무효화 + 푸시 알림
      invalidateStockCache(stockCode).catch(() => {});
      notifyBuy(stockCode, filledQty, fill.filledPrice, reasoning, triggerSource).catch((err) =>
        logger.warn(`알림 발송 오류 (BUY): ${err}`, { component: 'EXECUTOR' })
      );
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
    const isPaperSnapshot = getCtxIsPaper();
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

    // 🚫 손실 중 물타기 AI 검토 — 마이너스 포지션에 추가 매수 시 AI 허락 필요
    const avgBuyPrice = Number(chain.avg_buy_price ?? 0);
    if (avgBuyPrice > 0 && estimatedPrice > 0) {
      const pnlPct = ((estimatedPrice - avgBuyPrice) / avgBuyPrice) * 100;
      if (pnlPct < -0.5) {
        logger.warn(`⚠️ 손실 물타기 감지: ${stockCode} PnL=${pnlPct.toFixed(1)}% avg=${avgBuyPrice}원 → AI 검토`, { component: 'EXECUTOR' });
        try {
          const { checkLargeOrderEntryTiming } = await import('../ai/entry-timing.js');
          const entryCandles = await getDailyChart(stockCode, 20).catch(() => []);
          const entryCheck = await checkLargeOrderEntryTiming(
            stockCode,
            estimatedPrice,
            estimatedPrice * quantity,
            entryCandles,
            `물타기: ${reasoning} [avgBuy:${avgBuyPrice}원 pnl:${pnlPct.toFixed(1)}%]`,
          );
          if (!entryCheck.approved) {
            logger.warn(`🚫 손실 물타기 AI 거부 [${stockCode}]: ${entryCheck.reason}`, { component: 'EXECUTOR' });
            await logSystem('WARN', 'EXECUTOR', `손실 물타기 거부: ${stockCode} PnL=${pnlPct.toFixed(1)}% — ${entryCheck.reason}`);
            return;
          }
          logger.info(`✅ 손실 물타기 AI 승인 [${stockCode} PnL=${pnlPct.toFixed(1)}%]: ${entryCheck.reason}`, { component: 'EXECUTOR' });
        } catch (e) {
          // fail-closed: AI 오류 시 손실 물타기 허용하면 자유낙하 종목에 계속 추가 매수할 위험
          logger.warn(`🚫 손실 물타기 AI 검토 오류 → 차단 (fail-closed): ${stockCode} — ${(e as Error).message}`, { component: 'EXECUTOR' });
          await logSystem('WARN', 'EXECUTOR', `손실 물타기 AI 오류 차단: ${stockCode} PnL=${pnlPct.toFixed(1)}%`);
          return;
        }
      }
    }

    const riskCheck = await riskEngine.validateOrder({
      stockCode,
      side: 'BUY',
      quantity,
      estimatedPrice,
      isPaper: isPaperSnapshot,
    });

    if (!riskCheck.approved) {
      logger.warn(`❌ 물타기 거부 [${stockCode}]: ${riskCheck.reason}`, { component: 'EXECUTOR' });
      return;
    }

    // 스마트 물타기: ask1 지정가 주문 (시장가 슬리피지 방지)
    let smartBuyPrice: number | undefined;
    if (priceType !== 'LIMIT') {
      try {
        const { getOrderbook } = await import('../kis/market.js');
        const book = await getOrderbook(stockCode);
        const ask1 = book[0]?.askPrice ?? 0;
        if (ask1 > 0) {
          smartBuyPrice = ask1;
          logger.info(`💰 스마트 물타기: ${stockCode} ask1=${ask1.toLocaleString()} → 지정가`, { component: 'EXECUTOR' });
        }
      } catch { /* 호가 조회 실패 → 시장가 폴백 */ }
    }

    const result = await this.executeOrder({
      stockCode,
      side: 'BUY',
      quantity,
      price: priceType === 'LIMIT' ? limitPrice : smartBuyPrice,
      chainId: chain.id,
      triggerSource: 'TRACK_B',
      aiReasoning: reasoning,
    });

    if (result.success) {
      const fill = await this.confirmFill(result.orderNo, stockCode, quantity, estimatedPrice);
      if (!fill) {
        logger.error(`체결 미확인 → 물타기 체인 업데이트 보류: ${stockCode}`, { component: 'EXECUTOR' });
        return;
      }
      if (fill.filledQty <= 0) {
        logger.error(`물타기 체결 수량 0 → 업데이트 보류 (주문 거부 또는 미체결): ${stockCode}`, { component: 'EXECUTOR' });
        return;
      }
      const filledQty = Math.min(quantity, fill.filledQty);
      if (filledQty < quantity) {
        logger.warn(`⚠️ 물타기 부분체결 반영: ${stockCode} 요청 ${quantity}주 → 체결 ${filledQty}주`, { component: 'EXECUTOR' });
      }
      await chainManager.addAveraging(chain.id, fill.filledPrice, filledQty);
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

    // 스마트 익절: bid1(매수1호가) 지정가 → 시장가 슬리피지 방지
    let smartSellPrice: number | undefined;
    try {
      const { getOrderbook } = await import('../kis/market.js');
      const book = await getOrderbook(stockCode);
      const bid1 = book[0]?.bidPrice ?? 0;
      if (bid1 > 0) {
        smartSellPrice = bid1;
        logger.info(`💰 스마트 익절: ${stockCode} bid1=${bid1.toLocaleString()} → 지정가`, { component: 'EXECUTOR' });
      }
    } catch { /* 호가 조회 실패 → 시장가 폴백 */ }

    const result = await this.executeOrder({
      stockCode,
      side: 'SELL',
      quantity: safeQty,
      price: smartSellPrice,
      chainId: chain.id,
      triggerSource: 'TRACK_B',
      aiReasoning: reasoning,
    });

    if (result.success) {
      const now = await getCurrentPrice(stockCode).catch(() => null);
      const fallbackPrice = now?.currentPrice ?? (Number(chain.avg_buy_price) || 0);
      const fill = await this.confirmFill(result.orderNo, stockCode, safeQty, fallbackPrice);
      if (!fill) {
        logger.error(`체결 미확인 → 부분익절 체인 업데이트 보류: ${stockCode}`, { component: 'EXECUTOR' });
        return;
      }

      if (fill.filledQty <= 0) {
        logger.error(`부분익절 체결 수량 0 → 체인 업데이트 보류 (주문 거부 또는 미체결): ${stockCode}`, { component: 'EXECUTOR' });
        return;
      }
      const soldQty = Math.min(safeQty, fill.filledQty);
      if (soldQty < safeQty) {
        logger.warn(`⚠️ 부분익절 부분체결 반영: ${stockCode} 요청 ${safeQty}주 → 체결 ${soldQty}주`, { component: 'EXECUTOR' });
      }

      const avgBuy = Number(chain.avg_buy_price) || 0;
      const pnlPct = avgBuy > 0 ? ((fill.filledPrice - avgBuy) / avgBuy) * 100 : 0;
      await chainManager.partialProfit(chain.id, soldQty, fill.filledPrice, chain);
      invalidateStockCache(stockCode).catch(() => {});
      invalidateBalanceCache();
      hardInvalidateDashboardCache();
      notifySell(stockCode, soldQty, fill.filledPrice, pnlPct, reasoning, chain.strategy_mode).catch((err) =>
        logger.warn(`알림 발송 오류 (SELL): ${err}`, { component: 'EXECUTOR' })
      );
    }
  }

  /**
   * 전량 청산 (손절/강제)
   */
  private async executeClose(stockCode: string, reasoning: string, action: string): Promise<void> {
    const chain = await chainManager.findOpenChain(stockCode);
    if (!chain || chain.total_quantity === 0) return;

    // 스마트 매도: 일반 SELL → bid1 지정가, FORCE_CLOSE → 시장가 (확실한 체결 우선)
    let smartSellPrice: number | undefined;
    if (action !== 'FORCE_CLOSE') {
      try {
        const { getOrderbook } = await import('../kis/market.js');
        const book = await getOrderbook(stockCode);
        const bid1 = book[0]?.bidPrice ?? 0;
        if (bid1 > 0) {
          smartSellPrice = bid1;
          logger.info(`💰 스마트 매도: ${stockCode} bid1=${bid1.toLocaleString()} → 지정가`, { component: 'EXECUTOR' });
        }
      } catch { /* 호가 조회 실패 → 시장가 폴백 */ }
    }

    const result = await this.executeOrder({
      stockCode,
      side: 'SELL',
      quantity: chain.total_quantity,
      price: smartSellPrice,
      chainId: chain.id,
      triggerSource: 'TRACK_B',
      aiReasoning: reasoning,
    });

    if (result.success) {
      const now = await getCurrentPrice(stockCode).catch(() => null);
      const fallbackPrice = now?.currentPrice ?? (Number(chain.avg_buy_price) || 0);
      const fill = await this.confirmFill(result.orderNo, stockCode, chain.total_quantity, fallbackPrice);
      if (!fill) {
        logger.error(`체결 미확인 → 청산 체인 업데이트 보류: ${stockCode}`, { component: 'EXECUTOR' });
        return;
      }

      if (fill.filledQty <= 0) {
        logger.error(`청산 체결 수량 0 → 체인 업데이트 보류 (주문 거부 또는 미체결): ${stockCode}`, { component: 'EXECUTOR' });
        return;
      }
      const soldQty = Math.min(chain.total_quantity, fill.filledQty);
      if (soldQty < chain.total_quantity) {
        logger.warn(`⚠️ 전량청산 부분체결 반영: ${stockCode} 요청 ${chain.total_quantity}주 → 체결 ${soldQty}주`, { component: 'EXECUTOR' });
      }

      const closeReason = action === 'FORCE_CLOSE' ? `강제 청산: ${reasoning}` : `매도: ${reasoning}`;
      const avgBuy = Number(chain.avg_buy_price) || 0;
      const pnlKrw = avgBuy > 0 ? Math.round((fill.filledPrice - avgBuy) * soldQty) : 0;
      const pnlPct = avgBuy > 0 ? ((fill.filledPrice - avgBuy) / avgBuy) * 100 : 0;
      if (soldQty >= chain.total_quantity) {
        await chainManager.closeChain(chain.id, fill.filledPrice, chain, closeReason);
      } else {
        await chainManager.partialProfit(chain.id, soldQty, fill.filledPrice, chain);
      }
      invalidateStockCache(stockCode).catch(() => {});
      invalidateBalanceCache();
      hardInvalidateDashboardCache();
      notifySell(stockCode, soldQty, fill.filledPrice, pnlPct, closeReason, chain.strategy_mode).catch((err) =>
        logger.warn(`알림 발송 오류 (CLOSE): ${err}`, { component: 'EXECUTOR' })
      );

      // 체결 감사 로그: 매도 실체결 내역 (why + 실제 수익)
      await logSystem(
        'TRADE',
        'EXECUTOR',
        `SELL ${stockCode} x${soldQty} 체결 @${fill.filledPrice.toLocaleString()}원 | 수익 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${pnlKrw >= 0 ? '+' : ''}${pnlKrw.toLocaleString()}원) | ${closeReason}`,
      );

      // 🍽️ 개장 초단타 용돈 알림: 수익 5만원 이상 시 텔레그램 알림
      if (pnlKrw >= 50000 && reasoning.includes('초단타')) {
        import('../notifications/telegram.js').then(({ sendTelegramMessage }) => {
          sendTelegramMessage(
            `🍽️ *개장 초단타 용돈 벌었습니다!*\n\n` +
            `종목: ${stockCode}\n` +
            `수익: +${pnlKrw.toLocaleString()}원 (+${pnlPct.toFixed(2)}%)\n` +
            `저녁 식사비로 입금 확인해 주세요 😄`,
          );
        }).catch(() => {});
      }
    }
  }

  /** 실제 주문 실행 (Paper / Live 분기) — getCtxIsPaper() 컨텍스트에 따라 라우팅 */
  private async executeOrder(params: {
    stockCode: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    price?: number;
    chainId?: string;
    triggerSource?: string;
    aiReasoning?: string;
  }): Promise<OrderResult> {
    if (getCtxIsPaper()) {
      return paperTradeOrder(params);
    }

    // 장후 시간외 자동 감지 (15:40~16:00 KST → ORD_DVSN '06')
    const kstNow = getKSTNow();
    const kH = kstNow.getUTCHours(), kM = kstNow.getUTCMinutes();
    const isAfterHours = (kH === 15 && kM >= 40) || (kH === 16 && kM === 0);
    const orderType = isAfterHours
      ? OrderType.AFTER_HOURS
      : (params.price ? OrderType.LIMIT : OrderType.MARKET);

    // 실거래 주문
    const result = await placeOrder({
      stockCode: params.stockCode,
      side: params.side,
      quantity: params.quantity,
      price: params.price,
      orderType,
    });

    // DB 기록 — 실패 시에도 주문은 KIS에 전송됨, 반드시 기록 시도
    try {
      await insertOrder({
        chain_id: params.chainId ?? null,
        stock_code: params.stockCode,
        side: params.side,
        order_type: orderType,
        quantity: params.quantity,
        price: params.price ?? null,
        kis_order_no: result.orderNo,
        kis_status: result.success ? 'SUBMITTED' : 'FAILED',
        filled_quantity: 0,
        filled_price: null,
        status: result.success ? 'PENDING' : 'FAILED',
        trading_mode: getCtxIsPaper() ? 'paper' : 'live',
        trigger_source: params.triggerSource ?? null,
        ai_reasoning: params.aiReasoning ?? null,
      });
    } catch (dbErr) {
      // DB 기록 실패 시에도 KIS 주문은 이미 전송됨 — 로그로 추적 가능하게 기록
      logger.error(`🚨 주문 DB 기록 실패 (KIS 주문은 전송됨): ${params.side} ${params.stockCode} x${params.quantity} orderNo=${result.orderNo} err=${dbErr}`, { component: 'EXECUTOR' });
    }

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

  /** 체결 확인 캐시 + 중복주문 키 정리 — 장 마감 시 호출 */
  clearConfirmedOrders(): void {
    const size = this.confirmedOrders.size;
    if (size > 0) {
      this.confirmedOrders.clear();
      logger.info(`🧹 confirmedOrders 캐시 정리: ${size}건`, { component: 'EXECUTOR' });
    }
    // 전날 분 키 잔재 제거 (오늘 날짜 없는 항목)
    const todayPrefix = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const before = this._recentOrderKeys.size;
    for (const key of this._recentOrderKeys) {
      if (!key.includes(todayPrefix)) this._recentOrderKeys.delete(key);
    }
    if (before > 0) logger.info(`🧹 recentOrderKeys 정리: ${before}→${this._recentOrderKeys.size}건`, { component: 'EXECUTOR' });
  }

  private async confirmFill(
    orderNo: string,
    stockCode: string,
    expectedQty: number,
    fallbackPrice: number,
  ): Promise<{ filledQty: number; filledPrice: number } | null> {
    if (getCtxIsPaper()) {
      return { filledQty: expectedQty, filledPrice: roundKrw(fallbackPrice) };
    }

    // 멱등성: 이미 확인된 주문이면 중복 확인 방지
    if (this.confirmedOrders.has(orderNo)) {
      logger.warn(`⚠️ 이미 확인된 주문: ${orderNo} → 스킵`, { component: 'EXECUTOR' });
      return null;
    }

    // 지수 백오프 + jitter(±20%) — 동시 다발 재시도 충돌 방지
    const retryDelays = [3000, 5000, 8000, 15000].map(
      (ms) => ms + Math.floor(Math.random() * ms * 0.2),
    );

    for (let i = 0; i < retryDelays.length; i++) {
      await new Promise((r) => setTimeout(r, retryDelays[i]));

      try {
        const fill = await getOrderFills(orderNo);
        if (fill && fill.filledQty > 0) {
          logger.info(`✅ 체결 확인 (시도 ${i + 1}): ${stockCode} ${fill.filledQty}주 @${fill.filledPrice}`, {
            component: 'EXECUTOR',
          });

          // 멱등성 등록 먼저 (await 전에) → 동시 호출 시 중복 DB 업데이트 방지
          this.confirmedOrders.add(orderNo);
          await updateOrderByKisOrderNo(orderNo, {
            filled_quantity: fill.filledQty,
            filled_price: fill.filledPrice,
            status: fill.filledQty >= fill.orderQty ? 'FILLED' : 'PARTIAL',
            kis_status: 'FILLED',
          });

          return {
            filledQty: fill.filledQty,
            filledPrice: roundKrw(fill.filledPrice || fallbackPrice),
          };
        }

        logger.info(`⏳ 체결 대기 (시도 ${i + 1}/${retryDelays.length}): ${orderNo}`, {
          component: 'EXECUTOR',
        });
      } catch (error) {
        logger.warn(`체결 확인 에러 (시도 ${i + 1}): ${error}`, { component: 'EXECUTOR' });
      }
    }

    // 최종 실패: 미체결 지정가 주문 취소 → 호출측에서 체인 업데이트 보류
    logger.error(`🛑 체결 미확인 (${retryDelays.length}회 시도): ${orderNo} → 주문 취소 시도`, {
      component: 'EXECUTOR',
    });

    // 미체결 지정가 주문 자동 취소 (이미 체결된 시장가면 취소 실패 → 무시)
    try {
      await cancelOrder({ orderNo, stockCode, quantity: expectedQty });
      logger.warn(`🔄 미체결 주문 취소 완료: ${orderNo}`, { component: 'EXECUTOR' });
      await logSystem('WARN', 'EXECUTOR', `미체결 주문 취소: ${orderNo} (${stockCode})`);
    } catch {
      logger.warn(`⚠️ 주문 취소 실패 (이미 체결?): ${orderNo}`, { component: 'EXECUTOR' });
    }

    await logSystem('ERROR', 'EXECUTOR', `체결 미확인: ${orderNo}. 주문 취소 시도 완료. 수동 확인 필요.`);

    const { sendTelegramMessage } = await import('../notifications/telegram.js');
    await sendTelegramMessage(`🛑 체결 미확인 경고!\n주문번호: ${orderNo}\n종목: ${stockCode}\n주문 취소 시도 완료. 수동 확인 필요`);

    return null; // 체결 실패 시그널
  }
}

export const tradeExecutor = new TradeExecutor();
