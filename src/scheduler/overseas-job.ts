/**
 * 해외주식 자동매매 오케스트레이터
 * 모든 헬퍼/상태는 ./overseas/ 모듈에서 관리
 * 이 파일은 runOverseasJob() 메인 루프만 담당
 */
import { analyzeTechnicals, type OHLCV } from '../analysis/indicators.js';
import { ALLOCATION_GOLDEN, GATE, OVERSEAS, OVERSEAS_FEE_PCT, SECTOR_CLASS } from '../config/constants.js';
import { runWithMode } from '../config/context.js';
import { paperOnly } from '../config/index.js';
import { cacheSet } from '../cache/memory.js';
import { getPool, logSystem } from '../db/client.js';
import { getOverseasDailyChart, getOverseasPrice } from '../kis/overseas.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { activateKillSwitch, isKillSwitchActive, reportError, reportSuccess } from '../risk/kill-switch.js';
import { getOverseasLossTiers } from '../risk/seed-capital.js';

const SCOPE = 'OVERSEAS' as const;

// ── Paper/Live 병행운영: AsyncLocalStorage 컨텍스트 기반 ──
import { getCtxIsPaper } from '../config/context.js';

/** 현재 overseas-job 실행 모드 (AsyncLocalStorage 컨텍스트 → 전역 폴백) */
function isPaper(): boolean {
  return getCtxIsPaper();
}

import { analyzeOverseasWithAI, type OverseasStockInput } from '../ai/overseas/analyzer.js';
import { getAIGeneratedInsights } from '../ai/overseas/insights-generator.js';
import { checkUsEarnings } from '../automation/earnings-sentinel.js';
import { fetchExchangeRate } from '../automation/macro-data.js';
import { setOverseasScores } from '../cache/overseas-scores.js';
import { getFearGreedIndex, getUpcomingEarnings, interpretMarketSentiment } from '../market/external-signals.js';
import { getMacroSignal } from '../market/macro-signal.js';
import { touchActivity } from '../utils/cloud-sql-wake.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

export {
  cancelAllPendingOverseasOrders,
  getUserInsights,
  setUserInsights,
  syncPendingOverseasOrders,
} from './overseas/order-sync.js';
// ── 모듈 re-export (기존 import 경로 유지) ──
export {
  isOverseasJobRunning,
  resetAsiaSessionCache,
  resetUSSessionCache,
  restoreSessionStartValue,
  setShuttingDown,
} from './overseas/session.js';

import { fetchKospiRegime } from '../ai/track-b/market-regime.js';
import { logSystemEvent } from '../utils/system-events.js';
import { getOverseasDynamic } from '../config/constants.js';
import { getAllocRisk } from '../db/alloc-risk-cache.js';
import { isLoopActive, reportNoBuyCandidates } from './loop-mode.js';
import {
  getOverseasWinRates,
  getPendingOverseasStocks,
  getRecentPerfSummary,
  type OverseasWinRate,
} from './overseas/analytics.js';
import { filterAndRankBuyTargets } from './overseas/buy-filter.js';
// turtle 전략 비활성화 — main buy-filter와 중복, 황금비율 체계로 대체
// import { calcTurtleSignal, processTurtleExits } from './overseas/turtle.js';
import { enforceConcentrationCap } from './overseas/concentration-cap.js';
import { checkCorrelationLimit } from './overseas/correlation-engine.js';
import { getCrossMarketSignals } from './overseas/cross-market.js';
import { detectEarningsDrift } from './overseas/earnings-drift.js';
import { executeOverseasOrder } from './overseas/executor.js';
import { reconcileCashWithKIS, syncHoldingsFromKIS } from './overseas/kis-sync.js';
import { evaluateMarketDefense } from './overseas/market-defense.js';
import { batchMultiTF } from './overseas/multi-timeframe.js';
import { sendBuyRecommendations, sendHoldingAlerts } from './overseas/notifications.js';
import {
  getBigLossBlockedOverseas,
  getLossCooldownStocks,
  getManualSellCooldownStocks,
  getRecentLossStocks,
  getUserInsights,
  syncPendingOverseasOrders,
} from './overseas/order-sync.js';
// rotation-selling 비활성화 — rebalancer에 흡수
// import { executeRotationSelling } from './overseas/rotation-selling.js';
import { calcPositionSize } from './overseas/position-sizing.js';
import { rebalancePortfolio } from './overseas/rebalancer.js';
import {
  calcDynamicTpSl,
  calcDynamicTrailDrop,
  calcRollingKelly,
  calcStockEVMultipliers,
  calcUncertaintyPenalty,
  extractTradingPatterns,
  getGradualCooldown,
  getGradualCooldownStocks,
  getMemoryBlockedStocks,
  getVixRegime,
} from './overseas/risk-intelligence.js';
import { buildScaleInReservation, processScaleIns, shouldUseScaleIn } from './overseas/scale-in-manager.js';
// ── 추출 모듈 ──
import { evaluateSells, type TechResult } from './overseas/sell-logic.js';
import {
  getKSTDateString,
  getOpenMarketRegions,
  getSessionCache,
  getUSSessionId,
  modeKey,
  overseasState,
  type SessionCache,
  setSessionCache,
  setSessionStartValue,
} from './overseas/session.js';
import { getActiveSessionBrief } from './overseas/session-strategy.js';
import { detectSqueezeBreakouts } from './overseas/squeeze-detector.js';
import {
  classifyBucket,
  ensureOverseasTable,
  getBucketWeight,
  getCash,
  getCashKrw,
  getHoldings,
  getPaperSeedKrw,
  updateTradeState,
} from './overseas/state.js';
import { getTradeReviewInsights } from './overseas/trade-reviewer.js';
import { monitorVisionScalp } from './overseas/vision-scalp.js';
// ── 모듈 import ──
import { GLOBAL_WATCHLIST, WATCHLIST_BY_CODE } from './overseas/watchlist.js';

/**
 * 글로벌 주식 자동매매 Job
 * AI(Claude) + 기술적 지표 복합 판단
 * 최대 5종목 동시 보유, 종목당 $1,500 / 20% 중 작은 값
 */
// ⚡ LUNCH 시간 throttle — 12:00~14:00 ET 구간 30분 간격으로 확대 (paper/live 독립)
const _lastLunchRunAt = new Map<string, number>();
const LUNCH_THROTTLE_MS = 30 * 60 * 1000; // 30분

export async function runOverseasJob(_opts?: { isPaper?: boolean; isRescan?: boolean }): Promise<void> {
  // isPaper는 runWithMode(ctx)로 주입 — getCtxIsPaper()로 읽음
  const s = overseasState; // shorthand
  const modeK = modeKey(isPaper()); // paper/live 모드 키

  if (s.isRunning.get(modeK)) return;
  if (s._shuttingDown) {
    logger.info('Shutdown 진행 중 — 해외 Job 스킵', { component: 'OVERSEAS' });
    return;
  }

  // ⚡ US LUNCH 시간(12:00~14:00 ET) throttle — 30분 간격으로 확대 (AI 리소스 절감)
  {
    const { getUSMarketPhase } = await import('./loop-mode.js');
    const usPhase = getUSMarketPhase();
    if (usPhase === 'LUNCH') {
      const now = Date.now();
      const lastRun = _lastLunchRunAt.get(modeK) ?? 0;
      if (now - lastRun < LUNCH_THROTTLE_MS) {
        logger.debug(`⏭️ 해외 Job 스킵 [${modeK}] — US LUNCH 시간 throttle (30분 간격)`, { component: 'OVERSEAS' });
        return;
      }
      _lastLunchRunAt.set(modeK, now);
    }
  }

  // Kill Switch: 매도(탈출)는 항상 허용, 매수만 차단 (아래에서 분기)
  const killSwitchBuyBlock = isKillSwitchActive(SCOPE);
  if (killSwitchBuyBlock) {
    logger.warn('🛑 Kill Switch 활성 [해외] — 매수 차단, 매도만 실행', { component: 'OVERSEAS' });
  }

  // DB Advisory Lock — Cloud Run 롤링 배포 시 동시 실행 방지
  const LOCK_ID = 0x4f564553 + (isPaper() ? 1 : 0); // 'OVES' + paper/live 분리
  let lockClient: any = null;
  try {
    lockClient = await getPool().connect();
    const { rows } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_ID]);
    if (!rows[0]?.locked) {
      logger.warn('다른 인스턴스가 해외 Job 실행 중 — 스킵', { component: 'OVERSEAS' });
      lockClient.release();
      return;
    }
  } catch (lockErr) {
    lockClient?.release();
    lockClient = null;
    logger.error(
      `Advisory lock 획득 실패 [${isPaper() ? 'paper' : 'live'}] — 안전을 위해 중단: ${(lockErr as Error).message}`,
      { component: 'OVERSEAS' },
    );
    return;
  }

  s.isRunning.set(modeK, true);
  const jobTimeout = setTimeout(async () => {
    if (s.isRunning.get(modeK)) {
      logger.error('해외 Job 3분 타임아웃 — isRunning 강제 해제 + advisory lock 반환', { component: 'OVERSEAS' });
      s.isRunning.set(modeK, false);
      // advisory lock 해제 — 다음 사이클 deadlock 방지
      if (lockClient) {
        try { await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]); } catch { /* ignore */ }
        try { lockClient.release(); } catch { /* ignore */ }
        lockClient = null;
      }
    }
  }, 180_000);

  try {
    // ── 계좌 정합 (장중/장외 무관 항상 실행) ──
    await ensureOverseasTable();
    if (!isPaper()) {
      await syncPendingOverseasOrders();
      await syncHoldingsFromKIS(); // is_paper=NULL 정리 + 수동매매 반영
    }

    // ── 시장 시간 필터 ──
    const openRegions = getOpenMarketRegions();
    const isUSExtended = openRegions.has('US_EXTENDED') && !openRegions.has('US');

    // ── 현금 동기화 (시장 마감 무관 항상 실행) ──
    // KIS psamount API는 통합증거금 전체를 반환. 한국장 개장 중에는 국내 매매용 현금까지
    // 해외 가용금액에 포함되어 overseas_state['cash']가 과도하게 설정될 수 있음.
    // 기본: 한국장 마감 시에만 reconcile. 단, overseas cash=0이면 KR장 중에도 1회 복구
    if (!isPaper()) {
      const isKROpen = openRegions.has('KR');
      if (!isKROpen) {
        await reconcileCashWithKIS();
      } else {
        // KR장 중이지만 overseas cash가 0이면 1회 복구 (서버 재시작 시 cash=0 교착 방지)
        const currentOsCashKrw = await getCashKrw();
        if (currentOsCashKrw <= 0) {
          logger.info('💱 KR장 중이지만 overseas cash=0 → 1회 복구 reconcile 실행', { component: 'OVERSEAS' });
          await reconcileCashWithKIS();
        }
      }
    }

    if (openRegions.size === 0) {
      logger.info('🌏 모든 해외 시장 마감 — 스킵', { component: 'OVERSEAS' });
      // 🔒 early return — finally 블록이 정리하므로 즉시 return (v10.8: 이중 해제 방지)
      return;
    }
    // ── 환율 1회 조회 — 사이클 전체에서 동일 환율 사용 (환율 drift 방지) ──
    const cycleFxRate = await fetchExchangeRate();

    const allActiveStocks = GLOBAL_WATCHLIST.filter(
      (stock) => openRegions.has(stock.region) || (isUSExtended && stock.region === 'US'),
    );
    const isUSSession = openRegions.has('US') || isUSExtended;
    const _isAsiaSession = openRegions.has('JP') || openRegions.has('TW');
    const regionFlags = isUSExtended ? '🌙' : openRegions.has('US') ? '🇺🇸' : '🌏';

    const holdings = await getHoldings(isPaper());
    const pendingOrderStocks = await getPendingOverseasStocks(isPaper());
    const rawCash = await getCash(isPaper(), cycleFxRate);
    // 통합증거금(원화주문): live 모드에서 FX 환율 급변에 의한 외화 미수금 방지 — 5% 안전마진 적용
    let cash = !isPaper() && rawCash > 0 ? rawCash * (1 - GATE.FX_SAFETY_MARGIN) : rawCash;
    const usCodes = GLOBAL_WATCHLIST.filter((stock) => stock.region === 'US').map((stock) => stock.code);

    // ── 통합증거금: 해외/국내 비중 동적 할당 ──
    const holdingCost = Array.from(holdings.values()).reduce((s, h) => s + h.qty * h.avgPrice, 0);
    // v10.10.5: 목표 해외 포트폴리오 규모 — Paper/Live 모두 적용
    // (v10.10.4에서 Live만 적용 → Paper는 sizingPortfolioValue 누락)
    let targetOverseasUsd = 0;
    if (cycleFxRate > 0) {
      try {
        // 1) 전체 계좌 가치: Paper는 국내+해외 시드 합산, Live는 KIS 잔고
        let totalAccountKrw = 0;
        if (isPaper()) {
          const { PAPER_INITIAL_CAPITAL } = await import('../risk/paper-balance.js');
          totalAccountKrw = PAPER_INITIAL_CAPITAL + getPaperSeedKrw();
        } else {
          const { rows: totalRows } = await getPool().query(
            `SELECT value FROM overseas_state WHERE key = 'total_account_krw'`,
          );
          totalAccountKrw = Number(totalRows[0]?.value ?? 0);
        }

        if (totalAccountKrw > 0) {
          // 2) 사용자 설정 해외 목표비중 (portfolio_allocation_config.us_pct) 조회
          let userTargetPct: number | null = null;
          try {
            const { rows: allocRows } = await getPool().query(
              'SELECT us_pct FROM portfolio_allocation_config WHERE is_paper = $1 ORDER BY id DESC LIMIT 1',
              [isPaper()],
            );
            if (allocRows[0]?.us_pct != null) {
              userTargetPct = Number(allocRows[0].us_pct) / 100; // DB값 70 → 0.70
            }
          } catch { /* DB 미설정 시 시간대별 기본값 사용 */ }

          // 3) 시간대별 기본 비중 (통합증거금 현금 캡용)
          const isKROpen = openRegions.has('KR');
          const timeBasedPct = isUSSession
            ? 0.80
            : isUSExtended
            ? 0.70
            : isKROpen
            ? 0.35
            : openRegions.has('JP') || openRegions.has('TW')
            ? 0.55
            : 0.60;

          // 4) 사이징용 배분비율: 사용자 목표와 시간대별 중 큰 값
          //    → 사용자가 70%로 설정해도 US장(80%) 시간에는 80% 기준 사이징
          //    → KR장(35%)이라도 사용자 70%면 70% 기준 사이징 (소액 매수 방지)
          const sizingAllocPct = userTargetPct != null
            ? Math.max(userTargetPct, timeBasedPct)
            : timeBasedPct;

          // 5) 현금캡용 배분비율: Paper는 별도 풀이라 캡 불필요, Live는 시간대별 적용
          //    → Live에서도 사용자 목표 미만으로 내리지 않음
          const cashCapAllocPct = isPaper()
            ? 1.0 // Paper: 해외 시드 전체 사용 가능 (국내/해외 별도 풀)
            : (userTargetPct != null ? Math.max(userTargetPct, timeBasedPct) : timeBasedPct);

          const OVERSEAS_ALLOC_PCT = cashCapAllocPct;
          const maxOverseasKrw = totalAccountKrw * OVERSEAS_ALLOC_PCT;
          targetOverseasUsd = totalAccountKrw * sizingAllocPct / cycleFxRate;

          // 6) 현금 캡: 이미 해외에 투자된 금액도 비중에 포함 (Live만, Paper는 별도 풀)
          if (!isPaper()) {
            const currentOverseasKrw = holdingCost * cycleFxRate;
            const remainingAllocKrw = Math.max(0, maxOverseasKrw - currentOverseasKrw);
            const remainingAllocUsd = remainingAllocKrw / cycleFxRate;
            if (cash > remainingAllocUsd) {
              const label = isUSSession ? 'US장' : isUSExtended ? 'US프리/애프터' : isKROpen ? '국내장' : 'JP/TW/무장';
              logger.info(
                `💱 해외비중 상한: $${cash.toFixed(0)}→$${remainingAllocUsd.toFixed(0)} (총₩${(totalAccountKrw / 10000).toFixed(0)}만×${(OVERSEAS_ALLOC_PCT * 100).toFixed(0)}% - 보유$${holdingCost.toFixed(0)}) [${label}]`,
                { component: 'OVERSEAS' },
              );
              cash = remainingAllocUsd;
            }
          }
          logger.info(
            `📊 배분: 총₩${(totalAccountKrw / 10000).toFixed(0)}만 × ${(sizingAllocPct * 100).toFixed(0)}%(${userTargetPct != null ? `DB=${(userTargetPct * 100).toFixed(0)}%` : '기본'}) → 사이징=$${targetOverseasUsd.toFixed(0)} [${isPaper() ? 'PAPER' : 'LIVE'}]`,
            { component: 'OVERSEAS' },
          );
        }
      } catch { /* total_account_krw 미존재 시 무시 — 기존 로직 유지 */ }
    }

    // ── 루프 헬스 요약 ──
    const earlyEstPortfolio = cash + holdingCost;
    // v10.10.5: 동적 파라미터(maxPositions 등)도 목표배분 기준 적용
    const earlyEstSizing = targetOverseasUsd > 0 ? Math.max(earlyEstPortfolio, targetOverseasUsd) : earlyEstPortfolio;
    const allocRisk = await getAllocRisk(isPaper());
    const earlyMaxPos = getOverseasDynamic(earlyEstSizing, isPaper(), allocRisk.positionCapPct / 100).maxPositions;
    logger.info(
      `📊 해외 루프 ${regionFlags} | 현금 $${cash.toFixed(0)} | 보유 ${holdings.size}/${earlyMaxPos} ($${holdingCost.toFixed(0)}) | 종목풀 ${allActiveStocks.length} | ${isPaper() ? 'PAPER' : 'LIVE'}`,
      { component: 'OVERSEAS' },
    );

    // ── Vision Scalp TP/SL 모니터링 (→ overseas/vision-scalp.ts) ──
    await monitorVisionScalp(isPaper());

    // ── 세션 캐시 ──
    const todayStr = getKSTDateString();
    const usSessionId = getUSSessionId();
    const region = isUSSession ? ('US' as const) : ('ASIA' as const);
    const activeCache = getSessionCache(region);
    const sessionId = isUSSession ? usSessionId : todayStr;
    const isNewSession = !activeCache || activeCache.sessionDate !== sessionId;

    if (isNewSession) {
      setSessionCache(region, null);
      logger.info(`${regionFlags} 새 세션 시작 — 전 종목 점수 스캔 (${[...openRegions].join('/')})`, {
        component: 'OVERSEAS',
      });
    }

    const currentCache = getSessionCache(region);
    const activeStocks = allActiveStocks;
    if (currentCache) {
      logger.info(`세션 캐시 사용 — 전 종목(${activeStocks.length}) 시세 갱신 + 차트분석 캐시 재사용`, {
        component: 'OVERSEAS',
      });
    }

    touchActivity(); // 스케줄러 활동 → idle watcher에 알림
    logger.info(
      `${regionFlags} 해외주식 자동매매 시작 (${activeStocks.length}/${allActiveStocks.length}종목, 시장: ${[...openRegions].join('/')})`,
      { component: 'OVERSEAS' },
    );

    // ── 1. 시세 + 차트 병렬 수집 ──
    const techResults: TechResult[] = [];

    const BATCH = 8;
    for (let i = 0; i < activeStocks.length; i += BATCH) {
      const batch = activeStocks.slice(i, i + BATCH);
      const latestCache = getSessionCache(region);
      const settled = await Promise.allSettled(
        batch.map(async (stock) => {
          const price = await getOverseasPrice(stock.code, stock.exchange);
          const cached = latestCache?.techCache.get(stock.code);
          const chart = cached ? null : await getOverseasDailyChart(stock.code, stock.exchange, 40);
          return { stock, price, chart, cached };
        }),
      );

      for (const result of settled) {
        if (result.status !== 'fulfilled') continue;
        const { stock, price, chart, cached } = result.value;
        if (price.currentPrice <= 0) continue;

        const dayRange = price.dayHigh - price.dayLow;
        const dayRangePct = dayRange > 0 ? ((price.currentPrice - price.dayLow) / dayRange) * 100 : 50;
        const isMomentum = price.changePct >= 3 && dayRangePct >= 60;
        const isBigMover = price.changePct >= 5;

        let signal: string,
          score: number,
          rsi: number,
          adx: number,
          trendStrength: string,
          aboveMA20: boolean,
          aboveMA60: boolean;
        let bollingerSqueeze: boolean, bollingerBreakout: 'UP' | 'DOWN' | 'NONE';
        let atrPct: number;
        let vwapPosition: 'ABOVE' | 'BELOW' | 'AT' = 'AT';

        if (cached) {
          ({ signal, score, rsi, adx, trendStrength, aboveMA20, aboveMA60, bollingerSqueeze, bollingerBreakout } =
            cached);
          atrPct = cached.atrPct ?? 2.0;
          vwapPosition = cached.vwapPosition ?? 'AT';
        } else {
          if (!chart || chart.length < 30) continue;
          const candles: OHLCV[] = chart.map((c) => ({
            date: c.date,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          }));
          const tech = analyzeTechnicals(candles);
          if (!tech) continue;
          signal = tech.overallSignal;
          score = tech.score;
          rsi = tech.rsi14;
          adx = tech.adx14;
          trendStrength = tech.trendStrength;
          aboveMA20 = price.currentPrice > tech.sma20;
          aboveMA60 = price.currentPrice > tech.sma60;
          bollingerSqueeze = tech.bollingerSqueeze;
          bollingerBreakout = tech.bollingerBreakout;
          atrPct = tech.atrPct;
          vwapPosition = tech.vwapPosition;
        }

        // 최근 5일 저점 — 캐시 미사용 시 chart 데이터에서 직접 계산
        const prevLow5d = !cached && chart && chart.length >= 5
          ? Math.min(...chart.slice(-5).map((c) => c.low))
          : undefined;

        if (isNewSession) {
          const cacheTarget = getSessionCache(region);
          if (cacheTarget) {
            cacheTarget.techCache.set(stock.code, {
              score,
              rsi,
              adx,
              signal,
              trendStrength,
              isMomentum,
              dayRangePct,
              aboveMA20,
              aboveMA60,
              bollingerSqueeze,
              bollingerBreakout,
              atrPct,
              vwapPosition,
            });
          }
        }

        techResults.push({
          code: stock.code,
          name: stock.name,
          exchange: stock.exchange,
          sector: stock.sector,
          price,
          signal,
          score,
          rsi,
          adx,
          trendStrength,
          dayRangePct,
          isMomentum,
          isBigMover,
          aboveMA20,
          aboveMA60,
          bollingerSqueeze,
          bollingerBreakout,
          atrPct,
          vwapPosition,
          prevLow5d,
        });
        logger.info(
          `  ${stock.code}: $${price.currentPrice} ${price.changePct >= 0 ? '+' : ''}${price.changePct}% | ${signal}(${score}) RSI=${rsi.toFixed(0)} ADX=${adx.toFixed(0)} 일중${dayRangePct.toFixed(0)}%${isBigMover ? ' 🔥빅무버' : isMomentum ? ' 🚀모멘텀' : ''}${bollingerSqueeze ? (bollingerBreakout === 'UP' ? ' 💥BB↑' : bollingerBreakout === 'DOWN' ? ' 💥BB↓' : ' 🔧BBsq') : ''}${cached ? ' [캐시]' : ''}`,
          { component: 'OVERSEAS' },
        );
      }

      if (i + BATCH < activeStocks.length) {
        await sleep(100);
      }
    }

    // ── 1-c. 세션 캐시 저장 ──
    if (isNewSession && techResults.length > 0) {
      const topCount = isUSSession ? OVERSEAS.TOP_COUNT : OVERSEAS.ASIA_TOP_COUNT;
      const sorted = [...techResults].sort((a, b) => {
        const sa = a.score + (a.isMomentum ? 30 : 0);
        const sb = b.score + (b.isMomentum ? 30 : 0);
        return sb - sa;
      });
      const topCodes = sorted.slice(0, topCount).map((t) => t.code);
      const techCacheMap = new Map<
        string,
        {
          score: number;
          rsi: number;
          adx: number;
          signal: string;
          trendStrength: string;
          isMomentum: boolean;
          dayRangePct: number;
          aboveMA20: boolean;
          aboveMA60: boolean;
          bollingerSqueeze: boolean;
          bollingerBreakout: 'UP' | 'DOWN' | 'NONE';
          atrPct: number;
          vwapPosition?: 'ABOVE' | 'BELOW' | 'AT';
        }
      >();
      for (const t of techResults) {
        techCacheMap.set(t.code, {
          score: t.score,
          rsi: t.rsi,
          adx: t.adx,
          signal: t.signal,
          trendStrength: t.trendStrength,
          isMomentum: t.isMomentum,
          dayRangePct: t.dayRangePct,
          aboveMA20: t.aboveMA20,
          aboveMA60: t.aboveMA60,
          bollingerSqueeze: t.bollingerSqueeze,
          bollingerBreakout: t.bollingerBreakout,
          atrPct: t.atrPct,
          vwapPosition: t.vwapPosition,
        });
      }
      const newCache: SessionCache = { topCodes, sessionDate: sessionId, techCache: techCacheMap };
      setSessionCache(region, newCache);
      logger.info(`${regionFlags} 이번 세션 매수 후보: [${topCodes.join(', ')}] (score 기준 상위 ${topCount})`, {
        component: 'OVERSEAS',
      });
    }

    if (techResults.length === 0) {
      logger.warn('해외주식 분석 데이터 없음', { component: 'OVERSEAS' });
      return;
    }

    // ── 1-d. 터틀 전략 비활성화 (buy-filter 12단계 필터와 중복 → 제거) ──
    // 기존 터틀 돌파 종목은 sell-logic이 관리 (호환)

    // ── 1-b. 대시보드용 점수 캐시 갱신 ──
    const regionMap = new Map(GLOBAL_WATCHLIST.map((stock) => [stock.code, stock.region as 'US' | 'JP' | 'TW']));
    for (const [code] of holdings) {
      const t = techResults.find((r) => r.code === code);
      if (t && t.price.currentPrice > 0) {
        getPool()
          .query(
            `UPDATE overseas_holdings SET last_price = $1, last_price_at = NOW() WHERE stock_code = $2 AND is_paper = $3`,
            [t.price.currentPrice, code, isPaper()],
          )
          .catch(() => {});
        // v10.9.4: SSE 인메모리 캐시도 갱신 (기존: DB만 갱신 → SSE에서 stale 가격 표시)
        cacheSet(`overseas:lastprice:${code}`, { price: t.price.currentPrice, changePct: t.price.changePct, volume: t.price.volume }, 7200);
      }
    }

    const priceRows = techResults.filter((t) => t.price.currentPrice > 0);
    if (priceRows.length > 0) {
      const vals = priceRows
        .map((_t, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`)
        .join(',');
      const params = priceRows.flatMap((t) => [
        t.code,
        t.exchange,
        t.price.currentPrice,
        t.price.changePct,
        t.price.volume,
      ]);
      getPool()
        .query(
          `INSERT INTO overseas_prices (code, exchange, price, change_pct, volume, updated_at)
         VALUES ${vals}
         ON CONFLICT (exchange, code) DO UPDATE SET
           price = EXCLUDED.price, change_pct = EXCLUDED.change_pct,
           volume = EXCLUDED.volume, updated_at = NOW()`,
          params,
        )
        .catch(() => {});
    }

    setOverseasScores(
      techResults.map((t) => ({
        code: t.code,
        name: t.name,
        exchange: t.exchange,
        region: regionMap.get(t.code) ?? 'US',
        score: t.score,
        signal: t.signal,
        price: t.price.currentPrice,
        changePct: t.price.changePct,
        rsi: t.rsi,
        cachedAt: Date.now(),
      })),
      isPaper(),
    );

    // ── 2. AI(Claude) 판단 ──
    const heldSet = new Set(holdings.keys());
    const allAiInputs: OverseasStockInput[] = techResults.map((t) => {
      const holding = holdings.get(t.code);
      const pnlPct =
        holding && holding.avgPrice > 0
          ? ((t.price.currentPrice - holding.avgPrice) / holding.avgPrice) * 100
          : undefined;
      return {
        code: t.code,
        name: t.name,
        exchange: t.exchange,
        currentPrice: t.price.currentPrice,
        changePct: t.price.changePct,
        rsi: t.rsi,
        adx: t.adx,
        score: t.score,
        signal: t.signal,
        trendStrength: t.trendStrength,
        isHolding: !!holding,
        holdingPnlPct: pnlPct,
        dayRangePct: t.dayRangePct,
        isMomentum: t.isMomentum,
        isBigMover: t.isBigMover,
        aboveMA20: t.aboveMA20,
        bollingerSqueeze: t.bollingerSqueeze,
        bollingerBreakout: t.bollingerBreakout,
      };
    });

    const latestSessionCache = getSessionCache(region);
    let aiInputs = allAiInputs;
    if (latestSessionCache) {
      const topSet = new Set(latestSessionCache.topCodes);
      aiInputs = allAiInputs.filter(
        (si) => heldSet.has(si.code) || topSet.has(si.code) || si.isMomentum || si.isBigMover,
      );
      if (aiInputs.length < allAiInputs.length) {
        logger.info(
          `🤖 AI 입력 최적화: ${allAiInputs.length} → ${aiInputs.length}종목 (세션 후보 + 모멘텀/빅무버 포함)`,
          { component: 'OVERSEAS' },
        );
      }
    }

    const hasBuyCandidates = aiInputs.some((si) => !si.isHolding);
    const hasSellCandidates = aiInputs.some((si) => si.isHolding);
    const now_ms = Date.now();
    const intervalMs = OVERSEAS.AI_INTERVAL_MS;
    const lastAiCall = isPaper() ? s.lastPaperAiCallAt : s.lastUSAiCallAt;
    const aiCooldownOk = isUSSession ? now_ms - lastAiCall >= intervalMs : true;
    // 🔧 보유종목 악화 신호 시 쿨다운 바이패스 — 매도 결정 지연 방지
    const hasUrgentSell = aiInputs.some((si) => si.isHolding && (si.score <= -15 || si.rsi > 72));
    const shouldCallAI = (hasBuyCandidates || hasSellCandidates) && (aiCooldownOk || hasUrgentSell);
    if ((hasBuyCandidates || hasSellCandidates) && !aiCooldownOk && !hasUrgentSell) {
      logger.info(
        `🤖 AI 대기 중 — 다음 호출까지 ${Math.ceil((intervalMs - (now_ms - lastAiCall)) / 60000)}분 (무료 한도 절약)`,
        { component: 'OVERSEAS' },
      );
    }
    if (hasUrgentSell && !aiCooldownOk) {
      logger.info(`🚨 보유종목 악화 감지 → AI 쿨다운 바이패스 (매도 판단 우선)`, { component: 'OVERSEAS' });
    }

    // ── 선행 신호 수집 (AI 호출과 무관하게) ──
    const [crossSignals, earningsDrift, squeezeSignals, tradeReviewCtx, defenseSignal] = await Promise.all([
      getCrossMarketSignals().catch(() => []),
      detectEarningsDrift(usCodes, techResults).catch(() => []),
      Promise.resolve(detectSqueezeBreakouts(techResults)),
      getTradeReviewInsights().catch(() => ''),
      evaluateMarketDefense().catch(() => ({
        level: 'NONE' as const,
        positionReduction: 0,
        blockNewBuys: false,
        trailTighten: 0,
        reasons: [],
      })),
    ]);

    if (crossSignals.length > 0)
      logger.info(
        `🌏 크로스마켓 신호: ${crossSignals.map((s) => `${s.usCode}(${s.signalType} ${(s.confidence * 100).toFixed(0)}%)`).join(', ')}`,
        { component: 'OVERSEAS' },
      );
    if (earningsDrift.length > 0)
      logger.info(
        `📈 어닝 드리프트: ${earningsDrift.map((s) => `${s.code}(+${s.gapPct.toFixed(1)}% vol${s.volumeRatio.toFixed(1)}x)`).join(', ')}`,
        { component: 'OVERSEAS' },
      );
    if (squeezeSignals.length > 0)
      logger.info(`💥 스퀴즈 돌파: ${squeezeSignals.map((s) => `${s.code}(str${s.strength.toFixed(2)})`).join(', ')}`, {
        component: 'OVERSEAS',
      });
    if (defenseSignal.level !== 'NONE')
      logger.info(`🛡️ 방어 모드: ${defenseSignal.level} — ${defenseSignal.reasons.join(', ')}`, {
        component: 'OVERSEAS',
      });

    // v10.8: FearGreed/Earnings 1회 호출 후 재사용 (기존 3회/2회 중복 제거)
    const [_fgShared, _earningsShared] = await Promise.all([
      getFearGreedIndex().catch(() => null),
      getUpcomingEarnings(usCodes).catch(() => [] as import('../market/external-signals.js').EarningsEvent[]),
    ]);

    let aiDecisions: Awaited<ReturnType<typeof analyzeOverseasWithAI>> = [];
    if (shouldCallAI) {
      const fgEarly = _fgShared;
      const earningsEarly = _earningsShared;
      const earningsRiskCodes = earningsEarly.filter((e) => e.daysUntil >= 0 && e.daysUntil <= 5).map((e) => e.code);
      const positiveCount = techResults.filter((t) => t.price.changePct > 0).length;
      const breadthPct = techResults.length > 0 ? positiveCount / techResults.length : 0.5;

      const sectorChangeMap = new Map<string, number[]>();
      for (const t of techResults) {
        const arr = sectorChangeMap.get(t.sector) ?? [];
        arr.push(t.price.changePct);
        sectorChangeMap.set(t.sector, arr);
      }
      const sectorRanking = [...sectorChangeMap.entries()]
        .map(([sc, cs]) => ({ sector: sc, avg: cs.reduce((a, b) => a + b, 0) / cs.length }))
        .sort((a, b) => b.avg - a.avg);
      const sectorMomentumStr = sectorRanking
        .map((sc) => `${sc.sector}${sc.avg >= 0 ? '+' : ''}${sc.avg.toFixed(1)}%`)
        .join(' ');

      const mktCtx = fgEarly
        ? {
            fearGreed: fgEarly.fearGreedScore,
            fearGreedLabel: fgEarly.fearGreedLabel,
            vix: fgEarly.vix,
            earningsRisk: earningsRiskCodes,
            breadthPct,
            sectorMomentum: sectorMomentumStr,
          }
        : { breadthPct, sectorMomentum: sectorMomentumStr };

      // Gemini 활성 → AI 분석, 비활성 → 규칙기반 ($0)
      const { config: appConfig } = await import('../config/index.js');
      if (appConfig.geminiEnabled) {
        const [perfSummary, userInsights, aiInsights] = await Promise.all([
          getRecentPerfSummary(),
          getUserInsights(),
          getAIGeneratedInsights(),
        ]);
        const brief = getActiveSessionBrief();
        const sessionCtx = brief
          ? `[세션전략] ${brief.marketRegime}/${brief.riskLevel} | 집중:${brief.focusSectors.join(',')} | ${brief.narrative}`
          : '';
        const crossCtx =
          crossSignals.length > 0
            ? `[크로스마켓] ${crossSignals.map((s2) => `${s2.usCode} ${s2.signalType}(아시아 ${s2.asiaCode} ${s2.asiaChangePct >= 0 ? '+' : ''}${s2.asiaChangePct.toFixed(1)}%)`).join(', ')}`
            : '';
        const driftCtx =
          earningsDrift.length > 0
            ? `[어닝드리프트] ${earningsDrift.map((s2) => `${s2.code} ${s2.direction} gap${s2.gapPct >= 0 ? '+' : ''}${s2.gapPct.toFixed(1)}% vol${s2.volumeRatio.toFixed(1)}x`).join(', ')}`
            : '';
        const squeezeCtx =
          squeezeSignals.length > 0
            ? `[스퀴즈돌파] ${squeezeSignals.map((s2) => `${s2.code} str${s2.strength.toFixed(2)}`).join(', ')}`
            : '';
        const { getOverseasInsightsForPrompt } = await import('../automation/self-learning/overseas-analyzers.js');
        const overseasLearnedInsights = await getOverseasInsightsForPrompt().catch(() => '');
        const combinedInsights =
          [
            userInsights,
            aiInsights ? `[AI자기학습]\n${aiInsights}` : '',
            overseasLearnedInsights,
            sessionCtx,
            crossCtx,
            driftCtx,
            squeezeCtx,
            tradeReviewCtx ? `[매매복기]\n${tradeReviewCtx}` : '',
          ]
            .filter(Boolean)
            .join('\n\n') || undefined;
        aiDecisions = await analyzeOverseasWithAI(aiInputs, cash, holdings.size, perfSummary, combinedInsights, mktCtx);
      } else {
        const { analyzeOverseasRuleBased } = await import('../ai/overseas/rule-based-analyzer.js');
        aiDecisions = analyzeOverseasRuleBased(aiInputs, cash, holdings.size, mktCtx, crossSignals);
      }

      if (isUSSession) {
        if (isPaper()) s.lastPaperAiCallAt = Date.now();
        else s.lastUSAiCallAt = Date.now();
      }
    } else {
      logger.info('🤖 분석 생략 — 후보 없음 또는 쿨다운 중', { component: 'OVERSEAS' });
    }

    const aiMap = new Map(aiDecisions.map((d) => [d.code, d]));
    const overseasCodes = techResults.map((t) => t.code);
    const overseasWinRates = await getOverseasWinRates(overseasCodes).catch(() => new Map<string, OverseasWinRate>());

    // SEC EDGAR fundamentalScore 자동 캐시 (보유종목 + 상위 후보, 24시간 캐시)
    try {
      const { runSecResearchBatch, getCachedSecFundamentalScore } = await import('../automation/sec-research.js');
      const holdingTickers = [...holdings.keys()];
      const uncachedTickers = [...new Set([...holdingTickers, ...overseasCodes.slice(0, 5)])]
        .filter((t) => getCachedSecFundamentalScore(t) == null)
        .slice(0, 10);
      if (uncachedTickers.length > 0) {
        logger.info(`SEC 리서치 자동 실행: ${uncachedTickers.join(', ')}`, { component: 'OVERSEAS' });
        await runSecResearchBatch(uncachedTickers).catch((e: any) =>
          logger.warn(`SEC 리서치 실패 (스킵): ${e.message}`, { component: 'OVERSEAS' }),
        );
      }
    } catch { /* SEC 모듈 로드 실패 무시 */ }
    if (overseasWinRates.size > 0) {
      logger.info(`📈 해외 승률 데이터: ${overseasWinRates.size}종목`, { component: 'OVERSEAS' });
    }

    // ── VIX 레짐 감지 + 나스닥 전일 등락 (매도·매수 공통) ──
    const [earlyVixData, macroSigForSell] = await Promise.all([
      Promise.resolve(_fgShared), // v10.8: 위에서 이미 조회한 결과 재사용
      getMacroSignal().catch(() => null),
    ]);
    const vixValue = earlyVixData?.vix ?? 0;
    const vixRegime = getVixRegime(vixValue, isPaper());
    const nasdaqChange1d = macroSigForSell?.nasdaqChange1d ?? null;
    if (vixRegime.regime !== 'CALM') {
      logger.info(
        `🌡️ VIX 레짐: ${vixRegime.regime} (VIX=${vixValue.toFixed(1)}) — 사이징x${vixRegime.sizingMult} 트레일${vixRegime.trailTighten > 0 ? `-${vixRegime.trailTighten}%p` : '정상'}`,
        { component: 'OVERSEAS' },
      );
    }

    // ── 3. 포트폴리오 평가 + 동적 파라미터 ──
    const holdingEvalUsd = Array.from(holdings.entries()).reduce((sum, [code, h]) => {
      const tech = techResults.find((t) => t.code === code);
      return sum + (tech ? tech.price.currentPrice * h.qty : h.avgPrice * h.qty);
    }, 0);
    let portfolioValue = cash + holdingEvalUsd;
    // v10.10.5: maxPositions도 목표배분 기준 (실제 자산이 적어도 적절한 포지션 수 허용)
    const dynSizingBase = targetOverseasUsd > 0 ? Math.max(portfolioValue, targetOverseasUsd) : portfolioValue;
    const dynParams = getOverseasDynamic(dynSizingBase, isPaper(), allocRisk.positionCapPct / 100);
    const MAX_POSITIONS = dynParams.maxPositions;

    // ── 3-b. 실시간 뉴스 그라운딩 (Google Search) — 매도 판단 전 악재/호재 감지 ──
    const { checkHoldingsNews, checkMacroEvents } = await import('../ai/grounded-intel.js');
    const holdingsForNews = [...holdings.entries()].map(([code, h]) => {
      const tech = techResults.find((t) => t.code === code);
      const pnlPct = tech ? ((tech.price.currentPrice - h.avgPrice) / h.avgPrice) * 100 : 0;
      return { code, name: tech?.name ?? code, pnlPct };
    });
    const [groundedSignals, macroEvents] = await Promise.all([
      checkHoldingsNews(holdingsForNews).catch(() => []),
      checkMacroEvents().catch(() => []),
    ]);
    // 그라운딩 URGENT_SELL → AI override 주입 (매도 판단 강화)
    for (const sig of groundedSignals) {
      if (sig.action === 'URGENT_SELL' && sig.confidence >= 0.85) {
        aiMap.set(sig.code, {
          code: sig.code,
          action: 'SELL',
          confidence: sig.confidence,
          reasoning: `🔍 실시간뉴스: ${sig.headline}`,
        });
        logger.warn(`🔍 그라운딩 긴급매도 주입: ${sig.code} — ${sig.headline}`, { component: 'GROUNDED_INTEL' });
      }
    }

    // ── 4. 매도 판단 (→ overseas/sell-logic.ts) — 방어 모드 트레일 타이트닝 반영 ──
    const effectiveVixRegime =
      defenseSignal.trailTighten > 0
        ? { ...vixRegime, trailTighten: vixRegime.trailTighten + defenseSignal.trailTighten }
        : vixRegime;
    // 매크로 RISK_OFF Lv3 → 트레일 추가 타이트닝
    const macroTighten = macroEvents.some((e) => e.impact === 'RISK_OFF' && e.severity >= 3) ? 1.0 : 0;
    if (macroTighten > 0) effectiveVixRegime.trailTighten += macroTighten;
    const sellResult = await evaluateSells({
      holdings,
      pendingOrderStocks,
      techResults,
      aiMap,
      vixRegime: effectiveVixRegime,
      cash,
      isPaper: isPaper(),
      portfolioValue,
      fxRate: cycleFxRate,
      nasdaqChange1d,
    });
    const sellOrders = sellResult.sellOrders;
    cash = sellResult.cash;

    // v10.8: 매도 후 holdings Map 동기화 — DB에서 최신 상태 재로딩
    // 기존 코드: sellOrders(문자열)에서 종목코드 추출 시도 → 항상 실패 (전체 문자열이 code가 됨)
    if (sellOrders.length > 0) {
      const freshHoldings = await getHoldings(isPaper());
      holdings.clear();
      for (const [k, v] of freshHoldings) holdings.set(k, v);
    }
    let holdingEvalUsdPost = Array.from(holdings.entries()).reduce((sum, [code, h]) => {
      const tech = techResults.find((t) => t.code === code);
      return sum + (tech ? tech.price.currentPrice * h.qty : h.avgPrice * h.qty);
    }, 0);
    portfolioValue = cash + holdingEvalUsdPost;

    // v10.10.4: 사이징 레퍼런스 — 목표 해외 배분 규모와 현재 해외 규모 중 큰 값
    // 해외 자산이 목표 대비 적어도 목표 기준으로 사이징 → 점진적으로 목표 비중까지 증가
    // 리스크 관리(killSwitch, lossPct)는 실제 portfolioValue 기준 유지
    const sizingPortfolioValue = targetOverseasUsd > 0
      ? Math.max(portfolioValue, targetOverseasUsd)
      : portfolioValue;
    if (sizingPortfolioValue > portfolioValue) {
      logger.info(
        `📐 사이징 레퍼런스: $${portfolioValue.toFixed(0)}(현재) → $${sizingPortfolioValue.toFixed(0)}(목표) — 목표배분 기준 포지션 사이징`,
        { component: 'OVERSEAS' },
      );
    }

    // ── 4-c. 터틀 전략 비활성화 — sell-logic이 기존 터틀 포지션도 관리 ──

    // ── 5. 리스크 관리 ──
    const mk = modeKey(isPaper());
    if (s.sessionStartPortfolioValue.get(mk) === null || s.sessionStartPortfolioValue.get(mk) === undefined)
      await setSessionStartValue(portfolioValue, isPaper());
    const _sessionStart = s.sessionStartPortfolioValue.get(mk) ?? portfolioValue;

    // 손실 한도 — 해외 포트폴리오(USD) 기준, Paper/Live 분리
    const osLimit = getOverseasLossTiers(isPaper());
    const holdingCostUsd = Array.from(holdings.entries()).reduce((sum, [, h]) => sum + h.qty * h.avgPrice, 0);
    const unrealizedLossUsd = holdingCostUsd - holdingEvalUsdPost; // 양수 = 손실
    const lossPctOfPortfolio = portfolioValue > 0 ? (unrealizedLossUsd / portfolioValue) * 100 : 0;

    if (lossPctOfPortfolio >= osLimit.killPct) {
      await activateKillSwitch(
        `해외 손실 한도 초과: 해외자산 대비 -${lossPctOfPortfolio.toFixed(1)}% (한도 ${osLimit.killPct}%) — $${unrealizedLossUsd.toFixed(0)} 손실 (해외자산 $${portfolioValue.toFixed(0)})`,
        false,
        SCOPE,
      );
      sendTelegramMessage(
        `🛑 OVERSEAS KILL SWITCH: 해외자산 대비 -${lossPctOfPortfolio.toFixed(1)}%\n손실: $${unrealizedLossUsd.toFixed(0)} (해외자산 $${portfolioValue.toFixed(0)})\n해외 전체 매매 중단`,
      ).catch(() => {});
    } else if (lossPctOfPortfolio >= osLimit.blockPct && !s.dailyLossAlertSent5.get(mk)) {
      s.dailyLossAlertSent5.set(mk, true);
      sendTelegramMessage(
        `🚨 CRITICAL: 해외자산 대비 -${lossPctOfPortfolio.toFixed(1)}% 손실\n손실: $${unrealizedLossUsd.toFixed(0)} (해외자산 $${portfolioValue.toFixed(0)})\n신규 매수 차단됨`,
      ).catch(() => {});
    } else if (lossPctOfPortfolio >= osLimit.warnPct && !s.dailyLossAlertSent3.get(mk)) {
      s.dailyLossAlertSent3.set(mk, true);
      sendTelegramMessage(
        `⚠️ WARNING: 해외자산 대비 -${lossPctOfPortfolio.toFixed(1)}% 손실\n해외자산: $${portfolioValue.toFixed(0)}`,
      ).catch(() => {});
    }

    // ── 4-b. 집중도 캡 (→ overseas/concentration-cap.ts) ──
    const concCapResult = await enforceConcentrationCap({
      portfolioValue,
      pendingOrderStocks,
      techResults,
      sellOrders,
      cash,
      isPaper: isPaper(),
    });
    cash = concCapResult.cash;

    // ── 5. 매수 판단 ──
    const buyOrders: string[] = [];
    const updatedHoldings = await getHoldings(isPaper());
    const currentHoldingCount = updatedHoldings.size;

    // v10.8: 위에서 이미 조회한 결과 재사용 (중복 API 호출 제거)
    const marketSentiment = _fgShared;
    const upcomingEarnings = _earningsShared;

    const sentinelBlockedCodes = new Set<string>();
    if (!process.env.FINNHUB_API_KEY) {
      await Promise.all(
        usCodes.map(async (code) => {
          const r = await checkUsEarnings(code).catch(() => null);
          if (r?.hasUpcomingEarnings) sentinelBlockedCodes.add(code);
        }),
      );
      if (sentinelBlockedCodes.size > 0) {
        logger.info(`📅 실적발표 차단 (Yahoo): ${[...sentinelBlockedCodes].join(', ')}`, { component: 'OVERSEAS' });
      }
    }

    const mktSignal = marketSentiment ? interpretMarketSentiment(marketSentiment) : null;
    if (mktSignal) logger.info(`📊 시장 신호: ${mktSignal.reason}`, { component: 'OVERSEAS' });

    const quality = mktSignal?.marketQuality ?? 'OK';
    // 손실한도: OVERSEAS_LOSS_TIERS 통일 (warnPct → 회복모드, blockPct → 매수차단, killPct → 킬스위치)
    const riskBlocked = lossPctOfPortfolio >= osLimit.blockPct;
    const recoveryMode = lossPctOfPortfolio >= osLimit.warnPct && !riskBlocked;
    if (riskBlocked) {
      logger.warn(`⛔ 총자산 대비 -${lossPctOfPortfolio.toFixed(1)}% → 신규 매수 차단 (한도 ${osLimit.blockPct}%)`, {
        component: 'OVERSEAS',
      });
      await logSystem('WARN', 'OVERSEAS', `총자산 손실 -${lossPctOfPortfolio.toFixed(1)}% → 신규 매수 차단 (blockPct ${osLimit.blockPct}%)`);
    } else if (recoveryMode) {
      logger.warn(
        `⚠️ 손실 회복 모드(-${lossPctOfPortfolio.toFixed(1)}%): warnPct ${osLimit.warnPct}% 도달 → 고확신 종목만 매수`,
        { component: 'OVERSEAS' },
      );
    }

    // ── 포트폴리오 배분 비중 체크 — kr_pct / us_pct 목표 준수 (Live 전용) ──
    // Paper 모드는 국내 포트폴리오가 없어 해외비중 100%로 잡히므로 스킵
    let allocBlocked = false;
    const fxNow = cycleFxRate; // 사이클 환율 재사용
    if (!isPaper()) {
      try {
        // 3개 독립 쿼리 병렬 실행 (기존 순차 → 병렬, ~300ms 절약)
        const rotKey = isPaper() ? 'p_rotation_signal' : 'l_rotation_signal';
        const [domResult, allocResult, rotResult] = await Promise.all([
          getPool().query(
            `SELECT COALESCE(SUM(invested_amount), 0) AS domestic_invested
             FROM chains WHERE is_active = true AND is_paper = false`,
          ),
          getPool().query(
            'SELECT us_pct FROM portfolio_allocation_config WHERE is_paper = $1 ORDER BY id DESC LIMIT 1',
            [isPaper()],
          ),
          getPool().query('SELECT value FROM system_state WHERE key = $1', [rotKey]).catch(() => ({ rows: [] })),
        ]);
        const domesticInvestedKrw = Number(domResult.rows[0]?.domestic_invested ?? 0);
        const domesticInvestedUsd = fxNow > 0 ? domesticInvestedKrw / fxNow : 0;
        // 국내 투자중 금액이 $100 이상일 때만 비중 체크
        if (domesticInvestedUsd >= 100) {
          const grandInvestedUsd = (holdingEvalUsdPost || 0) + domesticInvestedUsd;
          let targetUsPct = Number(allocResult.rows[0]?.us_pct ?? 100);
          // 크로스마켓 로테이션: DB에 저장된 최신 로테이션 신호로 동적 조정
          try {
            const rotRows = rotResult.rows;
            if (rotRows.length > 0) {
              const rot = JSON.parse(rotRows[0].value);
              const ageMs = Date.now() - new Date(rot.updatedAt).getTime();
              if (ageMs < 12 * 60 * 60_000 && rot.adjustedUsPct !== undefined) {
                if (rot.adjustedUsPct !== targetUsPct) {
                  logger.info(`📊 로테이션 적용: US 목표 ${targetUsPct}%→${rot.adjustedUsPct}%`, {
                    component: 'OVERSEAS',
                  });
                }
                targetUsPct = rot.adjustedUsPct;
              }
            }
          } catch {
            /* 로테이션 미설정 시 원래값 유지 */
          }
          const currentUsPct = grandInvestedUsd > 0 ? ((holdingEvalUsdPost || 0) / grandInvestedUsd) * 100 : 0;
          if (currentUsPct > targetUsPct * 1.15) {
            allocBlocked = true;
            logger.warn(
              `📊 해외 배분 비중 초과: ${currentUsPct.toFixed(0)}% > 목표 ${targetUsPct}% (+15% 여유) → 신규 매수 차단`,
              { component: 'OVERSEAS' },
            );
          }
        }
      } catch {
        /* alloc config 미존재 시 무시 */
      }
    }

    const minCashForBuy = portfolioValue * (isPaper() ? 0.15 : 0.05); // Live 5%, Paper 15% — 통합증거금 적극 활용
    if (riskBlocked || allocBlocked || currentHoldingCount >= MAX_POSITIONS || cash < minCashForBuy) {
      const reasons: string[] = [];
      if (riskBlocked) reasons.push(`리스크차단(-${lossPctOfPortfolio.toFixed(1)}%)`);
      if (allocBlocked) reasons.push('해외비중초과');
      if (currentHoldingCount >= MAX_POSITIONS) reasons.push(`보유풀(${currentHoldingCount}/${MAX_POSITIONS})`);
      if (cash < minCashForBuy) reasons.push(`현금부족($${cash.toFixed(0)}<$${minCashForBuy.toFixed(0)})`);
      logger.info(`🚫 매수 블록 진입 불가 — ${reasons.join(', ')}`, { component: 'OVERSEAS' });
    }

    if (!riskBlocked && !allocBlocked && currentHoldingCount < MAX_POSITIONS && cash >= minCashForBuy) {
      const [lossCooldownSet, recentLossSet, manualSellCdSet, bigLossSet] = await Promise.all([
        getLossCooldownStocks(isPaper()),
        getRecentLossStocks(isPaper()),
        getManualSellCooldownStocks(),
        getBigLossBlockedOverseas(isPaper()),
      ]);
      if (lossCooldownSet.size > 0)
        logger.info(`🚫 손절 쿨다운 종목 (24h): ${[...lossCooldownSet].join(', ')}`, { component: 'OVERSEAS' });
      if (recentLossSet.size > 0)
        logger.info(`⚠️ 최근 손실 종목 (7일, AI≥80% 필수): ${[...recentLossSet].join(', ')}`, { component: 'OVERSEAS' });
      // -5% 초과 손실 종목 → 30일 절대 차단 (allowRebuy override만 해제 가능)
      if (bigLossSet.size > 0) {
        for (const code of bigLossSet) lossCooldownSet.add(code);
        logger.info(`🚫 -5%초과 손실 30일 차단: ${[...bigLossSet].join(', ')} (allowRebuy 필요)`, {
          component: 'OVERSEAS',
        });
      }
      // 수동매도 쿨다운: live 모드에서 사용자가 직접 판 종목은 2h 재매수 금지
      for (const code of manualSellCdSet) lossCooldownSet.add(code);
      if (manualSellCdSet.size > 0)
        logger.info(`🙋 수동매도 쿨다운 (2h): ${[...manualSellCdSet].join(', ')} — 자동 재매수 금지`, {
          component: 'OVERSEAS',
        });

      // ── 리스크 인텔리전스 (쿨다운, Memory Agent, Kelly) ──
      const [gradualCooldown, memoryBlockedStocks, kellyResult] = await Promise.all([
        getGradualCooldown(),
        getMemoryBlockedStocks(),
        calcRollingKelly(),
      ]);
      if (gradualCooldown.level >= 2) {
        const gcStocks = await getGradualCooldownStocks(gradualCooldown);
        for (const gcs of gcStocks) lossCooldownSet.add(gcs);
        logger.warn(`⏸️ 점진적 쿨다운 Lv${gradualCooldown.level}: ${gradualCooldown.message}`, {
          component: 'OVERSEAS',
        });
      }
      if (memoryBlockedStocks.size > 0)
        logger.info(`🧠 Memory Agent 차단 (60일 승률≤25%): ${[...memoryBlockedStocks].join(', ')}`, {
          component: 'OVERSEAS',
        });

      const sectorValues = new Map<string, number>();
      const techByCodeLocal = new Map(techResults.map((t) => [t.code, t]));
      for (const [code, holding] of updatedHoldings) {
        const watchItem = WATCHLIST_BY_CODE.get(code);
        if (!watchItem) continue;
        const tech = techByCodeLocal.get(code);
        const value = (tech?.price.currentPrice ?? holding.avgPrice) * holding.qty;
        sectorValues.set(watchItem.sector, (sectorValues.get(watchItem.sector) ?? 0) + value);
      }

      const freshBreadth =
        techResults.length > 0 ? techResults.filter((r) => r.price.changePct > 0).length / techResults.length : 0.5;

      // ── 불확실성 보정 사전 계산 ──
      const sectorDownSet = new Set<string>();
      {
        const sectorChanges = new Map<string, number[]>();
        for (const t of techResults) {
          const arr = sectorChanges.get(t.sector) ?? [];
          arr.push(t.price.changePct);
          sectorChanges.set(t.sector, arr);
        }
        for (const [sec, changes] of sectorChanges) {
          if (changes.reduce((a, b) => a + b, 0) / changes.length < -1.0) sectorDownSet.add(sec);
        }
      }
      const uncertaintyMap = new Map<string, { penalty: number; reasons: string[] }>();
      await Promise.all(
        techResults
          .filter((t) => !updatedHoldings.has(t.code))
          .map(async (t) => {
            const p = await calcUncertaintyPenalty({
              code: t.code,
              vix: vixValue,
              sectorDown: sectorDownSet.has(t.sector),
            });
            if (p.penalty > 0) uncertaintyMap.set(t.code, p);
          }),
      );

      // ── EV 기반 포지션 사이징 배율 ──
      const buyCandidateCodes = techResults.filter((t) => !updatedHoldings.has(t.code)).map((t) => t.code);
      const evMultipliers = await calcStockEVMultipliers(buyCandidateCodes);
      if (evMultipliers.size > 0) {
        const evEntries = [...evMultipliers.entries()].filter(([, v]) => v.sampleCount >= 3);
        if (evEntries.length > 0) {
          logger.info(
            `📊 EV 사이징: ${evEntries.map(([c, v]) => `${c}:EV${v.evPct >= 0 ? '+' : ''}${v.evPct.toFixed(1)}%×${v.evMultiplier.toFixed(2)}`).join(' ')}`,
            { component: 'OVERSEAS' },
          );
        }
      }

      // ── 매수 필터 체인 (→ overseas/buy-filter.ts) ──
      const brief = getActiveSessionBrief();
      const { getUserBlacklist, getUserFavorites } = await import('./overseas/utils.js');
      const [userBlacklist, userFavorites, kospiRegime] = await Promise.all([
        getUserBlacklist(),
        getUserFavorites(),
        fetchKospiRegime().catch(() => ({ penalty: 0 as const })),
      ]);
      // 섹터별 평균 등락률 맵 — O(n) 단일패스 (기존 O(n²) → O(n))
      const _sectorAcc = new Map<string, { sum: number; count: number }>();
      for (const t of techResults) {
        const prev = _sectorAcc.get(t.sector);
        if (prev) { prev.sum += t.price.changePct; prev.count++; }
        else _sectorAcc.set(t.sector, { sum: t.price.changePct, count: 1 });
      }
      const sectorMomentumMap = new Map<string, number>();
      for (const [sec, { sum, count }] of _sectorAcc) sectorMomentumMap.set(sec, sum / count);

      const buyTargets = filterAndRankBuyTargets({
        techResults,
        updatedHoldings,
        pendingOrderStocks,
        lossCooldownSet,
        recentLossSet,
        memoryBlockedStocks,
        vixRegime: effectiveVixRegime,
        vixValue,
        gradualCooldown,
        upcomingEarnings,
        sentinelBlockedCodes,
        mktSignal,
        sectorValues,
        portfolioValue,
        aiMap,
        freshBreadth,
        uncertaintyMap,
        overseasWinRates,
        isUSExtended,
        recoveryMode,
        isPaper: isPaper(),
        sessionBrief: brief,
        earningsDrift,
        userBlacklist,
        userFavorites,
        kospiPenalty: kospiRegime.penalty,
        sectorMomentumMap,
      });

      // ── Paper→Live 브릿지: paper 매수 후보를 live에 전달 ──
      if (isPaper() && buyTargets.length > 0) {
        const { setPaperBuySignals } = await import('./overseas/paper-signal-bridge.js');
        setPaperBuySignals(buyTargets);
      }

      if (buyTargets.length === 0) {
        logger.info(
          `🔍 매수 후보 없음 — techResults:${techResults.length} aiMap:${aiMap.size} extended:${isUSExtended} mq:${mktSignal?.marketQuality ?? 'N/A'} recovery:${recoveryMode}`,
          { component: 'OVERSEAS' },
        );
      } else {
        logger.info(
          `✅ 매수 후보 ${buyTargets.length}종목: ${buyTargets
            .slice(0, 3)
            .map((t) => `${t.code}(${t.score}점 AI${((t.ai?.confidence ?? 0) * 100).toFixed(0)}%)`)
            .join(', ')}`,
          { component: 'OVERSEAS' },
        );
      }

      // ── Shadow Tracker: US AI 점수 상위 3종목 가상진입 + 기존 포지션 TP/SL 체크 (OOS 검증) ──
      try {
        const { recordShadowEntries, updateShadowPositions } = await import('../shadow/shadow-tracker.js');
        const shadowPicks = [...techResults]
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((t) => ({ stockCode: t.code, score: t.score, entryPrice: t.price.currentPrice }))
          .filter((p) => p.entryPrice > 0);
        await recordShadowEntries('US', shadowPicks);
        const usPriceMap = new Map(techResults.map((t) => [t.code, t.price.currentPrice]));
        await updateShadowPositions('US', usPriceMap);
      } catch {
        /* shadow is non-critical */
      }

      // Auto Pilot 루프 적응형 인터벌 피드백 — live 모드에서만 보고
      if (isLoopActive() && !isPaper()) {
        reportNoBuyCandidates(buyTargets.length === 0);
      }

      // ── 장외시간 알림 (→ overseas/notifications.ts) ──
      if (isUSExtended && !isPaper()) {
        const alertMap = s.extendedAlertSentAt.get(mk) ?? new Map();
        await sendBuyRecommendations({
          buyTargets,
          aiMap,
          kellyResult,
          portfolioValue,
          cash,
          extendedAlertSentAt: alertMap,
          updatedHoldings,
          techResults,
          usdKrw: fxNow,
        });
        await sendHoldingAlerts({
          extendedAlertSentAt: alertMap,
          updatedHoldings,
          techResults,
          usdKrw: fxNow,
        });
      }

      // ── 순환 매도 비활성화 — rebalancer에 흡수 (황금비율 현금유보 15%와 충돌 방지) ──

      // ── Scale-In 확인 (→ overseas/scale-in-manager.ts) ──
      const scaleInResult = await processScaleIns({ techResults, buyOrders, cash, isPaper: isPaper() });
      cash = scaleInResult.cash;

      // ── 프리마켓 딥바이 체결 감시 (→ overseas/premarket-dip.ts) ──
      try {
        const { checkDipBuyFills } = await import('./overseas/premarket-dip.js');
        const dipFills = await checkDipBuyFills(isPaper());
        for (const fill of dipFills) buyOrders.push(fill);
      } catch {
        /* 딥바이 모듈 없으면 무시 */
      }

      // ── 멀티 타임프레임 분석 (매수 후보 대상) ──
      const mtfStocks = buyTargets.slice(0, 5).map((t) => ({ code: t.code, exchange: t.exchange }));
      const mtfResults = await batchMultiTF(mtfStocks).catch(() => new Map());

      // ── 방어 모드 적용: 매수 차단 / 트레일링 타이트닝 ──
      // Paper: 학습용이므로 방어모드 매수차단 바이패스 (매도 방어는 유지)
      const defenseBlockBuys = isPaper() ? false : defenseSignal.blockNewBuys;
      if (defenseSignal.blockNewBuys) {
        const bypass = isPaper() ? ' (Paper 바이패스)' : '';
        logger.warn(
          `🛡️ 방어 모드 ${defenseSignal.level} — 신규 매수 차단${bypass} (${defenseSignal.reasons.join(', ')})`,
          { component: 'OVERSEAS' },
        );
      }

      // ── 종가베팅 (조건부): 장이 나쁘면 마감 30분 전에만 매수, 좋으면 스윙 ──
      // 장세 판단: breadth(상승종목 비율) + VIX + 방어모드
      const { isUSMarketLastNMinutes, getMinutesToUSClose } = await import('./overseas/session.js');
      const isEodWindow = isUSMarketLastNMinutes(30);
      const isBadMarket =
        freshBreadth < 0.35 ||
        vixRegime.regime === 'STRESS' ||
        vixRegime.regime === 'CRISIS' ||
        defenseSignal.blockNewBuys;
      const eodBlockBuys = !isPaper() && openRegions.has('US') && !isEodWindow && isBadMarket;
      if (eodBlockBuys && buyTargets.length > 0) {
        logger.info(
          `⏰ 종가베팅: 약세장(breadth=${(freshBreadth * 100).toFixed(0)}% VIX=${vixRegime.regime}) 마감 ${getMinutesToUSClose()}분 전 — 후보 ${buyTargets.length}종목 대기`,
          { component: 'OVERSEAS' },
        );
      } else if (openRegions.has('US') && !isBadMarket) {
        logger.info(`📈 스윙모드: 정상장(breadth=${(freshBreadth * 100).toFixed(0)}%) — 매수 활성`, {
          component: 'OVERSEAS',
        });
      }

      // ── 매수 실행 (Rolling Kelly + EV배율 + VIX 레짐 + 점진적 쿨다운 + 상관관계 + MTF 반영) ──
      // 🔒 Kill Switch 재확인: 매도 중 손실 한도 초과로 발동될 수 있음
      const killSwitchBuyBlockFresh = isKillSwitchActive(SCOPE);
      if (killSwitchBuyBlockFresh && !killSwitchBuyBlock) {
        logger.warn(`🛑 Kill Switch 매도 중 발동 감지 — 해외 매수 전면 차단`, { component: 'OVERSEAS' });
      }
      if (killSwitchBuyBlockFresh) {
        logger.warn(`🛑 Kill Switch 활성 — 해외 매수 ${buyTargets.length}건 건너뜀`, { component: 'OVERSEAS' });
      }
      const slotsAvailable =
        killSwitchBuyBlockFresh || defenseBlockBuys || eodBlockBuys ? 0 : MAX_POSITIONS - currentHoldingCount;
      logger.info(
        `🔧 매수 루프: slots=${slotsAvailable} (max=${MAX_POSITIONS} held=${currentHoldingCount} kill=${killSwitchBuyBlockFresh} defense=${defenseBlockBuys}) cash=$${cash.toFixed(0)} targets=${buyTargets.length}`,
        { component: 'OVERSEAS' },
      );
      for (const target of buyTargets.slice(0, slotsAvailable)) {
        // 상관관계 차단: 같은 그룹 내 보유 초과 (Paper: 학습용 바이패스)
        const corrBlock = checkCorrelationLimit(target.code, updatedHoldings);
        if (corrBlock && !isPaper()) {
          logger.info(
            `🔗 상관관계 차단: ${target.code} (${corrBlock.group} ${corrBlock.currentCount}/${corrBlock.maxAllowed} — ${corrBlock.reason})`,
            { component: 'OVERSEAS' },
          );
          continue;
        }
        // 멀티 타임프레임 차단: 방향 불일치 (Live 소액 계좌는 바이패스 — 매수 기회 확보)
        const mtf = mtfResults.get(target.code);
        if (mtf?.blocked) {
          // Paper: 학습용이므로 MTF 차단 바이패스 / Live 소액: 매수 기회 확보
          if (isPaper() || portfolioValue < 500) {
            logger.info(
              `📊 MTF 경고(바이패스): ${target.code} (W:${mtf.weekly} D:${mtf.daily} H4:${mtf.h4} 합류${mtf.confluence}/3)`,
              { component: 'OVERSEAS' },
            );
          } else {
            logger.info(
              `📊 MTF 차단: ${target.code} (W:${mtf.weekly} D:${mtf.daily} H4:${mtf.h4} 합류${mtf.confluence}/3)`,
              { component: 'OVERSEAS' },
            );
            continue;
          }
        }
        // 사이징 계산 (→ overseas/position-sizing.ts)
        const mtfBonus = mtf?.confidenceBonus ?? 0;
        const stockEV = evMultipliers.get(target.code);
        const evMult = stockEV?.evMultiplier ?? 1.0;
        const wrData = overseasWinRates.get(target.code);
        const { sizingMult, positionSize } = calcPositionSize({
          target,
          portfolioValue: sizingPortfolioValue, // v10.10.4: 목표배분 기준 사이징
          kellyResult,
          vixRegime,
          gradualCooldown,
          cash,
          isPaper: isPaper(),
          evMultiplier: evMult,
          mtfBonus,
          sessionSizingMult: brief?.sizingMultiplier,
          winRate: wrData?.winRate,
          winRateSamples: wrData?.sampleCount,
          marketBreadth: freshBreadth,
        });
        // 최소 포지션: 사이징 레퍼런스의 10% (MIN_POSITION_PCT)
        const minPositionSize = sizingPortfolioValue * 0.1;
        if (positionSize < minPositionSize) {
          logger.info(
            `🔧 ${target.code}: positionSize=$${positionSize.toFixed(2)} < $${minPositionSize.toFixed(0)}(10%) → SKIP (sizing=${sizingMult} cash=$${cash.toFixed(0)})`,
            { component: 'OVERSEAS' },
          );
          continue; // v10.8: break→continue (고가 종목 스킵 후 저가 종목 평가 계속)
        }

        const targetWatchItem = WATCHLIST_BY_CODE.get(target.code);
        const isHighBetaEntry = SECTOR_CLASS.HIGH_BETA.includes(targetWatchItem?.sector ?? '');
        const isDefenseEntry = SECTOR_CLASS.DEFENSE.includes(targetWatchItem?.sector ?? '');
        const slDecimal = isHighBetaEntry ? 0.08 : isDefenseEntry ? 0.04 : 0.05;
        // v10.8.2: 마이크로(<$500) 10%, 소액(<$2000) 5%, 일반 Paper 2.5% / Live 2%
        const riskPct = sizingPortfolioValue < 500 ? 0.10 : sizingPortfolioValue < 2000 ? 0.05 : isPaper() ? 0.025 : 0.02;
        const maxRiskUSD = sizingPortfolioValue * riskPct;
        const qtyBy1PctRule =
          maxRiskUSD > 0 ? Math.floor(maxRiskUSD / (target.price.currentPrice * slDecimal)) : Infinity;
        // 수수료 0.25% 보정: positionSize가 1주 가격과 비슷하면 수수료 무시하고 1주 허용
        const priceWithFee = target.price.currentPrice * (1 + OVERSEAS_FEE_PCT);
        let qtyBySizing = Math.floor(positionSize / priceWithFee);
        if (qtyBySizing === 0 && positionSize >= target.price.currentPrice * 0.99) {
          qtyBySizing = 1; // 1주 가격 ±1% 내면 수수료 무시하고 매수
        }
        // v10.8.2: 마이크로 계좌 — 현금으로 1주 살 수 있으면 최소 1주 보장
        if (qtyBySizing === 0 && sizingPortfolioValue < 500 && target.price.currentPrice <= cash * 0.95) {
          qtyBySizing = 1;
        }
        // 집중캡 사전 체크: concentration-cap.ts의 CONC_CAP(25%)와 정렬
        // $500 미만: cap 무제한 (concentration-cap도 skip), $500+: 25% (cap 발동 기준과 동일)
        const existingHolding = updatedHoldings.get(target.code);
        const existingQty = existingHolding?.qty ?? 0;
        const CONC_CAP_PCT = sizingPortfolioValue < 500 ? 1.0 : 0.25;
        let maxQtyByConc =
          sizingPortfolioValue > 0
            ? Math.max(0, Math.floor((sizingPortfolioValue * CONC_CAP_PCT) / priceWithFee) - existingQty)
            : Infinity;
        // v10.8.2: 마이크로 계좌 — 집중캡 계산상 0이지만 현금으로 1주 가능하면 허용
        if (maxQtyByConc === 0 && sizingPortfolioValue < 500 && existingQty === 0 && target.price.currentPrice <= cash * 0.95) {
          maxQtyByConc = 1;
        }
        const fullQty = Math.min(qtyBySizing, qtyBy1PctRule > 0 ? qtyBy1PctRule : qtyBySizing, maxQtyByConc);

        if (fullQty <= 0) {
          // KIS TTTT3016U 소수점 매수는 미지원 (IGW00012 에러) → 1주 미만이면 스킵
          logger.info(
            `🔧 ${target.code}: fullQty=0 → SKIP (sizing=${qtyBySizing} risk=${qtyBy1PctRule} conc=${maxQtyByConc} price=$${target.price.currentPrice.toFixed(2)} posSize=$${positionSize.toFixed(0)} cash=$${cash.toFixed(0)})`,
            { component: 'OVERSEAS' },
          );
          continue;
        }

        // Scale-In: RSI과매수+추세약할 때만 분할, 대부분 100% 즉시매수 (v10.10.4)
        const useScaleIn = shouldUseScaleIn(target) && fullQty >= 3;
        const qty = useScaleIn ? Math.max(1, Math.floor(fullQty * 0.6)) : fullQty;
        const scaleInRemainder = useScaleIn ? fullQty - qty : 0;

        const buyMode = target.isMomentum ? '🚀모멘텀' : target.rsi <= 35 ? '📉과매도반등' : '📊트렌드';
        const wrInfo = overseasWinRates.get(target.code);
        const wrTag =
          wrInfo && wrInfo.sampleCount >= 5 ? ` 승률${(wrInfo.winRate * 100).toFixed(0)}%/${wrInfo.sampleCount}건` : '';
        const evTag =
          stockEV && stockEV.sampleCount >= 3 ? ` EV${stockEV.evPct >= 0 ? '+' : ''}${stockEV.evPct.toFixed(1)}%` : '';
        // 진입 소스 태그: 추후 승률 분석용
        const entrySource = target.isBigMover
          ? 'BIGMOVER'
          : target.isMomentum
            ? 'MOMENTUM'
            : target.bollingerBreakout === 'UP'
              ? 'BB_BREAKOUT'
              : target.rsi <= 35
                ? 'OVERSOLD'
                : 'TECHNICAL';

        // 황금비율 버킷 분류 + 한도 체크
        const isBlueChipEntry = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'AVGO', 'TSM', 'LLY', 'V'].includes(
          target.code,
        );
        const targetBucket = classifyBucket(entrySource, isBlueChipEntry);
        // SNIPER 오버라이드: AI 고확신(≥0.85) + 고점수(≥85) → 집중 단기 익절 전략 [4%@30%, 8%@100%]
        const effectiveBucket =
          target.ai?.action === 'BUY' &&
          (target.ai?.confidence ?? 0) >= 0.85 &&
          target.score >= 85
            ? 'SNIPER'
            : targetBucket;
        const bucketLimit = ALLOCATION_GOLDEN[`${effectiveBucket}_PCT` as keyof typeof ALLOCATION_GOLDEN];
        // v10.8: 시장가 기준 버킷 비중 (원가 기준 왜곡 방지)
        const livePriceMap = new Map(techResults.map((t) => [t.code, t.price.currentPrice]));
        const currentBucketWeight = getBucketWeight(updatedHoldings as any, portfolioValue, effectiveBucket, livePriceMap);
        if (bucketLimit != null && currentBucketWeight >= bucketLimit) {
          logger.info(
            `📊 버킷 한도 초과: ${target.code} [${effectiveBucket}] ${(currentBucketWeight * 100).toFixed(1)}% >= ${(bucketLimit * 100).toFixed(1)}%`,
            { component: 'OVERSEAS' },
          );
          continue;
        }
        const reason = `${buyMode} [${entrySource}] 사이징x${sizingMult}: score=${target.score} RSI=${target.rsi.toFixed(0)} ADX=${target.adx.toFixed(0)} sig=${target.signal}${wrTag}${evTag}`;

        logger.info(
          `🔧 ${target.code}: 매수 실행 시도 qty=${qty} @$${target.price.currentPrice.toFixed(2)} posSize=$${positionSize.toFixed(0)} fullQty=${fullQty}`,
          { component: 'OVERSEAS' },
        );
        const exec = await executeOverseasOrder(
          target.code,
          'BUY',
          qty,
          target.price.currentPrice,
          target.exchange,
          reason,
          0,
          0,
          { isPaper: isPaper() },
        );
        if (!exec.submitted) {
          logger.warn(`🔧 ${target.code}: 주문 미접수 (submitted=false)`, { component: 'OVERSEAS' });
          continue;
        }
        if (exec.filledQty <= 0) {
          pendingOrderStocks.add(target.code);
          buyOrders.push(`매수 접수 ${target.code} x${qty} ${buyMode} (체결 대기)`);
          continue;
        }

        const cost = exec.filledQty * exec.filledPrice * (1 + OVERSEAS_FEE_PCT);
        cash -= cost;

        const entryP = exec.filledPrice;
        const entryAtrPct = target.atrPct ?? 2.0;
        const entryTrailDrop = calcDynamicTrailDrop({
          sector: targetWatchItem?.sector ?? '',
          atrPct: entryAtrPct,
          maxPnlPct: 0,
          adx: target.adx,
          rsi: target.rsi,
        });
        const {
          tpPct,
          slPct: dynSlPct,
          tpLabel,
        } = calcDynamicTpSl({
          sector: targetWatchItem?.sector ?? '',
          adx: target.adx,
          rsi: target.rsi,
          aiConfidence: target.ai?.confidence,
          aiAction: target.ai?.action,
          vixRegime,
          isMomentum: target.isMomentum,
          atrPct: entryAtrPct,
        });
        // TACTICAL: -1.5% SL (오버나이트 갭 최소화), SNIPER: -2.0% SL (고확신이므로 타이트하게)
        const effectiveSlPct = targetBucket === 'TACTICAL' ? 1.5 : effectiveBucket === 'SNIPER' ? 2.0 : dynSlPct;
        // 매수 시점 동적 TP/SL + 버킷을 overseas_holdings에 영속 저장
        await updateTradeState({
          code: target.code,
          exchange: target.exchange,
          qty: exec.finalQty,
          avgPrice: exec.finalAvgPrice,
          newCash: cash,
          isPaper: isPaper(),
          fxRate: cycleFxRate,
          tpPct,
          slPct: -effectiveSlPct,
        });
        // 황금비율/SNIPER 버킷 태깅
        getPool()
          .query('UPDATE overseas_holdings SET strategy_bucket = $1 WHERE stock_code = $2 AND is_paper = $3', [
            effectiveBucket,
            target.code,
            isPaper(),
          ])
          .catch(() => {});
        const tpPrice = (entryP * (1 + tpPct / 100)).toFixed(2);
        const slPrice = (entryP * (1 - effectiveSlPct / 100)).toFixed(2);
        const kellyTag = kellyResult.sampleCount >= 10 ? ` Kelly${(kellyResult.halfKelly * 100).toFixed(0)}%` : '';
        const evLogTag =
          stockEV && stockEV.sampleCount >= 3
            ? ` EV${stockEV.evPct >= 0 ? '+' : ''}${stockEV.evPct.toFixed(1)}%×${evMult.toFixed(2)}`
            : '';
        const slTag = targetBucket === 'TACTICAL' ? ' ⚡SL-1.5%' : '';
        const buyLog = [
          `매수 ${target.code} x${exec.filledQty} @$${entryP.toFixed(2)} ${buyMode}${slTag}`,
          `📌 목표: $${tpPrice}(+${tpPct.toFixed(1)}%) | 손절: $${slPrice}(-${effectiveSlPct.toFixed(1)}%) | ATR트레일: ${entryTrailDrop.toFixed(1)}%(ATR${entryAtrPct.toFixed(1)}%) [${tpLabel}]`,
          `(AI ${((target.ai?.confidence ?? 0) * 100).toFixed(0)}% 사이징x${sizingMult}${kellyTag}${evLogTag} VIX:${vixRegime.regime}) [수수료 $${(exec.filledQty * exec.filledPrice * OVERSEAS_FEE_PCT).toFixed(2)}]`,
        ].join('\n');
        buyOrders.push(buyLog);
        await logSystem(
          'TRADE',
          'OVERSEAS',
          `BUY ${target.code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} | 사이징x${sizingMult}${kellyTag} VIX:${vixRegime.regime} (conf=${((target.ai?.confidence ?? 0) * 100).toFixed(0)}% score=${target.score}) | ${reason}`,
        );

        // 터틀 전략 비활성화 — 트레일 스탑은 sell-logic ATR 트레일로 통합

        // Scale-In 예약 (→ overseas/scale-in-manager.ts)
        if (scaleInRemainder > 0) {
          const { key: scaleInKey, value: scaleInValue } = buildScaleInReservation(
            target.code,
            scaleInRemainder,
            exec.filledPrice,
            target.exchange,
            isPaper(),
          );
          await getPool()
            .query(
              `INSERT INTO overseas_state(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
              [scaleInKey, scaleInValue],
            )
            .catch(() => {});
          buyOrders.push(`  📋 Scale-In 예약: ${target.code} 나머지 ${scaleInRemainder}주 (+2% 확인 시 추가매수)`);
        }
      }
    }

    // ── 5-b. 포트폴리오 비중 리밸런싱 (→ overseas/rebalancer.ts) ──
    const rbResult = await rebalancePortfolio({
      techResults,
      isPaper: isPaper(),
      sellOrders,
      extendedAlertSentAt: s.extendedAlertSentAt.get(mk) ?? new Map(),
      cash,
      defenseBlockBuys: !isPaper() && defenseSignal.blockNewBuys,
      positionReduction: !isPaper() ? defenseSignal.positionReduction : 0,
    });
    const rebalanceAlerts = rbResult.rebalanceAlerts;
    cash = rbResult.cash;

    // ── 5-c. 유휴현금 운용 비활성화 — 황금비율 현금유보 15%와 충돌 ──
    // 버킷 한도 내에서 자동 재투자는 매수 루프에서 처리
    const idleActions: string[] = [];

    // ── 6. 결과 로그 ──
    const totalActions = buyOrders.length + sellOrders.length + idleActions.length + rebalanceAlerts.length;
    const finalHoldings = await getHoldings(isPaper());
    const holdingList = Array.from(finalHoldings.entries()).map(([code, h]) => {
      const tech = techResults.find((t) => t.code === code);
      const pnl =
        tech && h.avgPrice > 0 ? (((tech.price.currentPrice - h.avgPrice) / h.avgPrice) * 100).toFixed(1) : '?';
      return `${code} x${h.qty} @$${h.avgPrice.toFixed(2)} (${Number(pnl) >= 0 ? '+' : ''}${pnl}%)`;
    });

    const summary = [
      `${regionFlags} 해외주식 자동매매 완료`,
      `분석: ${techResults.length}종목 | AI판단: ${aiDecisions.length}건 | 실행: ${totalActions}건`,
      `잔고: $${cash.toFixed(2)} | 보유: ${finalHoldings.size}/${MAX_POSITIONS}종목`,
      ...buyOrders.map((o) => `🟢 ${o}`),
      ...sellOrders.map((o) => `🔴 ${o}`),
      ...rebalanceAlerts,
      ...idleActions,
      holdingList.length > 0 ? `\n포트폴리오: ${holdingList.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const modeTag = isPaper() ? 'P' : 'L';
    logger.info(summary, { component: 'OVERSEAS', mode: modeTag });
    await logSystem('INFO', `OVERSEAS[${modeTag}]`, summary);
    // 시스템 이벤트 로그 (대시보드 표시용)
    const shortSummary =
      totalActions > 0
        ? [...buyOrders.map((o) => `BUY ${o}`), ...sellOrders.map((o) => `SELL ${o}`)].join(', ').slice(0, 120)
        : `스캔 ${techResults.length}종목 — 매매 없음`;
    logSystemEvent(`해외주식[${modeTag}]`, 'success', shortSummary);
    if (totalActions > 0) await sendTelegramMessage(summary).catch(() => {});

    // ── Memory Agent: 거래 패턴 자동 추출 (세션당 1회) ──
    extractTradingPatterns().catch(() => {});

    // ── 매도 후 빠른 재투자: 현금 해방 시 30초 후 재스캔 ──
    // v10.8: shutdown 체크 + 재귀 방지 (rescan에서 또 매도→또 rescan 무한루프 차단)
    if (
      sellOrders.length > 0 &&
      finalHoldings.size < MAX_POSITIONS &&
      cash >= portfolioValue * 0.15 &&
      !s._shuttingDown &&
      !_opts?.isRescan
    ) {
      const rescanMode = isPaper();
      logger.info(
        `🔄 매도 ${sellOrders.length}건 완료 → 30초 후 재스캔 (현금 $${cash.toFixed(0)} 재투자, ${rescanMode ? 'PAPER' : 'LIVE'})`,
        { component: 'OVERSEAS' },
      );
      setTimeout(() => {
        if (s._shuttingDown) return;
        runWithMode(rescanMode, () =>
          runOverseasJob({ isPaper: rescanMode, isRescan: true }).catch((e) =>
            logger.error(`재스캔 실패: ${e}`, { component: 'OVERSEAS' }),
          ),
        );
      }, 30_000);
    }

    reportSuccess(SCOPE);
  } catch (e) {
    const msg = (e as Error).message;
    const modeTag = isPaper() ? 'P' : 'L';
    logger.error(`해외주식 자동매매 실패[${modeTag}]: ${msg}`, { component: 'OVERSEAS', mode: modeTag });
    logSystemEvent(`해외주식[${modeTag}]`, 'error', msg.slice(0, 120));
    await reportError('OVERSEAS', msg, SCOPE);
  } finally {
    clearTimeout(jobTimeout);
    s.isRunning.set(modeK, false);
    if (lockClient) {
      try {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
      } catch (unlockErr) {
        logger.error(`🚨 해외주식 advisory lock 해제 실패 (DB 재시작 필요할 수 있음): ${unlockErr}`, {
          component: 'OVERSEAS',
        });
      }
      lockClient.release();
    }
  }
}

/**
 * Paper + Live 병행운영: 양쪽 모드 순차 실행
 * Paper → 가상자금 매매, Live → 실잔고 매매
 *
 * 중요: setTradingModeOverride 필수!
 *   env TRADING_MODE=paper 이므로 config.isPaper, config.kis 등
 *   전역 설정이 모두 모드에 맞게 전환되어야 함.
 *   (KIS TR ID, API키, reconcileCashWithKIS 등)
 */
export async function runOverseasDual(): Promise<void> {
  // 주말 가드: 토 09:00 ~ 월 06:00 KST = 전 세계 시장 휴장 → DB 접근 차단 (비용 절약)
  const { isWeekendClosed } = await import('../utils/holidays.js');
  const { getKSTNow } = await import('../utils/time.js');
  if (isWeekendClosed()) {
    const kst = getKSTNow();
    logger.info(`🌙 주말 휴장 스킵 (KST day=${kst.getUTCDay()} h=${kst.getUTCHours()})`, { component: 'OVERSEAS' });
    return;
  }

  logger.info('🇺🇸 runOverseasDual 시작 (paper→live)', { component: 'OVERSEAS' });

  // v10.9.4: paper 실행 전 isRunning 고착 방어 (이전 사이클 에러로 true 잔류 시)
  const paperModeK = modeKey(true);
  if (overseasState.isRunning.get(paperModeK)) {
    logger.warn(`⚠️ paper isRunning=true 고착 감지 → 강제 리셋`, { component: 'OVERSEAS' });
    overseasState.isRunning.set(paperModeK, false);
  }

  // AsyncLocalStorage로 격리 — 전역 오버라이드 없이 paper/live 독립 실행
  await runWithMode(true, async () => {
    try {
      logger.info('🇺🇸 [PAPER] overseas job 시작', { component: 'OVERSEAS' });
      await runOverseasJob({ isPaper: true });
      logger.info('🇺🇸 [PAPER] overseas job 완료', { component: 'OVERSEAS' });
    } catch (e) {
      logger.error(`해외주식 paper 실패: ${e}`, { component: 'OVERSEAS' });
    }
  });

  if (paperOnly) {
    logger.info('🇺🇸 paperOnly 모드 — live 스킵', { component: 'OVERSEAS' });
    return;
  }
  await runWithMode(false, async () => {
    try {
      await runOverseasJob({ isPaper: false });
    } catch (e) {
      logger.error(`해외주식 live 실패: ${e}`, { component: 'OVERSEAS' });
    }
  });
}
