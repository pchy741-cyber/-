import { checkLargeOrderEntryTiming } from '../ai/entry-timing.js';
import { sma } from '../analysis/moving-averages.js';
import { bollingerBands } from '../analysis/oscillators.js';
import { calcFibonacciLevels, volumeProfile } from '../analysis/patterns.js';
import { PARK_STOCK_CODE } from '../ai/track-b/defense-park.js';
import { setKrPartialTpStageNum } from '../ai/track-b/partial-tp.js';
import { recordSellForCooldown } from '../ai/track-b/sell-cooldown.js';
import { calculateATR } from '../automation/position-sizer.js';
import { hardInvalidateDashboardCache } from '../cache/dashboard-cache.js';
import { getCachedPriceMemory } from '../cache/memory.js';
import { getLastKnownPrice, invalidateStockCache } from '../cache/redis.js';
import { getDynamicDomesticTpSl, OrderType, STRATEGY_PARAMS, type StrategyMode } from '../config/constants.js';
import { getCtxIsPaper, runWithMode } from '../config/context.js';
import { config } from '../config/index.js';
import {
  getActiveStrategy,
  getOpenChains,
  getPool,
  insertOrder,
  isMemoryMode,
  logSystem,
  updateOrderByKisOrderNo,
  upsertWatchlistItem,
} from '../db/client.js';
import type { TradeDecision } from '../db/models.js';
import { getLatestSnapshot } from '../db/repo/snapshots.js';
import { getPositionForStock, invalidateBalanceCache } from '../kis/account.js';
import { getCurrentPrice, getDailyChart, getOrderbook } from '../kis/market.js';
import { cancelOrder, getOrderFills, type OrderResult, placeOrder } from '../kis/order.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { notifyBuy, notifySell } from '../notifications/web-push.js';
import { riskEngine } from '../risk/engine.js';
import { isKillSwitchActiveForMode, reportError, reportSuccess } from '../risk/kill-switch.js';
import { paperTradeOrder } from '../risk/paper.js';
import { type GateInput, runTradeGates } from '../risk/trade-gate.js';
import { isTradingDay } from '../utils/holidays.js';
import { acquireLock } from '../utils/lock.js';
import { logger } from '../utils/logger.js';
import { adjustToTickSize, roundKrw } from '../utils/money.js';
import { getKSTNow } from '../utils/time.js';
import { registerBuyIntent, releaseBuyIntent } from './buy-intent.js';
import { chainManager } from './chain.js';
import { registerPendingOrder } from './pending-order-manager.js';
import { cancelWatchdogTpOrder, startWatchdog } from './post-fill-watchdog.js';

/**
 * 매매 실행기 (Trade Executor)
 * - 모든 매매의 단일 진입점
 * - AI 판단 → 리스크 검증 → 주문 → 체결 확인 → 체인 업데이트
 */
export class TradeExecutor {
  // (종목코드)-(YYYYMMDDHHMM) 키로 분당 1회 중복 주문 방지 (5분 후 자동 정리)
  private readonly _recentOrderKeys = new Set<string>();
  private _lastKeyCleanup = Date.now();
  // 🔒 청산 실패 카운터: 연속 실패 시 무한 루프 방지 (key: "mode-stockCode")
  private readonly _closeFailCount = new Map<string, number>();
  // 🔒 청산 실패 백오프: 반복 실패 시 다음 재시도 가능 시각 (key: "mode-stockCode")
  private readonly _closeFailBackoff = new Map<string, number>();
  // 🔒 매수 거부 쿨다운: 현금 부족 등 거부 시 10분간 동일 종목 재시도 억제
  private readonly _buyRejectCooldown = new Map<string, number>();
  // v9: 진행 중 매수 카운터 — 포지션 한도 경쟁조건 방지 (paper/live 분리)
  // 체크 시 DB 포지션 + 진행 중 매수 수를 합산하여 한도 검사
  private _pendingBuyCount = { paper: 0, live: 0 };
  private _getPendingKey(): 'paper' | 'live' {
    return getCtxIsPaper() ? 'paper' : 'live';
  }

  /** logSystem fire-and-forget — DB 로그 실패가 매매 실행을 블록하지 않도록 */
  private _logFire(level: 'ERROR' | 'WARN' | 'INFO' | 'TRADE', component: string, message: string): void {
    logSystem(level, component, message).catch((e) =>
      logger.debug(`logSystem DB 기록 실패: ${e}`, { component: 'EXECUTOR' }),
    );
  }

  /**
   * 일일 서킷브레이커: 당일 총자산 -2% 이하 시 신규 매수 전면 차단
   * - 기존 포지션 SL/TP/TrailingStop 청산은 영향 없음 (매도만 차단 안 함)
   * - 판단 기준: 오늘 최신 스냅샷의 daily_pnl_pct
   * - 스냅샷 없으면 차단 안 함 (장 시작 직후 첫 스냅샷 전)
   * @returns true = 서킷브레이커 발동 (매수 차단)
   */
  private async _checkDailyCircuitBreaker(): Promise<boolean> {
    const DAILY_LOSS_LIMIT = getCtxIsPaper() ? -10.0 : -7.0; // Live -7%: -5%는 정상 변동성에도 발동 → 회복 매수 차단
    try {
      const isPaper = getCtxIsPaper();
      const latest = await getLatestSnapshot(isPaper);
      if (!latest) return false; // 스냅샷 없음 → 차단 안 함

      const dailyPnlPct = Number(latest.daily_pnl_pct ?? 0);
      if (dailyPnlPct <= DAILY_LOSS_LIMIT) {
        const modeTag = isPaper ? '🧪PAPER' : '💰LIVE';
        logger.warn(
          `🚨 [${modeTag}] 일일 서킷브레이커 발동: 당일 손실 ${dailyPnlPct.toFixed(2)}% ≤ ${DAILY_LOSS_LIMIT}% → 신규 매수 전면 차단 (장 마감까지 유지)`,
          { component: 'CIRCUIT_BREAKER' },
        );
        this._logFire(
          'WARN',
          'CIRCUIT_BREAKER',
          `일일 손실 한도 초과: ${dailyPnlPct.toFixed(2)}% ≤ ${DAILY_LOSS_LIMIT}% — 신규 매수 차단`,
        );
        return true;
      }
      return false;
    } catch (e) {
      // v17: live=fail-closed (안전), paper=fail-open (가용성)
      const failClosed = !getCtxIsPaper();
      logger.warn(`서킷브레이커 체크 실패 → ${failClosed ? '매수 차단 (fail-closed)' : '매수 허용 (fail-open)'}: ${(e as Error).message}`, {
        component: 'CIRCUIT_BREAKER',
      });
      return failClosed;
    }
  }

  private _minuteKey(stockCode: string, action: string): string {
    const now = getKSTNow();
    const ymd = now.toISOString().slice(0, 16).replace(/[-:T]/g, ''); // YYYYMMDDHHmm (KST)
    // 5분마다 이전 분 키만 정리 (현재 분 키 보존 — 전체 clear 시 동일 분 중복 허용 버그 방지)
    if (now.getTime() - this._lastKeyCleanup > 5 * 60_000) {
      for (const key of this._recentOrderKeys) {
        if (!key.includes(ymd)) this._recentOrderKeys.delete(key);
      }
      this._lastKeyCleanup = now.getTime();
    }
    // v26: hard cap 10,000 (메모리 누수 방지)
    if (this._recentOrderKeys.size > 10_000) {
      const arr = [...this._recentOrderKeys];
      this._recentOrderKeys.clear();
      for (const k of arr.slice(-8_000)) this._recentOrderKeys.add(k);
    }
    const mode = getCtxIsPaper() ? 'paper' : 'live';
    return `${mode}-${stockCode}-${action}-${ymd}`;
  }

  /**
   * AI 결정 배열을 일괄 처리
   * @param source 매수 출처 라벨 (TRACK_B, SNIPER, OPENING_BELL, AFTER_HOURS 등)
   */
  async processDecisions(decisions: TradeDecision[], mode: StrategyMode, source?: string): Promise<void> {
    // v10.7: 매도 먼저 순차실행 (현금 확보) → 매수는 종목별 병렬 (슬리피지 최소화)
    const sells = decisions.filter((d) => ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action));
    const buys = decisions.filter((d) => d.action === 'BUY' || d.action === 'AVERAGE_DOWN');
    const others = decisions.filter((d) => !sells.includes(d) && !buys.includes(d));

    // v16.1: 매도 병렬화 — 서로 다른 종목은 동시 실행 (딜레이 최적화)
    // 같은 종목 PARTIAL_SELL→SELL 같은 경우만 순차 (체인 상태 의존)
    const justSoldCodes = new Set<string>();
    const sellOthers = [...sells, ...others];
    if (sellOthers.length > 0) {
      const results = await Promise.allSettled(
        sellOthers.map(async (decision) => {
          try {
            await this.executeDecision(decision, mode);
            reportSuccess();
            if (sells.includes(decision)) justSoldCodes.add(decision.stock_code);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`주문 실행 실패 [${decision.stock_code}]: ${msg}`, { component: 'EXECUTOR' });
            await reportError('EXECUTOR', msg);
            this._logFire('ERROR', 'EXECUTOR', `실행 실패: ${decision.stock_code} - ${msg}`);
          }
        }),
      );
      // 실패 건수 로깅
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) logger.warn(`매도 ${failed}건 실패`, { component: 'EXECUTOR' });
    }

    // 매수: 종목별 병렬 실행 (서로 다른 종목은 동시 주문 가능)
    // 일일 서킷브레이커: 당일 -2% 초과 손실 시 신규 매수 전면 차단
    if (buys.length > 0 && (await this._checkDailyCircuitBreaker())) {
      return;
    }

    // ── C2 중앙 안전장치: 모든 매수 경로 통합 차단 (executor 레벨) ──────
    if (buys.length > 0) {
      const isPaper = getCtxIsPaper();
      const modeTag = isPaper ? '🧪PAPER' : '💰LIVE';

      // (0) Live 매수 수동 차단 플래그 — system_state.live_buy_disabled = 'true'
      if (!isPaper) {
        try {
          const { rows } = await getPool().query(`SELECT value FROM system_state WHERE key = 'live_buy_disabled'`);
          if (rows[0]?.value === 'true') {
            logger.info(`🔒 [${modeTag}] Live 매수 수동 차단 → ${buys.length}건 스킵 (system_state 플래그)`, { component: 'EXECUTOR' });
            return;
          }
        } catch { /* non-critical */ }
      }

      // (1) 연속손실 8회+ halt — Live: 완전 차단, Paper: 50% 축소는 sizer에서 처리
      if (!isPaper) {
        try {
          const { getLossStreakMultiplier } = await import('../risk/loss-streak.js');
          const lsMult = await getLossStreakMultiplier(false);
          if (lsMult <= 0) {
            logger.warn(`🛑 [${modeTag}] 연속손실 HALT → 전체 매수 ${buys.length}건 차단 (executor 중앙 가드)`, { component: 'EXECUTOR' });
            return;
          }
        } catch { /* non-critical */ }
      }

      // (2) 승률 45% 미만 가드 — Live만, 최소 샘플 8건 이상
      if (!isPaper) {
        try {
          const { isKrWinRateBelowThreshold } = await import('../risk/win-rate-guard.js');
          if (await isKrWinRateBelowThreshold(0.45)) {
            logger.warn(`⛔ [${modeTag}] 승률 가드 → 전체 매수 ${buys.length}건 차단 (executor 중앙 가드)`, { component: 'EXECUTOR' });
            return;
          }
        } catch { /* non-critical */ }
      }
    }

    // 즉시 반전 방지: 같은 사이클에서 매도된 종목은 재매수 차단 (수수료 이중 손실 방지)
    const buyList = justSoldCodes.size > 0 ? buys.filter((b) => {
      if (justSoldCodes.has(b.stock_code)) {
        const modeTag = getCtxIsPaper() ? '🧪PAPER' : '💰LIVE';
        logger.warn(`⏳ [${modeTag}] 즉시 반전 차단: ${b.stock_code} (같은 사이클 매도됨)`, { component: 'EXECUTOR' });
        return false;
      }
      return true;
    }) : buys;
    if (buyList.length > 0) {
      await Promise.allSettled(
        buyList.map(async (decision) => {
          const intentSource = decision.trigger_source ?? source ?? mode;
          if (!registerBuyIntent(decision.stock_code, intentSource)) return;
          try {
            await this.executeDecision(decision, mode);
            reportSuccess();
          } catch (error) {
            releaseBuyIntent(decision.stock_code);
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`주문 실행 실패 [${decision.stock_code}]: ${msg}`, { component: 'EXECUTOR' });
            await reportError('EXECUTOR', msg);
            this._logFire('ERROR', 'EXECUTOR', `실행 실패: ${decision.stock_code} - ${msg}`);
          }
        }),
      );
    }
    // 오래된 키 정리 — 현재 분 키만 남기고 이전 분 삭제 (전체 삭제 시 동일 분 중복 허용 버그 방지)
    if (this._recentOrderKeys.size > 200) {
      const currentMinute = getKSTNow().toISOString().slice(0, 16).replace(/[-:T]/g, '');
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
      this._logFire('WARN', 'EXECUTOR', `수량 0 스킵: ${action} ${stock_code}`);
      return;
    }

    // v28: 최소 주문금액 1만원 — 몇십원/몇백원 단위 의미없는 주문 차단
    const MIN_ORDER_KRW = 10_000;
    const estimatedAmount = (limit_price ?? 0) * quantity;
    if (estimatedAmount > 0 && estimatedAmount < MIN_ORDER_KRW && action !== 'FORCE_CLOSE') {
      logger.info(
        `⛔ 최소금액 미달 → 스킵: ${action} ${stock_code} ${quantity}주 × ${limit_price}원 = ${estimatedAmount.toLocaleString()}원 < ${MIN_ORDER_KRW.toLocaleString()}원`,
        { component: 'EXECUTOR' },
      );
      return;
    }

    // 분당 1회 중복 주문 가드 (같은 종목 같은 분에 매수/매도 2번 방지)
    const minuteKey = this._minuteKey(stock_code, action);
    if (this._recentOrderKeys.has(minuteKey)) {
      const dupModeTag = getCtxIsPaper() ? '🧪PAPER' : '💰LIVE';
      logger.warn(`⏳ [${dupModeTag}] 분당 중복 주문 차단: ${action} ${stock_code} (이미 이 분에 처리됨)`, {
        component: 'EXECUTOR',
      });
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
      const modeTag = getCtxIsPaper() ? '🧪PAPER' : '💰LIVE';

      // 🔒 LIVE 모드: 장 비영업일(주말/공휴일)이면 전체 주문 스킵
      if (!getCtxIsPaper() && !isTradingDay()) {
        logger.debug(`⏳ 장 비영업일 → 주문 스킵: ${action} ${stock_code}`, { component: 'EXECUTOR' });
        return;
      }

      logger.info(`▶ [${modeTag}] 실행: ${action} ${stock_code} x${quantity}`, { component: 'EXECUTOR' });

      // per-decision 모드 오버라이드 (BOTTOM_FISHING 등)
      const effectiveMode =
        decision.strategy_mode && decision.strategy_mode in STRATEGY_PARAMS
          ? (decision.strategy_mode as StrategyMode)
          : mode;

      const tpSlHints: import('../config/constants.js').DomesticTpSlHints | undefined = decision.ai_score
        ? {
            score: decision.ai_score,
            confidence: decision.confidence,
            rsi: decision.rsi,
            volumeRatio: decision.volume_ratio,
            pullbackSignal: decision.pullback_signal,
            envelopePos: decision.envelope_pos,
          }
        : undefined;

      switch (action) {
        case 'BUY':
          await this.executeBuy(
            stock_code,
            quantity,
            price_type,
            limit_price,
            effectiveMode,
            reasoning,
            decision.ai_score,
            tpSlHints,
            trigger_source,
          );
          break;
        case 'AVERAGE_DOWN':
          await this.executeAverageDown(stock_code, quantity, price_type, limit_price, reasoning);
          break;
        case 'PARTIAL_SELL':
          await this.executePartialSell(stock_code, quantity, reasoning, decision.partial_tp_stage);
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

    // 🔒 매수 거부 쿨다운: 현금 부족 등으로 거부된 종목 10분간 재시도 억제
    const cooldownKey = `${isPaperSnapshot ? 'paper' : 'live'}-${stockCode}`;
    const cooldownUntil = this._buyRejectCooldown.get(cooldownKey) ?? 0;
    if (Date.now() < cooldownUntil) {
      releaseBuyIntent(stockCode);
      return; // 쿨다운 기간 — 조용히 스킵
    }

    // 이미 열린 체인이 있으면 물타기로 전환
    // v16.2.3: 명시적 isPaper 전달 (컨텍스트 의존 제거 → Paper/Live 체인 혼선 방지)
    const existingChain = await chainManager.findOpenChain(stockCode, isPaperSnapshot);
    if (existingChain) {
      releaseBuyIntent(stockCode); // 물타기는 별도 intent 관리 — 여기서 해제
      logger.info(`이미 열린 체인 존재 → 물타기로 전환`, { component: 'EXECUTOR' });
      await this.executeAverageDown(stockCode, quantity, priceType, limitPrice, reasoning);
      return;
    }

    // v17: 원자적 포지션 한도 체크 — DB 조회 전 slot 선점(optimistic lock)으로 race condition 제거
    const pk = this._getPendingKey();
    this._pendingBuyCount[pk]++; // 먼저 슬롯 선점
    const allOpenChains = await getOpenChains(getCtxIsPaper());
    const effectiveCount = allOpenChains.length + this._pendingBuyCount[pk];
    if (effectiveCount > config.risk.maxConcurrentPositions) {
      this._pendingBuyCount[pk]--; // 슬롯 반환
      releaseBuyIntent(stockCode);
      logger.warn(
        `⛔ 동시 포지션 한도 초과 (${effectiveCount}/${config.risk.maxConcurrentPositions}, pending=${this._pendingBuyCount[pk]}) → 신규 매수 차단: ${stockCode}`,
        { component: 'EXECUTOR' },
      );
      this._logFire(
        'WARN',
        'EXECUTOR',
        `포지션 한도 초과: ${effectiveCount}/${config.risk.maxConcurrentPositions} — ${stockCode} 신규 매수 차단`,
      );
      return;
    }
    try {
      // v9: 모든 exit path에서 _pendingBuyCount 감소 보장

      // 가격 우선순위: limit_price(파이프라인) → 메모리캐시 → Redis캐시 → KIS API
      let estimatedPrice = limitPrice ?? 0;
      if (!estimatedPrice) {
        // 캐시 우선: 메모리 → Redis (대부분 50ms 이내 응답)
        estimatedPrice = getCachedPriceMemory(stockCode) ?? (await getLastKnownPrice(stockCode)) ?? 0;
        if (estimatedPrice > 0) {
          logger.info(`💰 캐시 가격 사용: ${stockCode} = ${estimatedPrice}원`, { component: 'EXECUTOR' });
        }

        // 캐시 miss → KIS API fallback
        if (!estimatedPrice || estimatedPrice <= 0) {
          const priceData = await getCurrentPrice(stockCode).catch(() => null);
          estimatedPrice = priceData?.currentPrice ?? 0;
        }
      }

      if (!estimatedPrice || estimatedPrice <= 0) {
        releaseBuyIntent(stockCode);
        logger.warn(`⛔ 현재가+캐시 모두 0 → 매수 스킵: ${stockCode}`, { component: 'EXECUTOR' });
        this._logFire('WARN', 'EXECUTOR', `매수 스킵: ${stockCode} - 현재가 조회 실패 (0원)`);
        return;
      }

      // 🚦 매매 게이트 (차트검수 + 확률교정 + 변동성사이징 + 레짐필터 + 쿨다운)
      // ETF 파킹 / 바닥낚시 종목은 게이트 생략 (스캐너가 이미 검증 or 차트 분석 불필요)
      const ETF_PARK_CODES = [PARK_STOCK_CODE, '114800', '252670', '251340']; // 파킹ETF: SOFR금리액티브,KODEX200인버스,KODEX200선물인버스2X,TIGER인버스
      // CASH_PARKING/ETF: cash-manager·포트폴리오 검증 완료 — 인트라데이 게이트 불필요
      // BOTTOM_FISHING은 리스크 검증 필요 (포지션 한도·손실 한도 우회 방지)
      const skipGates = ETF_PARK_CODES.includes(stockCode) || triggerSource === 'CASH_PARKING';

      // ScaleIn 3분할: 비ETF·수량 3 이상일 때 1/3 즉시 진입 + 2/3 지연 분할
      // (계획된 분할진입 → 물타기 횟수 제한·손실 AI 검토 우회)
      const useScaleIn = !skipGates && quantity >= 3;
      const firstTranche = useScaleIn ? Math.ceil(quantity / 3) : quantity;
      const secondTranche = useScaleIn ? Math.floor(quantity / 3) : 0;
      const thirdTranche = useScaleIn ? quantity - firstTranche - secondTranche : 0;
      // ScaleIn 2/3차는 executeAverageDown→addAveraging을 거치며 max_averaging_count 가드에 걸림.
      // 계획된 분할진입은 진짜 물타기가 아니므로 가드에서 제외되도록 카운트를 미리 확보 (투자금 불일치 버그 수정)
      const scaleInTrancheCount = (secondTranche > 0 ? 1 : 0) + (thirdTranche > 0 ? 1 : 0);

      const params = STRATEGY_PARAMS[mode] ?? STRATEGY_PARAMS.SWING;
      if (!STRATEGY_PARAMS[mode]) {
        logger.warn(`⚠️ 알 수 없는 전략 모드 "${mode}" → SWING 폴백 적용`, { component: 'EXECUTOR' });
      }
      let gatedQuantity = firstTranche;
      if (skipGates) {
        const skipModeTag = getCtxIsPaper() ? '🧪PAPER' : '💰LIVE';
        logger.info(`⏭️ [${skipModeTag}] 게이트 생략 (ETF파킹/현금파킹): ${stockCode} → 직접 주문`, {
          component: 'EXECUTOR',
        });
      } else
        try {
          const candles = await getDailyChart(stockCode, 65).catch(() => []);
          const gateInput: GateInput = {
            stockCode,
            action: 'BUY',
            quantity,
            estimatedPrice,
            candles: candles.map((c) => ({
              date: c.date,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
            })),
            strategyMode: mode,
            stopLossPct: params.stopLossPct,
            takeProfitPct: params.takeProfitPct,
            budgetKrw: estimatedPrice * quantity,
          };
          const gateResult = await runTradeGates(gateInput);
          if (!gateResult.passed) {
            releaseBuyIntent(stockCode);
            logger.warn(`🚦 게이트 차단 [${stockCode}]: ${gateResult.reason}`, { component: 'EXECUTOR' });
            this._logFire('WARN', 'TRADE_GATE', `매수 차단: ${stockCode} - ${gateResult.reason}`);
            return;
          }
          gatedQuantity = gateResult.adjustedQuantity ?? firstTranche;
        } catch (e) {
          const errMsg = (e as Error).message;
          // fail-closed: 게이트 장애 시 매수 허용하면 리스크 통제 우회 — 차단이 안전
          releaseBuyIntent(stockCode);
          logger.warn(`게이트 에러 (매수 차단): ${errMsg}`, { component: 'EXECUTOR' });
          this._logFire('WARN', 'EXECUTOR', `게이트 오류 (차단): ${stockCode} - ${errMsg}`);
          return;
        }

      // 리스크 체크 (ETF 파킹: Kill Switch + 포지션 상한만 확인)
      if (skipGates) {
        if (isKillSwitchActiveForMode('KR', isPaperSnapshot)) {
          releaseBuyIntent(stockCode);
          logger.warn(`🛑 Kill Switch 활성 → ETF 파킹 스킵: ${stockCode}`, { component: 'EXECUTOR' });
          return;
        }
        // 파킹도 단일 포지션 상한 검증 (과도한 익스포저 방지)
        const positionKrw = estimatedPrice * gatedQuantity;
        if (positionKrw > config.risk.maxPositionKrw * 1.5) {
          const capped = Math.floor((config.risk.maxPositionKrw * 1.5) / estimatedPrice);
          if (capped <= 0) { releaseBuyIntent(stockCode); return; }
          logger.warn(`📊 파킹 포지션 캡: ${gatedQuantity}→${capped}주 (상한 ${Math.round(config.risk.maxPositionKrw * 1.5 / 10000)}만원)`, { component: 'EXECUTOR' });
          gatedQuantity = capped;
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
          this._logFire('WARN', 'EXECUTOR', `매수 거부: ${stockCode} - ${riskCheck.reason}`);
          // 현금 부족/MDD 등 하드블록 → 10분 쿨다운 (동일 거부 로그 스팸 방지)
          this._buyRejectCooldown.set(cooldownKey, Date.now() + 10 * 60_000);
          return;
        }
        // v16: 리스크 소프트 사이즈 조절 (하드블록 → 비중 축소)
        if (riskCheck.sizeMultiplier && riskCheck.sizeMultiplier < 1.0) {
          const adjusted = Math.max(1, Math.floor(gatedQuantity * riskCheck.sizeMultiplier));
          logger.info(`📊 리스크 사이즈: ${gatedQuantity}→${adjusted}주 (${(riskCheck.sizeMultiplier * 100).toFixed(0)}%) — ${riskCheck.reason}`, { component: 'EXECUTOR' });
          gatedQuantity = adjusted;
        }
      }

      // v28: 스마트 집행 — 비ETF + 비방어 + 금액 30만+ → 상태머신
      const orderAmountKrw = estimatedPrice * gatedQuantity;
      // v29 이중주문 버그 수정: 스마트집행 성공 시 체결 저장 → 이후 대형게이트/호가계산/executeOrder 전부 스킵(더블매수 방지).
      let smartFill: { filledQty: number; filledPrice: number; orderNo: string } | null = null;
      if (!skipGates && orderAmountKrw >= 300_000) {
        try {
          const { smartExecuteBuy, checkLiquidityGate } = await import('./execution-engine.js');
          const execResult = await smartExecuteBuy({
            stockCode,
            quantity: gatedQuantity,
            estimatedPrice,
            isPaper: isPaperSnapshot,
            strategyMode: mode,
            expectedTpPct: STRATEGY_PARAMS[mode]?.takeProfitPct ?? 5,
          });
          if (execResult.skippedReason) {
            releaseBuyIntent(stockCode);
            logger.warn(`🚧 유동성 게이트 차단 [${stockCode}]: ${execResult.skippedReason}`, { component: 'EXECUTOR' });
            this._logFire('WARN', 'LIQUIDITY_GATE', `차단: ${stockCode} reason=${execResult.skippedReason}`);
            return;
          }
          if (!execResult.success) {
            releaseBuyIntent(stockCode);
            logger.warn(`❌ 스마트 집행 실패 [${stockCode}]: chase=${execResult.chaseCount}`, { component: 'EXECUTOR' });
            return;
          }
          // v29: 스마트 집행 성공 → 체결 저장. 아래 대형게이트/호가계산/executeOrder 전부 스킵하고 이 체결로 체인 생성.
          smartFill = { filledQty: execResult.filledQty, filledPrice: execResult.filledPrice, orderNo: execResult.orderNo };
          logger.info(
            `✅ 스마트 집행 성공: ${stockCode} ${execResult.filledQty}주 @${execResult.filledPrice} chase=${execResult.chaseCount} ${execResult.elapsed_ms}ms`,
            { component: 'EXECUTOR' },
          );
        } catch (smartErr) {
          // fail-open: 스마트 집행 실패 시 기존 로직으로 폴백
          logger.warn(`스마트 집행 오류 → 기존 로직 폴백: ${stockCode} ${smartErr}`, { component: 'EXECUTOR' });
        }
      }

      // 🎯 대형 주문 진입타이밍 AI 검토 (100만원 이상, ETF 파킹/바닥낚시 제외). v29: 스마트 이미 체결 시 스킵(고아포지션 방지).
      if (!skipGates && !smartFill && orderAmountKrw >= 1_000_000) {
        try {
          const entryCandles = await getDailyChart(stockCode, 20).catch(() => []);
          const entryCheck = await checkLargeOrderEntryTiming(
            stockCode,
            estimatedPrice,
            orderAmountKrw,
            entryCandles,
            reasoning,
          );
          if (!entryCheck.approved) {
            releaseBuyIntent(stockCode);
            logger.warn(
              `🎯 진입타이밍 AI 거부 [${stockCode} ${Math.round(orderAmountKrw / 10000)}만원]: ${entryCheck.reason}`,
              { component: 'EXECUTOR' },
            );
            this._logFire(
              'WARN',
              'ENTRY_TIMING',
              `대형주문 진입거부: ${stockCode} ${Math.round(orderAmountKrw / 10000)}만원 — ${entryCheck.reason}`,
            );
            return;
          }
        } catch (aiTimingErr) {
          /* fail-closed: AI 타이밍 서비스 장애 시 대형주문 차단 (안전 우선) */
          releaseBuyIntent(stockCode);
          logger.error(
            `🛑 진입타이밍 AI 장애로 대형주문 차단 [${stockCode} ${Math.round(orderAmountKrw / 10000)}만원]: ${(aiTimingErr as Error).message ?? aiTimingErr}`,
            { component: 'EXECUTOR' },
          );
          this._logFire(
            'ERROR',
            'ENTRY_TIMING',
            `AI 타이밍 서비스 장애 — 대형주문 차단 (fail-closed): ${stockCode} ${Math.round(orderAmountKrw / 10000)}만원`,
          );
          return;
        }
      }

      // 호가 진입 타이밍 — ask2 이하일 때만 매수 (ETF 파킹/바닥낚시 제외 — 시간외 단일가는 호가 무의미)
      // v10: 예약매수 — bid1~ask1 중간가 지정가 주문 (기존 ask1 → mid 가격으로 개선)
      // v16.3: 고확신 모멘텀 종목은 시장가 유지 (스마트매수 지정가 변환 시 체결률 저하 방지)
      // v18: Paper 모드도 지지선매수 적용 (단순 시장가 → 스마트 진입)
      const isHighConviction = (aiScore ?? 0) >= 85 && (tpSlHints?.confidence ?? 0) >= 0.7;
      let smartBuyPrice: number | undefined;
      if (!skipGates && !smartFill) {
        try {
          const book = await getOrderbook(stockCode);
          const ask1 = book[0]?.askPrice ?? 0;
          const ask2 = book[1]?.askPrice ?? 0;
          const bid1 = book[0]?.bidPrice ?? 0;
          if (ask1 > 0 && ask2 > 0 && estimatedPrice > ask2) {
            if (isHighConviction) {
              // 고확신 모멘텀: ask2 초과해도 수량 50% 축소 후 지지선 매수 (v18: 시장가→지지선)
              gatedQuantity = Math.max(1, Math.floor(gatedQuantity * 0.5));
              if (bid1 > 0) {
                const support = await calcSupportBuyPrice(stockCode, estimatedPrice, bid1, ask1);
                smartBuyPrice = support.price;
                logger.info(
                  `🚀 모멘텀 지지선진입: ${stockCode} 현재가 ${estimatedPrice} > ask2 ${ask2} — 수량 50%→${gatedQuantity}주, 지지선=${smartBuyPrice.toLocaleString()} [${support.reasoning}]`,
                  { component: 'EXECUTOR' },
                );
              } else {
                logger.info(
                  `🚀 모멘텀 진입: ${stockCode} 현재가 ${estimatedPrice} > ask2 ${ask2} — 수량 50% 축소(${gatedQuantity}주), 시장가`,
                  { component: 'EXECUTOR' },
                );
              }
            } else {
              releaseBuyIntent(stockCode);
              logger.warn(`⏸️ 호가 진입 보류: ${stockCode} 현재가 ${estimatedPrice} > ask2 ${ask2} — 스킵`, {
                component: 'EXECUTOR',
              });
              this._logFire('WARN', 'EXECUTOR', `호가 진입 보류: ${stockCode} 현재가=${estimatedPrice} ask2=${ask2}`);
              return;
            }
          } else if (bid1 > 0 && ask1 > 0) {
            // v18: 모든 종목에 지지선 매수 적용 (고확신 포함 — 더 좋은 진입가 확보)
            const support = await calcSupportBuyPrice(stockCode, estimatedPrice, bid1, ask1);
            smartBuyPrice = support.price;
            logger.info(
              `💰 지지선매수: ${stockCode} bid1=${bid1.toLocaleString()} support=${smartBuyPrice.toLocaleString()} ask1=${ask1.toLocaleString()} [${support.reasoning}]`,
              { component: 'EXECUTOR' },
            );
          } else if (ask1 > 0) {
            smartBuyPrice = ask1;
            logger.info(`💰 스마트 매수: ${stockCode} ask1=${ask1.toLocaleString()} → 지정가 폴백`, {
              component: 'EXECUTOR',
            });
          }
        } catch (e) {
          logger.warn(`호가 조회 실패 → 시장가 폴백: ${stockCode} ${(e as Error).message}`, { component: 'EXECUTOR' });
        }
      }

      // smartBuyPrice=0 방어: 시장가 폴백 (penny stock 등 비정상 호가)
      if (smartBuyPrice !== undefined && smartBuyPrice <= 0) smartBuyPrice = undefined;

      // 주문 실행 (지정가 우선 → 호가 없으면 시장가 폴백). v29: 스마트집행 이미 체결 시 재주문 금지(더블매수 방지).
      let fill: { filledQty: number; filledPrice: number; orderNo: string } | null;
      if (smartFill) {
        fill = smartFill;
        logger.info(`✅ 스마트 체결 사용(재주문 스킵): ${stockCode} ${fill.filledQty}주 @${fill.filledPrice}`, { component: 'EXECUTOR' });
      } else {
        const result = await this.executeOrder({
          stockCode,
          side: 'BUY',
          quantity: gatedQuantity,
          price: priceType === 'LIMIT' ? limitPrice : smartBuyPrice,
          triggerSource: triggerSource ?? 'TRACK_B',
          aiReasoning: reasoning,
          isPaper: isPaperSnapshot,
        });
        if (!result.success) {
          releaseBuyIntent(stockCode);
          return;
        }
        const cf = await this.confirmFill(result.orderNo, stockCode, gatedQuantity, estimatedPrice);
        fill = cf ? { ...cf, orderNo: result.orderNo } : null;
      }

      {
        if (!fill) {
          releaseBuyIntent(stockCode);
          logger.error(`체결 미확인 → 체인 생성 보류: ${stockCode}`, { component: 'EXECUTOR' });
          return;
        }
        if (fill.filledQty <= 0) {
          releaseBuyIntent(stockCode);
          logger.error(`매수 체결 수량 0 → 체인 생성 보류 (주문 거부 또는 미체결): ${stockCode}`, {
            component: 'EXECUTOR',
          });
          return;
        }
        const filledQty = Math.min(gatedQuantity, fill.filledQty);
        if (filledQty < gatedQuantity) {
          logger.warn(`⚠️ 매수 부분체결 반영: ${stockCode} 요청 ${gatedQuantity}주 → 체결 ${filledQty}주`, {
            component: 'EXECUTOR',
          });
        }

        // 동적 TP/SL: 항상 다팩터 엔진 사용 (v4: 플래그 폐지 → 해외와 동등)
        // 팩터: AI score + ADX + ATR + RSI + 거래량 + 시장레짐 + 수급
        const dbStrategy = await getActiveStrategy().catch(() => null);
        let scoreParams: { takeProfitPct: number; stopLossPct: number } | null = null;
        if (aiScore && aiScore >= 60) {
          // 자기학습 피드백: strategy_config에 학습된 TP/SL → 30% 블렌딩
          const learnedTp = dbStrategy?.take_profit_pct;
          const learnedSl = dbStrategy?.stop_loss_pct;
          const dyn = getDynamicDomesticTpSl({ ...tpSlHints, score: aiScore, learnedTp, learnedSl });
          scoreParams = { takeProfitPct: dyn.takeProfitPct, stopLossPct: dyn.stopLossPct };
          logger.info(
            `🎯 동적 TP/SL [${dyn.label}]: score=${aiScore} → TP ${dyn.takeProfitPct}% / SL ${dyn.stopLossPct}%`,
            { component: 'EXECUTOR' },
          );
        }
        let targetProfitPct = scoreParams?.takeProfitPct ?? dbStrategy?.take_profit_pct ?? params.takeProfitPct;
        let stopLossPct = scoreParams?.stopLossPct ?? dbStrategy?.stop_loss_pct ?? params.stopLossPct;

        // ATR 기반 동적 손절 — 전략 손절폭보다 넓어지지 않도록 캡 적용
        try {
          const atr = await calculateATR(stockCode);
          if (atr > 0 && fill.filledPrice > 0) {
            // v23: Chandelier Exit 방식 — ATR 3x (근거: 승률 51.3%, PF 1.61 vs ATR 2x 43%/1.34)
            // 출처: stratbase.ai Chandelier Exit backtest, arxiv:2604.27150
            const atrStopPct = -((atr * 3.0) / fill.filledPrice) * 100;
            // v23: SL 바닥 -4.5% (한국 중소형주 일중 변동 3-5%, -3.5%도 노이즈에 걸림)
            stopLossPct = Math.max(stopLossPct, Math.min(-4.5, atrStopPct));
            logger.info(`ATR 동적 손절: ${stockCode} ATR=${atr.toFixed(0)} → 손절 ${stopLossPct.toFixed(1)}%`, {
              component: 'EXECUTOR',
            });
          }
        } catch (e) {
          logger.warn(`ATR 계산 실패 → 기본 손절값 유지: ${stockCode} ${(e as Error).message}`, {
            component: 'EXECUTOR',
          });
        }

        // 1:2 손익비 보장: TP < 2 × |SL| 시 TP 상향 조정
        const minTp = 2 * Math.abs(stopLossPct);
        if (targetProfitPct < minTp) {
          logger.warn(
            `⚠️ 손익비 미달: ${stockCode} TP=${targetProfitPct.toFixed(1)}% SL=${stopLossPct.toFixed(1)}% → TP ${minTp.toFixed(1)}%로 상향`,
            { component: 'EXECUTOR' },
          );
          targetProfitPct = minTp;
        }

        // 체인 생성 (3회 재시도 — 고아 포지션 방지)
        let chainCreated = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const chainId = await chainManager.openChain({
              stockCode,
              mode,
              buyPrice: fill.filledPrice,
              quantity: filledQty,
              targetProfitPct,
              stopLossPct,
              maxAveragingCount: params.maxAveragingCount + (useScaleIn ? scaleInTrancheCount : 0),
              isPaper: isPaperSnapshot,
            });
            // orders.chain_id 연결 — 고아 포지션 방지 (audit P0)
            await updateOrderByKisOrderNo(fill.orderNo, { chain_id: chainId });
            chainCreated = true;

            // 워치독: 체결 즉시 TP 지정가 + SL 10초 폴링 (0-180초 무보호 갭 제거)
            // 워치독 시작: 실패 시 1회 재시도 (SL/TP 즉시 보호 필수)
            for (let wdAttempt = 0; wdAttempt < 2; wdAttempt++) {
              try {
                await startWatchdog({
                  chainId,
                  stockCode,
                  avgBuyPrice: fill.filledPrice,
                  quantity: filledQty,
                  stopLossPct,
                  takeProfitPct: targetProfitPct,
                  isPaper: isPaperSnapshot,
                  strategyMode: mode,
                });
                break;
              } catch (e) {
                if (wdAttempt === 0) {
                  logger.warn(`워치독 시작 실패 → 500ms 후 재시도: ${stockCode}`, { component: 'EXECUTOR' });
                  await new Promise((r) => setTimeout(r, 500));
                } else {
                  logger.error(`🚨 워치독 2회 시작 실패 — SL/TP 보호 없이 진행: ${stockCode} ${(e as Error).message}`, { component: 'EXECUTOR' });
                }
              }
            }

            // ScaleIn 3분할: 체인 생성 성공 후 2차(60s)/3차(120s) 분할 진입 스케줄
            if (useScaleIn && secondTranche > 0) {
              logger.info(
                `📊 ScaleIn 스케줄: ${stockCode} 1차 ${filledQty}주 완료 → 2차 ${secondTranche}주(60s), 3차 ${thirdTranche}주(120s)`,
                { component: 'EXECUTOR' },
              );
              // DB 마커 기록 — setTimeout 등록 전에 await (재시작 후 recoverPendingScaleIns 복구용)
              const trancheMarker = {
                stockCode,
                chainId,
                secondTranche,
                thirdTranche,
                scheduledAt: new Date().toISOString(),
                reasoning,
                isPaper: isPaperSnapshot,
              };
              let markerSaved = false;
              for (let m = 0; m < 3; m++) {
                try {
                  await getPool().query(
                    `INSERT INTO system_state (key, value) VALUES ($1, $2)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
                    [`pending_scalein_${chainId}`, JSON.stringify(trancheMarker)],
                  );
                  markerSaved = true;
                  break;
                } catch (e) {
                  if (m < 2) await new Promise((r) => setTimeout(r, 500));
                  else
                    logger.error(
                      `🚨 ScaleIn DB 마커 저장 최종 실패 — 재시작 시 트랜치 유실 위험: ${stockCode} chain=${chainId}: ${e}`,
                      { component: 'EXECUTOR' },
                    );
                }
              }
              logger.info(
                `📋 ScaleIn 마커 ${markerSaved ? '저장됨' : '저장실패'}: ${stockCode} chain=${chainId} 2차=${secondTranche}주 3차=${thirdTranche}주`,
                { component: 'EXECUTOR' },
              );
              setTimeout(() => {
                runWithMode(isPaperSnapshot, () =>
                  this.executeAverageDown(
                    stockCode,
                    secondTranche,
                    'MARKET',
                    undefined,
                    `ScaleIn 2차/3: ${reasoning}`,
                    true,
                  ),
                )
                  .then(() => {
                    logger.info(`✅ ScaleIn 2차 실행 완료: ${stockCode} ${secondTranche}주`, { component: 'EXECUTOR' });
                    // 3차도 완료되었거나 없으면 DB 마커 삭제
                    if (thirdTranche <= 0) {
                      getPool()
                        .query(`DELETE FROM system_state WHERE key = $1`, [`pending_scalein_${chainId}`])
                        .catch(() => {});
                    }
                  })
                  .catch((e) =>
                    logger.warn(`ScaleIn 2차 실패 ${stockCode}: ${(e as Error).message}`, { component: 'EXECUTOR' }),
                  );
              }, 60_000);
              if (thirdTranche > 0) {
                setTimeout(() => {
                  runWithMode(isPaperSnapshot, () =>
                    this.executeAverageDown(
                      stockCode,
                      thirdTranche,
                      'MARKET',
                      undefined,
                      `ScaleIn 3차/3: ${reasoning}`,
                      true,
                    ),
                  )
                    .then(() => {
                      logger.info(`✅ ScaleIn 3차 실행 완료: ${stockCode} ${thirdTranche}주`, {
                        component: 'EXECUTOR',
                      });
                      // 모든 트랜치 완료 → DB 마커 삭제
                      getPool()
                        .query(`DELETE FROM system_state WHERE key = $1`, [`pending_scalein_${chainId}`])
                        .catch(() => {});
                    })
                    .catch((e) =>
                      logger.warn(`ScaleIn 3차 실패 ${stockCode}: ${(e as Error).message}`, { component: 'EXECUTOR' }),
                    );
                }, 120_000);
              }
            }
            break;
          } catch (chainErr) {
            if (attempt < 2) {
              logger.warn(`⚠️ 체인 생성 재시도 ${attempt + 1}/3: ${stockCode} err=${chainErr}`, {
                component: 'EXECUTOR',
              });
              await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            } else {
              // 3회 실패 = 포지션 추적 불가 → 긴급 경고 + 텔레그램
              logger.error(
                `🚨 체인 생성 최종 실패 (체결 완료됨): ${stockCode} ${filledQty}주 @${fill.filledPrice} err=${chainErr}`,
                { component: 'EXECUTOR' },
              );
              this._logFire(
                'ERROR',
                'EXECUTOR',
                `🚨 고아 포지션 발생: ${stockCode} ${filledQty}주 @${fill.filledPrice} — 수동 복구 필요`,
              );
              sendTelegramMessage(
                `🚨 고아 포지션: ${stockCode} ${filledQty}주 @${fill.filledPrice.toLocaleString()}원 — 체인 생성 실패, 수동 확인 필요`,
              ).catch(() => {});
            }
          }
        }

        // 🔒 성공 시 Buy Intent 해제 (다른 전략의 AVERAGE_DOWN 허용)
        releaseBuyIntent(stockCode);

        // 감시목록 자동 등록 + 종목명 즉시 보정 (코드 저장 후 KRX API로 이름 조회)
        upsertWatchlistItem({ stock_code: stockCode, stock_name: stockCode, market: 'KOSPI' }, 'AUTO')
          .then(() => import('../kis/interest-group.js').then((m) => m.fixWatchlistNames()))
          .catch(() => {});

        // 캐시 무효화
        invalidateStockCache(stockCode).catch(() => {});
        if (chainCreated) {
          notifyBuy(stockCode, filledQty, fill.filledPrice, reasoning, triggerSource, isPaperSnapshot).catch((err) =>
            logger.warn(`알림 발송 오류 (BUY): ${err}`, { component: 'EXECUTOR' }),
          );
        } else {
          logger.error(`🚨 ORPHAN: 체결 완료됐으나 체인 생성 3회 실패 — notifyBuy 미발송: ${stockCode}`, {
            component: 'EXECUTOR',
          });
        }
      }
    } finally {
      this._pendingBuyCount[pk] = Math.max(0, this._pendingBuyCount[pk] - 1);
    } // v9: 슬롯 해제
  }

  /**
   * 물타기 (기존 체인에 추가 매수)
   * @param isScaleIn true이면 ScaleIn 2차/3차 분할 진입 — 물타기 횟수 제한·손실 AI 검토 우회
   */
  private async executeAverageDown(
    stockCode: string,
    quantity: number,
    priceType: string,
    limitPrice: number | undefined,
    reasoning: string,
    isScaleIn = false,
  ): Promise<void> {
    const isPaperSnapshot = getCtxIsPaper();
    const chain = await chainManager.findOpenChain(stockCode, isPaperSnapshot);
    if (!chain) {
      logger.warn(`물타기 실패: ${stockCode} 열린 체인 없음`, { component: 'EXECUTOR' });
      return;
    }

    // v17: ScaleIn 분할 진입도 Kill Switch + 서킷브레이커 재검증 (gate 우회 방지)
    if (isScaleIn) {
      if (isKillSwitchActiveForMode('KR', isPaperSnapshot)) {
        logger.warn(`🛑 ScaleIn 차단: ${stockCode} Kill Switch 활성`, { component: 'EXECUTOR' });
        return;
      }
      if (await this._checkDailyCircuitBreaker()) {
        logger.warn(`🛑 ScaleIn 차단: ${stockCode} 서킷브레이커 발동`, { component: 'EXECUTOR' });
        return;
      }
      // v18: ScaleIn 가격 체크 — 매수 평단가 대비 -1% 이상 하락 시 추가 투입 취소 (손실 포지션 확대 방지)
      const avgBuy = Number(chain.avg_buy_price ?? 0);
      if (avgBuy > 0) {
        const curPrice = await getCurrentPrice(stockCode).catch(() => ({ currentPrice: 0 }));
        if (curPrice.currentPrice > 0) {
          const pnlPctNow = ((curPrice.currentPrice - avgBuy) / avgBuy) * 100;
          if (pnlPctNow < -1.0) {
            logger.warn(
              `🛑 ScaleIn 가격차단: ${stockCode} PnL=${pnlPctNow.toFixed(1)}% (평단 ${avgBuy} → 현재 ${curPrice.currentPrice}) → 추가 투입 취소`,
              { component: 'EXECUTOR' },
            );
            return;
          }
        }
      }
    }

    // ScaleIn 분할 진입은 물타기 횟수 한도 적용 안 함 (계획된 분할이므로)
    if (!isScaleIn && chain.current_averaging_count >= chain.max_averaging_count) {
      logger.warn(`물타기 한도 도달: ${stockCode} (${chain.current_averaging_count}/${chain.max_averaging_count})`, {
        component: 'EXECUTOR',
      });
      return;
    }

    const price = await getCurrentPrice(stockCode);
    const estimatedPrice = limitPrice ?? price.currentPrice;

    // 🚫 손실 중 물타기 AI 검토 — ScaleIn 분할 진입은 계획된 진입이므로 우회
    const avgBuyPrice = Number(chain.avg_buy_price ?? 0);
    if (!isScaleIn && avgBuyPrice > 0 && estimatedPrice > 0) {
      const pnlPct = ((estimatedPrice - avgBuyPrice) / avgBuyPrice) * 100;
      if (pnlPct < -0.5) {
        logger.warn(`⚠️ 손실 물타기 감지: ${stockCode} PnL=${pnlPct.toFixed(1)}% avg=${avgBuyPrice}원 → AI 검토`, {
          component: 'EXECUTOR',
        });
        try {
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
            this._logFire(
              'WARN',
              'EXECUTOR',
              `손실 물타기 거부: ${stockCode} PnL=${pnlPct.toFixed(1)}% — ${entryCheck.reason}`,
            );
            return;
          }
          logger.info(`✅ 손실 물타기 AI 승인 [${stockCode} PnL=${pnlPct.toFixed(1)}%]: ${entryCheck.reason}`, {
            component: 'EXECUTOR',
          });
        } catch (e) {
          // fail-closed: AI 오류 시 손실 물타기 허용하면 자유낙하 종목에 계속 추가 매수할 위험
          logger.warn(`🚫 손실 물타기 AI 검토 오류 → 차단 (fail-closed): ${stockCode} — ${(e as Error).message}`, {
            component: 'EXECUTOR',
          });
          this._logFire('WARN', 'EXECUTOR', `손실 물타기 AI 오류 차단: ${stockCode} PnL=${pnlPct.toFixed(1)}%`);
          return;
        }
      }
    }

    // 🚫 No Average Down: 하락 추세(현재가 < MA5) 시 물타기 차단 — ScaleIn 분할 진입은 계획된 진입이므로 면제
    if (!isScaleIn) {
      try {
        const ma5Candles = await getDailyChart(stockCode, 5).catch(
          () => [] as import('../kis/market.js').DailyCandle[],
        );
        if (ma5Candles.length >= 5) {
          const ma5 = ma5Candles.slice(-5).reduce((sum, c) => sum + c.close, 0) / 5;
          const currentPx = price.currentPrice;
          if (currentPx < ma5) {
            logger.warn(
              `⛔ 하락추세 물타기 차단: ${stockCode} 현재가 ${currentPx.toLocaleString()} < MA5 ${ma5.toFixed(0)} → 스킵`,
              { component: 'EXECUTOR' },
            );
            this._logFire(
              'WARN',
              'EXECUTOR',
              `하락추세 물타기 차단: ${stockCode} 현재가 ${currentPx} < MA5 ${ma5.toFixed(0)}`,
            );
            return;
          }
        }
      } catch {
        /* MA5 조회 실패 시 물타기 허용 (fail-open) */
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
      // 현금 부족 등 하드블록 → 10분 쿨다운
      const avgDownCooldownKey = `${isPaperSnapshot ? 'paper' : 'live'}-${stockCode}`;
      this._buyRejectCooldown.set(avgDownCooldownKey, Date.now() + 10 * 60_000);
      return;
    }
    // v16: 리스크 소프트 사이즈 조절
    if (riskCheck.sizeMultiplier && riskCheck.sizeMultiplier < 1.0) {
      quantity = Math.max(1, Math.floor(quantity * riskCheck.sizeMultiplier));
      logger.info(`📊 물타기 사이즈 조정: ${(riskCheck.sizeMultiplier * 100).toFixed(0)}%`, { component: 'EXECUTOR' });
    }

    // 스마트 물타기: ask1 지정가 주문 (시장가 슬리피지 방지)
    let smartBuyPrice: number | undefined;
    if (priceType !== 'LIMIT') {
      try {
        const book = await getOrderbook(stockCode);
        const ask1 = book[0]?.askPrice ?? 0;
        if (ask1 > 0) {
          smartBuyPrice = ask1;
          logger.info(`💰 스마트 물타기: ${stockCode} ask1=${ask1.toLocaleString()} → 지정가`, {
            component: 'EXECUTOR',
          });
        }
      } catch {
        /* 호가 조회 실패 → 시장가 폴백 */
      }
    }

    const result = await this.executeOrder({
      stockCode,
      side: 'BUY',
      quantity,
      price: priceType === 'LIMIT' ? limitPrice : smartBuyPrice,
      chainId: chain.id,
      triggerSource: 'TRACK_B',
      aiReasoning: reasoning,
      isPaper: isPaperSnapshot,
    });

    if (result.success) {
      const fill = await this.confirmFill(result.orderNo, stockCode, quantity, estimatedPrice);
      if (!fill) {
        logger.error(`체결 미확인 → 물타기 체인 업데이트 보류: ${stockCode}`, { component: 'EXECUTOR' });
        return;
      }
      if (fill.filledQty <= 0) {
        logger.error(`물타기 체결 수량 0 → 업데이트 보류 (주문 거부 또는 미체결): ${stockCode}`, {
          component: 'EXECUTOR',
        });
        return;
      }
      const filledQty = Math.min(quantity, fill.filledQty);
      if (filledQty < quantity) {
        logger.warn(`⚠️ 물타기 부분체결 반영: ${stockCode} 요청 ${quantity}주 → 체결 ${filledQty}주`, {
          component: 'EXECUTOR',
        });
      }
      await chainManager.addAveraging(chain.id, fill.filledPrice, filledQty);
    }
  }

  /**
   * 부분 익절
   */
  private async executePartialSell(
    stockCode: string,
    quantity: number,
    reasoning: string,
    partialTpStage?: number,
  ): Promise<void> {
    const isPaperSnapshot = getCtxIsPaper();
    const chain = await chainManager.findOpenChain(stockCode, isPaperSnapshot);
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
      const book = await getOrderbook(stockCode);
      const bid1 = book[0]?.bidPrice ?? 0;
      if (bid1 > 0) {
        smartSellPrice = bid1;
        logger.info(`💰 스마트 익절: ${stockCode} bid1=${bid1.toLocaleString()} → 지정가`, { component: 'EXECUTOR' });
      }
    } catch {
      /* 호가 조회 실패 → 시장가 폴백 */
    }

    const result = await this.executeOrder({
      stockCode,
      side: 'SELL',
      quantity: safeQty,
      price: smartSellPrice,
      chainId: chain.id,
      triggerSource: 'TRACK_B',
      aiReasoning: reasoning,
      isPaper: isPaperSnapshot,
    });

    if (result.success) {
      const now = await getCurrentPrice(stockCode).catch(() => null);
      const fallbackPrice = now?.currentPrice ?? (Number(chain.avg_buy_price) || 0);
      const fill = await this.confirmFill(result.orderNo, stockCode, safeQty, fallbackPrice, 'SELL');
      if (!fill) {
        logger.error(`체결 미확인 → 부분익절 체인 업데이트 보류: ${stockCode}`, { component: 'EXECUTOR' });
        return;
      }

      if (fill.filledQty <= 0) {
        logger.error(`부분익절 체결 수량 0 → 체인 업데이트 보류 (주문 거부 또는 미체결): ${stockCode}`, {
          component: 'EXECUTOR',
        });
        return;
      }
      const soldQty = Math.min(safeQty, fill.filledQty);
      if (soldQty < safeQty) {
        logger.warn(`⚠️ 부분익절 부분체결 반영: ${stockCode} 요청 ${safeQty}주 → 체결 ${soldQty}주`, {
          component: 'EXECUTOR',
        });
      }

      const avgBuy = Number(chain.avg_buy_price) || 0;
      const pnlPct = avgBuy > 0 ? ((fill.filledPrice - avgBuy) / avgBuy) * 100 : 0;
      await chainManager.partialProfit(chain.id, soldQty, fill.filledPrice, chain);

      // v18: 분할TP 스테이지 카운터 — decision에 실려온 번호를 직접 저장 (기존 reasoning 정규식 파싱은
      // 파싱 실패/문구 변경 시 조용히 스킵되어 스테이지가 영구히 0에 머무는 버그 원인이었음 — 실측 확인됨)
      if (partialTpStage != null) {
        try {
          await setKrPartialTpStageNum(chain.id, partialTpStage);
        } catch (e) {
          logger.error(`분할TP 스테이지 저장 실패 (다음 사이클에 동일 단계 재실행 위험): ${stockCode} — ${e}`, {
            component: 'EXECUTOR',
          });
        }
      } else if (reasoning.includes('분할TP') || reasoning.includes('Partial TP')) {
        // 폴백: partial_tp_stage가 안 실려온 경우(구버전 호출 경로 등)에만 정규식 파싱 시도
        try {
          const stageMatch = reasoning.match(/(\d+)단계/);
          if (stageMatch) {
            await setKrPartialTpStageNum(chain.id, Number(stageMatch[1]));
          }
        } catch { /* non-critical */ }
      }

      invalidateStockCache(stockCode).catch(() => {});
      invalidateBalanceCache();
      hardInvalidateDashboardCache();
      notifySell(stockCode, soldQty, fill.filledPrice, pnlPct, reasoning, chain.strategy_mode, isPaperSnapshot).catch(
        (err) => logger.warn(`알림 발송 오류 (SELL): ${err}`, { component: 'EXECUTOR' }),
      );
    }
  }

  /**
   * 전량 청산 (손절/강제)
   */
  private async executeClose(stockCode: string, reasoning: string, action: string): Promise<void> {
    const isPaperSnapshot = getCtxIsPaper();
    const chain = await chainManager.findOpenChain(stockCode, isPaperSnapshot);
    if (!chain || chain.total_quantity === 0) return;

    // 🔒 장 비영업일(주말/공휴일)이면 청산 시도 자체를 스킵 — KIS 주문 불가
    if (!isPaperSnapshot && !isTradingDay()) {
      logger.debug(`⏳ 장 비영업일 → 청산 스킵: ${stockCode}`, { component: 'EXECUTOR' });
      return;
    }

    // 🔒 백오프: 반복 실패 후 일정 시간 대기 (로그 스팸 방지)
    const failKey = `${isPaperSnapshot ? 'paper' : 'live'}-${stockCode}`;
    const backoffUntil = this._closeFailBackoff.get(failKey) ?? 0;
    if (Date.now() < backoffUntil) {
      return; // 백오프 기간 중 — 조용히 스킵
    }

    // 워치독 TP 주문 취소 (다른 메커니즘의 매도와 충돌 방지)
    await cancelWatchdogTpOrder(stockCode).catch(() => {});

    // 🔒 연속 실패 시 무한 루프 방지
    const failCount = this._closeFailCount.get(failKey) ?? 0;
    if (failCount >= 5) {
      // v10: 5회 이상 실패 → 체인 자동 강제 종료 (무한 루프 완전 차단)
      // v17-fix: 종료 전 실제 KIS 잔고 확인 필수 — 검증 없이 종료하면 실보유 포지션이
      // DB 장부에서만 사라지고 계좌엔 그대로 남아 "물린 포지션"이 됨 (라이브 자금 고착 원인)
      if (!isPaperSnapshot) {
        try {
          invalidateBalanceCache();
          const kisPosition = await getPositionForStock(stockCode);
          const actualQty = kisPosition?.quantity ?? 0;
          if (actualQty > 0) {
            // v28-fix: 장 중이면 failCount 리셋 후 즉시 시장가 재매도 시도
            // (장전 5회 실패 → 장 열린 후에도 주문 안 보내던 치명적 버그 수정)
            const nowKst = getKSTNow();
            const kH = nowKst.getUTCHours();
            const kM = nowKst.getUTCMinutes();
            const isMarketOpen = (kH === 9 && kM >= 0) || (kH >= 10 && kH < 15) || (kH === 15 && kM <= 30);
            if (isMarketOpen) {
              logger.warn(
                `🔄 ${stockCode} 청산 ${failCount}회 실패 → 장중이므로 failCount 리셋, 시장가 재매도 시도 (KIS 실보유 ${actualQty}주)`,
                { component: 'EXECUTOR' },
              );
              this._closeFailCount.set(failKey, 0); // 리셋하여 아래 매도 로직 진행
              // fall through — 아래 시장가 매도 로직으로 진행
            } else {
              logger.error(
                `🚨 ${stockCode} 청산 ${failCount}회 연속 실패했지만 KIS 실보유 ${actualQty}주 확인됨 → 강제종료 보류 (장외시간)`,
                { component: 'EXECUTOR' },
              );
              import('../notifications/telegram.js')
                .then(({ sendTelegramMessage }) =>
                  sendTelegramMessage(
                    `🚨 매도 반복실패 (실전)\n종목: ${stockCode}\nKIS 실보유: ${actualQty}주 (매도 안 됨!)\n⚠️ 자동종료 보류 — KIS 앱에서 수동 매도 필요`,
                  ).catch((e) => logger.warn(`반복실패 텔레그램 실패: ${e}`, { component: 'EXECUTOR' })),
                )
                .catch(() => {});
              // 10분 백오프 — 반복 실패 로그 스팸 방지 (장 열리면 자연 해소)
              this._closeFailBackoff.set(failKey, Date.now() + 10 * 60_000);
              return; // 체인 유지 — 백오프 후 재시도, 절대 장부에서 지우지 않음
            }
          }
        } catch (posCheckErr) {
          // KIS 조회 자체가 실패하면 실보유 여부를 알 수 없으므로 안전 우선 — 종료 보류
          logger.error(
            `🚨 ${stockCode} 청산 실패 + KIS 잔고 조회도 실패 → 안전을 위해 강제종료 보류: ${posCheckErr}`,
            { component: 'EXECUTOR' },
          );
          this._closeFailBackoff.set(failKey, Date.now() + 10 * 60_000);
          return;
        }
      }
      logger.warn(`🔄 ${stockCode} 청산 ${failCount}회 연속 실패 → 체인 자동 강제 종료`, { component: 'EXECUTOR' });
      try {
        const avgBuy = Number(chain.avg_buy_price) || 0;
        // realized_pnl 리셋 제거 — 기존 partial PnL 보존, closeChain이 avgBuy 기준 잔여분 정산
        await chainManager.closeChain(
          chain.id,
          avgBuy,
          chain,
          `${failCount}회 연속 청산 실패 → 자동 강제 종료 (수동 KIS 확인 필요)`,
        );
        this._closeFailCount.delete(failKey);
        invalidateStockCache(stockCode).catch(() => {});
        hardInvalidateDashboardCache();
        this._logFire(
          'WARN',
          'EXECUTOR',
          `🔄 ${stockCode} 체인 강제 종료: ${failCount}회 연속 실패 (DB ${chain.total_quantity}주)`,
        );
        // DB 강제 종료 → KIS 실계좌 불일치 가능 → 반드시 수동 확인 요청
        import('../notifications/telegram.js')
          .then(({ sendTelegramMessage }) =>
            sendTelegramMessage(
              `🚨 체인 강제 종료 (${isPaperSnapshot ? '연습' : '실전'})\n종목: ${stockCode}\n사유: ${failCount}회 연속 청산 실패\n⚠️ KIS 앱에서 실제 잔고 수동 확인 필요`,
            ).catch((e) => logger.warn(`강제종료 텔레그램 실패: ${e}`, { component: 'EXECUTOR' })),
          )
          .catch((e) => logger.warn(`텔레그램 모듈 로드 실패: ${e}`, { component: 'EXECUTOR' }));
      } catch (closeErr) {
        logger.error(`체인 강제 종료 실패: ${stockCode} — ${closeErr}`, { component: 'EXECUTOR' });
        this._closeFailCount.set(failKey, failCount + 1);
      }
      return;
    }

    // v10.9.4: FORCE_CLOSE는 시장가 강제 (손절 시 bid1 지정가 미체결 → 손실 확대 방지)
    // SELL(일반 매도)만 bid1 지정가 시도 → 0.05% 슬리피지 절감
    let smartSellPrice: number | undefined;
    if (action !== 'FORCE_CLOSE') {
      try {
        const book = await getOrderbook(stockCode);
        const bid1 = book[0]?.bidPrice ?? 0;
        if (bid1 > 0) {
          smartSellPrice = bid1;
          logger.info(`💰 스마트 매도: ${stockCode} bid1=${bid1.toLocaleString()} → 지정가 (${action})`, {
            component: 'EXECUTOR',
          });
        }
      } catch {
        /* 호가 조회 실패 → 시장가 폴백 */
      }
    } else {
      logger.info(`🚨 강제청산: ${stockCode} → 시장가 주문 (손절 체결 보장)`, { component: 'EXECUTOR' });
    }

    // v9-fix: executeOrder가 throw하면 동기화 로직에 도달 못하는 버그 수정
    // try/catch로 감싸서 throw·return 모두 동일한 동기화 경로 통과
    let result: OrderResult;
    try {
      result = await this.executeOrder({
        stockCode,
        side: 'SELL',
        quantity: chain.total_quantity,
        price: smartSellPrice,
        chainId: chain.id,
        triggerSource: 'TRACK_B',
        aiReasoning: reasoning,
        isPaper: isPaperSnapshot,
      });
    } catch (orderErr) {
      const errMsg = orderErr instanceof Error ? orderErr.message : String(orderErr);
      result = { success: false, orderNo: '', message: errMsg };
    }

    if (!result.success) {
      this._closeFailCount.set(failKey, failCount + 1);

      // v10.5: 매도 실패 시 KIS 동기화 — qty 에러는 즉시, 그 외는 2회 이상 반복 시
      const errText = (result.message ?? '').toLowerCase();
      const isQtyError = errText.includes('수량을 초과') || errText.includes('quantity') || errText.includes('apbk0');
      if (!isPaperSnapshot && (isQtyError || failCount >= 2)) {
        try {
          invalidateBalanceCache(); // 캐시 무효화 후 실잔고 조회
          const kisPosition = await getPositionForStock(stockCode);
          const actualQty = kisPosition?.quantity ?? 0;

          if (actualQty === 0) {
            // KIS에 보유 0주 → 이미 매도됐거나 미보유 상태 → 체인 강제 종료
            logger.warn(`🔄 DB-KIS 불일치 해소: ${stockCode} DB=${chain.total_quantity}주 KIS=0주 → 체인 강제 종료`, {
              component: 'EXECUTOR',
            });
            const avgBuy = Number(chain.avg_buy_price) || 0;
            const pnlPctKisSync = avgBuy > 0 ? ((0 - avgBuy) / avgBuy) * 100 : 0;
            await chainManager.closeChain(
              chain.id,
              avgBuy,
              chain,
              `KIS 동기화: DB ${chain.total_quantity}주 → 실보유 0주 (이미 매도 완료 추정)`,
            );
            this._closeFailCount.delete(failKey);
            invalidateStockCache(stockCode).catch(() => {});
            hardInvalidateDashboardCache();
            notifySell(
              stockCode,
              chain.total_quantity,
              0,
              pnlPctKisSync,
              `DB-KIS 동기화 강제 청산: 실보유 0주`,
              chain.strategy_mode,
              isPaperSnapshot,
            ).catch((err) => logger.warn(`notifySell() 실패 (DB-KIS 동기화): ${err}`, { component: 'EXECUTOR' }));
            this._logFire(
              'WARN',
              'EXECUTOR',
              `🔄 DB-KIS 동기화: ${stockCode} 체인 강제 종료 (DB ${chain.total_quantity}주, KIS 0주)`,
            );
          } else if (actualQty < chain.total_quantity) {
            // KIS 보유 < DB 기록 → 부분 불일치 → qty 에러면 즉시 강제 종료
            logger.warn(`🔄 DB-KIS 부분 불일치: ${stockCode} DB=${chain.total_quantity}주 KIS=${actualQty}주`, {
              component: 'EXECUTOR',
            });
            if (isQtyError || failCount >= 2) {
              logger.warn(`🔄 부분 불일치 → 체인 강제 종료 (qty에러=${isQtyError}, 실패${failCount + 1}회)`, {
                component: 'EXECUTOR',
              });
              const avgBuy = Number(chain.avg_buy_price) || 0;
              await chainManager.closeChain(
                chain.id,
                avgBuy,
                chain,
                `KIS 동기화: DB ${chain.total_quantity}주 → 실보유 ${actualQty}주 (불일치 강제 종료)`,
              );
              this._closeFailCount.delete(failKey);
              invalidateStockCache(stockCode).catch(() => {});
              hardInvalidateDashboardCache();
            }
          }
        } catch (syncErr) {
          logger.warn(`KIS 동기화 조회 실패: ${stockCode} — ${syncErr}`, { component: 'EXECUTOR' });
          // v10.5: qty 에러인데 KIS 조회도 실패 → 즉시 체인 강제 종료 (무한루프 차단)
          // KIS에서 "수량 초과" = 실보유 0주 확실 → 조회 실패해도 안전하게 종료 가능
          if (isQtyError) {
            logger.warn(`🔄 qty 에러 + KIS 조회 실패 → 체인 강제 종료 (실보유 0주 추정): ${stockCode}`, {
              component: 'EXECUTOR',
            });
            const avgBuy = Number(chain.avg_buy_price) || 0;
            await chainManager.closeChain(
              chain.id,
              avgBuy,
              chain,
              `KIS 동기화 실패: ${stockCode} 주문수량초과 에러 → 실보유 0주 추정, 강제 종료`,
            );
            this._closeFailCount.delete(failKey);
            invalidateStockCache(stockCode).catch(() => {});
            hardInvalidateDashboardCache();
          } else if (failCount >= 2) {
            logger.warn(`🔄 동기화 조회 실패 + ${failCount + 1}회 반복 → 체인 강제 종료`, { component: 'EXECUTOR' });
            const avgBuy = Number(chain.avg_buy_price) || 0;
            await chainManager.closeChain(
              chain.id,
              avgBuy,
              chain,
              `KIS 동기화 실패: ${stockCode} ${failCount + 1}회 반복 오류 → 강제 종료`,
            );
            this._closeFailCount.delete(failKey);
            invalidateStockCache(stockCode).catch(() => {});
            hardInvalidateDashboardCache();
          }
        }
      }
      return;
    }

    // 성공 시 실패 카운터 초기화
    this._closeFailCount.delete(failKey);

    {
      const now = await getCurrentPrice(stockCode).catch(() => null);
      const fallbackPrice = now?.currentPrice ?? (Number(chain.avg_buy_price) || 0);
      const fill = await this.confirmFill(result.orderNo, stockCode, chain.total_quantity, fallbackPrice, 'SELL');
      if (!fill) {
        // v10.9.4: confirmFill 타임아웃도 closeFailCount 증가 (기존: 미증가 → 5회 안전장치 무력화)
        this._closeFailCount.set(failKey, failCount + 1);
        logger.error(`체결 미확인 → 청산 체인 업데이트 보류 (failCount=${failCount + 1}): ${stockCode}`, { component: 'EXECUTOR' });
        return;
      }

      if (fill.filledQty <= 0) {
        logger.error(`청산 체결 수량 0 → 체인 업데이트 보류 (주문 거부 또는 미체결): ${stockCode}`, {
          component: 'EXECUTOR',
        });
        return;
      }
      const soldQty = Math.min(chain.total_quantity, fill.filledQty);
      const remainQty = chain.total_quantity - soldQty;
      if (remainQty > 0) {
        logger.warn(`⚠️ 전량청산 부분체결 반영: ${stockCode} 요청 ${chain.total_quantity}주 → 체결 ${soldQty}주, 잔여 ${remainQty}주`, {
          component: 'EXECUTOR',
        });
      }

      const closeReason = action === 'FORCE_CLOSE' ? `강제 청산: ${reasoning}` : `매도: ${reasoning}`;
      const avgBuy = Number(chain.avg_buy_price) || 0;
      const pnlKrw = avgBuy > 0 ? Math.round((fill.filledPrice - avgBuy) * soldQty) : 0;
      const pnlPct = avgBuy > 0 ? ((fill.filledPrice - avgBuy) / avgBuy) * 100 : 0;
      if (soldQty >= chain.total_quantity) {
        await chainManager.closeChain(chain.id, fill.filledPrice, chain, closeReason);
        recordSellForCooldown(stockCode, isPaperSnapshot, pnlPct < 0); // v21: 손절 시 isStopLoss=true → 4h 쿨다운
      } else {
        await chainManager.partialProfit(chain.id, soldQty, fill.filledPrice, chain);
        // v29 [수익잠식 버그#1]: 부분매도도 재매수 쿨다운 등록 — 기존엔 full close만 등록되어
        //   슬라이스 매도 후 다음 사이클 즉시 재매수 churn(수익 반납)이 무제한이었음.
        //   익절 partial→2h / 손절 partial→4h. 강한 setup(AI≥85+주도주+반전)만 hard-gates 우회로 재진입.
        recordSellForCooldown(stockCode, isPaperSnapshot, pnlPct < 0);
        // v10.9.4: FORCE_CLOSE 부분체결 → 잔여 수량 즉시 시장가 재매도 (잔여 포지션 방치 방지)
        if (action === 'FORCE_CLOSE' && remainQty > 0) {
          logger.warn(`🔄 FORCE_CLOSE 잔여 ${remainQty}주 즉시 재매도: ${stockCode}`, { component: 'EXECUTOR' });
          try {
            const retryResult = await this.executeOrder({
              stockCode,
              side: 'SELL',
              quantity: remainQty,
              // price 미지정 → 시장가
              chainId: chain.id,
              triggerSource: 'TRACK_B',
              aiReasoning: `부분체결 잔여 ${remainQty}주 재매도`,
              isPaper: isPaperSnapshot,
            });
            if (retryResult.success) {
              const retryFill = await this.confirmFill(retryResult.orderNo, stockCode, remainQty, fill.filledPrice, 'SELL');
              if (retryFill && retryFill.filledQty > 0) {
                const updatedChain = await chainManager.findOpenChain(stockCode, isPaperSnapshot);
                if (updatedChain) {
                  await chainManager.closeChain(updatedChain.id, retryFill.filledPrice, updatedChain, `${closeReason} (잔여 재매도)`);
                  recordSellForCooldown(stockCode, isPaperSnapshot, pnlPct < 0);
                }
              }
            }
          } catch (retryErr) {
            logger.error(`잔여 재매도 실패: ${stockCode} ${remainQty}주 — ${retryErr}`, { component: 'EXECUTOR' });
          }
        }
      }
      invalidateStockCache(stockCode).catch(() => {});
      invalidateBalanceCache();
      hardInvalidateDashboardCache();
      notifySell(stockCode, soldQty, fill.filledPrice, pnlPct, closeReason, chain.strategy_mode, isPaperSnapshot).catch(
        (err) => logger.warn(`알림 발송 오류 (CLOSE): ${err}`, { component: 'EXECUTOR' }),
      );

      // 체결 감사 로그: 매도 실체결 내역 (why + 실제 수익)
      this._logFire(
        'TRADE',
        'EXECUTOR',
        `SELL ${stockCode} x${soldQty} 체결 @${fill.filledPrice.toLocaleString()}원 | 수익 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${pnlKrw >= 0 ? '+' : ''}${pnlKrw.toLocaleString()}원) | ${closeReason}`,
      );

      // 🍽️ 개장 초단타 용돈 알림: 수익 5만원 이상 시 텔레그램 알림
      if (pnlKrw >= 50000 && reasoning.includes('초단타')) {
        import('../notifications/telegram.js')
          .then(({ sendTelegramMessage }) => {
            sendTelegramMessage(
              `🍽️ *개장 초단타 용돈 벌었습니다!*\n\n` +
                `종목: ${stockCode}\n` +
                `수익: +${pnlKrw.toLocaleString()}원 (+${pnlPct.toFixed(2)}%)\n` +
                `저녁 식사비로 입금 확인해 주세요 😄`,
            ).catch(() => {});
          })
          .catch(() => {});
      }
    }
  }

  /** 실제 주문 실행 (Paper / Live 분기) — isPaper 스냅샷을 명시적으로 전달 (AsyncLocalStorage 교차오염 방지) */
  private async executeOrder(params: {
    stockCode: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    price?: number;
    chainId?: string;
    triggerSource?: string;
    aiReasoning?: string;
    isPaper?: boolean;
  }): Promise<OrderResult> {
    const isPaper = params.isPaper ?? getCtxIsPaper();
    if (isPaper) {
      return paperTradeOrder(params);
    }

    // LIVE 매매 중 인메모리 DB 모드 감지 → 주문 차단 (DB 복구 전 주문은 휘발됨)
    if (isMemoryMode()) {
      logger.error(`🚫 LIVE 주문 차단: 인메모리 DB 모드 활성 — ${params.stockCode} (DB 복구 후 자동 재개)`, {
        component: 'EXECUTOR',
      });
      this._logFire(
        'ERROR',
        'EXECUTOR',
        `LIVE 주문 차단 (인메모리 모드): ${params.side} ${params.stockCode} x${params.quantity}`,
      );
      return { success: false, orderNo: '', message: '인메모리 DB 모드 — LIVE 주문 차단' };
    }

    // 장후 시간외 자동 감지 (15:40~16:00 KST → ORD_DVSN '06')
    const kstNow = getKSTNow();
    const kH = kstNow.getUTCHours(),
      kM = kstNow.getUTCMinutes();
    const isAfterHours = (kH === 15 && kM >= 40) || (kH === 16 && kM === 0);
    // v27: 장전 동시호가 (08:00~09:00 KST) — 시장가 주문 불가, 지정가 전환 필수
    const isPreMarket = kH === 8 || (kH === 7 && kM >= 30);
    // 시간외 주문은 반드시 가격 필요 (ORD_DVSN='06'에 price=0 → KIS 거부)
    let effectivePrice = params.price;
    if (isAfterHours && !effectivePrice) {
      effectivePrice = await getCurrentPrice(params.stockCode)
        .then((p) => p.currentPrice)
        .catch(() => 0);
      if (!effectivePrice) {
        logger.warn(`⛔ 시간외 주문 가격 조회 실패 → 주문 스킵: ${params.stockCode}`, { component: 'EXECUTOR' });
        return { success: false, orderNo: '', message: '시간외 주문 가격 없음' };
      }
    }
    // v27: 장전 시장가→지정가 전환 (08:00~09:00 KST 시장가 접수 불가)
    if (isPreMarket && !effectivePrice) {
      effectivePrice = await getCurrentPrice(params.stockCode)
        .then((p) => p.currentPrice)
        .catch(() => 0);
      if (!effectivePrice) {
        logger.warn(`⛔ 장전 주문 가격 조회 실패 → 주문 스킵: ${params.stockCode}`, { component: 'EXECUTOR' });
        return { success: false, orderNo: '', message: '장전 주문 가격 없음' };
      }
      logger.info(`📋 장전 시장가→지정가 전환: ${params.stockCode} @${effectivePrice.toLocaleString()} (동시호가)`, { component: 'EXECUTOR' });
    }
    const orderType = isAfterHours ? OrderType.AFTER_HOURS : effectivePrice ? OrderType.LIMIT : OrderType.MARKET;

    // 실거래 주문
    const result = await placeOrder({
      stockCode: params.stockCode,
      side: params.side,
      quantity: params.quantity,
      price: effectivePrice,
      orderType,
    });

    // DB 기록 — 실패 시에도 주문은 KIS에 전송됨, 반드시 기록 시도 (재시도 포함)
    const orderRecord = {
      chain_id: params.chainId ?? null,
      stock_code: params.stockCode,
      side: params.side,
      order_type: orderType,
      quantity: params.quantity,
      price: effectivePrice ?? null,
      kis_order_no: result.orderNo,
      kis_status: result.success ? 'SUBMITTED' : 'FAILED',
      filled_quantity: 0,
      filled_price: null,
      status: result.success ? ('PENDING' as const) : ('FAILED' as const),
      trading_mode: isPaper ? ('paper' as const) : ('live' as const),
      trigger_source: params.triggerSource ?? null,
      ai_reasoning: params.aiReasoning ?? null,
    };
    let dbInserted = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await insertOrder(orderRecord);
        dbInserted = true;
        break;
      } catch (dbErr) {
        logger.error(
          `🚨 주문 DB 기록 실패 (시도 ${attempt + 1}/3): ${params.side} ${params.stockCode} x${params.quantity} orderNo=${result.orderNo} err=${dbErr}`,
          { component: 'EXECUTOR' },
        );
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    if (!dbInserted) {
      // 3회 재시도 실패 → 고아 포지션 위험: 텔레그램 긴급 알림 + system_log
      const orphanMsg =
        `🚨 *고아 포지션 경고*\n` +
        `KIS 주문은 전송되었으나 DB 기록 3회 실패!\n` +
        `주문번호: ${result.orderNo}\n` +
        `${params.side} ${params.stockCode} x${params.quantity}\n` +
        `모드: ${isPaper ? 'Paper' : 'LIVE'}\n` +
        `즉시 수동 확인 필요`;
      import('../notifications/telegram.js')
        .then(({ sendTelegramMessage }) =>
          sendTelegramMessage(orphanMsg).catch((e) => logger.warn(`고아포지션 텔레그램 실패: ${e}`, { component: 'EXECUTOR' })),
        )
        .catch((e) => logger.warn(`텔레그램 모듈 로드 실패: ${e}`, { component: 'EXECUTOR' }));
      this._logFire(
        'ERROR',
        'EXECUTOR',
        `고아포지션: ${params.side} ${params.stockCode} x${params.quantity} orderNo=${result.orderNo} — DB 기록 3회 실패`,
      );
    }

    this._logFire(
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

  /** 체결 확인 캐시 + 중복주문 키 + 청산실패 카운터 정리 — 장 마감 시 호출 */
  clearConfirmedOrders(): void {
    const size = this.confirmedOrders.size;
    if (size > 0) {
      this.confirmedOrders.clear();
      logger.info(`🧹 confirmedOrders 캐시 정리: ${size}건`, { component: 'EXECUTOR' });
    }
    // 전날 분 키 잔재 제거 (오늘 날짜 없는 항목)
    const todayPrefix = getKSTNow().toISOString().slice(0, 10).replace(/-/g, '');
    const before = this._recentOrderKeys.size;
    for (const key of this._recentOrderKeys) {
      if (!key.includes(todayPrefix)) this._recentOrderKeys.delete(key);
    }
    if (before > 0)
      logger.info(`🧹 recentOrderKeys 정리: ${before}→${this._recentOrderKeys.size}건`, { component: 'EXECUTOR' });
    // 청산실패 카운터 + 백오프 장 마감 정리 (다음 장에 이월 방지)
    if (this._closeFailCount.size > 0) {
      logger.info(`🧹 closeFailCount 정리: ${this._closeFailCount.size}건`, { component: 'EXECUTOR' });
      this._closeFailCount.clear();
    }
    this._closeFailBackoff.clear();
    this._buyRejectCooldown.clear();
  }

  private async confirmFill(
    orderNo: string,
    stockCode: string,
    expectedQty: number,
    fallbackPrice: number,
    side: 'BUY' | 'SELL' = 'BUY',
  ): Promise<{ filledQty: number; filledPrice: number } | null> {
    if (getCtxIsPaper()) {
      return { filledQty: expectedQty, filledPrice: roundKrw(fallbackPrice) };
    }

    // 멱등성: 이미 확인된 주문이면 중복 확인 방지
    if (this.confirmedOrders.has(orderNo)) {
      logger.warn(`⚠️ 이미 확인된 주문: ${orderNo} → 스킵`, { component: 'EXECUTOR' });
      return null;
    }

    // v11: 체결확인 15초 타임아웃 (기존 30초 → 15초)
    // 지정가 주문은 미체결 시 pending-order-manager가 관리하므로 빠른 반환 우선
    const MAX_WAIT_MS = 15_000;
    const FAST_POLL_MS = 500; // 처음 5초: 500ms 간격
    const SLOW_POLL_MS = 1500; // 이후: 1.5초 간격 (기존 2초)
    const FAST_PHASE_MS = 5000;
    let elapsed = 0;
    let attempt = 0;

    while (elapsed < MAX_WAIT_MS) {
      const pollInterval = elapsed < FAST_PHASE_MS ? FAST_POLL_MS : SLOW_POLL_MS;
      await new Promise((r) => setTimeout(r, pollInterval));
      elapsed += pollInterval;
      attempt++;

      try {
        const fill = await getOrderFills(orderNo);
        if (fill && fill.filledQty > 0) {
          logger.info(
            `✅ 체결 확인 (${elapsed}ms, 시도 ${attempt}): ${stockCode} ${fill.filledQty}주 @${fill.filledPrice}`,
            {
              component: 'EXECUTOR',
            },
          );

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

        if (attempt % 5 === 0) {
          logger.info(`⏳ 체결 대기 (${Math.round(elapsed / 1000)}초/${MAX_WAIT_MS / 1000}초): ${orderNo}`, {
            component: 'EXECUTOR',
          });
        }
      } catch (error) {
        logger.warn(`체결 확인 에러 (시도 ${attempt}): ${error}`, { component: 'EXECUTOR' });
      }
    }

    // 최종 실패: 미체결 지정가 주문 취소 → 호출측에서 체인 업데이트 보류
    logger.error(`🛑 체결 미확인 (${attempt}회 시도, ${Math.round(elapsed / 1000)}초): ${orderNo} → 주문 취소 시도`, {
      component: 'EXECUTOR',
    });

    // v20.1: 매수 미체결 → pending-order-manager에 등록 (재배치/체결 관리)
    if (side === 'BUY') {
      try {
        const strategy = await getActiveStrategy();
        await registerPendingOrder({
          orderNo,
          stockCode,
          quantity: expectedQty,
          limitPrice: fallbackPrice,
          supportReasoning: '지정가 미체결 → 예약매수 전환',
          mode: (strategy?.mode ?? 'SWING') as StrategyMode,
          isPaper: getCtxIsPaper(),
        });
        logger.info(`📋 미체결 매수 → 예약주문 등록: ${stockCode} ${expectedQty}주 @${fallbackPrice.toLocaleString()}`, {
          component: 'EXECUTOR',
        });
        return null; // pending-order-manager가 이후 관리
      } catch (e) {
        logger.warn(`예약주문 등록 실패 → 기존 취소 로직 진행: ${e}`, { component: 'EXECUTOR' });
      }
    }

    // 미체결 지정가 주문 자동 취소 (매도 또는 예약등록 실패 시)
    try {
      await cancelOrder({ orderNo, stockCode, quantity: expectedQty });
      // 🔒 DB 주문 상태도 CANCELLED로 업데이트 — PENDING 잔류 방지 (중복매수 위험 차단)
      await updateOrderByKisOrderNo(orderNo, { status: 'CANCELLED' });
      logger.warn(`🔄 미체결 주문 취소 완료: ${orderNo}`, { component: 'EXECUTOR' });
      this._logFire('WARN', 'EXECUTOR', `미체결 주문 취소: ${orderNo} (${stockCode})`);
    } catch {
      // 취소 실패 = 이미 체결된 것일 수 있으므로 UNCONFIRMED 마킹 (reconciler가 나중에 복구)
      await updateOrderByKisOrderNo(orderNo, { status: 'PENDING', kis_status: 'UNCONFIRMED' }).catch((e) =>
        logger.warn(`UNCONFIRMED 마킹 실패: ${orderNo} — ${e}`, { component: 'EXECUTOR' }),
      );
      logger.warn(`⚠️ 주문 취소 실패 (이미 체결?): ${orderNo}`, { component: 'EXECUTOR' });
    }

    this._logFire('ERROR', 'EXECUTOR', `체결 미확인: ${orderNo}. 주문 취소 시도 완료. 수동 확인 필요.`);

    await sendTelegramMessage(
      `🛑 체결 미확인 경고!\n주문번호: ${orderNo}\n종목: ${stockCode}\n주문 취소 시도 완료. 수동 확인 필요`,
    ).catch((e) => logger.warn(`미체결 경고 텔레그램 실패: ${e}`, { component: 'EXECUTOR' }));

    return null; // 체결 실패 시그널
  }

  /**
   * ScaleIn 미완료 트랜치 복구 — 프로세스 재시작 시 호출
   * system_state에서 pending_scalein_* 마커를 읽어 미실행 트랜치 실행
   */
  async recoverPendingScaleIns(): Promise<void> {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ key: string; value: string }>(
        `SELECT key, value FROM system_state WHERE key LIKE 'pending_scalein_%'`,
      );

      if (rows.length === 0) return;

      logger.info(`🔄 ScaleIn 미완료 트랜치 ${rows.length}건 복구 시작`, { component: 'EXECUTOR' });

      for (const row of rows) {
        try {
          const marker = JSON.parse(row.value) as {
            stockCode: string;
            chainId: number;
            secondTranche: number;
            thirdTranche: number;
            scheduledAt: string;
            reasoning: string;
            isPaper: boolean;
          };

          // 스케줄 후 90초 이상 지났으면 복구 대상 (원래 setTimeout 60초 + 여유 30초)
          const scheduledMs = new Date(marker.scheduledAt).getTime();
          if (Date.now() - scheduledMs < 90_000) {
            // 아직 원래 setTimeout이 실행 중일 수 있음 → 스킵
            continue;
          }

          // 체인이 아직 열려있는지 확인
          const { rows: chainRows } = await pool.query(`SELECT status FROM transaction_chains WHERE id = $1`, [
            marker.chainId,
          ]);
          if (!chainRows[0] || !['OPEN', 'AVERAGING', 'PROFIT_TAKING'].includes(chainRows[0].status)) {
            // 체인 이미 닫힘 → 마커 삭제
            await pool.query(`DELETE FROM system_state WHERE key = $1`, [row.key]);
            continue;
          }

          // 이미 실행된 트랜치 확인 (체인의 주문 수로 판단)
          const { rows: orderRows } = await pool.query<{ cnt: string }>(
            `SELECT COUNT(*) as cnt FROM orders WHERE chain_id = $1 AND side = 'BUY' AND status = 'FILLED'`,
            [marker.chainId],
          );
          const buyCount = Number(orderRows[0]?.cnt ?? 0);

          // 1차만 체결 (1건) → 2차+3차 실행
          // 2차까지 체결 (2건) → 3차만 실행
          // 3건 이상 → 이미 완료
          if (buyCount >= 3 || (buyCount >= 2 && marker.thirdTranche <= 0)) {
            await pool.query(`DELETE FROM system_state WHERE key = $1`, [row.key]);
            logger.info(`✅ ScaleIn 이미 완료: ${marker.stockCode} chain=${marker.chainId}`, { component: 'EXECUTOR' });
            continue;
          }

          logger.info(
            `🔄 ScaleIn 복구: ${marker.stockCode} chain=${marker.chainId} (기존 매수 ${buyCount}건, 2차=${marker.secondTranche}주, 3차=${marker.thirdTranche}주)`,
            { component: 'EXECUTOR' },
          );

          if (buyCount < 2 && marker.secondTranche > 0) {
            // 2차 트랜치 즉시 실행
            try {
              await runWithMode(marker.isPaper, () =>
                this.executeAverageDown(
                  marker.stockCode,
                  marker.secondTranche,
                  'MARKET',
                  undefined,
                  `ScaleIn 2차/3 복구: ${marker.reasoning}`,
                  true,
                ),
              );
              logger.info(`✅ ScaleIn 2차 복구 완료: ${marker.stockCode} ${marker.secondTranche}주`, {
                component: 'EXECUTOR',
              });
            } catch (e) {
              logger.warn(`ScaleIn 2차 복구 실패: ${marker.stockCode}: ${(e as Error).message}`, {
                component: 'EXECUTOR',
              });
            }
          }

          if (marker.thirdTranche > 0 && buyCount < 3) {
            // 3차 트랜치: 2차 직후 30s 대기 후 즉시 실행 (복구 경로에서는 await)
            await new Promise((r) => setTimeout(r, 30_000));
            try {
              await runWithMode(marker.isPaper, () =>
                this.executeAverageDown(
                  marker.stockCode,
                  marker.thirdTranche,
                  'MARKET',
                  undefined,
                  `ScaleIn 3차/3 복구: ${marker.reasoning}`,
                  true,
                ),
              );
              logger.info(`✅ ScaleIn 3차 복구 완료: ${marker.stockCode} ${marker.thirdTranche}주`, {
                component: 'EXECUTOR',
              });
              await pool.query(`DELETE FROM system_state WHERE key = $1`, [row.key]).catch(() => {});
            } catch (e) {
              logger.warn(`ScaleIn 3차 복구 실패: ${marker.stockCode}: ${(e as Error).message}`, {
                component: 'EXECUTOR',
              });
            }
          } else {
            // 3차 없으면 바로 마커 삭제
            await pool.query(`DELETE FROM system_state WHERE key = $1`, [row.key]);
          }
        } catch (e) {
          logger.warn(`ScaleIn 마커 파싱/복구 실패: ${row.key}: ${(e as Error).message}`, { component: 'EXECUTOR' });
          // 파싱 실패한 마커는 삭제
          await pool.query(`DELETE FROM system_state WHERE key = $1`, [row.key]).catch(() => {});
        }
      }
    } catch (e) {
      logger.warn(`ScaleIn 복구 조회 실패: ${(e as Error).message}`, { component: 'EXECUTOR' });
    }
  }
}

/**
 * 지지선 기반 매수가 계산 (Phase 4: Smart Limit Entry)
 * 근거: Bollinger+Fibonacci 복합 지지선 (Pineify 연구 — "기관급 지지/저항 구간")
 * BB lower(25%) + Fib 0.618(30%) + VP support(25%) + SMA20(20%) 가중 평균
 */
async function calcSupportBuyPrice(
  stockCode: string,
  currentPrice: number,
  bid1: number,
  ask1: number,
): Promise<{ price: number; reasoning: string }> {
  const midPrice = Math.floor((bid1 + ask1) / 2);
  const candles = await getDailyChart(stockCode, 65).catch(() => []);
  if (candles.length < 20) return { price: midPrice, reasoning: 'mid(캔들부족)' };

  const closes = candles.map((c) => c.close);
  const floor = currentPrice * 0.98; // 현재가 대비 -2% 이내만

  const bb = bollingerBands(closes, 20);
  const fib = calcFibonacciLevels(candles, currentPrice);
  const vp = volumeProfile(candles);
  const sma20 = sma(closes, 20);

  const candidates: { p: number; w: number; n: string }[] = [];

  // BB lower band (최신값 = 배열 마지막)
  if (bb.lower.length > 0) {
    const bbLower = bb.lower[bb.lower.length - 1];
    if (bbLower >= floor) candidates.push({ p: bbLower, w: 0.25, n: 'BB' });
  }

  // Fib 0.618 되돌림
  if (fib?.levels) {
    const fib618 = fib.levels.find((l) => Math.abs(l.level - 0.618) < 1e-9);
    if (fib618 && fib618.price >= floor) candidates.push({ p: fib618.price, w: 0.3, n: 'Fib' });
  }

  // Volume Profile — 현재가 아래 최대 거래량 지지선
  const vpSupports = vp
    .filter((v) => v.isSupport && v.priceLevel < currentPrice && v.priceLevel >= floor)
    .sort((a, b) => b.volumePct - a.volumePct);
  if (vpSupports.length > 0) {
    candidates.push({ p: vpSupports[0].priceLevel, w: 0.25, n: 'VP' });
  }

  // SMA20 (최신값 = 배열 마지막)
  if (sma20.length > 0) {
    const sma20Val = sma20[sma20.length - 1];
    if (sma20Val >= floor) candidates.push({ p: sma20Val, w: 0.2, n: 'SMA20' });
  }

  if (candidates.length === 0) return { price: midPrice, reasoning: 'mid(지지선없음)' };

  const totalW = candidates.reduce((s, c) => s + c.w, 0);
  const weighted = candidates.reduce((s, c) => s + c.p * (c.w / totalW), 0);
  // bid1 ≤ 지지선가 ≤ midPrice 범위 클램핑
  const supportPrice = Math.max(bid1, Math.min(midPrice, Math.floor(weighted)));

  return {
    price: adjustToTickSize(supportPrice),
    reasoning: candidates.map((c) => `${c.n}=${c.p.toLocaleString()}`).join(' '),
  };
}

export const tradeExecutor = new TradeExecutor();
