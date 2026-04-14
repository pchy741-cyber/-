import { analyzeTechnicals } from '../../analysis/indicators.js';
import { getLearnedInsightsForPrompt } from '../../automation/self-learning.js';
import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import { config } from '../../config/index.js';
import { getActiveStrategy, getActiveWatchlist, getLatestScores, getOpenChains, getRecentLossStocks, logSystem } from '../../db/client.js';
import type { TradeDecision } from '../../db/models.js';
import { getAccountBalance } from '../../kis/account.js';
import { getBatchPrices, getDailyChart, isMarketOpen } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { buildTrackBContext } from './context.js';
import {
  buildDefenseParkEntryDecisions,
  buildDefenseParkExitDecisions,
  getDefenseParkState,
  isMarketRecovering,
  isPortfolioInDowntrend,
  PARK_STOCK_CODE,
} from './defense-park.js';
import { runClaudeExecution } from './executor.js';
import { runGeminiExecution } from './gemini-executor.js';
import { technicalFallbackDecisions } from './technical-fallback.js';
import { IDLE_PARK_CODE, IDLE_PARK_NAME } from './trading-rules.js';

/**
 * Track B 전체 파이프라인
 * 장중 5~15분 간격 실행
 *
 * 흐름:
 * 1. 장 열림 확인
 * 2. DB에서 캐싱된 스코어 + 열린 체인 로드
 * 3. KIS에서 실시간 시세 수집
 * 4. Claude에 컨텍스트 전달 → 매매 판단
 * 5. 판단 결과를 TradeExecutor로 전달 (HOLD 제외)
 */
export async function runTrackBPipeline(): Promise<TradeDecision[]> {
  const startTime = Date.now();
  logger.info('🔄 Track B 파이프라인 시작', { component: 'TRACK_B' });

  try {
    // 1. 장 열림 확인
    if (!isMarketOpen()) {
      logger.info('장이 닫혀있어 Track B 스킵', { component: 'TRACK_B' });
      return [];
    }

    // 2. 데이터 로드 (병렬)
    const [watchlist, openChains, strategy, balanceRaw, reservedWithdraw, recentLossCodes] = await Promise.all([
      getActiveWatchlist(),
      getOpenChains(),
      getActiveStrategy(),
      getAccountBalance(),
      import('../../automation/profit-withdraw.js').then(m => m.getTotalReserved()).catch(() => 0),
      getRecentLossStocks(14), // 14일 이내 손절 종목 재진입 금지
    ]);
    const balance = { ...balanceRaw, reservedWithdraw } as any;

    if (watchlist.length === 0) {
      logger.warn('감시 목록이 비어있습니다', { component: 'TRACK_B' });
      return [];
    }

    const mode = (strategy?.mode ?? 'SWING') as StrategyMode;

    // ─── 방어 파킹 시스템 ───────────────────────────────────────────────
    // 하락장 감지 시 전종목 청산 → KODEX 200 파킹 / 회복 시 자동 복귀
    const parkState = await getDefenseParkState();

    if (parkState.isActive) {
      // 방어 파킹 중 — 시장 회복 여부만 확인
      const chainStockCodesEarly = openChains.map((c) => c.stock_code);
      const allCodesEarly = [...new Set([...chainStockCodesEarly, PARK_STOCK_CODE])];
      const livePricesEarly = await getBatchPrices(allCodesEarly);

      const { recovering, reason: recoveryReason } = await isMarketRecovering(openChains, livePricesEarly);
      if (recovering) {
        logger.info(`✅ 방어 파킹 해제 조건 충족: ${recoveryReason}`, { component: 'TRACK_B' });
        return buildDefenseParkExitDecisions(openChains, recoveryReason);
      }

      logger.info(`🛡️ 방어 파킹 유지 중 (진입: ${parkState.entryReason ?? ''}) — 정상 매매 스킵`, { component: 'TRACK_B' });
      return [];
    }

    // 방어 파킹 비활성 — 하락세 감지
    const { downtrend, reason: downtrendReason } = await isPortfolioInDowntrend();
    if (downtrend) {
      // 하락세 진입: 실시간 가격 먼저 수집 후 방어 파킹 결정 생성
      const chainCodesForPark = openChains.map((c) => c.stock_code);
      const allCodesForPark = [...new Set([...chainCodesForPark, PARK_STOCK_CODE])];
      const livePricesForPark = await getBatchPrices(allCodesForPark);
      const orderableCashForPark = Math.max(0, balance.orderableCash - (balance.reservedWithdraw ?? 0));

      logger.warn(`📉 하락세 감지 → 방어 파킹 진입: ${downtrendReason}`, { component: 'TRACK_B' });
      return buildDefenseParkEntryDecisions(openChains, livePricesForPark, orderableCashForPark, downtrendReason);
    }
    // ───────────────────────────────────────────────────────────────────

    // 3. 캐싱된 스코어 로드 (Redis 우선 → DB fallback)
    const stockCodes = watchlist.map((w) => w.stock_code);
    const { getCachedScores } = await import('../../cache/redis.js');
    let scores = await getCachedScores(stockCodes);
    if (scores.length === 0) {
      scores = await getLatestScores(stockCodes);
    }

    if (scores.length === 0) {
      logger.warn('오늘의 AI 스코어가 없습니다 (Track A 미실행?) → 기술적 지표 fallback 진행', { component: 'TRACK_B' });
    }

    // 4. 실시간 시세 수집 (열린 체인의 종목 + 방어파킹/유휴파킹 ETF 포함)
    const chainStockCodes = openChains.map((c) => c.stock_code);
    const allStockCodes = [...new Set([...stockCodes, ...chainStockCodes, PARK_STOCK_CODE, IDLE_PARK_CODE])];
    const livePrices = await getBatchPrices(allStockCodes);

    // 가격 캐싱 — 대시보드에서 API 실패 시 fallback용
    try {
      const { cachePrice } = await import('../../cache/redis.js');
      const { cachePriceMemory } = await import('../../cache/memory.js');
      for (const [code, p] of livePrices) {
        if (p.currentPrice > 0) {
          cachePriceMemory(code, p.currentPrice);
          cachePrice(code, p.currentPrice).catch(() => {});
        }
      }
    } catch { /* cache optional */ }

    // 5. 전 종목 차트 데이터 수집 (기술적 지표용)
    // kisRateLimiter가 내부에서 12/sec 큐 관리 → 5개씩 병렬 발사
    const chartData = new Map<string, import('../../kis/market.js').DailyCandle[]>();
    const allCodesForChart = [...new Set([...stockCodes, ...openChains.map((c) => c.stock_code)])];
    const CHART_BATCH = 5;
    for (let i = 0; i < allCodesForChart.length; i += CHART_BATCH) {
      const batch = allCodesForChart.slice(i, i + CHART_BATCH);
      const results = await Promise.allSettled(batch.map((code) => getDailyChart(code, 65)));
      for (let j = 0; j < batch.length; j++) {
        const r = results[j];
        if (r.status === 'fulfilled') {
          if (r.value.length >= 30) {
            chartData.set(batch[j], r.value);
          } else {
            logger.warn(`차트 데이터 부족: ${batch[j]} (${r.value.length}/30)`, { component: 'TRACK_B' });
          }
        } else {
          logger.warn(`차트 조회 실패: ${batch[j]} - ${r.reason}`, { component: 'TRACK_B' });
        }
      }
    }

    // 6. AI 매매 판단: Claude → Gemini → 기술적 지표 (3단 폴백)
    const hasScores = scores.length > 0;

    // 보유 종목 없고 + 매수 후보(스코어 ≥threshold + 신뢰도 ≥0.6)도 없으면 AI 호출 스킵
    // confidence < 0.6은 폴백 스코어 — BUY 후보로 취급 안 함 (과매매 방지)
    const hasBuyCandidates = scores.some(
      (s) => (s.composite_score ?? 0) >= STRATEGY_PARAMS[mode].buyThreshold && (s.confidence ?? 1) >= 0.6,
    );
    const hasOpenPositions = openChains.length > 0;
    if (!hasOpenPositions && !hasBuyCandidates) {
      logger.info('⏭️ AI 스킵: 보유 종목 없음 + 매수 후보 없음 → 기술적 지표 fallback', { component: 'TRACK_B' });
    }

    let decisions: TradeDecision[] = [];

    // AI 컨텍스트 구성 (스코어가 있을 때만 + AI 호출 필요 시)
    if (hasScores && (hasOpenPositions || hasBuyCandidates)) {
      const technicalsSummary: string[] = [];
      const topStocks = scores.slice(0, 5).map((s) => s.stock_code);
      for (const code of topStocks) {
        const candles = chartData.get(code);
        if (candles) {
          const result = analyzeTechnicals(candles);
          if (result) {
            const patternStr = result.candlePatterns.length > 0
              ? ' 패턴=' + result.candlePatterns.map(p => `${p.bullish ? '📈' : '📉'}${p.name}`).join(',')
              : '';
            const pricePos = `고가대비${result.pctFrom3DayHigh.toFixed(1)}% 저가대비${result.pctFrom5DayLow >= 0 ? '+' : ''}${result.pctFrom5DayLow.toFixed(1)}% VWAP=${result.vwapPosition}`;
            technicalsSummary.push(
              `${code}: RSI=${result.rsi14.toFixed(0)} MACD=${result.macdCrossover} 볼린저=${result.bollingerPosition} 종합=${result.overallSignal}(${result.score}점) ${pricePos}` +
                (result.goldenCross ? ' ⭐골든크로스' : '') +
                (result.deathCross ? ' ⚠️데드크로스' : '') +
                patternStr,
            );
          }
        }
      }

      const learnedInsights = await getLearnedInsightsForPrompt().catch(() => '');

      let context = await buildTrackBContext({
        mode,
        scores,
        livePrices,
        openChains,
        balance,
      });

      if (technicalsSummary.length > 0) {
        context += `\n\n## 기술적 지표 분석\n${technicalsSummary.join('\n')}`;
      }
      if (learnedInsights) {
        context += `\n${learnedInsights}`;
      }
      // 손실 종목 재진입 금지 — AI에게도 명시
      if (recentLossCodes.size > 0) {
        context += `\n\n## 🚫 손절 쿨다운 (14일 재진입 금지)\n${[...recentLossCodes].join(', ')}\n→ 위 종목은 최근 손절 이력이 있습니다. 절대 BUY 결정 금지.`;
      }

      const execParams = { mode, context, customPrompt: strategy?.claude_prompt ?? undefined };

      // 6-1. Claude 매매 판단 (1순위)
      const hasClaudeKey = config.ai.anthropicKey && !config.ai.anthropicKey.startsWith('your_');
      if (hasClaudeKey) {
        try {
          decisions = await runClaudeExecution(execParams);
        } catch (claudeErr) {
          logger.warn(`⚠️ Claude 실행 실패: ${claudeErr}`, { component: 'TRACK_B' });
        }
      }

      // 6-2. Claude 실패 → Gemini Pro 매매 판단 (2순위)
      if (decisions.length === 0) {
        try {
          decisions = await runGeminiExecution(execParams);
        } catch (geminiErr) {
          logger.warn(`⚠️ Gemini 실행 실패: ${geminiErr}`, { component: 'TRACK_B' });
        }
      }
    }

    // 6-3. AI 모두 실패/스코어 없음/전부 HOLD → 기술적 지표 (3순위)
    const aiAllHold = decisions.length > 0 && decisions.every((d) => d.action === 'HOLD');
    if (decisions.length === 0 || aiAllHold) {
      if (aiAllHold) {
        // AI가 명시적으로 전부 HOLD를 반환한 경우:
        // 신규 진입(BUY/AVERAGE_DOWN)은 차단, 청산(SELL/FORCE_CLOSE)만 허용
        // → AI 판단을 존중하되 하드 룰 손익절은 아래 6-4 블록에서 처리
        logger.info(`🔄 AI 전부 HOLD → 기술적 폴백은 청산 신호만 허용 (신규 진입 차단)`, { component: 'TRACK_B' });
        const orderableCashForTech = Math.max(0, balance.orderableCash - ((balance as any).reservedWithdraw ?? 0));
        const totalAssetsForTech = balance.totalEvalAmount + orderableCashForTech;
        const techDecisions = technicalFallbackDecisions({
          mode,
          watchlist: watchlist.map((w) => ({ stock_code: w.stock_code, stock_name: w.stock_name })),
          livePrices,
          chartData,
          openChains,
          orderableCash: 0, // 신규 진입 예산 0 — 청산 판단만 생성됨
          maxPositionKrw: config.risk.maxPositionKrw,
          totalAssets: totalAssetsForTech,
          lossBlockedCodes: recentLossCodes,
          aiScores: scores.map((s: any) => ({ stock_code: s.stock_code, score: s.composite_score ?? 0 })),
          takeProfitPct: strategy?.take_profit_pct ?? undefined,
          stopLossPct: strategy?.stop_loss_pct ?? undefined,
          buyThreshold: strategy?.buy_threshold ?? undefined,
        });
        // BUY/AVERAGE_DOWN 제외 — SELL/PARTIAL_SELL/FORCE_CLOSE만 병합
        const exitOnly = techDecisions.filter((d) => ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action));
        decisions = [...exitOnly];
      } else {
        logger.info(`🔧 기술적 지표 기반 자동매매 모드 (스코어=${scores.length}개)`, { component: 'TRACK_B' });
        const orderableCashForTech = Math.max(0, balance.orderableCash - ((balance as any).reservedWithdraw ?? 0));
        const totalAssetsForTech = balance.totalEvalAmount + orderableCashForTech;
        const techDecisions = technicalFallbackDecisions({
          mode,
          watchlist: watchlist.map((w) => ({ stock_code: w.stock_code, stock_name: w.stock_name })),
          livePrices,
          chartData,
          openChains,
          orderableCash: orderableCashForTech,
          maxPositionKrw: config.risk.maxPositionKrw,
          totalAssets: totalAssetsForTech,
          lossBlockedCodes: recentLossCodes,
          aiScores: scores.map((s: any) => ({ stock_code: s.stock_code, score: s.composite_score ?? 0 })),
          takeProfitPct: strategy?.take_profit_pct ?? undefined,
          stopLossPct: strategy?.stop_loss_pct ?? undefined,
          buyThreshold: strategy?.buy_threshold ?? undefined,
        });
        decisions = [...techDecisions];
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // 6-3-B. 💰 유휴 현금 파킹
    //   - 현금 비중 15% 초과 + BUY 신호 없음 → 머니마켓 ETF 자동 매수
    //   - 머니마켓 ETF: 사실상 원금 손실 0%, 익일물 콜금리 수준 (~3.4% 연간)
    //   - 채권 아님 — 단기금융(MMF) 유형, 수수료보다 높은 수익 보장
    //   - KODEX 200은 하락장 방어용으로만 사용 (defense-park.ts)
    // ─────────────────────────────────────────────────────────────────
    if (mode !== 'SCALPING') {
      const hasBuyDecision = decisions.some((d) => d.action === 'BUY' || d.action === 'AVERAGE_DOWN');
      const alreadyIdleParked = openChains.some((c) => c.stock_code === IDLE_PARK_CODE && Number(c.total_quantity) > 0);
      const orderableCash = Math.max(0, balance.orderableCash - ((balance as any).reservedWithdraw ?? 0));
      const totalAssets = balance.totalEvalAmount + orderableCash;
      const idleCashPct = totalAssets > 0 ? (orderableCash / totalAssets) * 100 : 0;

      // 파킹 진입: 매수 결정 후 남은 현금이 10% 초과 + 파킹 여유 있을 때
      // alreadyIdleParked는 현재 보유 수량 기준 — 일부 매도 후 현금 재쌓이면 추가 파킹 허용
      const plannedBuyCash = decisions
        .filter((d) => (d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && d.stock_code !== IDLE_PARK_CODE)
        .reduce((sum, d) => sum + (d.limit_price ?? 0) * (d.quantity ?? 0), 0);
      const cashAfterBuys = Math.max(0, orderableCash - plannedBuyCash);
      const idlePctAfterBuys = totalAssets > 0 ? (cashAfterBuys / totalAssets) * 100 : 0;

      // 현재 파킹된 ETF 평가금액 계산 (이미 많이 파킹돼 있으면 추가 불필요)
      const idleParkChain = openChains.find((c) => c.stock_code === IDLE_PARK_CODE);
      const idleParkValue = idleParkChain
        ? (livePrices.get(IDLE_PARK_CODE)?.currentPrice ?? Number(idleParkChain.avg_buy_price ?? 0)) * Number(idleParkChain.total_quantity)
        : 0;
      const idleParkPct = totalAssets > 0 ? (idleParkValue / totalAssets) * 100 : 0;
      // 파킹 잔액 + 신규 파킹 대상이 전체의 30% 이하일 때만 추가 파킹 (무한 파킹 방지)
      const canParkMore = idleParkPct < 30;

      if (idlePctAfterBuys > 10 && !alreadyIdleParked && canParkMore) {
        const parkPrice = livePrices.get(IDLE_PARK_CODE);
        if (parkPrice && parkPrice.currentPrice > 0) {
          // 매수 후 남은 현금의 85%를 파킹 (15%는 긴급 매수 여유분)
          const parkAmount = cashAfterBuys * 0.85;
          const qty = Math.floor(parkAmount / parkPrice.currentPrice);
          if (qty > 0) {
            logger.info(
              `💰 유휴 현금 머니마켓 파킹: 전체 ${idleCashPct.toFixed(1)}% / 매수 후 ${idlePctAfterBuys.toFixed(1)}% 대기 → ${IDLE_PARK_NAME} ${qty}주 (${Math.round(parkAmount).toLocaleString()}원)`,
              { component: 'TRACK_B' },
            );
            decisions.push({
              action: 'BUY',
              stock_code: IDLE_PARK_CODE,
              quantity: qty,
              price_type: 'MARKET',
              limit_price: parkPrice.currentPrice,
              reasoning: `유휴 현금 파킹: 현금 ${idlePctAfterBuys.toFixed(1)}%(매수후 잔여) → ${IDLE_PARK_NAME} (단기금융형, 익일물 콜금리 수준 수익)`,
              confidence: 0.95,
            });
          }
        }
      }

      // 파킹 해제: 머니마켓 ETF 보유 중 + 실제 매수 신호 발생 → 파킹 매도 후 재투자
      if (hasBuyDecision && alreadyIdleParked) {
        const parkChain = openChains.find((c) => c.stock_code === IDLE_PARK_CODE);
        if (parkChain && parkChain.total_quantity > 0) {
          const parkPrice = livePrices.get(IDLE_PARK_CODE);
          if (parkPrice && parkPrice.currentPrice > 0) {
            const parkPnlPct = parkChain.avg_buy_price
              ? ((parkPrice.currentPrice - Number(parkChain.avg_buy_price)) / Number(parkChain.avg_buy_price)) * 100
              : 0;
            logger.info(
              `🔄 머니마켓 파킹 해제: 매수 신호 → ${IDLE_PARK_NAME} ${parkChain.total_quantity}주 매도 (수익률 ${parkPnlPct.toFixed(2)}%)`,
              { component: 'TRACK_B' },
            );
            decisions.push({
              action: 'FORCE_CLOSE',
              stock_code: IDLE_PARK_CODE,
              quantity: parkChain.total_quantity,
              price_type: 'MARKET',
              reasoning: `머니마켓 파킹 해제: 매수 신호 발생 → ${IDLE_PARK_NAME} 청산 후 재투자 (보유 수익 ${parkPnlPct.toFixed(2)}%)`,
              confidence: 0.95,
            });
          }
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // 6-4. 🔒 하드 룰: AI 결정과 무관하게 익절/손절 강제 실행
    //   - Claude가 HOLD 해도 목표 수익률/손절 초과 시 무조건 실행
    //   - chain.target_profit_pct / chain.stop_loss_pct (매수 당시 저장된 값) 기준
    //   - DB 전략 세팅값(strategy.take_profit_pct 등)으로 override
    // ─────────────────────────────────────────────────────────────────
    {
      const baseParams = (await import('../../config/constants.js')).STRATEGY_PARAMS[mode];
      const dbTakeProfit = strategy?.take_profit_pct ?? null;
      const dbStopLoss = strategy?.stop_loss_pct ?? null;

      for (const chain of openChains) {
        const price = livePrices.get(chain.stock_code);
        if (!price || !chain.avg_buy_price) continue;
        const avgBuy = Number(chain.avg_buy_price);
        if (avgBuy <= 0 || price.currentPrice <= 0) continue;
        const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;

        // 이미 매도 결정이 있으면 스킵 (중복 방지)
        const alreadySelling = decisions.some(
          (d) => d.stock_code === chain.stock_code && ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action),
        );
        if (alreadySelling) continue;

        // 체인 저장값 vs DB 세팅값 중 더 보수적인 값 사용
        const targetPct = dbTakeProfit ?? (Number(chain.target_profit_pct) || baseParams.takeProfitPct);
        const stopPct = dbStopLoss ?? (Number(chain.stop_loss_pct) || baseParams.stopLossPct);

        if (pnlPct >= targetPct) {
          const sellRatio = baseParams.takeProfitRatio ?? 0.5;
          const sellQty = Math.ceil(chain.total_quantity * sellRatio);
          const safeQty = Math.min(sellQty, chain.total_quantity);
          if (safeQty > 0) {
            logger.info(`🔒 하드 익절: ${chain.stock_code} +${pnlPct.toFixed(1)}% (목표 ${targetPct}%) — AI HOLD 무시`, { component: 'TRACK_B' });
            decisions.push({
              action: safeQty >= chain.total_quantity ? 'SELL' : 'PARTIAL_SELL',
              stock_code: chain.stock_code,
              quantity: safeQty,
              price_type: 'MARKET',
              reasoning: `하드 익절: +${pnlPct.toFixed(1)}% (목표 ${targetPct}%) — AI 결정 무관 강제 실행`,
              confidence: 1.0,
            });
          }
        } else if (pnlPct <= stopPct) {
          logger.info(`🔒 하드 손절: ${chain.stock_code} ${pnlPct.toFixed(1)}% (한도 ${stopPct}%) — AI HOLD 무시`, { component: 'TRACK_B' });
          decisions.push({
            action: 'FORCE_CLOSE',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `하드 손절: ${pnlPct.toFixed(1)}% (한도 ${stopPct}%) — AI 결정 무관 강제 실행`,
            confidence: 1.0,
          });
        }
      }
    }

    // 7. HOLD 제외 + BUY 결정에 현재가 주입 (executor 재조회 실패 방지)
    for (const d of decisions) {
      if ((d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && !d.limit_price) {
        const livePrice = livePrices.get(d.stock_code)?.currentPrice ?? 0;
        if (livePrice > 0) d.limit_price = livePrice;
      }
    }

    // 7-B. 수량 강제 보정: AI가 1주처럼 과소 계산 시 예산 기반으로 상향
    // AI는 수량 계산 오류가 잦음 → 코드에서 직접 검증하고 보정
    {
      const orderableCashNow = Math.max(0, balance.orderableCash - ((balance as any).reservedWithdraw ?? 0));
      const _params = STRATEGY_PARAMS[mode];
      const budgetPerBuy = Math.floor(orderableCashNow / _params.splitCount);
      for (const d of decisions) {
        if ((d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && (d.limit_price ?? 0) > 0 && d.stock_code !== IDLE_PARK_CODE) {
          const price = d.limit_price!;
          const maxQtyByRisk = Math.floor(config.risk.maxPositionKrw / price);
          const targetQty = Math.min(maxQtyByRisk, Math.max(1, Math.floor(budgetPerBuy / price)));
          if ((d.quantity ?? 0) < targetQty) {
            logger.info(
              `📊 수량 보정: ${d.stock_code} ${d.quantity ?? 0}주 → ${targetQty}주 (예산 ${budgetPerBuy.toLocaleString()}원 ÷ ${price.toLocaleString()}원, 한도 ${maxQtyByRisk}주)`,
              { component: 'TRACK_B' },
            );
            d.quantity = targetQty;
          }
        }
      }
    }
    // 현재가 없는 BUY 결정 제외 (가격 조회 불가 종목 → 매수 불가)
    const actionable = decisions.filter((d) => {
      if (d.action !== 'HOLD' && (d.action === 'BUY' || d.action === 'AVERAGE_DOWN')) {
        const hasPrice = (d.limit_price ?? 0) > 0;
        if (!hasPrice) logger.warn(`가격 없는 BUY 제외: ${d.stock_code}`, { component: 'TRACK_B' });
        return hasPrice;
      }
      return d.action !== 'HOLD';
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await logSystem(
      'INFO',
      'TRACK_B',
      `파이프라인 완료 (${elapsed}초): ${decisions.length}개 판단, ${actionable.length}개 실행 대기`,
    );

    logger.info(`✅ Track B 완료 (${elapsed}초): 총 ${decisions.length}개 판단, ${actionable.length}개 액션`, {
      component: 'TRACK_B',
    });

    return actionable;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await logSystem('ERROR', 'TRACK_B', `파이프라인 실패: ${msg}`);
    logger.error(`❌ Track B 실패: ${msg}`, { component: 'TRACK_B' });
    return []; // 실패 시 안전하게 아무것도 안 함
  }
}
