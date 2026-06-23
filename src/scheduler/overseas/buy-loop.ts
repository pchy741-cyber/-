/**
 * 해외주식 매수 루프 — 필터 → 사이징 → 상관관계 → MTF → 버킷 → 실행
 * (overseas-job.ts에서 추출)
 */
import type { analyzeOverseasWithAI } from '../../ai/overseas/analyzer.js';
import { fetchKospiRegime } from '../../ai/track-b/market-regime.js';
import { checkUsEarnings } from '../../automation/earnings-sentinel.js';
import { ALLOCATION_GOLDEN, OVERSEAS, OVERSEAS_FEE_PCT, SECTOR_CLASS } from '../../config/constants.js';
import { getOverseasDynamic } from '../../config/constants.js';
import { getPool, logSystem } from '../../db/client.js';
import type { EarningsEvent, MarketSentiment } from '../../market/external-signals.js';
import { interpretMarketSentiment } from '../../market/external-signals.js';
import { getOverseasLossTiers } from '../../risk/seed-capital.js';
import { logger } from '../../utils/logger.js';
import type { OverseasWinRate } from './analytics.js';
import { filterAndRankBuyTargets } from './buy-filter.js';
import { checkCorrelationLimit } from './correlation-engine.js';
import type { EarningsDriftSignal } from './earnings-drift.js';
import { executeOverseasOrder } from './executor.js';
import { isLoopActive, reportNoBuyCandidates } from '../loop-mode.js';
import { batchMultiTF } from './multi-timeframe.js';
import { sendBuyRecommendations, sendHoldingAlerts } from './notifications.js';
import { getBigLossBlockedOverseas, getLossCooldownStocks, getManualSellCooldownStocks, getRecentLossStocks } from './order-sync.js';
import { calcPositionSize } from './position-sizing.js';
import {
  calcDynamicTpSl,
  calcDynamicTrailDrop,
  calcRollingKelly,
  calcStockEVMultipliers,
  calcUncertaintyPenalty,
  getGradualCooldown,
  getGradualCooldownStocks,
  getMemoryBlockedStocks,
  getVixRegime,
} from './risk-intelligence.js';
import { buildScaleInReservation, processScaleIns, shouldUseScaleIn } from './scale-in-manager.js';
import type { TechResult } from './sell-logic.js';
import { getActiveSessionBrief } from './session-strategy.js';
import { modeKey, overseasState } from './session.js';
import { classifyBucket, getBucketWeight, getHoldings, updateTradeState } from './state.js';
import { GLOBAL_WATCHLIST, WATCHLIST_BY_CODE } from './watchlist.js';

type OverseasHolding = Awaited<ReturnType<typeof getHoldings>> extends Map<string, infer V> ? V : never;

// ── Named constants ──
/** Portfolio value below which the account is considered "small" (USD) */
const SMALL_ACCOUNT_USD = 500;
/** Portfolio value below which the account is considered "mid-size" (USD) */
const MID_ACCOUNT_USD = 2000;

export interface BuyLoopParams {
  techResults: TechResult[];
  aiMap: Map<string, Awaited<ReturnType<typeof analyzeOverseasWithAI>>[number]>;
  holdings: Map<string, OverseasHolding>;
  cash: number;
  portfolioValue: number;
  isPaper: boolean;
  cycleFxRate: number;
  sellOrders: string[];
  pendingOrderStocks: Set<string>;
  overseasWinRates: Map<string, OverseasWinRate>;
  vixValue: number;
  effectiveVixRegime: ReturnType<typeof getVixRegime>;
  lossPctOfPortfolio: number;
  openRegions: Set<string>;
  isUSExtended: boolean;
  isUSSession: boolean;
  marketSentiment: MarketSentiment | null;
  upcomingEarnings: EarningsEvent[];
  defenseSignal: { level: string; blockNewBuys: boolean; positionReduction: number; trailTighten: number; reasons: string[] };
  usCodes: string[];
  earningsDrift: EarningsDriftSignal[];
  freshBreadth: number;
  allocRisk: { positionCapPct: number };
  // v12.3: 뉴스 테마/감성 데이터
  newsThemeSectors?: Set<string>;
  newsSentimentScore?: number;
}

export interface BuyLoopResult {
  buyOrders: string[];
  cash: number;
}

export async function executeBuyLoop(params: BuyLoopParams): Promise<BuyLoopResult> {
  const {
    techResults, aiMap, isPaper: isPaperMode, cycleFxRate, sellOrders,
    pendingOrderStocks, overseasWinRates, vixValue, effectiveVixRegime,
    lossPctOfPortfolio, openRegions, isUSExtended, isUSSession,
    marketSentiment, upcomingEarnings, defenseSignal, usCodes,
    earningsDrift, freshBreadth, allocRisk,
  } = params;
  let { cash, portfolioValue, holdings } = params;
  const mk = modeKey(isPaperMode);
  const s = overseasState;
  const SCOPE = 'OVERSEAS' as const;

  const buyOrders: string[] = [];
  const updatedHoldings = await getHoldings(isPaperMode);
  const currentHoldingCount = updatedHoldings.size;
  const osLimit = getOverseasLossTiers(isPaperMode);
  const riskBlocked = lossPctOfPortfolio >= osLimit.blockPct;

  // v10.9.7: techResults 룩업 맵 — O(n) find() 3곳 → O(1) (섹터별 보유가치, 포트폴리오 배분 등)
  const techByCode = new Map(techResults.map((t) => [t.code, t]));
  const recoveryMode = lossPctOfPortfolio >= osLimit.warnPct && !riskBlocked;
  const dynParams = getOverseasDynamic(portfolioValue, isPaperMode, allocRisk.positionCapPct / 100);
  const MAX_POSITIONS = dynParams.maxPositions;

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

  // ── 포트폴리오 배분 비중 체크 ──
  let allocBlocked = false;
  if (!isPaperMode) {
    try {
      const { rows: domRows } = await getPool().query(
        `SELECT COALESCE(SUM(invested_amount), 0) AS domestic_invested
         FROM chains WHERE is_active = true AND is_paper = false`,
      );
      const domesticInvestedKrw = Number(domRows[0]?.domestic_invested ?? 0);
      const domesticInvestedUsd = cycleFxRate > 0 ? domesticInvestedKrw / cycleFxRate : 0;
      if (domesticInvestedUsd >= 100) {
        const holdingEvalUsdPost = Array.from(updatedHoldings.entries()).reduce((sum, [code, h]) => {
          const tech = techByCode.get(code);
          return sum + (tech ? tech.price.currentPrice * h.qty : h.avgPrice * h.qty);
        }, 0);
        const grandInvestedUsd = (holdingEvalUsdPost || 0) + domesticInvestedUsd;
        const { rows: allocRows } = await getPool().query(
          'SELECT us_pct FROM portfolio_allocation_config WHERE is_paper = $1 ORDER BY id DESC LIMIT 1',
          [isPaperMode],
        );
        let targetUsPct = Number(allocRows[0]?.us_pct ?? 100);
        try {
          const rotKey = isPaperMode ? 'p_rotation_signal' : 'l_rotation_signal';
          const { rows: rotRows } = await getPool().query('SELECT value FROM system_state WHERE key = $1', [rotKey]);
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
        } catch (e) {
          logger.warn(`로테이션 시그널 조회 실패 (기본값 유지): ${(e as Error).message}`, { component: 'OVERSEAS' });
        }
        const currentUsPct = grandInvestedUsd > 0 ? ((holdingEvalUsdPost || 0) / grandInvestedUsd) * 100 : 0;
        const ALLOC_BUFFER = 1.15; // 15% buffer above target allocation
        if (currentUsPct > targetUsPct * ALLOC_BUFFER) {
          allocBlocked = true;
          logger.warn(
            `📊 해외 배분 비중 초과: ${currentUsPct.toFixed(0)}% > 목표 ${targetUsPct}% (+15% 여유) → 신규 매수 차단`,
            { component: 'OVERSEAS' },
          );
        }
      }
    } catch (e) {
      logger.warn(`배분 비중 체크 실패 (무시): ${(e as Error).message}`, { component: 'OVERSEAS' });
    }
  }

  /** Minimum cash ratio to allow new buys (Paper: 15% buffer, Live: 5% buffer) */
  const MIN_CASH_RATIO = isPaperMode ? 0.15 : 0.05;
  const minCashForBuy = portfolioValue * MIN_CASH_RATIO;
  if (riskBlocked || allocBlocked || currentHoldingCount >= MAX_POSITIONS || cash < minCashForBuy) {
    const reasons: string[] = [];
    if (riskBlocked) reasons.push(`리스크차단(-${lossPctOfPortfolio.toFixed(1)}%)`);
    if (allocBlocked) reasons.push('해외비중초과');
    if (currentHoldingCount >= MAX_POSITIONS) reasons.push(`보유풀(${currentHoldingCount}/${MAX_POSITIONS})`);
    if (cash < minCashForBuy) reasons.push(`현금부족($${cash.toFixed(0)}<$${minCashForBuy.toFixed(0)})`);
    logger.info(`🚫 매수 블록 진입 불가 — ${reasons.join(', ')}`, { component: 'OVERSEAS' });
    // Scale-In + 딥바이 체결 감시는 매수 차단과 무관하게 실행
    const scaleInResult = await processScaleIns({ techResults, buyOrders, cash, isPaper: isPaperMode });
    cash = scaleInResult.cash;
    try {
      const { checkDipBuyFills } = await import('./premarket-dip.js');
      const dipFills = await checkDipBuyFills(isPaperMode);
      for (const fill of dipFills) buyOrders.push(fill);
    } catch { /* 딥바이 모듈 없으면 무시 */ }
    return { buyOrders, cash };
  }

  const [lossCooldownSet, recentLossSet, manualSellCdSet, bigLossSet] = await Promise.all([
    getLossCooldownStocks(isPaperMode),
    getRecentLossStocks(isPaperMode),
    getManualSellCooldownStocks(),
    getBigLossBlockedOverseas(isPaperMode),
  ]);
  if (lossCooldownSet.size > 0)
    logger.info(`🚫 손절 쿨다운 종목 (24h): ${[...lossCooldownSet].join(', ')}`, { component: 'OVERSEAS' });
  if (recentLossSet.size > 0)
    logger.info(`⚠️ 최근 손실 종목 (7일, AI≥80% 필수): ${[...recentLossSet].join(', ')}`, { component: 'OVERSEAS' });
  if (bigLossSet.size > 0) {
    for (const code of bigLossSet) lossCooldownSet.add(code);
    logger.info(`🚫 -5%초과 손실 30일 차단: ${[...bigLossSet].join(', ')} (allowRebuy 필요)`, {
      component: 'OVERSEAS',
    });
  }
  for (const code of manualSellCdSet) lossCooldownSet.add(code);
  if (manualSellCdSet.size > 0)
    logger.info(`🙋 수동매도 쿨다운 (2h): ${[...manualSellCdSet].join(', ')} — 자동 재매수 금지`, {
      component: 'OVERSEAS',
    });

  // ── 리스크 인텔리전스 ──
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
  for (const [code, holding] of updatedHoldings) {
    const watchItem = WATCHLIST_BY_CODE.get(code);
    if (!watchItem) continue;
    const tech = techByCode.get(code);
    const value = (tech?.price.currentPrice ?? holding.avgPrice) * holding.qty;
    sectorValues.set(watchItem.sector, (sectorValues.get(watchItem.sector) ?? 0) + value);
  }

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

  // ── 매수 필터 체인 ──
  const brief = getActiveSessionBrief();
  const { getUserBlacklist, getUserFavorites } = await import('./utils.js');
  const [userBlacklist, userFavorites, kospiRegime] = await Promise.all([
    getUserBlacklist(),
    getUserFavorites(),
    fetchKospiRegime().catch(() => ({ penalty: 0 as const })),
  ]);
  // v10.9.7: O(n²) → O(n) 단일패스 (기존: 종목마다 전체 반복으로 같은 섹터 찾기)
  const sectorMomentumMap = new Map<string, number>();
  const _sectorSums = new Map<string, { sum: number; count: number }>();
  for (const t of techResults) {
    const prev = _sectorSums.get(t.sector);
    if (prev) { prev.sum += t.price.changePct; prev.count++; }
    else _sectorSums.set(t.sector, { sum: t.price.changePct, count: 1 });
  }
  for (const [sector, { sum, count }] of _sectorSums) {
    sectorMomentumMap.set(sector, sum / count);
  }

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
    isPaper: isPaperMode,
    sessionBrief: brief,
    earningsDrift,
    userBlacklist,
    userFavorites,
    kospiPenalty: kospiRegime.penalty,
    sectorMomentumMap,
    newsThemeSectors: params.newsThemeSectors,
    newsSentimentScore: params.newsSentimentScore,
  });

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

  // ── Shadow Tracker ──
  try {
    const { recordShadowEntries, updateShadowPositions } = await import('../../shadow/shadow-tracker.js');
    const shadowPicks = [...techResults]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((t) => ({ stockCode: t.code, score: t.score, entryPrice: t.price.currentPrice }))
      .filter((p) => p.entryPrice > 0);
    await recordShadowEntries('US', shadowPicks);
    const usPriceMap = new Map(techResults.map((t) => [t.code, t.price.currentPrice]));
    await updateShadowPositions('US', usPriceMap);
  } catch (e) {
    logger.warn(`Shadow tracker 실패 (비필수): ${(e as Error).message}`, { component: 'OVERSEAS' });
  }

  // Auto Pilot
  if (isLoopActive() && !isPaperMode) {
    reportNoBuyCandidates(buyTargets.length === 0);
  }

  // ── 장외시간 알림 ──
  if (isUSExtended && !isPaperMode) {
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
      usdKrw: cycleFxRate,
    });
    await sendHoldingAlerts({
      extendedAlertSentAt: alertMap,
      updatedHoldings,
      techResults,
      usdKrw: cycleFxRate,
    });
  }

  // ── Scale-In ──
  const scaleInResult = await processScaleIns({ techResults, buyOrders, cash, isPaper: isPaperMode });
  cash = scaleInResult.cash;

  // ── 물타기(평균단가 하향) — AI가 AVERAGE_DOWN 판단한 보유 종목 ──
  const MAX_AVG_DOWN = 2; // 최대 2회
  const AVG_DOWN_SIZE_RATIO = 0.5; // 기존 포지션의 50% 규모로 추가매수
  const AVG_DOWN_MIN_CONF = 0.70; // v12.3: 물타기 최소 신뢰도 (기존: 없음 → 저확신 물타기로 손실 증폭)
  for (const [code, aiDec] of aiMap) {
    if (aiDec.action !== 'AVERAGE_DOWN') continue;
    if (aiDec.confidence < AVG_DOWN_MIN_CONF) {
      logger.info(`🔻 ${code}: 물타기 AI 신뢰도 부족 (${(aiDec.confidence * 100).toFixed(0)}% < ${(AVG_DOWN_MIN_CONF * 100).toFixed(0)}%) — SKIP`, { component: 'OVERSEAS' });
      continue;
    }
    const holding = updatedHoldings.get(code);
    if (!holding || holding.qty <= 0) continue;

    // DB에서 물타기 횟수 확인
    let avgCount = 0;
    try {
      const { rows } = await getPool().query(
        'SELECT averaging_count FROM overseas_holdings WHERE stock_code = $1 AND is_paper = $2',
        [code, isPaperMode],
      );
      avgCount = Number(rows[0]?.averaging_count ?? 0);
    } catch { /* DB 없으면 0 */ }

    if (avgCount >= MAX_AVG_DOWN) {
      logger.info(`🔻 ${code}: 물타기 한도 도달 (${avgCount}/${MAX_AVG_DOWN}) — SKIP`, { component: 'OVERSEAS' });
      continue;
    }

    const tech = techByCode.get(code);
    if (!tech) continue;
    const currentPrice = tech.price.currentPrice;
    const pnlPct = holding.avgPrice > 0 ? ((currentPrice - holding.avgPrice) / holding.avgPrice) * 100 : 0;

    // 안전장치: -3% ~ -8% 구간만 물타기
    if (pnlPct > -3 || pnlPct < -8) {
      logger.info(`🔻 ${code}: PnL ${pnlPct.toFixed(1)}% 물타기 범위 밖 (-3~-8%) — SKIP`, { component: 'OVERSEAS' });
      continue;
    }

    // 집중도 상한 25% 체크
    const positionValue = holding.qty * currentPrice;
    if (portfolioValue > 0 && positionValue / portfolioValue >= 0.25) {
      logger.info(`🔻 ${code}: 집중도 ${((positionValue / portfolioValue) * 100).toFixed(0)}% ≥ 25% — SKIP`, { component: 'OVERSEAS' });
      continue;
    }

    // 물타기 수량 = 기존 포지션의 50% (최소 1주)
    const avgDownQty = Math.max(1, Math.floor(holding.qty * AVG_DOWN_SIZE_RATIO));
    const cost = avgDownQty * currentPrice * (1 + OVERSEAS_FEE_PCT);
    if (cost > cash * 0.5) {
      logger.info(`🔻 ${code}: 물타기 비용 $${cost.toFixed(0)} > 현금 50% — SKIP`, { component: 'OVERSEAS' });
      continue;
    }

    const exec = await executeOverseasOrder(
      code, 'BUY', avgDownQty, currentPrice, tech.exchange,
      `물타기${avgCount + 1}회 PnL=${pnlPct.toFixed(1)}% AI=${(aiDec.confidence * 100).toFixed(0)}%`,
      holding.qty, holding.avgPrice,
      { isPaper: isPaperMode },
    );

    if (exec.submitted && exec.filledQty > 0) {
      cash -= exec.filledQty * exec.filledPrice * (1 + OVERSEAS_FEE_PCT);
      // DB 물타기 횟수 증가 + initial_avg_price 기록
      getPool().query(
        `UPDATE overseas_holdings SET averaging_count = COALESCE(averaging_count, 0) + 1,
         initial_avg_price = CASE WHEN COALESCE(initial_avg_price, 0) = 0 THEN $2 ELSE initial_avg_price END
         WHERE stock_code = $1 AND is_paper = $3`,
        [code, holding.avgPrice, isPaperMode],
      ).catch(() => {});

      const newAvg = exec.finalAvgPrice;
      const improvement = holding.avgPrice > 0 ? ((holding.avgPrice - newAvg) / holding.avgPrice * 100).toFixed(1) : '0';
      buyOrders.push(
        `🔻 물타기 ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (${avgCount + 1}/${MAX_AVG_DOWN}회)\n` +
        `  평단가: $${holding.avgPrice.toFixed(2)} → $${newAvg.toFixed(2)} (-${improvement}%) | PnL=${pnlPct.toFixed(1)}%`,
      );
      await logSystem('TRADE', 'OVERSEAS',
        `AVERAGE_DOWN ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} | 평단가 $${holding.avgPrice.toFixed(2)}→$${newAvg.toFixed(2)} (${avgCount + 1}/${MAX_AVG_DOWN}) AI=${(aiDec.confidence * 100).toFixed(0)}%`,
      );
      logger.info(
        `🔻 물타기 성공: ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} → 평단가 $${newAvg.toFixed(2)} (${avgCount + 1}/${MAX_AVG_DOWN})`,
        { component: 'OVERSEAS' },
      );
    }
  }

  // ── 회복 재진입 (RECOVERY_BUY) — 손절 후 반등 감지 시 50% 사이즈 재진입 ──
  const RECOVERY_SIZE_RATIO = 0.5; // 일반 매수의 50% 사이즈
  const RECOVERY_MIN_CONF = 0.72;
  for (const [code, aiDec] of aiMap) {
    if (aiDec.action !== 'RECOVERY_BUY') continue;
    if (aiDec.confidence < RECOVERY_MIN_CONF) continue;
    if (updatedHoldings.has(code)) continue; // 이미 보유 중이면 스킵
    if (pendingOrderStocks.has(code)) continue;

    const tech = techByCode.get(code);
    if (!tech) continue;
    const currentPrice = tech.price.currentPrice;
    if (currentPrice <= 0) continue;

    // 포지션 사이징: 일반 매수의 50%
    const normalQty = Math.floor((cash * 0.08) / currentPrice); // 8% 포지션
    const recoveryQty = Math.max(1, Math.floor(normalQty * RECOVERY_SIZE_RATIO));
    const cost = recoveryQty * currentPrice * (1 + OVERSEAS_FEE_PCT);
    if (cost > cash * 0.3) continue; // 현금 30% 초과 시 스킵

    const exec = await executeOverseasOrder(
      code, 'BUY', recoveryQty, currentPrice, tech.exchange,
      `RECOVERY_BUY 손절후반등 AI=${(aiDec.confidence * 100).toFixed(0)}%: ${aiDec.reasoning}`,
      0, 0,
      { isPaper: isPaperMode },
    );

    if (exec.submitted && exec.filledQty > 0) {
      cash -= exec.filledQty * exec.filledPrice * (1 + OVERSEAS_FEE_PCT);
      buyOrders.push(
        `🔄 회복재진입 ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (50%사이즈) AI=${(aiDec.confidence * 100).toFixed(0)}%`,
      );
      await logSystem('TRADE', 'OVERSEAS',
        `RECOVERY_BUY ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} | ${aiDec.reasoning}`,
      );
      logger.info(
        `🔄 회복재진입: ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (손절후반등 50%사이즈)`,
        { component: 'OVERSEAS' },
      );
    }
  }

  // ── 프리마켓 딥바이 체결 감시 ──
  try {
    const { checkDipBuyFills } = await import('./premarket-dip.js');
    const dipFills = await checkDipBuyFills(isPaperMode);
    for (const fill of dipFills) buyOrders.push(fill);
  } catch { /* 딥바이 모듈 없으면 무시 */ }

  // ── MTF 분석 ──
  const mtfStocks = buyTargets.slice(0, 5).map((t) => ({ code: t.code, exchange: t.exchange }));
  const mtfResults = await batchMultiTF(mtfStocks).catch(() => new Map());

  // ── 방어 모드 ──
  const defenseBlockBuys = isPaperMode ? false : defenseSignal.blockNewBuys;
  if (defenseSignal.blockNewBuys) {
    const bypass = isPaperMode ? ' (Paper 바이패스)' : '';
    logger.warn(
      `🛡️ 방어 모드 ${defenseSignal.level} — 신규 매수 차단${bypass} (${defenseSignal.reasons.join(', ')})`,
      { component: 'OVERSEAS' },
    );
  }

  // ── 종가베팅 ──
  const { isUSMarketLastNMinutes, getMinutesToUSClose } = await import('./session.js');
  const isEodWindow = isUSMarketLastNMinutes(30);
  const isBadMarket =
    freshBreadth < 0.35 ||
    effectiveVixRegime.regime === 'STRESS' ||
    effectiveVixRegime.regime === 'CRISIS' ||
    defenseSignal.blockNewBuys;
  const eodBlockBuys = !isPaperMode && openRegions.has('US') && !isEodWindow && isBadMarket;
  if (eodBlockBuys && buyTargets.length > 0) {
    logger.info(
      `⏰ 종가베팅: 약세장(breadth=${(freshBreadth * 100).toFixed(0)}% VIX=${effectiveVixRegime.regime}) 마감 ${getMinutesToUSClose()}분 전 — 후보 ${buyTargets.length}종목 대기`,
      { component: 'OVERSEAS' },
    );
  } else if (openRegions.has('US') && !isBadMarket) {
    logger.info(`📈 스윙모드: 정상장(breadth=${(freshBreadth * 100).toFixed(0)}%) — 매수 활성`, {
      component: 'OVERSEAS',
    });
  }

  // ── 매수 실행 ──
  const { isKillSwitchActive } = await import('../../risk/kill-switch.js');
  const killSwitchBuyBlockFresh = isKillSwitchActive(SCOPE);
  if (killSwitchBuyBlockFresh) {
    logger.warn(`🛑 Kill Switch 활성 — 해외 매수 ${buyTargets.length}건 건너뜀`, { component: 'OVERSEAS' });
  }
  const slotsAvailable =
    killSwitchBuyBlockFresh || defenseBlockBuys || eodBlockBuys ? 0 : MAX_POSITIONS - currentHoldingCount;
  logger.info(
    `🔧 매수 루프: slots=${slotsAvailable} (max=${MAX_POSITIONS} held=${currentHoldingCount} kill=${killSwitchBuyBlockFresh} defense=${defenseBlockBuys}) cash=$${cash.toFixed(0)} targets=${buyTargets.length}`,
    { component: 'OVERSEAS' },
  );

  const vixRegime = effectiveVixRegime;
  for (const target of buyTargets.slice(0, slotsAvailable)) {
    const corrBlock = checkCorrelationLimit(target.code, updatedHoldings);
    if (corrBlock && !isPaperMode) {
      logger.info(
        `🔗 상관관계 차단: ${target.code} (${corrBlock.group} ${corrBlock.currentCount}/${corrBlock.maxAllowed} — ${corrBlock.reason})`,
        { component: 'OVERSEAS' },
      );
      continue;
    }
    const mtf = mtfResults.get(target.code);
    if (mtf?.blocked) {
      if (isPaperMode || portfolioValue < SMALL_ACCOUNT_USD) {
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

    const mtfBonus = mtf?.confidenceBonus ?? 0;
    const stockEV = evMultipliers.get(target.code);
    const evMult = stockEV?.evMultiplier ?? 1.0;
    const wrData = overseasWinRates.get(target.code);
    const { sizingMult, positionSize } = calcPositionSize({
      target,
      portfolioValue,
      kellyResult,
      vixRegime,
      gradualCooldown,
      cash,
      isPaper: isPaperMode,
      evMultiplier: evMult,
      mtfBonus,
      sessionSizingMult: brief?.sizingMultiplier,
      winRate: wrData?.winRate,
      winRateSamples: wrData?.sampleCount,
      marketBreadth: freshBreadth,
      atrPct: target.atrPct, // v12.2: Moreira-Muir 변동성 역비례 사이징
    });
    // v10.11: 10% → 5% (기존: 소액 포지션 전부 SKIP → 70% 현금 유휴)
    const MIN_POSITION_RATIO = 0.05; // 5% of portfolio
    const minPositionSize = portfolioValue * MIN_POSITION_RATIO;
    if (positionSize < minPositionSize) {
      logger.info(
        `🔧 ${target.code}: positionSize=$${positionSize.toFixed(2)} < $${minPositionSize.toFixed(0)}(10%) → SKIP (sizing=${sizingMult} cash=$${cash.toFixed(0)})`,
        { component: 'OVERSEAS' },
      );
      continue;
    }

    const targetWatchItem = WATCHLIST_BY_CODE.get(target.code);
    const isHighBetaEntry = SECTOR_CLASS.HIGH_BETA.includes(targetWatchItem?.sector ?? '');
    const isDefenseEntry = SECTOR_CLASS.DEFENSE.includes(targetWatchItem?.sector ?? '');
    const slDecimal = isHighBetaEntry ? 0.08 : isDefenseEntry ? 0.04 : 0.05;
    // v10.11: Paper riskPct 2.5%→5% (기존: $500주식 2주만 허용 → 소액 매수 병목)
    const riskPct = portfolioValue < SMALL_ACCOUNT_USD ? 0.10 : portfolioValue < MID_ACCOUNT_USD ? 0.05 : isPaperMode ? 0.05 : 0.02;
    const maxRiskUSD = portfolioValue * riskPct;
    const qtyBy1PctRule =
      maxRiskUSD > 0 ? Math.floor(maxRiskUSD / (target.price.currentPrice * slDecimal)) : Infinity;
    const priceWithFee = target.price.currentPrice * (1 + OVERSEAS_FEE_PCT);
    let qtyBySizing = Math.floor(positionSize / priceWithFee);
    if (qtyBySizing === 0 && positionSize >= target.price.currentPrice * 0.99) {
      qtyBySizing = 1;
    }
    if (qtyBySizing === 0 && portfolioValue < SMALL_ACCOUNT_USD && target.price.currentPrice <= cash * 0.95) {
      qtyBySizing = 1;
    }
    const existingHolding = updatedHoldings.get(target.code);
    const existingQty = existingHolding?.qty ?? 0;
    /** Small account threshold (USD) — below this, relax concentration limits */
    /** Concentration cap: % of portfolio allowed per single position */
    // v10.11: 집중도 상한 25%→35% Paper (자금 분산 과다 완화)
    const CONC_CAP_PCT = portfolioValue < SMALL_ACCOUNT_USD ? 1.0 : isPaperMode ? 0.35 : 0.25;
    let maxQtyByConc =
      portfolioValue > 0
        ? Math.max(0, Math.floor((portfolioValue * CONC_CAP_PCT) / priceWithFee) - existingQty)
        : Infinity;
    if (maxQtyByConc === 0 && portfolioValue < 500 && existingQty === 0 && target.price.currentPrice <= cash * 0.95) {
      maxQtyByConc = 1;
    }
    const fullQty = Math.min(qtyBySizing, qtyBy1PctRule > 0 ? qtyBy1PctRule : qtyBySizing, maxQtyByConc);

    if (fullQty <= 0) {
      logger.info(
        `🔧 ${target.code}: fullQty=0 → SKIP (sizing=${qtyBySizing} risk=${qtyBy1PctRule} conc=${maxQtyByConc} price=$${target.price.currentPrice.toFixed(2)} posSize=$${positionSize.toFixed(0)} cash=$${cash.toFixed(0)})`,
        { component: 'OVERSEAS' },
      );
      continue;
    }

    const useScaleIn = shouldUseScaleIn(target) && fullQty >= 3;
    const qty = useScaleIn ? Math.max(1, Math.floor(fullQty * 0.6)) : fullQty;
    const scaleInRemainder = useScaleIn ? fullQty - qty : 0;

    const buyMode = target.isMomentum ? '🚀모멘텀' : target.rsi <= 35 ? '📉과매도반등' : '📊트렌드';
    const wrInfo = overseasWinRates.get(target.code);
    const wrTag =
      wrInfo && wrInfo.sampleCount >= 5 ? ` 승률${(wrInfo.winRate * 100).toFixed(0)}%/${wrInfo.sampleCount}건` : '';
    const evTag =
      stockEV && stockEV.sampleCount >= 3 ? ` EV${stockEV.evPct >= 0 ? '+' : ''}${stockEV.evPct.toFixed(1)}%` : '';
    const entrySource = target.isBigMover
      ? 'BIGMOVER'
      : target.isMomentum
        ? 'MOMENTUM'
        : target.bollingerBreakout === 'UP'
          ? 'BB_BREAKOUT'
          : target.rsi <= 35
            ? 'OVERSOLD'
            : 'TECHNICAL';

    const isBlueChipEntry = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'AVGO', 'TSM', 'LLY', 'V'].includes(
      target.code,
    );
    const targetBucket = classifyBucket(entrySource, isBlueChipEntry);
    const effectiveBucket =
      target.ai?.action === 'BUY' &&
      (target.ai?.confidence ?? 0) >= 0.85 &&
      target.score >= 85
        ? 'SNIPER'
        : targetBucket;
    const bucketLimit = ALLOCATION_GOLDEN[`${effectiveBucket}_PCT` as keyof typeof ALLOCATION_GOLDEN];
    const livePriceMap = new Map(techResults.map((t) => [t.code, t.price.currentPrice]));
    const currentBucketWeight = getBucketWeight(
      updatedHoldings as Map<string, { qty: number; avgPrice: number; bucket: string }>,
      portfolioValue, effectiveBucket, livePriceMap,
    );
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
      { isPaper: isPaperMode },
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
    const effectiveSlPct = targetBucket === 'TACTICAL' ? 1.5 : effectiveBucket === 'SNIPER' ? 2.0 : dynSlPct;
    await updateTradeState({
      code: target.code,
      exchange: target.exchange,
      qty: exec.finalQty,
      avgPrice: exec.finalAvgPrice,
      newCash: cash,
      isPaper: isPaperMode,
      fxRate: cycleFxRate,
      tpPct,
      slPct: -effectiveSlPct,
    });
    getPool()
      .query('UPDATE overseas_holdings SET strategy_bucket = $1 WHERE stock_code = $2 AND is_paper = $3', [
        effectiveBucket,
        target.code,
        isPaperMode,
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

    if (scaleInRemainder > 0) {
      const { key: scaleInKey, value: scaleInValue } = buildScaleInReservation(
        target.code,
        scaleInRemainder,
        exec.filledPrice,
        target.exchange,
        isPaperMode,
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

  return { buyOrders, cash };
}
