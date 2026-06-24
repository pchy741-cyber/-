/**
 * 매수 후보 필터링 — 오케스트레이터
 *
 * 5단계 파이프라인:
 *   1. 하드 게이트 (hard-gates)    → 절대 차단
 *   2. 스코어링   (scoring)        → 보너스·기술점수
 *   3. 품질 게이트 (quality-gates)  → 6개 중 N개
 *   4. 리스크 게이트 (risk-gates)   → 5개 중 N개
 *   5. 진입 판정  (entry-decision) → 레짐/스캘핑/AI/꽁돈
 *
 * 각 모듈은 독립적이며, FilterContext 타입을 통해서만 데이터를 주고받는다.
 * 모듈 간 직접 import 없음 → 크로스오염 원천 차단.
 */

import { analyzeTechnicals } from '../../analysis/indicators.js';
import { getCtxIsPaper } from '../../config/context.js';
import { logger } from '../../utils/logger.js';
import { tryFinalEntry, tryRegimeRouterEntry } from './filters/entry-decision.js';
// ── 필터 모듈 (각각 독립, 크로스 import 없음) ──
import { isHardBlocked } from './filters/hard-gates.js';
import { checkQualityGates } from './filters/quality-gates.js';
import { checkRiskGates, isBreakoutBlocked } from './filters/risk-gates.js';
import { computeScoring } from './filters/scoring.js';
import type { HardGateInput } from './filters/types.js';
import { routeByRegime } from './strategy-router.js';
import {
  type BuyCandidate,
  buildAiScoreMap,
  hasNoAiScores,
  resolveStrategyParams,
  type TechnicalFallbackParams,
} from './technical-fallback-types.js';
import { MEGA_CAP_PRIORITY_CODES } from './trading-rules.js';

/**
 * 매수 후보 필터링 (퍼블릭 API — 호출부 변경 불필요)
 */
export async function filterBuyCandidates(params: TechnicalFallbackParams): Promise<BuyCandidate[]> {
  const {
    mode,
    watchlist,
    livePrices,
    chartData,
    openChains,
    junkStockCodes,
    lossBlockedCodes,
    bigLossBlockedCodes,
    manuallySoldCodes,
    recentlySoldCodes,
    winRates,
    marketSignals,
    lossHistory,
  } = params;

  const strategyParams = resolveStrategyParams(mode, params);
  const aiScoreMap = buildAiScoreMap(params.aiScores);
  const noAiScores = hasNoAiScores(params.aiScores);
  const feedbackRequirePullback = params.requirePullback ?? false;
  const feedbackMinVolRatio = params.minVolumeRatio ?? 1.0;
  const openStockCodes = new Set(openChains.map((c) => c.stock_code));
  const isPaper = getCtxIsPaper();

  // 거래대금 맵 생성 (스마트 재진입 주도주 필터용, KIS acml_tr_pbmn 공식값 → 원 단위)
  const tradingValues = new Map<string, number>();
  for (const [stockCode, price] of livePrices) {
    if (price.tradingValueEok > 0) {
      tradingValues.set(stockCode, price.tradingValueEok * 100_000_000);
    }
  }

  const candidates: BuyCandidate[] = [];

  for (const stock of watchlist) {
    // ━━━ BREAKOUT 모드 전용 경로 (기존 5단계 파이프라인 완전 우회) ━━━
    if (mode === 'BREAKOUT') {
      const hardGateInput: HardGateInput = {
        stock,
        openStockCodes,
        lossBlockedCodes,
        bigLossBlockedCodes,
        manuallySoldCodes,
        recentlySoldCodes,
        junkStockCodes,
        winRates,
        livePrices,
        aiScoreMap,
        isPaper,
        lossHistory,
        chartData,
        tradingValues,
      };
      if (isHardBlocked(hardGateInput)) continue;

      const candles = chartData.get(stock.stock_code);
      const price = livePrices.get(stock.stock_code);
      if (!candles || candles.length < 30 || !price || price.currentPrice <= 0) continue;

      // Lazy import: BREAKOUT이 아닌 모드에서는 절대 로드되지 않음
      const { analyzeBreakoutSignals } = await import('../../analysis/breakout-detection.js');
      const breakout = analyzeBreakoutSignals(candles);
      if (!breakout.detected || !breakout.volumeConfirmed) continue;

      const tech = analyzeTechnicals(candles);
      if (!tech) continue;

      logger.info(
        `  📈 ${stock.stock_code}: BREAKOUT [${breakout.subStrategy}] conf=${breakout.confidence.toFixed(2)} vol=${breakout.details.volumeRatio.toFixed(1)}x | ${breakout.reason}`,
        { component: 'TRACK_B' },
      );

      candidates.push({
        stock_code: stock.stock_code,
        tech,
        price,
        candleBonus: 0,
        breakoutSignal: breakout,
        smartReentrySl: hardGateInput._smartReentrySl,
      });
      continue;
    }

    const megaCap = MEGA_CAP_PRIORITY_CODES.get(stock.stock_code);

    // ━━━ 1단계: 하드 게이트 ━━━
    const hardGateInput: HardGateInput = {
      stock,
      openStockCodes,
      lossBlockedCodes,
      bigLossBlockedCodes,
      manuallySoldCodes,
      recentlySoldCodes,
      junkStockCodes,
      winRates,
      livePrices,
      aiScoreMap,
      isPaper,
      lossHistory,
      chartData,
      tradingValues,
    };
    if (isHardBlocked(hardGateInput)) continue;

    // ━━━ v13-fix: 극단 급락 종목만 신규매수 차단 (안전망) ━━━
    // 당일 -5% 이상 폭락 종목만 신규매수 차단 (메가캡 -7%)
    // 물타기(AVERAGE_DOWN)는 별도 로직에서 허용 — 여기는 신규 진입만 제한
    {
      const priceCheck = livePrices.get(stock.stock_code);
      if (priceCheck && priceCheck.changePct < 0 && !openStockCodes.has(stock.stock_code)) {
        const isMc = MEGA_CAP_PRIORITY_CODES.has(stock.stock_code);
        const extremeLimit = isMc ? -7.0 : -5.0;
        if (priceCheck.changePct <= extremeLimit) {
          logger.info(
            `  🔪 ${stock.stock_code}: 폭락 신규매수 차단 (당일 ${priceCheck.changePct.toFixed(1)}% ≤ ${extremeLimit}%) → 스킵`,
            { component: 'TRACK_B' },
          );
          continue;
        }
      }
    }

    // ━━━ 데이터 준비 ━━━
    const candles = chartData.get(stock.stock_code);
    const price = livePrices.get(stock.stock_code);
    if (!candles || candles.length < 30 || !price || price.currentPrice <= 0) continue;

    const tech = analyzeTechnicals(candles);
    if (!tech) continue;

    // 레짐 라우터
    const closes = candles.map((c) => c.close);
    const aiScore = aiScoreMap.get(stock.stock_code) ?? 0;
    const regimeRoute = routeByRegime(tech, closes, aiScore);

    // buyThreshold (대형주 보정 + 레짐 보정)
    const buyThreshold =
      (megaCap ? strategyParams.buyThreshold - megaCap.thresholdReduction : strategyParams.buyThreshold) +
      regimeRoute.buyThresholdAdj;

    // ━━━ 2단계: 스코어링 ━━━
    const scoring = computeScoring({
      stock,
      tech,
      candles,
      price,
      signals: marketSignals?.get(stock.stock_code),
      mode,
      megaCap,
      aiScore,
      feedbackMinVolRatio,
    });

    // 스코어 로깅
    logger.info(
      `  📊 ${stock.stock_code}: score=${tech.score}${scoring.candleBonus > 0 ? `+${scoring.candleBonus}캔들` : ''} RSI=${tech.rsi14.toFixed(0)} ADX=${tech.adx14.toFixed(0)}(${tech.trendStrength}) MACD=${tech.macdCrossover} vol=${tech.volumeRatio.toFixed(2)}x 레짐=${regimeRoute.regime}${regimeRoute.routed ? '✓' : ''}`,
      { component: 'TRACK_B' },
    );

    // 승률피드백: 눌림목 필수 구간
    if (feedbackRequirePullback && !scoring.truePullbackPattern && scoring.fibBonus === 0 && aiScore < 92) {
      logger.info(`  ⏸️ ${stock.stock_code}: 승률피드백 눌림필수 → 스킵`, { component: 'TRACK_B' });
      continue;
    }

    const noAiForStock = noAiScores || aiScore === 0;

    // ━━━ 3단계: 품질 게이트 ━━━
    const quality = checkQualityGates({
      tech,
      scoring,
      mode,
      aiScore,
      buyThreshold,
      megaCap,
      noAiForStock,
      feedbackMinVolRatio,
      curPrice: price.currentPrice,
      isRallyDay: params.kospiBoost,
    });
    if (!quality.passed) {
      const d = quality.details;
      logger.info(
        `  🔍 ${stock.stock_code}: 품질게이트 ${quality.count}/${quality.min} 미달 [vol=${d.vol} trend=${d.trend} dir=${d.dir} rsi=${d.rsi} cf=${d.cf} sig=${d.sig}] → 스킵`,
        { component: 'TRACK_B' },
      );
      continue;
    }

    // ━━━ 4단계: 리스크 게이트 ━━━
    const riskInput = {
      stockCode: stock.stock_code,
      tech,
      candles,
      scoring,
      aiScore,
      signals: marketSignals?.get(stock.stock_code),
      regimeRoute,
      curPrice: price.currentPrice,
    };

    // 가짜돌파 하드블록
    if (isBreakoutBlocked(riskInput)) continue;

    const risk = checkRiskGates(riskInput);
    if (!risk.passed) {
      const d = risk.details;
      logger.info(
        `  ⚠️ ${stock.stock_code}: 리스크게이트 ${risk.count}/${risk.min} 미달 [chase=${d.chase} tech=${d.tech} vp=${d.vp} short=${d.short} breakout=${d.breakout}] → 스킵`,
        { component: 'TRACK_B' },
      );
      continue;
    }

    // ━━━ 5단계: 진입 판정 ━━━
    const entryInput = {
      stockCode: stock.stock_code,
      tech,
      price,
      scoring,
      regimeRoute,
      aiScore,
      buyThreshold,
      mode,
      allowScalpingBuys: params.allowScalpingBuys,
      winRates,
      noAiScores, // 전역 AI 탈락 여부 → entry-decision 폴백 판단용
    };

    // 5a. 레짐 라우터 빠른 진입
    const smartSl = hardGateInput._smartReentrySl;

    const regimeVerdict = tryRegimeRouterEntry(entryInput);
    if (regimeVerdict.action === 'BUY') {
      candidates.push({
        stock_code: stock.stock_code,
        tech,
        price,
        candleBonus: scoring.candleBonus,
        regimeRoute,
        smartReentrySl: smartSl,
      });
      continue;
    }

    // 5b. AI 필수 + 꽁돈 + 기술점수
    const finalVerdict = tryFinalEntry(entryInput);
    if (finalVerdict.action === 'BUY') {
      candidates.push({
        stock_code: stock.stock_code,
        tech,
        price,
        candleBonus: scoring.candleBonus,
        regimeRoute,
        smartReentrySl: smartSl,
      });
    }
  }

  return candidates;
}
