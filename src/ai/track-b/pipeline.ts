import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import { config } from '../../config/index.js';
import {
  enableMemoryMode,
  getActiveStrategy,
  getActiveWatchlist,
  getLatestScores,
  getOpenChains,
  getRecentLossStocks,
  getRecentManuallySoldStocks,
  getTodayRepeatStopCodes,
  logSystem,
} from '../../db/client.js';
import type { TradeDecision } from '../../db/models.js';
import { getAccountBalance } from '../../kis/account.js';
import { getBatchPrices, getDailyChart, isMarketOpen, getChangeRankingStocks } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { buildDefenseParkExitDecisions, getDefenseParkState, PARK_STOCK_CODE } from './defense-park.js';
import { IDLE_PARK_STOCK_CODE } from './cash-manager.js';
import { setActiveEngine } from '../../cache/ai-status.js';
import { technicalFallbackDecisions } from './technical-fallback.js';
import { fetchKospiRegime, checkDailyLoss } from './market-regime.js';
import { getMacroSnapshot } from '../../automation/macro-data.js';
import { getInvestorFlow } from '../../automation/investor-flow.js';
import { filterEarlySells, applyHardRules, filterManualCooldown, deduplicateSells, filterSectorConcentration } from './risk-guard.js';
import { adjustPositionSizes } from './position-sizer.js';

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
        const msg = String(dbErr?.message ?? dbErr);
        if (msg.includes('timeout') || msg.includes('terminated') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
          logger.warn(`⚡ DB 연결 실패 → 인메모리 모드로 전환: ${msg}`, { component: 'TRACK_B' });
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
    // 당일 2회 이상 손절 종목 → 당일 재진입 완전 차단
    const todayRepeatStopCodes = await getTodayRepeatStopCodes(2);
    if (todayRepeatStopCodes.size > 0) {
      logger.warn(`🚫 당일 반복손절 재진입 차단: ${[...todayRepeatStopCodes].join(', ')}`, { component: 'TRACK_B' });
    }
    const balanceRaw = await getAccountBalance();
    const balance = balanceRaw as any;

    if (watchlist.length === 0) {
      logger.warn('감시 목록이 비어있습니다', { component: 'TRACK_B' });
      return [];
    }

    // ── 개장 초단타 모드: 09:00~09:10 자동 강제 적용 ─────────────────
    const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const kstH = nowKst.getUTCHours();
    const kstM = nowKst.getUTCMinutes();
    const isOpeningBell = kstH === 9 && kstM < 10;
    const dbMode = (strategy?.mode ?? 'SWING') as StrategyMode;
    // SNIPER/DEFENSE는 개장벨에도 모드 유지 (SNIPER는 CEO가 명시적으로 설정한 집중 전략)
    const mode: StrategyMode = (isOpeningBell && dbMode !== 'DEFENSE' && dbMode !== 'SNIPER') ? 'SCALPING' : dbMode;
    if (isOpeningBell && mode === 'SCALPING') {
      logger.info('🔔 개장 초단타 모드 자동 활성화 (09:00~09:10) — SCALPING +1.2% 즉시 익절', { component: 'TRACK_B' });
    }
    // SCALPING 09:25 데드라인: 이후 신규 매수는 SWING 기준으로 전환 (기존 체인은 강제청산 유지)
    const isPastScalpDeadline = dbMode === 'SCALPING' && (kstH > 9 || (kstH === 9 && kstM >= 25));
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

    // ── 실시간 시세 수집 ──────────────────────────────────────────────
    const chainStockCodes = openChains.map((c) => c.stock_code);
    const allStockCodes = [...new Set([...stockCodes, ...chainStockCodes, PARK_STOCK_CODE, IDLE_PARK_STOCK_CODE])];
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

    // ── 차트 데이터 수집 ──────────────────────────────────────────────
    const chartData = new Map<string, import('../../kis/market.js').DailyCandle[]>();
    const allCodesForChart = [...new Set([...stockCodes, ...openChains.map((c) => c.stock_code)])];
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
    const macroRiskOff = macroSnapshot?.regime === 'RISK_OFF';
    if (macroRiskOff) {
      logger.info(`🌐 매크로 RISK_OFF (Fear&Greed=${macroSnapshot?.fearGreedIndex ?? '?'}, VKOSPI=${macroSnapshot?.vkospi ?? '?'}) → 신규 매수 추가 제한`, { component: 'TRACK_B' });
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
    const effectiveMode: StrategyMode = isPastScalpDeadline
      ? 'SWING'
      : (scores.length === 0 && mode === 'DEFENSE') ? 'SWING' : mode;
    if (isPastScalpDeadline) {
      logger.info('⏰ SCALPING 09:25 이후 → 신규 매수 SWING 기준 전환 (기존 SCALPING 포지션은 강제청산)', { component: 'TRACK_B' });
    } else if (scores.length === 0 && mode === 'DEFENSE') {
      logger.info('⚡ AI 스코어 없음 + DEFENSE 모드 → SWING으로 완화', { component: 'TRACK_B' });
    }

    let hasBuyCandidates = scores.some(
      (s) => (s.composite_score ?? 0) >= STRATEGY_PARAMS[effectiveMode].buyThreshold && (s.confidence ?? 0) >= 0.35,
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
              (s) => (s.composite_score ?? 0) >= STRATEGY_PARAMS[effectiveMode].buyThreshold && (s.confidence ?? 0) >= 0.35,
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
      const FLOW_SCORE_ADJ: Record<string, number> = { STRONG_BUY: 15, BUY: 8, NEUTRAL: 0, SELL: -10, STRONG_SELL: -20 };
      const flowBatch = stockCodes.slice(0, 10); // 최대 10종목만 (rate limit)
      const flowResults = await Promise.allSettled(
        flowBatch.map((code) =>
          Promise.race([
            getInvestorFlow(code, 5).then((f) => ({ code, adj: FLOW_SCORE_ADJ[f.trend] ?? 0 })),
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
          const CHART_BATCH2 = 5;
          for (let i = 0; i < newStocks.length; i += CHART_BATCH2) {
            const batch = newStocks.slice(i, i + CHART_BATCH2);
            const results = await Promise.allSettled(batch.map((s) => getDailyChart(s.stock_code, 65)));
            for (let j = 0; j < batch.length; j++) {
              const r = results[j];
              if (r.status === 'fulfilled' && r.value.length >= 30) chartData.set(batch[j].stock_code, r.value);
            }
          }
          for (const s of newStocks) watchlist.push({ id: '', stock_code: s.stock_code, stock_name: s.stock_name, market: 'KOSPI' as const, is_active: true, added_at: '', notes: null });
          logger.info(`✅ 상승장 동적 편입: ${newStocks.length}개 → 총 후보 ${watchlist.length}개`, { component: 'TRACK_B' });
        }
      } catch (err) {
        logger.warn(`등락률 상위 조회 실패 (스킵): ${err}`, { component: 'TRACK_B' });
      }
    }

    // ── 4. 기술적 지표 매매 판단 ─────────────────────────────────────
    // 수급 보정 반영: composite_score + flowAdj (±20점 범위 제한)
    const adjustedScores = scores
      .filter((s: any) => (s.confidence ?? 0) >= 0.3)
      .map((s: any) => {
        const base = s.composite_score ?? 0;
        const adj = flowAdjMap.get(s.stock_code) ?? 0;
        return { stock_code: s.stock_code, score: Math.min(100, Math.max(0, base + adj)) };
      });

    let decisions = await technicalFallbackDecisions({
      mode: effectiveMode,
      watchlist: watchlist
        .filter((w) => w.stock_code !== PARK_STOCK_CODE)
        .map((w) => ({ stock_code: w.stock_code, stock_name: w.stock_name })),
      livePrices,
      chartData,
      openChains,
      orderableCash,
      maxPositionKrw: config.risk.maxPositionKrw,
      totalAssets,
      lossBlockedCodes: new Set([...recentLossCodes, ...todayRepeatStopCodes]),
      manuallySoldCodes,
      aiScores: adjustedScores,
      takeProfitPct: strategy?.take_profit_pct ?? undefined,
      stopLossPct: strategy?.stop_loss_pct ?? undefined,
      buyThreshold: strategy?.buy_threshold ?? undefined,
      winRates,
      // effectiveMode=SCALPING일 때만 KOSPI MA60 하락장 블록·macroRiskOff 면제 (09:25 이후엔 SWING 기준 적용)
      blockNewBuys:
        kstH > 15 ||
        (kstH === 15 && kstM >= 10) ||
        dailyLoss.blocked ||
        (effectiveMode !== 'SCALPING' && kospiRegime.penalty >= 2) ||
        (effectiveMode !== 'SCALPING' && macroRiskOff),
      kospiBoost: kospiRegime.boost,
      allocationTarget: allocCfg ? {
        stock_pct: Number(allocCfg.stock_pct),
        rebalance_threshold_pct: Number(allocCfg.rebalance_threshold_pct),
        is_active: Boolean(allocCfg.is_active),
      } : null,
      currentStockValue,
      junkStockCodes,
    });

    setActiveEngine('technical');
    logger.info(
      `📊 기술적 지표 매매 실행 [${hasScores ? 'technical+AI힌트' : 'technical'}] (AI점수=${scores.length}개, 결정=${decisions.length}개)`,
      { component: 'TRACK_B' },
    );

    // ── 5. 조기 매도 방지 필터 ───────────────────────────────────────
    decisions = filterEarlySells({
      decisions,
      openChains,
      livePrices,
      mode,
      stopLossPct: strategy?.stop_loss_pct ?? null,
      takeProfitPct: strategy?.take_profit_pct ?? null,
    });

    // ── 5b. 섹터 집중 매수 차단 ──────────────────────────────────────
    decisions = filterSectorConcentration(decisions, openChains);

    // ── 6. 유휴 현금 파킹 관리 ───────────────────────────────────────
    {
      const { manageCashParking } = await import('./cash-manager.js');
      const cashDecisions = manageCashParking({
        orderableCash,
        totalAssets,
        hasBuyCandidates,
        openChains,
        livePrices,
        mode,
        blockNewBuys:
          kstH > 15 ||
          (kstH === 15 && kstM >= 10) ||
          dailyLoss.blocked ||
          kospiRegime.penalty >= 2 ||
          macroRiskOff,
      });
      for (const d of cashDecisions) {
        if (d.action === 'SELL') decisions.unshift(d);
        else decisions.push(d);
      }
    }

    // ── 7. 하드룰: 트레일링 스탑 + 고정 손절 강제 ───────────────────
    decisions = await applyHardRules({
      decisions,
      openChains,
      livePrices,
      mode,
      stopLossPct: strategy?.stop_loss_pct ?? null,
    });

    // KIS 관심종목 보완 동기화: 매수 후보 있으나 실제 BUY 결정 없을 때
    if (hasBuyCandidates) {
      const hasActualBuy = decisions.some(
        (d) => ['BUY', 'AVERAGE_DOWN'].includes(d.action),
      );
      if (!hasActualBuy) {
        logger.info('⏭️ 매수 후보 있으나 BUY 결정 없음 → KIS 관심종목 재동기화', { component: 'TRACK_B' });
        import('../../kis/interest-group.js').then(m => m.syncInterestGroups()).catch(() => {});
      }
    }

    // BUY 결정에 현재가 주입 (executor 재조회 실패 방지)
    for (const d of decisions) {
      if ((d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && !d.limit_price) {
        const livePrice = livePrices.get(d.stock_code)?.currentPrice ?? 0;
        if (livePrice > 0) d.limit_price = livePrice;
      }
    }

    // ── 8. CEO 수동 매도 쿨다운 필터 ─────────────────────────────────
    decisions = filterManualCooldown(decisions, manuallySoldCodes);

    // ── 9. 포지션 크기 보정 (KOSPI 레짐 반영) ────────────────────────
    decisions = adjustPositionSizes({
      decisions,
      scores: scores.map((s: any) => ({ stock_code: s.stock_code, composite_score: s.composite_score ?? undefined })),
      mode,
      totalAssets,
      kospiRegimePenalty: kospiRegime.penalty,
      kospiBoost: kospiRegime.boost,
    });

    // ── 10. 중복 매도 신호 제거 ──────────────────────────────────────
    decisions = deduplicateSells(decisions);

    // ── 최종 필터: 가격 없는 BUY 제외 ───────────────────────────────
    const actionable = decisions.filter((d) => {
      if (d.action === 'HOLD') return false;
      if (d.action === 'BUY' || d.action === 'AVERAGE_DOWN') {
        const hasPrice = (d.limit_price ?? 0) > 0;
        if (!hasPrice) logger.warn(`가격 없는 BUY 제외: ${d.stock_code}`, { component: 'TRACK_B' });
        return hasPrice;
      }
      return true;
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await logSystem('INFO', 'TRACK_B', `파이프라인 완료 (${elapsed}초): ${decisions.length}개 판단, ${actionable.length}개 실행 대기`);
    logger.info(`✅ Track B 완료 (${elapsed}초): 총 ${decisions.length}개 판단, ${actionable.length}개 액션`, { component: 'TRACK_B' });

    return actionable;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await logSystem('ERROR', 'TRACK_B', `파이프라인 실패: ${msg}`);
    logger.error(`❌ Track B 실패: ${msg}`, { component: 'TRACK_B' });
    return [];
  }
}
