import { STRATEGY_PARAMS, REFRESH, type StrategyMode } from '../../config/constants.js';
import { config } from '../../config/index.js';
import {
  enableMemoryMode,
  getActiveStrategy,
  getActiveWatchlist,
  getLatestScores,
  getOpenChains,
  getPool,
  getRecentLossStocks,
  getRecentManuallySoldStocks,
  getTodayRepeatStopCodes,
  logSystem,
} from '../../db/client.js';
import type { TradeDecision } from '../../db/models.js';
import { getAccountBalance } from '../../kis/account.js';
import { getBatchPrices, getDailyChart, isMarketOpen, getChangeRankingStocks, getOrderbook } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { buildDefenseParkExitDecisions, getDefenseParkState, PARK_STOCK_CODE } from './defense-park.js';
import { IDLE_PARK_STOCK_CODE } from './cash-manager.js';
import { setActiveEngine } from '../../cache/ai-status.js';
import { technicalFallbackDecisions } from './technical-fallback.js';
import { fetchKospiRegime, checkDailyLoss } from './market-regime.js';
import { getMacroSnapshot, getMacroScoreAdjustment } from '../../automation/macro-data.js';
import { checkNewsForStock } from '../../automation/news-sentinel.js';
import { monitorDisclosures, getDisclosureScoreAdjustment } from '../../automation/dart-monitor.js';
import { getInvestorFlow } from '../../automation/investor-flow.js';
import { calcPortfolioStressLevel, getPerformanceMultiplier } from '../../automation/portfolio-guard.js';
import { applyDecisionFlow } from './decision-flow.js';
import { reconcilePendingOrders } from '../../trading/fill-reconciler.js';

// DART 캐시 갱신 추적 (DART_API_KEY 있을 때만, REFRESH.DART_INTERVAL_MS 마다)
let _lastDartRefreshAt = 0;

/**
 * Track B 전체 파이프라인 — 장중 5분 간격 실행
 *
 * 실행 순서 (각 단계는 독립 모듈, 충돌 없음):
 * 1. 장 열림 확인
 * 2. DB/KIS 데이터 로드
 * 3. KOSPI 레짐 + 일일 손실 + 매크로 스냅샷 (market-regime.ts + macro-data.ts)
 * 4. 기술적 지표 매매 판단 (technical-fallback.ts)
 * 5. 조기 매도 방지 필터 (risk-guard.ts)
 * 6. 유휴 현금 파킹 관리 (cash-manager.ts)
 * 7. 하드룰 손절/트레일링 강제 (risk-guard.ts)
 * 8. 수동 매도 쿨다운 필터 (risk-guard.ts)
 * 9. 포지션 크기 보정 (position-sizer.ts)
 * 10. 중복 매도 신호 제거 (risk-guard.ts)
 */
export async function runTrackBPipeline(): Promise<TradeDecision[]> {
  const startTime = Date.now();
  logger.info('🔄 Track B 파이프라인 시작', { component: 'TRACK_B' });

  try {
    // ── 0. 미체결 주문 정리 (체결확인 + 10분 초과 취소) ─────────────
    await reconcilePendingOrders().catch(() => {});

    // ── 1. 장 열림 확인 ──────────────────────────────────────────────
    if (!isMarketOpen()) {
      logger.info('장이 닫혀있어 Track B 스킵', { component: 'TRACK_B' });
      return [];
    }

    // ── 2. 데이터 로드 (병렬) ────────────────────────────────────────
    const dbLoadWithFallback = async () => {
      try {
        return await Promise.all([
          getActiveWatchlist(),
          getOpenChains(),
          getActiveStrategy(),
          getRecentLossStocks(7),
          getRecentManuallySoldStocks(24),
        ]);
      } catch (dbErr: any) {
        const msg = String(dbErr?.message ?? dbErr).toLowerCase();
        const code = String(dbErr?.code ?? '');
        const isNetworkErr =
          ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(code) ||
          msg.includes('timeout') || msg.includes('terminated') || msg.includes('econnrefused') ||
          msg.includes('connection') || msg.includes('enotfound');
        if (isNetworkErr) {
          logger.warn(`⚡ DB 연결 실패 → 인메모리 모드로 전환: [${code}] ${msg}`, { component: 'TRACK_B' });
          enableMemoryMode();
          return await Promise.all([
            getActiveWatchlist(),
            getOpenChains(),
            getActiveStrategy(),
            getRecentLossStocks(7),
            getRecentManuallySoldStocks(24),
          ]);
        }
        throw dbErr;
      }
    };
    const [watchlist, openChains, strategy, recentLossCodes, manuallySoldCodes] = await dbLoadWithFallback();
    // 당일 1회 이상 손절 종목 → 당일 재진입 완전 차단 (recentLossCodes = 7일 손실차단)
    const todayRepeatStopCodes = await getTodayRepeatStopCodes(1);
    if (todayRepeatStopCodes.size > 0) {
      logger.warn(`🚫 당일 반복손절 재진입 차단: ${[...todayRepeatStopCodes].join(', ')}`, { component: 'TRACK_B' });
    }
    const balanceRaw = await getAccountBalance();
    const balance = balanceRaw as any;

    if (watchlist.length === 0) {
      logger.warn('감시 목록이 비어있습니다', { component: 'TRACK_B' });
      return [];
    }

    // ── 개장 초단타 모드: 09:00~09:30 자동 강제 적용 ─────────────────
    // Intl API로 서버 타임존 무관하게 정확한 KST 시각 계산
    const _kstParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date());
    const kstH = Number(_kstParts.find(p => p.type === 'hour')!.value);
    const kstM = Number(_kstParts.find(p => p.type === 'minute')!.value);
    const isOpeningBell = kstH === 9 && kstM < 15;  // 09:00~09:14 (15분 윈도우 — 09:15+ 진입 시 09:30 TP 도달 불가)
    const dbMode = (strategy?.mode ?? 'SWING') as StrategyMode;
    // SNIPER/DEFENSE는 개장벨에도 모드 유지 (SNIPER는 CEO가 명시적으로 설정한 집중 전략)
    const mode: StrategyMode = (isOpeningBell && dbMode !== 'DEFENSE' && dbMode !== 'SNIPER') ? 'SCALPING' : dbMode;
    if (isOpeningBell && mode === 'SCALPING') {
      logger.info('🔔 개장 초단타 모드 자동 활성화 (09:00~09:14) — SCALPING +2.0% 즉시 익절', { component: 'TRACK_B' });
    }
    // SCALPING 09:30 데드라인: 이후 신규 매수는 SWING 기준으로 전환 (기존 체인은 강제청산 유지)
    const isPastScalpDeadline = dbMode === 'SCALPING' && (kstH > 9 || (kstH === 9 && kstM >= 30));
    const isScalpingMode = dbMode === 'SCALPING';

    // ── 방어 파킹 시스템 ──────────────────────────────────────────────
    const parkState = await getDefenseParkState();
    if (parkState.isActive) {
      logger.info(`🔓 방어 파킹 강제 해제 → 기술적 매매 복귀`, { component: 'TRACK_B' });
      return buildDefenseParkExitDecisions(openChains, '기술적 매매 우선 — 방어 파킹 해제');
    }
    const orphanedKodex = openChains.find((c) => c.stock_code === PARK_STOCK_CODE);
    if (orphanedKodex) {
      logger.warn(`🧹 잔여 KODEX 200 즉시 청산`, { component: 'TRACK_B' });
      return buildDefenseParkExitDecisions([orphanedKodex], 'KODEX 200 잔여 포지션 청산');
    }

    // ── AI 스코어 로드 ────────────────────────────────────────────────
    const stockCodes: string[] = watchlist.map((w) => w.stock_code);
    const { getCachedScores } = await import('../../cache/redis.js');
    let scores = await getCachedScores(stockCodes);
    if (scores.length === 0) scores = await getLatestScores(stockCodes);
    if (scores.length === 0) {
      logger.warn('오늘의 AI 스코어가 없습니다 (Track A 미실행?) → 기술적 지표 fallback 진행', { component: 'TRACK_B' });
    }

    // ── 실시간 시세 수집 (KIS rate limit 방지: 상위 35종목 + 보유종목) ──
    // 워치리스트 전체(~79종목) 동시 조회 시 KIS 1000 req/10min 한도 초과 → rate limit storm
    // AI 스코어 상위 35개만 BUY 평가, 보유종목은 무조건 포함 (TP/SL 트리거)
    const chainStockCodes = openChains.map((c) => c.stock_code);
    const scoreMapPre = new Map(scores.map((s: any) => [s.stock_code, (s.composite_score ?? 0) as number]));
    const sortedWatchlistCodes = [...stockCodes]
      .sort((a, b) => (scoreMapPre.get(b) ?? 0) - (scoreMapPre.get(a) ?? 0))
      .slice(0, 35);
    const allStockCodes = [...new Set([...sortedWatchlistCodes, ...chainStockCodes, PARK_STOCK_CODE, IDLE_PARK_STOCK_CODE])];
    logger.info(`📡 시세 조회: ${allStockCodes.length}종목 (워치리스트 상위 ${sortedWatchlistCodes.length} + 보유 ${chainStockCodes.length})`, { component: 'TRACK_B' });
    const livePrices = await getBatchPrices(allStockCodes);

    const _rawOrderableCash = Math.max(0, balance.orderableCash ?? 0);

    // 가격 캐싱 (대시보드 fallback용)
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

    // ── 차트 데이터 수집 (동일 상위 35 + 보유종목 기준) ─────────────────
    const chartData = new Map<string, import('../../kis/market.js').DailyCandle[]>();
    const allCodesForChart = [...new Set([...sortedWatchlistCodes, ...openChains.map((c) => c.stock_code)])];
    const CHART_BATCH = 5;
    for (let i = 0; i < allCodesForChart.length; i += CHART_BATCH) {
      const batch = allCodesForChart.slice(i, i + CHART_BATCH);
      const results = await Promise.allSettled(batch.map((code) => getDailyChart(code, 65)));
      for (let j = 0; j < batch.length; j++) {
        const r = results[j];
        if (r.status === 'fulfilled' && r.value.length >= 30) {
          chartData.set(batch[j], r.value);
        } else if (r.status === 'rejected') {
          logger.warn(`차트 조회 실패: ${batch[j]} - ${r.reason}`, { component: 'TRACK_B' });
        }
      }
    }

    // ── 3. KOSPI 레짐 + 일일 손실 (병렬) ────────────────────────────
    const orderableCash = _rawOrderableCash;
    const totalAssets = balance.totalEvalAmount + orderableCash;

    const [kospiRegime, dailyLoss, macroSnapshot] = await Promise.all([
      fetchKospiRegime(),
      checkDailyLoss({ openChains, livePrices, totalAssets }),
      getMacroSnapshot().catch(() => null),
    ]);

    // DART 공시 캐시 갱신 (1시간 간격 — API 키 없으면 no-op)
    if (process.env.DART_API_KEY && Date.now() - _lastDartRefreshAt > REFRESH.DART_INTERVAL_MS) {
      _lastDartRefreshAt = Date.now();
      monitorDisclosures().catch(() => {});
    }
    const macroRiskOff = !config.isPaper && macroSnapshot?.regime === 'RISK_OFF';
    if (macroSnapshot?.regime === 'RISK_OFF') {
      logger.info(`🌐 매크로 RISK_OFF (Fear&Greed=${macroSnapshot?.fearGreedIndex ?? '?'}, VKOSPI=${macroSnapshot?.vkospi ?? '?'}) → ${config.isPaper ? '모의투자 — 차단 스킵' : '신규 매수 추가 제한'}`, { component: 'TRACK_B' });
    }

    // 현재 주식 포지션 가치
    const currentStockValue = openChains
      .filter(c => c.stock_code !== PARK_STOCK_CODE)
      .reduce((sum, c) => {
        const price = livePrices.get(c.stock_code)?.currentPrice ?? Number(c.avg_buy_price ?? 0);
        return sum + price * Number(c.total_quantity ?? 0);
      }, 0);

    // ── 매수 후보 스크리닝 + KIS 관심종목 동기화 ──────────────────────
    const hasScores = scores.length > 0;

    // 자동 DEFENSE 트리거: 급락 서킷브레이커 OR (하락장+당일하락+손실-1.5%+)
    const autoShouldDefense = dbMode === 'SWING' && (
      kospiRegime.flashCrash ||
      (kospiRegime.penalty >= 2 && kospiRegime.todayDown && dailyLoss.dailyPnlPct <= -1.5)
    );
    // 자동 SWING 복귀: DB=DEFENSE이지만 시장 정상화 (MA60 위 + 당일 하락 없음 + 손실 0.5% 미만)
    const autoShouldRevertSwing = dbMode === 'DEFENSE' &&
      kospiRegime.penalty === 0 && !kospiRegime.todayDown && dailyLoss.dailyPnlPct > -0.5;

    const effectiveMode: StrategyMode = isPastScalpDeadline
      ? 'SWING'
      : autoShouldDefense ? 'DEFENSE'
      : autoShouldRevertSwing ? 'SWING'
      : (scores.length === 0 && mode === 'DEFENSE') ? 'SWING'
      : mode;

    if (isPastScalpDeadline) {
      logger.info('⏰ SCALPING 09:30 이후 → 신규 매수 SWING 기준 전환 (기존 SCALPING 포지션은 강제청산)', { component: 'TRACK_B' });
      // DB 모드 자동 전환 (SCALPING → SWING) — 한 번만 실행 (WHERE mode='SCALPING' 조건으로 멱등)
      getPool().query(
        `UPDATE strategy_config SET mode='SWING', updated_at=NOW() WHERE is_active=true AND mode='SCALPING'`
      ).then(({ rowCount }) => {
        if (rowCount && rowCount > 0) logger.info('✅ DB 모드 자동전환: SCALPING → SWING (09:30 이후)', { component: 'TRACK_B' });
      }).catch((e: Error) => logger.warn(`모드 자동전환 DB 업데이트 실패: ${e.message}`, { component: 'TRACK_B' }));
    } else if (autoShouldDefense) {
      const reason = kospiRegime.flashCrash ? '급락 서킷브레이커' : `하락장(penalty${kospiRegime.penalty})+당일하락+손실${dailyLoss.dailyPnlPct.toFixed(1)}%`;
      logger.warn(`🔴 자동 DEFENSE 모드 전환: ${reason} → 신규 매수 극제한`, { component: 'TRACK_B' });
    } else if (autoShouldRevertSwing) {
      logger.info(`🟢 자동 SWING 복귀: KOSPI 정상(penalty=0) + 당일 무하락 + 손실${dailyLoss.dailyPnlPct.toFixed(1)}% → DEFENSE 해제`, { component: 'TRACK_B' });
      // DB 모드 복귀 (DEFENSE → SWING) — 멱등 조건
      getPool().query(
        `UPDATE strategy_config SET mode='SWING', updated_at=NOW() WHERE is_active=true AND mode='DEFENSE'`
      ).then(({ rowCount }) => {
        if (rowCount && rowCount > 0) logger.info('✅ DB 모드 자동전환: DEFENSE → SWING (시장 정상화)', { component: 'TRACK_B' });
      }).catch((e: Error) => logger.warn(`모드 자동복귀 DB 업데이트 실패: ${e.message}`, { component: 'TRACK_B' }));
    } else if (scores.length === 0 && mode === 'DEFENSE') {
      logger.info('⚡ AI 스코어 없음 + DEFENSE 모드 → SWING으로 완화', { component: 'TRACK_B' });
    }

    let hasBuyCandidates = scores.some(
      (s) => (s.composite_score ?? 0) >= STRATEGY_PARAMS[effectiveMode].buyThreshold && (s.confidence ?? 0) >= 0.55,
    );
    const hasOpenPositions = openChains.some((c) => Number(c.total_quantity) > 0);
    if (!hasBuyCandidates) {
      logger.info(`⏭️ 매수 후보 없음 → KIS 관심종목 재동기화 (보유종목 ${hasOpenPositions ? '있음' : '없음'})`, { component: 'TRACK_B' });
      try {
        const { syncInterestGroups } = await import('../../kis/interest-group.js');
        const { added } = await syncInterestGroups();
        if (added.length > 0) {
          logger.info(`📌 신규 ${added.length}종목 감시 편입 (${added.join(', ')})`, { component: 'TRACK_B' });
          const newPrices = await getBatchPrices(added).catch(() => new Map());
          for (const [code, price] of newPrices) { livePrices.set(code, price); stockCodes.push(code); }
          for (const code of added) {
            const candles = await getDailyChart(code, 65).catch(() => []);
            if (candles.length >= 30) chartData.set(code, candles);
          }
          const newScores = await getLatestScores(added).catch(() => []);
          if (newScores.length > 0) {
            scores.push(...newScores);
            hasBuyCandidates = scores.some(
              (s) => (s.composite_score ?? 0) >= STRATEGY_PARAMS[effectiveMode].buyThreshold && (s.confidence ?? 0) >= 0.55,
            );
          }
        }
      } catch { /* 동기화 실패해도 파이프라인 계속 */ }
    }

    // 승률 데이터 + 황금비율 배분 설정
    const { getStockWinRates } = await import('../../analysis/win-rate.js');
    const winRates = await getStockWinRates(stockCodes).catch(() => new Map());

    // ── 외국인/기관 수급 → AI 스코어 보정 (15분 캐시) ───────────────────
    // KIS rate limit 대응: 워치리스트 5개씩 배치, 타임아웃 4초/종목
    const flowAdjMap = new Map<string, number>();
    try {
      const FLOW_SCORE_ADJ: Record<string, number> = { STRONG_BUY: 10, BUY: 6, NEUTRAL: 0, SELL: -10, STRONG_SELL: -20 };
      const flowBatch = sortedWatchlistCodes.slice(0, 10); // AI 스코어 상위 10종목 (rate limit + 매수 후보 우선)
      const flowResults = await Promise.allSettled(
        flowBatch.map((code) =>
          Promise.race([
            getInvestorFlow(code, 5).then((f) => {
              const trendAdj = FLOW_SCORE_ADJ[f.trend] ?? 0;
              // 외국인 연속 순매수/순매도 streak 보정: +5(3일+연속매수) / -8(3일+연속매도)
              const streakAdj = f.foreignStreak >= 3 ? 5 : f.foreignStreak <= -3 ? -8 : 0;
              return { code, adj: trendAdj + streakAdj };
            }),
            new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 3000)),
          ]),
        ),
      );
      for (const r of flowResults) {
        if (r.status === 'fulfilled') flowAdjMap.set(r.value.code, r.value.adj);
      }
      if (flowAdjMap.size > 0) {
        logger.info(`📊 수급 스코어 보정: ${[...flowAdjMap.entries()].filter(([, v]) => v !== 0).map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`).join(', ')}`, { component: 'TRACK_B' });
      }
    } catch { /* 수급 실패해도 파이프라인 계속 */ }

    // STRONG_SELL(-20점) = 외국인+기관 동반 이탈 → 잡주 필터 대상
    const junkStockCodes = new Set(
      [...flowAdjMap.entries()].filter(([, adj]) => adj <= -20).map(([code]) => code),
    );
    if (junkStockCodes.size > 0) {
      logger.info(`🗑️ 잡주 필터 대상(STRONG_SELL): ${[...junkStockCodes].join(', ')}`, { component: 'TRACK_B' });
    }

    const allocCfg = await import('../../db/client.js')
      .then(m => m.getPool().query('SELECT * FROM portfolio_allocation_config WHERE is_active = true LIMIT 1'))
      .then(r => r.rows[0] ?? null).catch(() => null);

    // ── 3-d. 실시간 등락률 상위 종목 동적 편입 ────────────────────────────
    // 조건: KOSPI >= MA60 (하락장 아님) + 일일손실 미차단
    // kospiBoost(MA20>MA60 강세) 뿐 아니라 중립장(penalty=0)에서도 작동
    const watchlistSet = new Set(watchlist.map((w) => w.stock_code));
    if ((kospiRegime.penalty === 0 || isScalpingMode) && !dailyLoss.blocked) {
      try {
        const topGainers = await getChangeRankingStocks(10, 'J');
        const newStocks = topGainers.filter((s) => s.stock_code && !watchlistSet.has(s.stock_code));
        if (newStocks.length > 0) {
          logger.info(`📈 상승장 실시간 편입 후보: ${newStocks.map((s) => s.stock_code).join(', ')}`, { component: 'TRACK_B' });
          const newPrices = await getBatchPrices(newStocks.map((s) => s.stock_code)).catch(() => new Map());
          for (const [code, price] of newPrices) livePrices.set(code, price);
          for (let i = 0; i < newStocks.length; i += CHART_BATCH) {
            const batch = newStocks.slice(i, i + CHART_BATCH);
            const results = await Promise.allSettled(batch.map((s) => getDailyChart(s.stock_code, 65)));
            for (let j = 0; j < batch.length; j++) {
              const r = results[j];
              if (r.status === 'fulfilled' && r.value.length >= 30) chartData.set(batch[j].stock_code, r.value);
            }
          }
          for (const s of newStocks) watchlist.push({ id: '', stock_code: s.stock_code, stock_name: s.stock_name, market: 'KOSPI' as const, is_active: true, added_at: '', notes: null, source: 'AUTO' });
          logger.info(`✅ 상승장 동적 편입: ${newStocks.length}개 → 총 후보 ${watchlist.length}개`, { component: 'TRACK_B' });
        }
      } catch (err) {
        logger.warn(`등락률 상위 조회 실패 (스킵): ${err}`, { component: 'TRACK_B' });
      }
    }

    // ── 4. 기술적 지표 매매 판단 ─────────────────────────────────────
    // 수급 보정 반영: composite_score + flowAdj (±20점 범위 제한)
    // confidence < 0.55 신호 제거 + 당일 스코어 아니면 -8점 패널티 (stale 스코어 억제)

    // 시총 기반 소형주 패널티: 잡주 리스크 감소 (완전 차단 아닌 점수 감산 → 고확신 소형주는 여전히 진입 가능)
    // 200억 미만: -20점(사실상 차단), 200~500억: -10점, 500억+: 무패널티
    const marketCapAdjMap = new Map<string, number>();
    for (const [code, price] of livePrices) {
      const cap = price.marketCapEok;
      if (cap > 0 && cap < 200) marketCapAdjMap.set(code, -20);
      else if (cap > 0 && cap < 500) marketCapAdjMap.set(code, -10);
    }
    const microCapCodes = [...marketCapAdjMap.entries()].filter(([, v]) => v <= -20).map(([k]) => k);
    const smallCapCodes = [...marketCapAdjMap.entries()].filter(([, v]) => v === -10).map(([k]) => k);
    if (microCapCodes.length > 0) logger.info(`🏚️ 마이크로캡 패널티(-20): ${microCapCodes.join(', ')} (시총 200억 미만)`, { component: 'TRACK_B' });
    if (smallCapCodes.length > 0) logger.info(`🏠 소형주 패널티(-10): ${smallCapCodes.join(', ')} (시총 200~500억)`, { component: 'TRACK_B' });

    // ── 신규매수 차단 플래그 (한 곳에서 정의) ──────────────────────────
    const isPastClose = kstH > 15 || (kstH === 15 && kstM >= 10);
    const portfolioStress = calcPortfolioStressLevel(openChains, livePrices, totalAssets);
    if (portfolioStress >= 1) {
      logger.warn(`⚠️ 포트폴리오 스트레스 레벨 ${portfolioStress} (미실현 손실 누적)`, { component: 'TRACK_B' });
    }
    const blockNewBuys =
      isPastClose ||
      dailyLoss.blocked ||
      kospiRegime.flashCrash ||
      (!isScalpingMode && kospiRegime.penalty >= 2) ||
      (!isScalpingMode && macroRiskOff) ||
      portfolioStress >= 2;  // 미실현 손실 -3.5% 이상 → 신규매수 전면차단

    if (blockNewBuys) {
      const blockReason =
        isPastClose ? '마감시간(15:10+)' :
        dailyLoss.blocked ? `일일손실초과(${dailyLoss.dailyPnlPct.toFixed(1)}%)` :
        kospiRegime.flashCrash ? 'KOSPI급락서킷브레이커' :
        kospiRegime.penalty >= 2 ? `KOSPI하락장(penalty=2,KOSPI<MA60)` :
        portfolioStress >= 2 ? `포트폴리오위험(미실현손실-3.5%↑)` :
        `매크로RISK_OFF(VKOSPI=${macroSnapshot?.vkospi?.toFixed(1) ?? '?'})`;
      logger.warn(`🚫 신규매수 차단: ${blockReason}`, { component: 'TRACK_B' });
    }

    const todayDate = new Date().toISOString().split('T')[0]; // "2026-05-07"
    // KOSPI 레짐에 따른 전종목 점수 감산: 조정장(penalty=1) -10, 하락장(penalty=2) -15, 당일하락(todayDown) -5
    // 이유: AI 점수는 개별 팩터만 반영하며 시장 방향성 무관. 하락장 낙칼 방지를 위해 threshold 상향 대신 점수 직접 감산.
    const kospiPenaltyAdj = kospiRegime.penalty >= 2 ? -15 : kospiRegime.penalty >= 1 ? -10 : kospiRegime.todayDown ? -5 : 0;
    if (kospiPenaltyAdj !== 0) {
      logger.info(`📉 KOSPI 레짐 점수 보정: penalty=${kospiRegime.penalty} todayDown=${kospiRegime.todayDown} → 전종목 ${kospiPenaltyAdj}점 감산`, { component: 'TRACK_B' });
    }
    const adjustedScores = scores
      .filter((s: any) => (s.confidence ?? 0) >= 0.55)
      .map((s: any) => {
        const base = s.composite_score ?? 0;
        const adj = flowAdjMap.get(s.stock_code) ?? 0;
        const capAdj = marketCapAdjMap.get(s.stock_code) ?? 0;
        // score_date가 DB timestamp("2026-05-07T00:00:00Z") 또는 Date.toString() 형식일 수 있으므로 ISO날짜로 정규화
        const scoreDay = s.score_date
          ? (typeof s.score_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.score_date)
              ? s.score_date
              : new Date(s.score_date).toISOString().split('T')[0])
          : null;
        const stale = scoreDay && scoreDay !== todayDate ? -8 : 0;
        if (stale < 0) logger.info(`⏳ 스코어 stale 패널티: ${s.stock_code} (${scoreDay} ≠ ${todayDate} → -8점)`, { component: 'TRACK_B' });
        const macroAdj = macroSnapshot ? getMacroScoreAdjustment(macroSnapshot) : 0;
        const dartAdj = process.env.DART_API_KEY ? getDisclosureScoreAdjustment(s.stock_code) : 0;
        const totalAdj = adj + capAdj + stale + kospiPenaltyAdj + macroAdj + dartAdj;
        const boundedAdj = totalAdj < 0 ? Math.max(totalAdj, -20) : totalAdj;
        const rawScore = Math.min(100, Math.max(0, base + boundedAdj));
        // 80점 초과 구간 압축 → 분포 개선 (80~100 → 80~92)
        const compressed = rawScore <= 80 ? rawScore : 80 + (rawScore - 80) * 0.6;
        return { stock_code: s.stock_code, score: Math.round(compressed) };
      });

    // 적응형 파라미터: DB 명시 설정 > 시장 최적화 자동값 > STRATEGY_PARAMS 기본값
    // DB 설정이 있어도 constants의 값보다 낮아질 수 없음 (floors)
    const adaptP = kospiRegime.adaptive[effectiveMode];
    const baseP = STRATEGY_PARAMS[effectiveMode] as { buyThreshold: number; takeProfitPct: number; stopLossPct: number };
    const adaptThreshold = adaptP?.buyThreshold ?? baseP.buyThreshold;
    const adaptTp = adaptP?.takeProfitPct ?? baseP.takeProfitPct;
    const adaptSl = adaptP?.stopLossPct ?? baseP.stopLossPct;
    // buyThreshold: DB는 상향만 가능 (더 엄격하게만)
    const resolvedThreshold = strategy?.buy_threshold != null
      ? Math.max(strategy.buy_threshold, adaptThreshold)
      : adaptThreshold;
    // takeProfitPct: DB는 상향만 가능 (더 큰 수익 목표만)
    const resolvedTp = strategy?.take_profit_pct != null
      ? Math.max(strategy.take_profit_pct, adaptTp)
      : adaptTp;
    // stopLossPct: DB는 하향만 가능 (더 넓은 손절 허용만) — 타이트하게 조이는 건 금지
    const resolvedSl = strategy?.stop_loss_pct != null
      ? Math.min(strategy.stop_loss_pct, adaptSl)
      : adaptSl;

    // 성과 배율: 최근 5거래일 승률/수익 기반 (0.7x ~ 1.2x)
    const perfMult = await getPerformanceMultiplier();
    // 복리 포지션 사이징: 총자산 20% 기반 (고정 캡 → 동적 스케일링)
    const assetBasedMax = Math.round(totalAssets * 0.20);
    const baseMaxPos = dailyLoss.earlyWarning
      ? Math.round(assetBasedMax * 0.5)
      : assetBasedMax;
    // 스트레스 레벨 1 → 포지션 추가 10% 축소
    const stressMult = portfolioStress >= 1 ? 0.9 : 1.0;
    const adjMaxPositionKrw = Math.round(baseMaxPos * perfMult * stressMult);
    if (perfMult !== 1.0 || stressMult !== 1.0) {
      logger.info(`📐 maxPositionKrw 조정: ${baseMaxPos.toLocaleString()} × 성과${perfMult}x × 스트레스${stressMult}x = ${adjMaxPositionKrw.toLocaleString()}원`, { component: 'TRACK_B' });
    }

    // ── 호가 불균형 보정 (매수 후보 상위 5종목 — 매수 확신도 검증) ───────────────
    // bid/ask 비율 ≥ 1.5 → 매수세 강함 +6, ≥ 1.2 → +3
    // bid/ask 비율 ≤ 0.7 → 매도세 강함 -6, ≤ 0.85 → -3
    const orderbookAdjMap = new Map<string, number>();
    if (!blockNewBuys) {
      try {
        const topCandidates = adjustedScores
          .filter(s => s.score >= resolvedThreshold - 10)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
        const obResults = await Promise.allSettled(
          topCandidates.map(s =>
            Promise.race([
              getOrderbook(s.stock_code).then(ob => {
                if (!ob || ob.length === 0) return { code: s.stock_code, adj: 0 };
                const totalBid = ob.reduce((sum, e) => sum + e.bidVolume, 0);
                const totalAsk = ob.reduce((sum, e) => sum + e.askVolume, 0);
                if (totalAsk === 0) return { code: s.stock_code, adj: 0 };
                const ratio = totalBid / totalAsk;
                const adj = ratio >= 1.5 ? 6 : ratio >= 1.2 ? 3 : ratio <= 0.7 ? -6 : ratio <= 0.85 ? -3 : 0;
                return { code: s.stock_code, adj };
              }),
              new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 2000)),
            ])
          )
        );
        for (const r of obResults) {
          if (r.status === 'fulfilled') orderbookAdjMap.set(r.value.code, r.value.adj);
        }
        const nonZero = [...orderbookAdjMap.entries()].filter(([, v]) => v !== 0);
        if (nonZero.length > 0) {
          logger.info(`📋 호가 불균형 보정: ${nonZero.map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`).join(', ')}`, { component: 'TRACK_B' });
        }
      } catch { /* 호가 실패해도 파이프라인 계속 */ }
    }

    const finalScores = orderbookAdjMap.size > 0
      ? adjustedScores.map(s => {
          const obAdj = orderbookAdjMap.get(s.stock_code) ?? 0;
          return obAdj !== 0 ? { ...s, score: Math.min(100, Math.max(0, s.score + obAdj)) } : s;
        })
      : adjustedScores;

    const decisions = await technicalFallbackDecisions({
      mode: effectiveMode,
      watchlist: watchlist
        .filter((w) => w.stock_code !== PARK_STOCK_CODE)
        .map((w) => ({ stock_code: w.stock_code, stock_name: w.stock_name })),
      livePrices,
      chartData,
      openChains,
      orderableCash,
      maxPositionKrw: adjMaxPositionKrw,
      totalAssets,
      lossBlockedCodes: new Set([...recentLossCodes, ...todayRepeatStopCodes]),
      manuallySoldCodes,
      aiScores: finalScores, // AI 꽁돈 진입(>=92점)만 활성화, 손실청산 보조
      takeProfitPct: resolvedTp,
      stopLossPct: resolvedSl,
      buyThreshold: resolvedThreshold,
      winRates,
      // penalty=1(조정장) 단독으로는 차단 안함 → adaptive threshold +2 로 대응
      // penalty=2(하락장, KOSPI<MA60)만 차단. SCALPING 모드면 macro/regime 면제
      blockNewBuys,
      kospiBoost: kospiRegime.boost,
      allocationTarget: allocCfg ? {
        stock_pct: Number(allocCfg.stock_pct),
        rebalance_threshold_pct: Number(allocCfg.rebalance_threshold_pct),
        is_active: Boolean(allocCfg.is_active),
      } : null,
      currentStockValue,
      junkStockCodes,
    });

    // ── AI 손실 조기청산: 손실 중 + AI 부정평가(< 45점) → FORCE_CLOSE 주입 ──
    // Gemini 무료 품질이 낮아 진입엔 안 쓰지만, 이미 보유 중 악화 종목 탈출엔 활용
    const aiScoreMapForExit = new Map(finalScores.map((s) => [s.stock_code, s.score]));
    for (const chain of openChains) {
      const liveP = livePrices.get(chain.stock_code);
      if (!liveP || !chain.avg_buy_price) continue;
      const pnlPct = ((liveP.currentPrice - Number(chain.avg_buy_price)) / Number(chain.avg_buy_price)) * 100;
      const aiScore = aiScoreMapForExit.get(chain.stock_code) ?? null;
      if (pnlPct < -1.0 && aiScore !== null && aiScore < 45) {
        const alreadyExiting = decisions.some(
          (d) => d.stock_code === chain.stock_code && ['SELL', 'FORCE_CLOSE', 'PARTIAL_SELL'].includes(d.action),
        );
        if (!alreadyExiting) {
          logger.info(
            `🤖 AI 손실청산: ${chain.stock_code} 손실=${pnlPct.toFixed(1)}% AI=${aiScore}점(<45) → FORCE_CLOSE`,
            { component: 'TRACK_B' },
          );
          decisions.push({
            action: 'FORCE_CLOSE',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `AI 부정평가(${aiScore}점<45) + 손실(${pnlPct.toFixed(1)}%) → AI 손절 가속`,
            confidence: 0.85,
          });
        }
      }
    }

    // ── 뉴스 악재 감시: 보유 종목 악재 뉴스 → FORCE_CLOSE ──
    for (const chain of openChains) {
      const alreadyExiting = decisions.some(
        (d) => d.stock_code === chain.stock_code && ['SELL', 'FORCE_CLOSE', 'PARTIAL_SELL'].includes(d.action),
      );
      if (alreadyExiting) continue;
      const liveP = livePrices.get(chain.stock_code);
      if (!liveP || !chain.avg_buy_price) continue;
      const pnlPct = ((liveP.currentPrice - Number(chain.avg_buy_price)) / Number(chain.avg_buy_price)) * 100;
      if (pnlPct <= -5.0) continue; // 이미 깊은 손실 — 기존 SL이 처리
      try {
        const news = await checkNewsForStock(chain.stock_code);
        if (news.hasBadNews) {
          logger.warn(
            `📰 뉴스악재청산: ${chain.stock_code} pnl=${pnlPct.toFixed(1)}% → "${news.headline.slice(0, 60)}" → FORCE_CLOSE`,
            { component: 'TRACK_B' },
          );
          decisions.push({
            action: 'FORCE_CLOSE',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `뉴스악재: "${news.headline.slice(0, 50)}"`,
            confidence: 0.95,
          });
        }
      } catch { /* 뉴스 실패 시 무시 */ }
    }

    setActiveEngine('technical');
    logger.info(
      `📊 기술적 지표 매매 실행 [${hasScores ? 'technical+AI힌트' : 'technical'}] (AI점수=${scores.length}개, 결정=${decisions.length}개)`,
      { component: 'TRACK_B' },
    );

    // ── 5~10. 우선순위 결정 체인 (decision-flow.ts — 순서 절대 고정) ──
    const actionable = await applyDecisionFlow({
      rawDecisions: decisions,
      openChains,
      livePrices,
      mode: effectiveMode,
      manuallySoldCodes,
      scores: scores.map((s: any) => ({ stock_code: s.stock_code, composite_score: s.composite_score ?? undefined })),
      totalAssets,
      kospiRegime: { penalty: kospiRegime.penalty, boost: kospiRegime.boost, todayDown: kospiRegime.todayDown },
      resolvedSl,
      resolvedTp,
      orderableCash,
      hasBuyCandidates,
      blockNewBuys,
      adjMaxPositionKrw,
      kstH,
      kstM,
      dailyLossEarlyWarning: dailyLoss.earlyWarning,
    });

    if (hasBuyCandidates && !actionable.some((d) => ['BUY', 'AVERAGE_DOWN'].includes(d.action))) {
      logger.info('⏭️ 매수 후보 있으나 BUY 결정 없음 → KIS 관심종목 재동기화', { component: 'TRACK_B' });
      import('../../kis/interest-group.js').then(m => m.syncInterestGroups()).catch(() => {});
    }

    // 유휴 현금 모니터링 로그
    const idleCashPct = totalAssets > 0 ? (orderableCash / totalAssets * 100).toFixed(1) : '0.0';
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await logSystem('INFO', 'TRACK_B', `파이프라인 완료 (${elapsed}초): ${decisions.length}개 판단, ${actionable.length}개 실행 대기`);
    logger.info(`✅ Track B 완료 (${elapsed}초): 총 ${decisions.length}개 판단, ${actionable.length}개 액션 | 유휴현금 ${idleCashPct}% (${orderableCash.toLocaleString()}원)`, { component: 'TRACK_B' });

    return actionable;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await logSystem('ERROR', 'TRACK_B', `파이프라인 실패: ${msg}`);
    logger.error(`❌ Track B 실패: ${msg}`, { component: 'TRACK_B' });
    return [];
  }
}
