/**
 * 해외주식 자동매매 오케스트레이터
 * 모든 헬퍼/상태는 ./overseas/ 모듈에서 관리
 * 이 파일은 runOverseasJob() 메인 루프만 담당
 */
import { analyzeTechnicals, type OHLCV } from '../analysis/indicators.js';
import { OVERSEAS, SECTOR_CLASS, OVERSEAS_FEE_PCT } from '../config/constants.js';
import { config, setTradingModeOverride } from '../config/index.js';
import { getPool, logSystem } from '../db/client.js';
import { getOverseasDailyChart, getOverseasPrice, placeFractionalOverseasBuy, type OverseasPrice } from '../kis/overseas.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { isKillSwitchActive, activateKillSwitch, reportError, reportSuccess } from '../risk/kill-switch.js';
import { OVERSEAS_LOSS_TIERS } from '../risk/seed-capital.js';

const SCOPE = 'OVERSEAS' as const;

// ── Paper/Live 병행운영: 모드 오버라이드 ──
let _modeOverride: boolean | null = null;
/** 현재 overseas-job 실행 모드 (오버라이드 → isPaper() 폴백) */
function isPaper(): boolean { return _modeOverride ?? config.isPaper; }
import { logger } from '../utils/logger.js';
import { analyzeOverseasWithAI, type OverseasStockInput } from '../ai/overseas/analyzer.js';
import { getAIGeneratedInsights } from '../ai/overseas/insights-generator.js';
import { setOverseasScores } from '../cache/overseas-scores.js';
import { getFearGreedIndex, getUpcomingEarnings, interpretMarketSentiment } from '../market/external-signals.js';
import { checkUsEarnings } from '../automation/earnings-sentinel.js';
import { fetchExchangeRate } from '../automation/macro-data.js';

// ── 모듈 re-export (기존 import 경로 유지) ──
export { setShuttingDown, isOverseasJobRunning, resetUSSessionCache, resetAsiaSessionCache, restoreSessionStartValue } from './overseas/session.js';
export { syncPendingOverseasOrders, cancelAllPendingOverseasOrders, getUserInsights, setUserInsights } from './overseas/order-sync.js';

// ── 모듈 import ──
import { GLOBAL_WATCHLIST, MAX_POSITIONS } from './overseas/watchlist.js';
import {
  ensureOverseasTable, getHoldings, getCash, updateTradeState,
  getMaxPrice, setMaxPrice, clearMaxPrice,
} from './overseas/state.js';
import { overseasState, getOpenMarketRegions, getKSTDateString, getUSSessionId, setSessionStartValue, type SessionCache } from './overseas/session.js';
import { getRecentPerfSummary, getOverseasWinRates, getPendingOverseasStocks, type OverseasWinRate } from './overseas/analytics.js';
import { syncPendingOverseasOrders, getUserInsights, getLossCooldownStocks, getRecentLossStocks } from './overseas/order-sync.js';
import { syncHoldingsFromKIS, reconcileCashWithKIS } from './overseas/kis-sync.js';
import { executeOverseasOrder, deployIdleCash } from './overseas/executor.js';
import {
  calcDynamicTrailDrop, getVixRegime,
  getGradualCooldown, getGradualCooldownStocks,
  calcUncertaintyPenalty,
  clearPartialTpStageNum,
  calcRollingKelly,
  calcStockEVMultipliers,
  extractTradingPatterns, getMemoryBlockedStocks,
} from './overseas/risk-intelligence.js';
import { getActiveSessionBrief } from './overseas/session-strategy.js';
import { detectEarningsDrift } from './overseas/earnings-drift.js';
import { getCrossMarketSignals } from './overseas/cross-market.js';
import { evaluateMarketDefense } from './overseas/market-defense.js';
import { detectSqueezeBreakouts } from './overseas/squeeze-detector.js';
import { checkCorrelationLimit } from './overseas/correlation-engine.js';
import { batchMultiTF } from './overseas/multi-timeframe.js';
import { getTradeReviewInsights } from './overseas/trade-reviewer.js';

// ── 추출 모듈 ──
import { evaluateSells, type TechResult } from './overseas/sell-logic.js';
import { filterAndRankBuyTargets } from './overseas/buy-filter.js';
import { sendBuyRecommendations, sendHoldingAlerts } from './overseas/notifications.js';
import { monitorVisionScalp } from './overseas/vision-scalp.js';
import { rebalancePortfolio } from './overseas/rebalancer.js';

/**
 * 소수점 매수 실행 — 금액 기준 주문 (Live 전용, 미국 주식만)
 * 주가가 포지션 사이즈보다 클 때 사용 (예: NOW $101, 포지션 $96)
 */
async function executeFractionalBuy(
  code: string, amountUsd: number, estimatedPrice: number, exchange: string, reasoning: string,
): Promise<{ submitted: boolean; filledQty: number; filledPrice: number; finalQty: number; finalAvgPrice: number; orderNo?: string }> {
  try {
    const result = await placeFractionalOverseasBuy({ stockCode: code, exchange, amountUsd });
    const { insertOrder: ins } = await import('../db/client.js');
    const estimatedQty = Math.round((amountUsd / estimatedPrice) * 1000) / 1000;
    await ins({
      chain_id: null, stock_code: code, side: 'BUY', order_type: '01',
      quantity: estimatedQty, price: estimatedPrice, kis_order_no: result.orderNo,
      kis_status: result.success ? 'SUBMITTED' : 'FAILED',
      filled_quantity: result.success ? estimatedQty : 0,
      filled_price: result.success ? estimatedPrice : null,
      status: result.success ? 'PENDING' : 'FAILED', trading_mode: 'live',
      trigger_source: 'OVERSEAS', ai_reasoning: `[소수점매수 $${amountUsd}] ${reasoning}`,
    });
    if (result.success) {
      logger.info(`🔬 [LIVE] 소수점 매수: ${code} $${amountUsd} ≈${estimatedQty.toFixed(3)}주 @$${estimatedPrice.toFixed(2)} (${result.orderNo})`, { component: 'OVERSEAS' });
      return { submitted: true, filledQty: estimatedQty, filledPrice: estimatedPrice, finalQty: estimatedQty, finalAvgPrice: estimatedPrice, orderNo: result.orderNo };
    }
    logger.error(`🔬 소수점 매수 실패: ${code} — ${result.message}`, { component: 'OVERSEAS' });
    return { submitted: false, filledQty: 0, filledPrice: 0, finalQty: 0, finalAvgPrice: 0 };
  } catch (e) {
    logger.error(`🔬 소수점 매수 에러: ${code} — ${(e as Error).message}`, { component: 'OVERSEAS' });
    return { submitted: false, filledQty: 0, filledPrice: 0, finalQty: 0, finalAvgPrice: 0 };
  }
}

/**
 * 글로벌 주식 자동매매 Job
 * AI(Claude) + 기술적 지표 복합 판단
 * 최대 5종목 동시 보유, 종목당 $1,500 / 20% 중 작은 값
 */
export async function runOverseasJob(opts?: { isPaper?: boolean }): Promise<void> {
  _modeOverride = opts?.isPaper ?? null;
  const s = overseasState; // shorthand

  if (s.isRunning) return;
  if (s._shuttingDown) {
    logger.info('Shutdown 진행 중 — 해외 Job 스킵', { component: 'OVERSEAS' });
    return;
  }

  // Kill Switch: 매도(탈출)는 항상 허용, 매수만 차단 (아래에서 분기)
  const killSwitchBuyBlock = isKillSwitchActive(SCOPE);
  if (killSwitchBuyBlock) {
    logger.warn('🛑 Kill Switch 활성 [해외] — 매수 차단, 매도만 실행', { component: 'OVERSEAS' });
  }

  // DB Advisory Lock — Cloud Run 롤링 배포 시 동시 실행 방지
  const LOCK_ID = 0x4F564553 + (isPaper() ? 1 : 0); // 'OVES' + paper/live 분리
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
    if (!isPaper()) {
      logger.error(`Advisory lock 획득 실패 (LIVE 모드) — 안전을 위해 중단: ${(lockErr as Error).message}`, { component: 'OVERSEAS' });
      return;
    }
  }

  s.isRunning = true;
  const jobTimeout = setTimeout(() => {
    if (s.isRunning) {
      logger.error('해외 Job 3분 타임아웃 — isRunning 강제 해제', { component: 'OVERSEAS' });
      s.isRunning = false;
    }
  }, 180_000);

  try {
    // ── 시장 시간 필터 (Paper 모드: 장외에서도 매매 허용) ──
    const openRegions = getOpenMarketRegions();
    const isUSExtended = openRegions.has('US_EXTENDED') && !openRegions.has('US');
    if (openRegions.size === 0 && !isPaper()) {
      logger.info('🌏 모든 해외 시장 마감 — 스킵', { component: 'OVERSEAS' });
      return;
    }
    // Paper 장외: 전 종목 대상 (US 기준), 시세는 DB 캐시/마지막 가격 사용
    const paperOffHours = isPaper() && openRegions.size === 0;
    const allActiveStocks = paperOffHours
      ? GLOBAL_WATCHLIST
      : GLOBAL_WATCHLIST.filter(stock =>
          openRegions.has(stock.region) || (isUSExtended && stock.region === 'US'));
    const isUSSession = openRegions.has('US') || isUSExtended || paperOffHours;
    const isAsiaSession = openRegions.has('JP') || openRegions.has('TW');
    const regionFlags = paperOffHours ? '📝' : isUSExtended ? '🌙' : openRegions.has('US') ? '🇺🇸' : '🌏';

    await ensureOverseasTable();
    if (!isPaper()) await syncPendingOverseasOrders();
    if (!isPaper()) await syncHoldingsFromKIS();
    if (!isPaper()) await reconcileCashWithKIS();

    const holdings = await getHoldings(isPaper());
    const pendingOrderStocks = await getPendingOverseasStocks(isPaper());
    let cash = await getCash(isPaper());
    const usCodes = GLOBAL_WATCHLIST.filter(stock => stock.region === 'US').map(stock => stock.code);

    // ── 루프 헬스 요약 ──
    const holdingCost = Array.from(holdings.values()).reduce((s, h) => s + h.qty * h.avgPrice, 0);
    logger.info(
      `📊 해외 루프 ${regionFlags} | 현금 $${cash.toFixed(0)} | 보유 ${holdings.size}/${MAX_POSITIONS} ($${holdingCost.toFixed(0)}) | 종목풀 ${allActiveStocks.length} | ${isPaper() ? 'PAPER' : 'LIVE'}`,
      { component: 'OVERSEAS' },
    );

    // ── Vision Scalp TP/SL 모니터링 (→ overseas/vision-scalp.ts) ──
    await monitorVisionScalp(isPaper());

    // ── 세션 캐시 ──
    const todayStr = getKSTDateString();
    const usSessionId = getUSSessionId();
    const activeCache = isUSSession ? s.usSessionCache : s.asiaSessionCache;
    const sessionId = isUSSession ? usSessionId : todayStr;
    const isNewSession = !activeCache || activeCache.sessionDate !== sessionId;

    if (isNewSession) {
      if (isUSSession) s.usSessionCache = null;
      else s.asiaSessionCache = null;
      logger.info(`${regionFlags} 새 세션 시작 — 전 종목 점수 스캔 (${[...openRegions].join('/')})`, { component: 'OVERSEAS' });
    }

    const currentCache = isUSSession ? s.usSessionCache : s.asiaSessionCache;
    const activeStocks = allActiveStocks;
    if (currentCache) {
      logger.info(`세션 캐시 사용 — 전 종목(${activeStocks.length}) 시세 갱신 + 차트분석 캐시 재사용`, { component: 'OVERSEAS' });
    }

    logger.info(`${regionFlags} 해외주식 자동매매 시작 (${activeStocks.length}/${allActiveStocks.length}종목, 시장: ${[...openRegions].join('/')})`, { component: 'OVERSEAS' });

    // ── 1. 시세 + 차트 병렬 수집 ──
    const techResults: TechResult[] = [];

    const BATCH = 8;
    for (let i = 0; i < activeStocks.length; i += BATCH) {
      const batch = activeStocks.slice(i, i + BATCH);
      const latestCache = isUSSession ? s.usSessionCache : s.asiaSessionCache;
      const settled = await Promise.allSettled(
        batch.map(async (stock) => {
          const price = await getOverseasPrice(stock.code, stock.exchange);
          const cached = latestCache?.techCache.get(stock.code);
          const chart = cached ? null : await getOverseasDailyChart(stock.code, stock.exchange, 40);
          return { stock, price, chart, cached };
        })
      );

      for (const result of settled) {
        if (result.status !== 'fulfilled') continue;
        const { stock, price, chart, cached } = result.value;
        if (price.currentPrice <= 0) continue;

        const dayRange = price.dayHigh - price.dayLow;
        const dayRangePct = dayRange > 0 ? ((price.currentPrice - price.dayLow) / dayRange) * 100 : 50;
        const isMomentum = price.changePct >= 3 && dayRangePct >= 60;
        const isBigMover = price.changePct >= 5;

        let signal: string, score: number, rsi: number, adx: number, trendStrength: string, aboveMA20: boolean, aboveMA60: boolean;
        let bollingerSqueeze: boolean, bollingerBreakout: 'UP' | 'DOWN' | 'NONE';
        let atrPct: number;

        if (cached) {
          ({ signal, score, rsi, adx, trendStrength, aboveMA20, aboveMA60, bollingerSqueeze, bollingerBreakout } = cached);
          atrPct = cached.atrPct ?? 2.0; // 캐시에 없으면 기본값 2%
        } else {
          if (!chart || chart.length < 30) continue;
          const candles: OHLCV[] = chart.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
          const tech = analyzeTechnicals(candles);
          if (!tech) continue;
          signal = tech.overallSignal; score = tech.score;
          rsi = tech.rsi14; adx = tech.adx14; trendStrength = tech.trendStrength;
          aboveMA20 = price.currentPrice > tech.sma20;
          aboveMA60 = price.currentPrice > tech.sma60;
          bollingerSqueeze = tech.bollingerSqueeze;
          bollingerBreakout = tech.bollingerBreakout;
          atrPct = tech.atrPct;
        }

        if (isNewSession) {
          const cacheTarget = isUSSession ? s.usSessionCache : s.asiaSessionCache;
          if (cacheTarget) {
            cacheTarget.techCache.set(stock.code, { score, rsi, adx, signal, trendStrength, isMomentum, dayRangePct, aboveMA20, aboveMA60, bollingerSqueeze, bollingerBreakout, atrPct });
          }
        }

        techResults.push({
          code: stock.code, name: stock.name, exchange: stock.exchange, sector: stock.sector,
          price, signal, score, rsi, adx, trendStrength, dayRangePct, isMomentum, isBigMover, aboveMA20, aboveMA60,
          bollingerSqueeze, bollingerBreakout, atrPct,
        });
        logger.info(
          `  ${stock.code}: $${price.currentPrice} ${price.changePct >= 0 ? '+' : ''}${price.changePct}% | ${signal}(${score}) RSI=${rsi.toFixed(0)} ADX=${adx.toFixed(0)} 일중${dayRangePct.toFixed(0)}%${isBigMover ? ' 🔥빅무버' : isMomentum ? ' 🚀모멘텀' : ''}${bollingerSqueeze ? (bollingerBreakout === 'UP' ? ' 💥BB↑' : bollingerBreakout === 'DOWN' ? ' 💥BB↓' : ' 🔧BBsq') : ''}${cached ? ' [캐시]' : ''}`,
          { component: 'OVERSEAS' },
        );
      }

      if (i + BATCH < activeStocks.length) {
        await new Promise(r => setTimeout(r, 100));
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
      const topCodes = sorted.slice(0, topCount).map(t => t.code);
      const techCacheMap = new Map<string, { score: number; rsi: number; adx: number; signal: string; trendStrength: string; isMomentum: boolean; dayRangePct: number; aboveMA20: boolean; aboveMA60: boolean; bollingerSqueeze: boolean; bollingerBreakout: 'UP' | 'DOWN' | 'NONE'; atrPct: number }>();
      for (const t of techResults) {
        techCacheMap.set(t.code, { score: t.score, rsi: t.rsi, adx: t.adx, signal: t.signal, trendStrength: t.trendStrength, isMomentum: t.isMomentum, dayRangePct: t.dayRangePct, aboveMA20: t.aboveMA20, aboveMA60: t.aboveMA60, bollingerSqueeze: t.bollingerSqueeze, bollingerBreakout: t.bollingerBreakout, atrPct: t.atrPct });
      }
      const newCache: SessionCache = { topCodes, sessionDate: sessionId, techCache: techCacheMap };
      if (isUSSession) s.usSessionCache = newCache;
      else s.asiaSessionCache = newCache;
      logger.info(`${regionFlags} 이번 세션 매수 후보: [${topCodes.join(', ')}] (score 기준 상위 ${topCount})`, { component: 'OVERSEAS' });
    }

    if (techResults.length === 0) {
      logger.warn('해외주식 분석 데이터 없음', { component: 'OVERSEAS' });
      return;
    }

    // ── 1-b. 대시보드용 점수 캐시 갱신 ──
    const regionMap = new Map(GLOBAL_WATCHLIST.map(stock => [stock.code, stock.region as 'US' | 'JP' | 'TW']));
    for (const [code] of holdings) {
      const t = techResults.find(r => r.code === code);
      if (t && t.price.currentPrice > 0) {
        getPool().query(
          `UPDATE overseas_holdings SET last_price = $1, last_price_at = NOW() WHERE stock_code = $2 AND is_paper = $3`,
          [t.price.currentPrice, code, isPaper()],
        ).catch(() => {});
      }
    }

    const priceRows = techResults.filter(t => t.price.currentPrice > 0);
    if (priceRows.length > 0) {
      const vals = priceRows.map((t, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(',');
      const params = priceRows.flatMap(t => [t.code, t.exchange, t.price.currentPrice, t.price.changePct, t.price.volume]);
      getPool().query(
        `INSERT INTO overseas_prices (code, exchange, price, change_pct, volume, updated_at)
         VALUES ${vals}
         ON CONFLICT (exchange, code) DO UPDATE SET
           price = EXCLUDED.price, change_pct = EXCLUDED.change_pct,
           volume = EXCLUDED.volume, updated_at = NOW()`,
        params,
      ).catch(() => {});
    }

    setOverseasScores(techResults.map(t => ({
      code: t.code, name: t.name, exchange: t.exchange,
      region: regionMap.get(t.code) ?? 'US',
      score: t.score, signal: t.signal, price: t.price.currentPrice,
      changePct: t.price.changePct, rsi: t.rsi, cachedAt: Date.now(),
    })));

    // ── 2. AI(Claude) 판단 ──
    const heldSet = new Set(holdings.keys());
    const allAiInputs: OverseasStockInput[] = techResults.map(t => {
      const holding = holdings.get(t.code);
      const pnlPct = holding ? ((t.price.currentPrice - holding.avgPrice) / holding.avgPrice) * 100 : undefined;
      return {
        code: t.code, name: t.name, exchange: t.exchange,
        currentPrice: t.price.currentPrice, changePct: t.price.changePct,
        rsi: t.rsi, adx: t.adx, score: t.score,
        signal: t.signal, trendStrength: t.trendStrength,
        isHolding: !!holding, holdingPnlPct: pnlPct,
        dayRangePct: t.dayRangePct, isMomentum: t.isMomentum, isBigMover: t.isBigMover,
        aboveMA20: t.aboveMA20, bollingerSqueeze: t.bollingerSqueeze, bollingerBreakout: t.bollingerBreakout,
      };
    });

    const latestSessionCache = isUSSession ? s.usSessionCache : s.asiaSessionCache;
    let aiInputs = allAiInputs;
    if (latestSessionCache) {
      const topSet = new Set(latestSessionCache.topCodes);
      aiInputs = allAiInputs.filter(si => heldSet.has(si.code) || topSet.has(si.code) || si.isMomentum || si.isBigMover);
      if (aiInputs.length < allAiInputs.length) {
        logger.info(`🤖 AI 입력 최적화: ${allAiInputs.length} → ${aiInputs.length}종목 (세션 후보 + 모멘텀/빅무버 포함)`, { component: 'OVERSEAS' });
      }
    }

    const hasBuyCandidates = aiInputs.some(si => !si.isHolding);
    const hasSellCandidates = aiInputs.some(si => si.isHolding);
    const now_ms = Date.now();
    const intervalMs = OVERSEAS.AI_INTERVAL_MS;
    const lastAiCall = isPaper() ? s.lastPaperAiCallAt : s.lastUSAiCallAt;
    const aiCooldownOk = isUSSession ? (now_ms - lastAiCall >= intervalMs) : true;
    const shouldCallAI = (hasBuyCandidates || hasSellCandidates) && aiCooldownOk;
    if ((hasBuyCandidates || hasSellCandidates) && !aiCooldownOk) {
      logger.info(`🤖 AI 대기 중 — 다음 호출까지 ${Math.ceil((intervalMs - (now_ms - lastAiCall)) / 60000)}분 (무료 한도 절약)`, { component: 'OVERSEAS' });
    }

    // ── 선행 신호 수집 (AI 호출과 무관하게) ──
    const [crossSignals, earningsDrift, squeezeSignals, tradeReviewCtx, defenseSignal] = await Promise.all([
      getCrossMarketSignals().catch(() => []),
      detectEarningsDrift(usCodes, techResults).catch(() => []),
      Promise.resolve(detectSqueezeBreakouts(techResults)),
      getTradeReviewInsights().catch(() => ''),
      evaluateMarketDefense().catch(() => ({ level: 'NONE' as const, positionReduction: 0, blockNewBuys: false, trailTighten: 0, reasons: [] })),
    ]);

    if (crossSignals.length > 0) logger.info(`🌏 크로스마켓 신호: ${crossSignals.map(s => `${s.usCode}(${s.signalType} ${(s.confidence * 100).toFixed(0)}%)`).join(', ')}`, { component: 'OVERSEAS' });
    if (earningsDrift.length > 0) logger.info(`📈 어닝 드리프트: ${earningsDrift.map(s => `${s.code}(+${s.gapPct.toFixed(1)}% vol${s.volumeRatio.toFixed(1)}x)`).join(', ')}`, { component: 'OVERSEAS' });
    if (squeezeSignals.length > 0) logger.info(`💥 스퀴즈 돌파: ${squeezeSignals.map(s => `${s.code}(str${s.strength.toFixed(2)})`).join(', ')}`, { component: 'OVERSEAS' });
    if (defenseSignal.level !== 'NONE') logger.info(`🛡️ 방어 모드: ${defenseSignal.level} — ${defenseSignal.reasons.join(', ')}`, { component: 'OVERSEAS' });

    let aiDecisions: Awaited<ReturnType<typeof analyzeOverseasWithAI>> = [];
    if (shouldCallAI) {
      const [perfSummary, userInsights, aiInsights] = await Promise.all([
        getRecentPerfSummary(), getUserInsights(), getAIGeneratedInsights(),
      ]);
      const [fgEarly, earningsEarly] = await Promise.all([
        getFearGreedIndex().catch(() => null),
        getUpcomingEarnings(usCodes).catch(() => [] as import('../market/external-signals.js').EarningsEvent[]),
      ]);
      const earningsRiskCodes = earningsEarly.filter(e => e.daysUntil >= 0 && e.daysUntil <= 5).map(e => e.code);
      const positiveCount = techResults.filter(t => t.price.changePct > 0).length;
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
      const sectorMomentumStr = sectorRanking.map(sc => `${sc.sector}${sc.avg >= 0 ? '+' : ''}${sc.avg.toFixed(1)}%`).join(' ');

      const mktCtx = fgEarly ? {
        fearGreed: fgEarly.fearGreedScore, fearGreedLabel: fgEarly.fearGreedLabel,
        vix: fgEarly.vix, earningsRisk: earningsRiskCodes, breadthPct, sectorMomentum: sectorMomentumStr,
      } : { breadthPct, sectorMomentum: sectorMomentumStr };
      const brief = getActiveSessionBrief();
      const sessionCtx = brief ? `[세션전략] ${brief.marketRegime}/${brief.riskLevel} | 집중:${brief.focusSectors.join(',')} | ${brief.narrative}` : '';
      const crossCtx = crossSignals.length > 0 ? `[크로스마켓] ${crossSignals.map(s => `${s.usCode} ${s.signalType}(아시아 ${s.asiaCode} ${s.asiaChangePct >= 0 ? '+' : ''}${s.asiaChangePct.toFixed(1)}%)`).join(', ')}` : '';
      const driftCtx = earningsDrift.length > 0 ? `[어닝드리프트] ${earningsDrift.map(s => `${s.code} ${s.direction} gap${s.gapPct >= 0 ? '+' : ''}${s.gapPct.toFixed(1)}% vol${s.volumeRatio.toFixed(1)}x`).join(', ')}` : '';
      const squeezeCtx = squeezeSignals.length > 0 ? `[스퀴즈돌파] ${squeezeSignals.map(s => `${s.code} str${s.strength.toFixed(2)}`).join(', ')}` : '';
      const combinedInsights = [userInsights, aiInsights ? `[AI자기학습]\n${aiInsights}` : '', sessionCtx, crossCtx, driftCtx, squeezeCtx, tradeReviewCtx ? `[매매복기]\n${tradeReviewCtx}` : ''].filter(Boolean).join('\n\n') || undefined;
      aiDecisions = await analyzeOverseasWithAI(aiInputs, cash, holdings.size, perfSummary, combinedInsights, mktCtx);
      if (isUSSession) {
        if (isPaper()) s.lastPaperAiCallAt = Date.now();
        else s.lastUSAiCallAt = Date.now();
      }
    } else {
      logger.info('🤖 AI 생략 — 후보 없음 또는 쿨다운 중 (무료 한도 절약)', { component: 'OVERSEAS' });
    }

    const aiMap = new Map(aiDecisions.map(d => [d.code, d]));
    const overseasCodes = techResults.map(t => t.code);
    const overseasWinRates = await getOverseasWinRates(overseasCodes).catch(() => new Map<string, OverseasWinRate>());
    if (overseasWinRates.size > 0) {
      logger.info(`📈 해외 승률 데이터: ${overseasWinRates.size}종목`, { component: 'OVERSEAS' });
    }

    // ── VIX 레짐 감지 (매도·매수 공통) ──
    const earlyVixData = await getFearGreedIndex().catch(() => null);
    const vixValue = earlyVixData?.vix ?? 0;
    const vixRegime = getVixRegime(vixValue);
    if (vixRegime.regime !== 'CALM') {
      logger.info(`🌡️ VIX 레짐: ${vixRegime.regime} (VIX=${vixValue.toFixed(1)}) — 사이징x${vixRegime.sizingMult} 트레일${vixRegime.trailTighten > 0 ? `-${vixRegime.trailTighten}%p` : '정상'}`, { component: 'OVERSEAS' });
    }

    // ── 3. 매도 판단 (→ overseas/sell-logic.ts) — 방어 모드 트레일 타이트닝 반영 ──
    const effectiveVixRegime = defenseSignal.trailTighten > 0
      ? { ...vixRegime, trailTighten: vixRegime.trailTighten + defenseSignal.trailTighten }
      : vixRegime;
    const sellResult = await evaluateSells({ holdings, pendingOrderStocks, techResults, aiMap, vixRegime: effectiveVixRegime, cash, isPaper: isPaper() });
    const sellOrders = sellResult.sellOrders;
    cash = sellResult.cash;

    // ── 4. 리스크 관리 ──
    const holdingEvalUsd = Array.from(holdings.entries()).reduce((sum, [code, h]) => {
      const tech = techResults.find((t) => t.code === code);
      return sum + (tech ? tech.price.currentPrice * h.qty : h.avgPrice * h.qty);
    }, 0);
    const portfolioValue = cash + holdingEvalUsd;
    if (s.sessionStartPortfolioValue === null) await setSessionStartValue(portfolioValue);
    const sessionStart = s.sessionStartPortfolioValue ?? portfolioValue;

    // 손실 한도 — 해외 포트폴리오(USD) 기준 30%
    const osLimit = OVERSEAS_LOSS_TIERS;
    const holdingCostUsd = Array.from(holdings.entries()).reduce((sum, [, h]) => sum + h.qty * h.avgPrice, 0);
    const unrealizedLossUsd = holdingCostUsd - holdingEvalUsd; // 양수 = 손실
    const lossPctOfPortfolio = portfolioValue > 0 ? (unrealizedLossUsd / portfolioValue) * 100 : 0;

    if (lossPctOfPortfolio >= osLimit.killPct) {
      await activateKillSwitch(
        `해외 손실 한도 초과: 해외자산 대비 -${lossPctOfPortfolio.toFixed(1)}% (한도 ${osLimit.killPct}%) — $${unrealizedLossUsd.toFixed(0)} 손실 (해외자산 $${portfolioValue.toFixed(0)})`,
        false,
        SCOPE,
      );
      sendTelegramMessage(`🛑 OVERSEAS KILL SWITCH: 해외자산 대비 -${lossPctOfPortfolio.toFixed(1)}%\n손실: $${unrealizedLossUsd.toFixed(0)} (해외자산 $${portfolioValue.toFixed(0)})\n해외 전체 매매 중단`).catch(() => {});
    } else if (lossPctOfPortfolio >= osLimit.blockPct && !s.dailyLossAlertSent5) {
      s.dailyLossAlertSent5 = true;
      sendTelegramMessage(`🚨 CRITICAL: 해외자산 대비 -${lossPctOfPortfolio.toFixed(1)}% 손실\n손실: $${unrealizedLossUsd.toFixed(0)} (해외자산 $${portfolioValue.toFixed(0)})\n신규 매수 차단됨`).catch(() => {});
    } else if (lossPctOfPortfolio >= osLimit.warnPct && !s.dailyLossAlertSent3) {
      s.dailyLossAlertSent3 = true;
      sendTelegramMessage(`⚠️ WARNING: 해외자산 대비 -${lossPctOfPortfolio.toFixed(1)}% 손실\n해외자산: $${portfolioValue.toFixed(0)}`).catch(() => {});
    }

    // ── 4-b. 집중도 캡 (소액 계좌 $500 미만: 1-2종목 집중 → 캡 비활성) ──
    if (portfolioValue >= 500) {
      const CONC_CAP = 0.30;
      const CONC_TARGET = 0.25;
      const capHoldings = await getHoldings(isPaper());
      for (const [capCode, capHolding] of capHoldings) {
        if (pendingOrderStocks.has(capCode)) continue;
        const capTech = techResults.find(t => t.code === capCode);
        if (!capTech || capTech.price.currentPrice <= 0) continue;
        const posValue = capTech.price.currentPrice * capHolding.qty;
        const posWeight = posValue / portfolioValue;
        if (posWeight <= CONC_CAP) continue;
        const targetQty = Math.floor((portfolioValue * CONC_TARGET) / capTech.price.currentPrice);
        const sellQty = capHolding.qty - targetQty;
        if (sellQty < 1) continue;
        logger.warn(`⚠️ 집중도 캡 발동: ${capCode} 비중 ${(posWeight * 100).toFixed(0)}% > 30% → ${sellQty}주 매도`, { component: 'OVERSEAS' });
        const exec = await executeOverseasOrder(capCode, 'SELL', sellQty, capTech.price.currentPrice, capTech.exchange, `집중도 캡(${(posWeight * 100).toFixed(0)}% > 30%) — 25%로 강제 분산 매도`, capHolding.qty, capHolding.avgPrice, { isPaper: isPaper() });
        if (exec.submitted && exec.filledQty > 0) {
          const proceeds = exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
          cash += proceeds;
          await updateTradeState({ code: capCode, exchange: capTech.exchange, qty: exec.finalQty, avgPrice: exec.finalAvgPrice, newCash: cash, isPaper: isPaper() });
          if (exec.finalQty <= 0) { await clearMaxPrice(capCode, isPaper()); await clearPartialTpStageNum(capCode, isPaper()); await getPool().query(`DELETE FROM overseas_state WHERE key = $1`, [`${isPaper() ? 'p_' : 'l_'}scale_in_${capCode}`]).catch(() => {}); }
          sellOrders.push(`⚠️ 집중캡 매도 ${capCode} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (비중 ${(posWeight * 100).toFixed(0)}% → 25%, +$${proceeds.toFixed(0)} 회수)`);
        }
      }
    }

    // ── 5. 매수 판단 ──
    const buyOrders: string[] = [];
    const updatedHoldings = await getHoldings(isPaper());
    const currentHoldingCount = updatedHoldings.size;

    const [marketSentiment, upcomingEarnings] = await Promise.all([
      getFearGreedIndex().catch(() => null),
      getUpcomingEarnings(usCodes).catch(() => []),
    ]);

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
    const riskBlockPct = (quality === 'GREAT' || quality === 'OK') ? 5 : 3;
    const riskBlocked = lossPctOfPortfolio >= riskBlockPct;
    const recoveryMode = lossPctOfPortfolio >= 3 && !riskBlocked;
    if (riskBlocked) {
      logger.warn(`⛔ 총자산 대비 -${lossPctOfPortfolio.toFixed(1)}% → 신규 매수 차단 (한도 ${riskBlockPct}%)`, { component: 'OVERSEAS' });
      await logSystem('WARN', 'OVERSEAS', `총자산 손실 -${lossPctOfPortfolio.toFixed(1)}% → 신규 매수 차단`);
    } else if (recoveryMode) {
      logger.warn(`⚠️ 손실 회복 모드(-${lossPctOfPortfolio.toFixed(1)}%): ${quality} 장세 → AI 85%+ 고확신 종목만 매수`, { component: 'OVERSEAS' });
    }

    // ── 포트폴리오 배분 비중 체크 — kr_pct / us_pct 목표 준수 ──
    let allocBlocked = false;
    const fxNow = await fetchExchangeRate();
    try {
      const { rows: snap } = await getPool().query(
        `SELECT total_value FROM daily_snapshots WHERE DATE(created_at) = CURRENT_DATE ORDER BY id DESC LIMIT 1`
      );
      const krPortfolioUsd = snap.length > 0 && fxNow > 0 ? Number(snap[0].total_value) / fxNow : 0;
      const grandPortfolioUsd = portfolioValue + krPortfolioUsd;
      if (grandPortfolioUsd > 0) {
        const { rows: allocRows } = await getPool().query('SELECT us_pct FROM portfolio_allocation_config LIMIT 1');
        const targetUsPct = Number(allocRows[0]?.us_pct ?? 30);
        const currentUsPct = (portfolioValue / grandPortfolioUsd) * 100;
        if (currentUsPct > targetUsPct * 1.15) {
          allocBlocked = true;
          logger.warn(`📊 해외 배분 비중 초과: ${currentUsPct.toFixed(0)}% > 목표 ${targetUsPct}% (+15% 여유) → 신규 매수 차단`, { component: 'OVERSEAS' });
        }
      }
    } catch { /* alloc config 미존재 시 무시 */ }

    if (!riskBlocked && !allocBlocked && currentHoldingCount < MAX_POSITIONS && cash >= 50) {
      const [lossCooldownSet, recentLossSet] = await Promise.all([getLossCooldownStocks(isPaper()), getRecentLossStocks(isPaper())]);
      if (lossCooldownSet.size > 0) logger.info(`🚫 손절 쿨다운 종목 (24h): ${[...lossCooldownSet].join(', ')}`, { component: 'OVERSEAS' });
      if (recentLossSet.size > 0) logger.info(`⚠️ 최근 손실 종목 (7일, AI≥80% 필수): ${[...recentLossSet].join(', ')}`, { component: 'OVERSEAS' });

      // ── 리스크 인텔리전스 (쿨다운, Memory Agent, Kelly) ──
      const [gradualCooldown, memoryBlockedStocks, kellyResult] = await Promise.all([
        getGradualCooldown(), getMemoryBlockedStocks(), calcRollingKelly(),
      ]);
      if (gradualCooldown.level >= 2) {
        const gcStocks = await getGradualCooldownStocks(gradualCooldown);
        for (const gcs of gcStocks) lossCooldownSet.add(gcs);
        logger.warn(`⏸️ 점진적 쿨다운 Lv${gradualCooldown.level}: ${gradualCooldown.message}`, { component: 'OVERSEAS' });
      }
      if (memoryBlockedStocks.size > 0) logger.info(`🧠 Memory Agent 차단 (60일 승률≤25%): ${[...memoryBlockedStocks].join(', ')}`, { component: 'OVERSEAS' });

      const sectorValues = new Map<string, number>();
      for (const [code, holding] of updatedHoldings) {
        const watchItem = GLOBAL_WATCHLIST.find(w => w.code === code);
        if (!watchItem) continue;
        const tech = techResults.find(t => t.code === code);
        const value = (tech?.price.currentPrice ?? holding.avgPrice) * holding.qty;
        sectorValues.set(watchItem.sector, (sectorValues.get(watchItem.sector) ?? 0) + value);
      }

      const freshBreadth = techResults.length > 0
        ? techResults.filter(r => r.price.changePct > 0).length / techResults.length
        : 0.5;

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
        techResults.filter(t => !updatedHoldings.has(t.code)).map(async t => {
          const p = await calcUncertaintyPenalty({ code: t.code, vix: vixValue, sectorDown: sectorDownSet.has(t.sector) });
          if (p.penalty > 0) uncertaintyMap.set(t.code, p);
        })
      );

      // ── EV 기반 포지션 사이징 배율 ──
      const buyCandidateCodes = techResults.filter(t => !updatedHoldings.has(t.code)).map(t => t.code);
      const evMultipliers = await calcStockEVMultipliers(buyCandidateCodes);
      if (evMultipliers.size > 0) {
        const evEntries = [...evMultipliers.entries()].filter(([, v]) => v.sampleCount >= 3);
        if (evEntries.length > 0) {
          logger.info(`📊 EV 사이징: ${evEntries.map(([c, v]) => `${c}:EV${v.evPct >= 0 ? '+' : ''}${v.evPct.toFixed(1)}%×${v.evMultiplier.toFixed(2)}`).join(' ')}`, { component: 'OVERSEAS' });
        }
      }

      // ── 매수 필터 체인 (→ overseas/buy-filter.ts) ──
      const buyTargets = filterAndRankBuyTargets({
        techResults, updatedHoldings, pendingOrderStocks,
        lossCooldownSet, recentLossSet, memoryBlockedStocks,
        vixRegime, vixValue, gradualCooldown,
        upcomingEarnings, sentinelBlockedCodes, mktSignal,
        sectorValues, portfolioValue, aiMap, freshBreadth,
        uncertaintyMap, overseasWinRates, isUSExtended, recoveryMode, isPaper: isPaper(),
      });

      // ── 장외시간 알림 (→ overseas/notifications.ts) ──
      if (isUSExtended && !isPaper()) {
        await sendBuyRecommendations({
          buyTargets, aiMap, kellyResult, portfolioValue, cash,
          extendedAlertSentAt: s.extendedAlertSentAt, updatedHoldings, techResults,
          usdKrw: fxNow,
        });
        await sendHoldingAlerts({
          extendedAlertSentAt: s.extendedAlertSentAt, updatedHoldings, techResults,
          usdKrw: fxNow,
        });
      }

      // ── 순환 매도 ──
      if (buyTargets.length > 0) {
        const topTarget = buyTargets[0];
        const confFactor = Math.min(1, Math.max(0, topTarget.ai?.confidence ?? 0.65));
        const scoreFactor = Math.min(1, Math.max(0, (topTarget.score + 50) / 100));
        const combined = confFactor * 0.55 + scoreFactor * 0.45;
        const rotSizingMult = Math.round((0.6 + combined * 1.2) * vixRegime.sizingMult * gradualCooldown.sizingPenalty * 100) / 100;
        const rotKellyPct = kellyResult.sampleCount >= 10 ? kellyResult.halfKelly : (topTarget.isMomentum && (topTarget.ai?.confidence ?? 0) >= 0.85 ? 0.25 : 0.20);
        const rotBaseSize = portfolioValue * Math.min(rotKellyPct, 0.25);
        const neededCash = Math.min(rotBaseSize * rotSizingMult, portfolioValue * 0.20);

        if (cash < neededCash) {
          const concKey = isPaper() ? 'p_concentration_code' : 'l_concentration_code';
          const { rows: ccRows } = await getPool().query("SELECT value FROM overseas_state WHERE key = $1", [concKey]).catch(() => ({ rows: [] as { value: string }[] }));
          const concentrationCode = ccRows[0]?.value ?? null;
          if (concentrationCode && concentrationCode !== topTarget.code) {
            const concHolding = updatedHoldings.get(concentrationCode);
            const concTech = techResults.find(t => t.code === concentrationCode);
            if (concHolding && concTech && concTech.price.currentPrice > 0 && concHolding.qty >= 2) {
              const concPnlPct = ((concTech.price.currentPrice - concHolding.avgPrice) / concHolding.avgPrice) * 100;
              if (concPnlPct > 0) {
                const shortfall = neededCash - cash;
                const maxSellQty = Math.floor(concHolding.qty / 2);
                const sellQty = Math.min(Math.ceil(shortfall / concTech.price.currentPrice), maxSellQty);
                if (sellQty >= 1) {
                  const rotateReason = `순환매도: ${topTarget.code} 진입 재원 (집중포지션 +${concPnlPct.toFixed(1)}% 일부 청산)`;
                  const exec = await executeOverseasOrder(concentrationCode, 'SELL', sellQty, concTech.price.currentPrice, concTech.exchange, rotateReason, concHolding.qty, concHolding.avgPrice, { isPaper: isPaper() });
                  if (exec.submitted && exec.filledQty > 0) {
                    const proceeds = exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
                    cash += proceeds;
                    await updateTradeState({ code: concentrationCode, exchange: concTech.exchange, qty: exec.finalQty, avgPrice: exec.finalAvgPrice, newCash: cash, isPaper: isPaper() });
                    if (exec.finalQty <= 0) { await clearMaxPrice(concentrationCode, isPaper()); await clearPartialTpStageNum(concentrationCode, isPaper()); }
                    sellOrders.push(`🔄 순환매도 ${concentrationCode} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (+${concPnlPct.toFixed(1)}%) → ${topTarget.code} 진입 재원 $${proceeds.toFixed(0)}`);
                  }
                }
              }
            }
          }
        }
      }

      // ── Scale-In 확인: 기존 보유 종목 중 +2% 이상 상승 시 나머지 40% 추가매수 ──
      {
        const scaleInPrefix = isPaper() ? 'p_scale_in_' : 'l_scale_in_';
        const { rows: scaleInRows } = await getPool().query<{ key: string; value: string }>(
          `SELECT key, value FROM overseas_state WHERE key LIKE $1`, [`${scaleInPrefix}%`]
        ).catch(() => ({ rows: [] as { key: string; value: string }[] }));
        for (const row of scaleInRows) {
          const code = row.key.replace(scaleInPrefix, '');
          const info = JSON.parse(row.value) as { remainingQty: number; entryPrice: number; createdAt: string; exchange: string };
          const holdingDays = (Date.now() - new Date(info.createdAt).getTime()) / (1000 * 60 * 60 * 24);
          // 3일 초과 → Scale-In 취소
          if (holdingDays > 3) {
            await getPool().query(`DELETE FROM overseas_state WHERE key = $1`, [row.key]).catch(() => {});
            logger.info(`📋 Scale-In 취소: ${code} (3일 초과, 미확인)`, { component: 'OVERSEAS' });
            continue;
          }
          const tech = techResults.find(t => t.code === code);
          if (!tech) continue;
          const pnlFromEntry = ((tech.price.currentPrice - info.entryPrice) / info.entryPrice) * 100;
          if (pnlFromEntry >= 2.0 && cash >= info.remainingQty * tech.price.currentPrice * 1.0025) {
            const exec = await executeOverseasOrder(code, 'BUY', info.remainingQty, tech.price.currentPrice, info.exchange,
              `📈 Scale-In 추가매수 (+${pnlFromEntry.toFixed(1)}% 확인) — 나머지 ${info.remainingQty}주`, 0, 0, { isPaper: isPaper() });
            if (exec.submitted && exec.filledQty > 0) {
              const cost = exec.filledQty * exec.filledPrice * 1.0025;
              cash -= cost;
              await updateTradeState({ code, exchange: info.exchange, qty: exec.finalQty, avgPrice: exec.finalAvgPrice, newCash: cash, isPaper: isPaper() });
              buyOrders.push(`📈 Scale-In ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (+${pnlFromEntry.toFixed(1)}% 확인 추가매수)`);
              await logSystem('TRADE', 'OVERSEAS', `SCALE-IN ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} +${pnlFromEntry.toFixed(1)}%`);
            }
            await getPool().query(`DELETE FROM overseas_state WHERE key = $1`, [row.key]).catch(() => {});
          }
        }
      }

      // ── 멀티 타임프레임 분석 (매수 후보 대상) ──
      const mtfStocks = buyTargets.slice(0, 5).map(t => ({ code: t.code, exchange: t.exchange }));
      const mtfResults = await batchMultiTF(mtfStocks).catch(() => new Map());

      // ── 방어 모드 적용: 매수 차단 / 트레일링 타이트닝 ──
      const defenseBlockBuys = defenseSignal.blockNewBuys;
      if (defenseBlockBuys) {
        logger.warn(`🛡️ 방어 모드 ${defenseSignal.level} — 신규 매수 차단 (${defenseSignal.reasons.join(', ')})`, { component: 'OVERSEAS' });
      }

      // ── 매수 실행 (Rolling Kelly + EV배율 + VIX 레짐 + 점진적 쿨다운 + 상관관계 + MTF 반영) ──
      if (killSwitchBuyBlock) {
        logger.warn(`🛑 Kill Switch 활성 — 해외 매수 ${buyTargets.length}건 건너뜀`, { component: 'OVERSEAS' });
      }
      const slotsAvailable = (killSwitchBuyBlock || defenseBlockBuys) ? 0 : MAX_POSITIONS - currentHoldingCount;
      for (const target of buyTargets.slice(0, slotsAvailable)) {
        // 상관관계 차단: 같은 그룹 내 보유 초과
        const corrBlock = checkCorrelationLimit(target.code, updatedHoldings);
        if (corrBlock) {
          logger.info(`🔗 상관관계 차단: ${target.code} (${corrBlock.group} ${corrBlock.currentCount}/${corrBlock.maxAllowed} — ${corrBlock.reason})`, { component: 'OVERSEAS' });
          continue;
        }
        // 멀티 타임프레임 차단: 방향 불일치 (Live 소액 계좌는 바이패스 — 매수 기회 확보)
        const mtf = mtfResults.get(target.code);
        if (mtf?.blocked) {
          if (!isPaper() && portfolioValue < 500) {
            logger.info(`📊 MTF 경고(소액 바이패스): ${target.code} (W:${mtf.weekly} D:${mtf.daily} H4:${mtf.h4} 합류${mtf.confluence}/3)`, { component: 'OVERSEAS' });
          } else {
            logger.info(`📊 MTF 차단: ${target.code} (W:${mtf.weekly} D:${mtf.daily} H4:${mtf.h4} 합류${mtf.confluence}/3)`, { component: 'OVERSEAS' });
            continue;
          }
        }
        // MTF 합류 보너스: 3TF 일치 → +0.10, 2TF → +0.05
        const mtfBonus = mtf?.confidenceBonus ?? 0;
        const confFactor = Math.min(1, Math.max(0, (target.ai?.confidence ?? 0.65) + mtfBonus));
        const scoreFactor = Math.min(1, Math.max(0, (target.score + 50) / 100));
        const combined = confFactor * 0.55 + scoreFactor * 0.45;
        // EV 기반 배율: 기대값 양수 종목은 확대, 음수 종목은 축소
        const stockEV = evMultipliers.get(target.code);
        const evMult = stockEV?.evMultiplier ?? 1.0;
        const rawSizingMult = Math.round((0.6 + combined * 1.2) * evMult * vixRegime.sizingMult * gradualCooldown.sizingPenalty * 100) / 100;
        // Paper 모드: sizingMult 하한 0.50 (실험/학습 → 적극 투자)
        const sizingMult = isPaper() ? Math.max(rawSizingMult, 0.50) : rawSizingMult;
        // Kelly 기반 포지션 사이즈
        const paperMode = isPaper();
        const kellyDefault = paperMode ? 0.30 : 0.25;
        const kellyMomentum = paperMode ? 0.35 : 0.30;
        const kellyCap = paperMode ? 0.35 : 0.30;
        const kellyFloor = paperMode ? 0.15 : 0.20;
        // 소액 계좌($500 미만): Kelly 무시, 포트폴리오 80% 집중 (1-2종목 전력투구)
        const isSmallAccount = portfolioValue < 500;
        const kellyPct = isSmallAccount ? 0.80
          : kellyResult.sampleCount >= 10 ? Math.max(kellyResult.halfKelly, kellyFloor)
          : (target.isMomentum && (target.ai?.confidence ?? 0) >= 0.85 ? kellyMomentum : kellyDefault);
        const baseSize = portfolioValue * Math.min(kellyPct, isSmallAccount ? 0.80 : kellyCap);
        // 소액 계좌: 현금 95% 사용 (1-2종목 집중), 일반: 70% 버퍼
        const cashUsageCap = isSmallAccount ? 0.95 : 0.70;
        const positionSize = Math.min(baseSize * sizingMult, cash * cashUsageCap);
        // 소액투자 가능: 통합증거금 소액 매수 허용 (수수료 0.25% → $20도 $0.05)
        const minPositionSize = 20;
        if (positionSize < minPositionSize) break;

        const targetWatchItem = GLOBAL_WATCHLIST.find(w => w.code === target.code);
        const isHighBetaEntry = SECTOR_CLASS.HIGH_BETA.includes(targetWatchItem?.sector ?? '');
        const isDefenseEntry = SECTOR_CLASS.DEFENSE.includes(targetWatchItem?.sector ?? '');
        const slDecimal = isHighBetaEntry ? 0.08 : isDefenseEntry ? 0.04 : 0.05;
        // Paper 모드: 3% 리스크 허용 (Live: 2% — 황금비율 상향)
        const riskPct = isPaper() ? 0.03 : 0.02;
        const maxRiskUSD = portfolioValue * riskPct;
        const qtyBy1PctRule = maxRiskUSD > 0 ? Math.floor(maxRiskUSD / (target.price.currentPrice * slDecimal)) : Infinity;
        const qtyBySizing = Math.floor(positionSize / (target.price.currentPrice * 1.0025));
        const fullQty = Math.min(qtyBySizing, qtyBy1PctRule > 0 ? qtyBy1PctRule : qtyBySizing);

        if (fullQty <= 0) continue;

        // Scale-In: 모멘텀/빅무버는 100% 즉시매수, 나머지는 60% 진입 → +2% 확인 후 40% 추가
        const useScaleIn = !target.isMomentum && !target.isBigMover && fullQty >= 3;
        const qty = useScaleIn ? Math.max(1, Math.floor(fullQty * 0.6)) : fullQty;
        const scaleInRemainder = useScaleIn ? fullQty - qty : 0;

        const buyMode = target.isMomentum ? '🚀모멘텀' : (target.rsi <= 35 ? '📉과매도반등' : '📊트렌드');
        const wrInfo = overseasWinRates.get(target.code);
        const wrTag = wrInfo && wrInfo.sampleCount >= 5 ? ` 승률${(wrInfo.winRate * 100).toFixed(0)}%/${wrInfo.sampleCount}건` : '';
        const evTag = stockEV && stockEV.sampleCount >= 3 ? ` EV${stockEV.evPct >= 0 ? '+' : ''}${stockEV.evPct.toFixed(1)}%` : '';
        const reason = target.ai
          ? `${buyMode} AI(${(target.ai.confidence * 100).toFixed(0)}%) 사이징x${sizingMult}: ${target.ai.reasoning}${wrTag}${evTag}`
          : `${buyMode} 기술(AI없음) 사이징x${sizingMult}: score=${target.score} RSI=${target.rsi.toFixed(0)} ADX=${target.adx.toFixed(0)}${wrTag}${evTag}`;

        const exec = await executeOverseasOrder(target.code, 'BUY', qty, target.price.currentPrice, target.exchange, reason, 0, 0, { isPaper: isPaper() });
        if (!exec.submitted) continue;
        if (exec.filledQty <= 0) {
          pendingOrderStocks.add(target.code);
          buyOrders.push(`매수 접수 ${target.code} x${qty} ${buyMode} (체결 대기)`);
          continue;
        }

        const cost = exec.filledQty * exec.filledPrice * 1.0025;
        cash -= cost;
        await updateTradeState({ code: target.code, exchange: target.exchange, qty: exec.finalQty, avgPrice: exec.finalAvgPrice, newCash: cash, isPaper: isPaper() });

        const entryP = exec.filledPrice;
        const tpPct = isHighBetaEntry ? 20 : 15;
        const slPct = isHighBetaEntry ? 8 : isDefenseEntry ? 4 : 5;
        const entryAtrPct = target.atrPct ?? 2.0;
        const entryTrailDrop = calcDynamicTrailDrop({ sector: targetWatchItem?.sector ?? '', atrPct: entryAtrPct, maxPnlPct: 0, adx: target.adx, rsi: target.rsi });
        const tpPrice = (entryP * (1 + tpPct / 100)).toFixed(2);
        const slPrice = (entryP * (1 - slPct / 100)).toFixed(2);
        const kellyTag = kellyResult.sampleCount >= 10 ? ` Kelly${(kellyResult.halfKelly * 100).toFixed(0)}%` : '';
        const evLogTag = stockEV && stockEV.sampleCount >= 3 ? ` EV${stockEV.evPct >= 0 ? '+' : ''}${stockEV.evPct.toFixed(1)}%×${evMult.toFixed(2)}` : '';
        const buyLog = [
          `매수 ${target.code} x${exec.filledQty} @$${entryP.toFixed(2)} ${buyMode}`,
          `📌 목표: $${tpPrice}(+${tpPct}%) | 손절: $${slPrice}(-${slPct}%) | ATR트레일: ${entryTrailDrop.toFixed(1)}%(ATR${entryAtrPct.toFixed(1)}%)`,
          `(AI ${((target.ai?.confidence ?? 0) * 100).toFixed(0)}% 사이징x${sizingMult}${kellyTag}${evLogTag} VIX:${vixRegime.regime}) [수수료 $${(exec.filledQty * exec.filledPrice * OVERSEAS_FEE_PCT).toFixed(2)}]`,
        ].join('\n');
        buyOrders.push(buyLog);
        await logSystem('TRADE', 'OVERSEAS', `BUY ${target.code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} | 사이징x${sizingMult}${kellyTag} VIX:${vixRegime.regime} (conf=${((target.ai?.confidence ?? 0) * 100).toFixed(0)}% score=${target.score}) | ${reason}`);

        // Scale-In 예약: 나머지 40% 추가매수 대기 (+2% 확인 시)
        if (scaleInRemainder > 0) {
          const scaleInKey = `${isPaper() ? 'p_' : 'l_'}scale_in_${target.code}`;
          const scaleInValue = JSON.stringify({ remainingQty: scaleInRemainder, entryPrice: exec.filledPrice, createdAt: new Date().toISOString(), exchange: target.exchange });
          await getPool().query(
            `INSERT INTO overseas_state(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [scaleInKey, scaleInValue]
          ).catch(() => {});
          buyOrders.push(`  📋 Scale-In 예약: ${target.code} 나머지 ${scaleInRemainder}주 (+2% 확인 시 추가매수)`);
        }
      }
    }

    // ── 5-b. 포트폴리오 비중 리밸런싱 (→ overseas/rebalancer.ts) ──
    const rbResult = await rebalancePortfolio({ techResults, isPaper: isPaper(), sellOrders, extendedAlertSentAt: s.extendedAlertSentAt });
    const rebalanceAlerts = rbResult.rebalanceAlerts;
    cash = rbResult.cash;

    // ── 5-c. 유휴현금 운용 (킬스위치 시 스킵 — 매수 행위) ──
    const avgTechScore = techResults.length > 0 ? techResults.reduce((sum, t) => sum + t.score, 0) / techResults.length : 0;
    cash = await getCash(isPaper());
    const idleCashHoldings = await getHoldings(isPaper());
    const idleResult = killSwitchBuyBlock
      ? { cashUsed: 0, actions: [] as string[] }
      : await deployIdleCash({ cash, holdings: idleCashHoldings, techResults, isUSSession, avgScore: avgTechScore, isPaper: isPaper() });
    if (idleResult.cashUsed !== 0) cash -= idleResult.cashUsed;
    const idleActions = idleResult.actions;

    // ── 6. 결과 로그 ──
    const totalActions = buyOrders.length + sellOrders.length + idleActions.length + rebalanceAlerts.length;
    const finalHoldings = await getHoldings(isPaper());
    const holdingList = Array.from(finalHoldings.entries()).map(([code, h]) => {
      const tech = techResults.find(t => t.code === code);
      const pnl = tech ? ((tech.price.currentPrice - h.avgPrice) / h.avgPrice * 100).toFixed(1) : '?';
      return `${code} x${h.qty} @$${h.avgPrice.toFixed(2)} (${Number(pnl) >= 0 ? '+' : ''}${pnl}%)`;
    });

    const summary = [
      `${regionFlags} 해외주식 자동매매 완료`,
      `분석: ${techResults.length}종목 | AI판단: ${aiDecisions.length}건 | 실행: ${totalActions}건`,
      `잔고: $${cash.toFixed(2)} | 보유: ${finalHoldings.size}/${MAX_POSITIONS}종목`,
      ...buyOrders.map(o => `🟢 ${o}`),
      ...sellOrders.map(o => `🔴 ${o}`),
      ...rebalanceAlerts,
      ...idleActions,
      holdingList.length > 0 ? `\n포트폴리오: ${holdingList.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    logger.info(summary, { component: 'OVERSEAS' });
    await logSystem('INFO', 'OVERSEAS', summary);
    if (totalActions > 0) await sendTelegramMessage(summary);

    // ── Memory Agent: 거래 패턴 자동 추출 (세션당 1회) ──
    extractTradingPatterns().catch(() => {});

    // ── 매도 후 빠른 재투자: 현금 해방 시 60초 후 재스캔 ──
    if (sellOrders.length > 0 && finalHoldings.size < MAX_POSITIONS && cash >= 50) {
      const rescanMode = isPaper();
      logger.info(`🔄 매도 ${sellOrders.length}건 완료 → 60초 후 재스캔 (현금 $${cash.toFixed(0)} 재투자, ${rescanMode ? 'PAPER' : 'LIVE'})`, { component: 'OVERSEAS' });
      setTimeout(() => {
        // 재스캔 시 전역 모드 오버라이드 필수 (KIS API 자격증명 일치)
        setTradingModeOverride(rescanMode ? 'paper' : 'live');
        runOverseasJob({ isPaper: rescanMode })
          .catch((e) => logger.error(`재스캔 실패: ${e}`, { component: 'OVERSEAS' }))
          .finally(() => setTradingModeOverride(null));
      }, 60_000);
    }

    reportSuccess(SCOPE);
  } catch (e) {
    const msg = (e as Error).message;
    logger.error(`해외주식 자동매매 실패: ${msg}`, { component: 'OVERSEAS' });
    await reportError('OVERSEAS', msg, SCOPE);
  } finally {
    clearTimeout(jobTimeout);
    s.isRunning = false;
    _modeOverride = null;
    if (lockClient) {
      try { await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]); } catch {}
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
  // ── Paper 모드 ──
  setTradingModeOverride('paper');
  try {
    await runOverseasJob({ isPaper: true });
  } catch (e) {
    logger.error(`해외주식 paper 실패: ${e}`, { component: 'OVERSEAS' });
  } finally {
    setTradingModeOverride(null);
  }

  // ── Live 모드 ──
  setTradingModeOverride('live');
  try {
    await runOverseasJob({ isPaper: false });
  } catch (e) {
    logger.error(`해외주식 live 실패: ${e}`, { component: 'OVERSEAS' });
  } finally {
    setTradingModeOverride(null);
  }
}
