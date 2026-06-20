import { analyzeTechnicals } from '../../analysis/indicators.js';
import { isKospiOverrideActive } from '../../risk/kospi-override.js';
import {
  assessCrashLevel,
  type CrashSignal,
  generateInverseDecisions,
  generatePanicSellDecisions,
  INVERSE_ETF_CODES,
} from '../../automation/crash-profit.js';
import { getCommunityScoreAdjustment } from '../../automation/community-sentinel.js';
import { getDisclosureScoreAdjustment, monitorDisclosures } from '../../automation/dart-monitor.js';
import { getCachedPiotroskiScore, getCachedFundamentalScore } from '../../automation/dart-research.js';
import { getInvestorFlow } from '../../automation/investor-flow.js';
import { getMacroScoreAdjustment, getMacroSnapshot } from '../../automation/macro-data.js';
import { checkNewsForStock } from '../../automation/news-sentinel.js';
import {
  calcPortfolioStressLevel,
  getCrossModeBoost,
  getPerformanceMultiplier,
  getWinRateFeedback,
} from '../../automation/portfolio-guard.js';
import { setActiveEngine } from '../../cache/ai-status.js';
import { REFRESH, STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import { getCtxIsPaper } from '../../config/context.js';
import { config } from '../../config/index.js';
import {
  getLatestScores,
  getPool,
  logSystem,
} from '../../db/client.js';
import type { TradeDecision } from '../../db/models.js';
import { logScanSession } from '../../db/scan-logger.js';
import {
  getBatchPrices,
  getChangeRankingStocks,
  getDailyChart,
  getKSTNow,
  getOrderbook,
  isMarketOpen,
} from '../../kis/market.js';
import { getBatchStockSignals } from '../../kis/market-signals.js';
import { getConsensusTrend } from '../../market/consensus.js';
import { fetchStockDisclosures } from '../../market/krx-disclosure.js';
import { getMacroSignal } from '../../market/macro-signal.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { checkEntryTiming } from '../../risk/entry-timing-guard.js';
import { reconcilePendingOrders } from '../../trading/fill-reconciler.js';
import { logger } from '../../utils/logger.js';
import { getOverride } from '../ai-overrides.js';
import { IDLE_PARK_STOCK_CODE } from './cash-manager.js';
import { applyDecisionFlow } from './decision-flow.js';
import { buildDefenseParkExitDecisions, getDefenseParkState, PARK_STOCK_CODE, PARK_STOCK_NAME } from './defense-park.js';
import { checkDailyLoss, fetchKospiRegime } from './market-regime.js';
import { generatePartialTpDecisions } from './sell-signals.js';
import { technicalFallbackDecisions } from './technical-fallback.js';
import { MEGA_CAP_PRIORITY_CODES } from './trading-rules.js';

import { loadPipelineData } from './data-loader.js';
// 역호환: executor.ts가 pipeline.ts에서 import
export { recordSellForCooldown } from './sell-cooldown.js';

// DART 캐시 갱신 추적 — paper/live 모드별 분리 (크로스오염 방지)
const _lastDartRefreshAt = new Map<string, number>();
// 고확신 눌림목 텔레그램 알림 쿨다운 (30분/종목) — paper/live 모드별 분리
const _alertedHighConviction = new Map<string, Map<string, number>>();

function getAlertMap(): Map<string, number> {
  const mode = getCtxIsPaper() ? 'paper' : 'live';
  if (!_alertedHighConviction.has(mode)) _alertedHighConviction.set(mode, new Map());
  return _alertedHighConviction.get(mode)!;
}

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
    const {
      watchlist, openChains, strategy, recentLossCodes, manuallySoldCodes,
      todayRepeatStopCodes, bigLossBlocked, recentlySoldCodes, balance,
      lossHistory, ctxIsPaper,
    } = await loadPipelineData();

    if (watchlist.length === 0) {
      logger.warn('감시 목록이 비어있습니다', { component: 'TRACK_B' });
      return [];
    }

    // ── 개장 초단타 모드: 09:00~09:30 자동 강제 적용 ─────────────────
    // Intl API로 서버 타임존 무관하게 정확한 KST 시각 계산
    const _kstParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(new Date());
    const kstH = Number(_kstParts.find((p) => p.type === 'hour')!.value);
    const kstM = Number(_kstParts.find((p) => p.type === 'minute')!.value);
    const _isOpeningBell = kstH === 9 && kstM < 15; // 09:00~09:14 (15분 윈도우 — 09:15+ 진입 시 09:30 TP 도달 불가)
    const dbMode = (strategy?.mode ?? 'SWING') as StrategyMode;
    // ── 장초반 09:00-09:30 신규 매수 차단 (매도는 허용) ──
    // SCALPING 모드 + 연습모드는 예외 (CEO가 명시적으로 스캘핑 지시한 경우)
    const isOpeningVolatility = kstH === 9 && kstM < 20 && !getCtxIsPaper() && dbMode !== 'SCALPING'; // v10.5: 09:40→09:20 (과도한 차단 → Live 매매 기회 확보)
    // SNIPER/DEFENSE는 개장벨에도 모드 유지 (SNIPER는 CEO가 명시적으로 설정한 집중 전략)
    // SCALPING 자동 활성화 비활성화 (2026-06 성과 검토: 승률 25.7%, profit factor 0.98 → 실질 손실)
    const mode: StrategyMode = dbMode;
    // SCALPING 10:00 데드라인: 이후 신규 매수는 SWING 기준으로 전환 (기존 체인은 강제청산 유지)
    const isPastScalpDeadline = dbMode === 'SCALPING' && kstH >= 10;
    const isScalpingMode = dbMode === 'SCALPING';

    // ── 방어 파킹 시스템 ──────────────────────────────────────────────
    // 2026-06 성과 검토: 파킹 즉시 해제 → 하락장 재진입 → 추가 손실 루프
    // v3: 파킹 중에는 isMarketRecovering 판정에 맡기고, pipeline에서 강제 해제하지 않음
    // Paper 모드: 방어 파킹 완전 면제 — 연습매매는 하락장에서도 거래 데이터를 수집해야 함
    const parkState = ctxIsPaper
      ? {
          isActive: false,
          parkStockCode: PARK_STOCK_CODE,
          parkStockName: PARK_STOCK_NAME,
          entryReason: null,
          enteredAt: null,
        }
      : await getDefenseParkState();
    if (parkState.isActive) {
      // 회복 판정만 수행 — 즉시 해제 금지
      const { isMarketRecovering } = await import('./defense-park.js');
      const { getBatchPrices: getParkPrices } = await import('../../kis/market.js');
      const parkPrices = await getParkPrices([PARK_STOCK_CODE, ...Array.from(INVERSE_ETF_CODES)]);
      const recovery = await isMarketRecovering(openChains, parkPrices);
      if (recovery.recovering) {
        logger.info(`✅ 방어 파킹 회복 감지 → 해제: ${recovery.reason}`, { component: 'TRACK_B' });
        return buildDefenseParkExitDecisions(openChains, recovery.reason);
      }
      logger.info(`🛡️ 방어 파킹 유지 중 — 회복 미감지`, { component: 'TRACK_B' });
      return []; // 파킹 유지, 신규 매수 차단
    }
    const orphanedKodex = openChains.find((c) => c.stock_code === PARK_STOCK_CODE);
    if (orphanedKodex) {
      logger.warn(`🧹 잔여 파킹 ETF 즉시 청산`, { component: 'TRACK_B' });
      return buildDefenseParkExitDecisions([orphanedKodex], '파킹 ETF 잔여 포지션 청산');
    }
    // 인버스 ETF 잔여 — 아래 generateInverseDecisions(NONE 레벨)에서 처리
    const orphanedInverses = openChains.filter((c) => INVERSE_ETF_CODES.has(c.stock_code) && c.total_quantity > 0);
    if (orphanedInverses.length > 0 && !parkState.isActive) {
      // crash signal NONE이면 generateInverseDecisions가 전량 청산 결정 생성
    }

    // ── AI 스코어 로드 (워치리스트 + 발굴종목 전체) ──────────────────────
    const stockCodes: string[] = watchlist.map((w) => w.stock_code);
    const { getCachedScores } = await import('../../cache/redis.js');
    let scores = await getCachedScores(stockCodes);
    // 워치리스트만 조회 → 발굴종목 누락 → DB에서 오늘 전체 AI 점수 보충
    if (scores.length < stockCodes.length * 0.5) {
      const { getAllRecentScores } = await import('../../db/client.js');
      const allScores = await getAllRecentScores();
      // 기존 Redis 점수 + DB 전체 점수 병합 (Redis 우선)
      const existing = new Set(scores.map((s) => s.stock_code));
      for (const s of allScores) {
        if (!existing.has(s.stock_code)) scores.push(s);
      }
    }
    if (scores.length === 0) scores = await getLatestScores(stockCodes);
    if (scores.length === 0) {
      logger.warn('오늘의 AI 스코어가 없습니다 (Track A 미실행?) → 기술적 지표 fallback 진행', {
        component: 'TRACK_B',
      });
    } else {
      // 스코어 freshness 체크: Track A 실패 감지
      const todayDate = getKSTNow().toISOString().split('T')[0]; // KST 기준 — Track A 저장 형식과 일치
      const staleScores = scores.filter((s: any) => {
        if (!s.score_date) return false;
        // score_date: pg DATE → string (setTypeParser 적용) | Redis → string
        const sd = String(s.score_date).slice(0, 10); // "YYYY-MM-DD"
        return sd !== todayDate;
      });
      if (staleScores.length > 0) {
        const sample = scores
          .slice(0, 2)
          .map((s: any) => `${s.stock_code}:${typeof s.score_date}=${String(s.score_date).slice(0, 20)}`)
          .join(', ');
        logger.warn(`🔍 score_date 디버그: today=${todayDate} samples=[${sample}]`, { component: 'TRACK_B' });
      }
      if (staleScores.length > scores.length * 0.5) {
        logger.error(
          `🔴 AI 스코어 ${staleScores.length}/${scores.length}개가 오늘자가 아님 (Track A 실패?) — 기술지표 가중 진행`,
          { component: 'TRACK_B' },
        );
      }
      logger.info(`🎯 AI 스코어 ${scores.length}개 로드 (워치리스트 ${stockCodes.length}종목)`, {
        component: 'TRACK_B',
      });
    }

    // ── 임시점수 주입: SURGE/KIS_SYNC/ANCHOR 신규 편입 종목 (순환참조 해결) ──────
    // ai_scores FK → watchlist 순환: 신규 편입 종목은 AI 점수가 없어 파이프라인에서 완전 차단됨.
    // SURGE(거래대금 급등) / KIS_SYNC(CEO 즐겨찾기) / ANCHOR(삼성·하이닉스)는
    // 실시간 발굴 근거가 있으므로 provisional score 62 주입 → 분봉·수급 분석으로 본평가 진행.
    if (stockCodes.length > 0) {
      try {
        const todayKst = getKSTNow().toISOString().split('T')[0];
        const existingScoreCodes = new Set(scores.map((s: any) => s.stock_code as string));
        const { rows: newlyTagged } = await getPool().query(
          `SELECT stock_code FROM watchlist
           WHERE is_active = true
             AND source IN ('SURGE', 'KIS_SYNC', 'ANCHOR', 'THEME_CLUSTER')
             AND added_at >= NOW() - INTERVAL '24 hours'
             AND stock_code NOT IN (
               SELECT DISTINCT stock_code FROM ai_scores
                WHERE score_date >= CURRENT_DATE - INTERVAL '3 days'
             )
             AND stock_code = ANY($1)`,
          [stockCodes],
        );
        for (const row of newlyTagged) {
          if (!existingScoreCodes.has(row.stock_code)) {
            scores.push({ stock_code: row.stock_code, composite_score: 62, confidence: 0, score_date: todayKst } as any);
            logger.info(`🔀 임시점수(62) 주입: ${row.stock_code} — SURGE/KIS 신규편입 (순환참조 우회)`, {
              component: 'TRACK_B',
            });
          }
        }
      } catch {
        /* 주입 실패 시 기존 동작 유지 */
      }
    }

    // ── 실시간 시세 수집 (KIS rate limit 방지: AI 점수 상위 20종목 + 보유종목) ──
    // AI 점수 없는 종목 포함 시 buy-filter에서 전량 차단 → KIS 쿼터 낭비
    // AI 점수 있는 종목만 추려서 composite_score 상위 20개 평가 (35→20 부하 43% 감소)
    const chainStockCodes = openChains.map((c) => c.stock_code);
    const scoreMapPre = new Map(scores.map((s: any) => [s.stock_code, Number(s.composite_score ?? 0)]));
    const aiScoredCodes = new Set(scores.map((s: any) => s.stock_code as string));
    const sortedWatchlistCodes = [...stockCodes]
      .filter((code) => aiScoredCodes.has(code))
      .sort((a, b) => (scoreMapPre.get(b) ?? 0) - (scoreMapPre.get(a) ?? 0))
      .slice(0, 20);
    const allStockCodes = [
      ...new Set([
        ...sortedWatchlistCodes,
        ...chainStockCodes,
        PARK_STOCK_CODE,
        IDLE_PARK_STOCK_CODE,
        ...Array.from(INVERSE_ETF_CODES),
      ]),
    ];
    logger.info(
      `📡 시세 조회: ${allStockCodes.length}종목 (AI점수 상위 ${sortedWatchlistCodes.length}/${aiScoredCodes.size}개 + 보유 ${chainStockCodes.length})`,
      { component: 'TRACK_B' },
    );
    const livePrices = await getBatchPrices(allStockCodes);

    // ── Shadow Tracker: KR AI 점수 상위 3종목 가상진입 (OOS 검증) ──
    try {
      const { recordShadowEntries, updateShadowPositions } = await import('../../shadow/shadow-tracker.js');
      const shadowPicks = sortedWatchlistCodes
        .slice(0, 3)
        .map((code) => ({
          stockCode: code,
          score: scoreMapPre.get(code) ?? 0,
          entryPrice: livePrices.get(code)?.currentPrice ?? 0,
        }))
        .filter((p) => p.entryPrice > 0);
      await recordShadowEntries('KR', shadowPicks);
      const krPriceMap = new Map([...livePrices].map(([k, v]) => [k, v.currentPrice]));
      await updateShadowPositions('KR', krPriceMap);
    } catch {
      /* shadow is non-critical */
    }

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
    } catch {
      /* cache optional */
    }

    // ── 차트 데이터 수집 (동일 상위 35 + 보유종목 기준) ─────────────────
    const chartData = new Map<string, import('../../kis/market.js').DailyCandle[]>();
    const allCodesForChart = [...new Set([...sortedWatchlistCodes, ...openChains.map((c) => c.stock_code)])];
    const CHART_BATCH = 12; // v10.7: 5→12 (차트수집 10초→3초, rate limiter 15/sec에 맞춤)
    for (let i = 0; i < allCodesForChart.length; i += CHART_BATCH) {
      const batch = allCodesForChart.slice(i, i + CHART_BATCH);
      // BREAKOUT 모드: 252일 (200일 SMA + 52주 고저)
      // v9-fix: 40→65 역일 (≈45 거래일, MACD 34+ 충족 보장)
      const chartDays = mode === 'BREAKOUT' ? 252 : 65;
      const results = await Promise.allSettled(batch.map((code) => getDailyChart(code, chartDays)));
      for (let j = 0; j < batch.length; j++) {
        const r = results[j];
        // v9-fix: MACD slow EMA(26) + signal(9) = 35 최소 필요. 20→40 상향
        if (r.status === 'fulfilled' && r.value.length >= 40) {
          chartData.set(batch[j], r.value);
        } else if (r.status === 'rejected') {
          logger.warn(`차트 조회 실패: ${batch[j]} - ${r.reason}`, { component: 'TRACK_B' });
        }
      }
    }

    // ── 3. KOSPI 레짐 + 일일 손실 (병렬) ────────────────────────────
    const orderableCash = _rawOrderableCash;
    // 총자산: netAsset(순자산) = 전체 현금 + 국내주식평가 (KIS T+2 정산 기준, 가장 정확)
    // 통합증거금 계좌에서 해외 투자 시 KRW 풀 감소 → orderableCash+evalAmount 과소평가
    // netAsset 사용으로 올바른 포지션 사이징 보장 (해외 투자금 차감 반영된 실제 국내 가용자산)
    let totalAssets =
      balance.netAsset > 0
        ? balance.netAsset
        : balance.totalDeposit > 0
          ? balance.totalDeposit + balance.totalEvalAmount
          : balance.totalEvalAmount + orderableCash;

    // 해외 포지션 시가총액 (집중도 체크용 — 국내만 사용 시 불필요한 부분매도 발생 방지)
    const overseasValueKrwPromise = getPool()
      .query(
        'SELECT SUM(last_price * quantity) AS total_usd FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1',
        [ctxIsPaper],
      )
      .then(async ({ rows }) => {
        const usd = Number(rows[0]?.total_usd ?? 0);
        if (usd <= 0) return 0;
        const { getFxRate } = await import('../../api/routes/dashboard/helpers.js');
        const fx = await getFxRate();
        const { FALLBACK_FX_RATE: FB } = await import('../../config/constants.js');
        return usd * (fx > 0 ? fx : FB);
      })
      .catch(() => 0);

    const [kospiRegime, dailyLoss, macroSnapshot, overseasValueKrw, macroSigForCrash] = await Promise.all([
      fetchKospiRegime(),
      checkDailyLoss({ openChains, livePrices, totalAssets }),
      getMacroSnapshot().catch(() => null),
      overseasValueKrwPromise,
      getMacroSignal().catch(() => null),
    ]);
    // Paper 모드: getPaperBalance는 국내 자산만 반환 → 해외 포지션 시가 합산
    if (ctxIsPaper && overseasValueKrw > 0) totalAssets += overseasValueKrw;

    // DART 공시 캐시 갱신 (1시간 간격 — API 키 없으면 no-op, 모드별 독립)
    const dartMode = getCtxIsPaper() ? 'paper' : 'live';
    if (process.env.DART_API_KEY && Date.now() - (_lastDartRefreshAt.get(dartMode) ?? 0) > REFRESH.DART_INTERVAL_MS) {
      _lastDartRefreshAt.set(dartMode, Date.now());
      monitorDisclosures().catch(() => {});
    }
    const macroRiskOff = !ctxIsPaper && macroSnapshot?.regime === 'RISK_OFF';
    if (macroSnapshot?.regime === 'RISK_OFF') {
      logger.info(
        `🌐 매크로 RISK_OFF (Fear&Greed=${macroSnapshot?.fearGreedIndex ?? '?'}, VKOSPI=${macroSnapshot?.vkospi ?? '?'}) → ${ctxIsPaper ? '모의투자 — 차단 스킵' : '신규 매수 추가 제한'}`,
        { component: 'TRACK_B' },
      );
    }

    // ── 하락장 수익화 — Crash Signal 평가 ──────────────────────────────
    const crashSignal: CrashSignal = assessCrashLevel({
      kospiPenalty: kospiRegime.penalty,
      todayDown: kospiRegime.todayDown,
      flashCrash: kospiRegime.flashCrash,
      dailyPnlPct: dailyLoss.dailyPnlPct,
      vkospi: macroSnapshot?.vkospi ?? undefined,
      kospiChangePct: macroSnapshot?.kospiChange ?? undefined,
      fearGreedIndex: macroSnapshot?.fearGreedIndex ?? undefined,
      nasdaqChange1d: macroSigForCrash?.nasdaqChange1d ?? undefined,
    });
    if (crashSignal.level !== 'NONE') {
      logger.warn(
        `🔻 하락장 신호: ${crashSignal.level} (score=${crashSignal.score}) — ${crashSignal.reasons.join(', ')}`,
        { component: 'CRASH_PROFIT' },
      );
    }

    // 현재 주식 포지션 가치
    const currentStockValue = openChains
      .filter((c) => c.stock_code !== PARK_STOCK_CODE)
      .reduce((sum, c) => {
        const price = livePrices.get(c.stock_code)?.currentPrice ?? Number(c.avg_buy_price ?? 0);
        return sum + price * Number(c.total_quantity ?? 0);
      }, 0);

    // ── 매수 후보 스크리닝 + KIS 관심종목 동기화 ──────────────────────
    const hasScores = scores.length > 0;

    // 자동 DEFENSE 트리거: 급락 서킷브레이커 OR (하락장+당일하락+손실-1.5%+)
    const autoShouldDefense =
      dbMode === 'SWING' &&
      (kospiRegime.flashCrash || (kospiRegime.penalty >= 2 && kospiRegime.todayDown && dailyLoss.dailyPnlPct <= -1.5));
    // 자동 SWING 복귀: DB=DEFENSE이지만 시장 정상화 (MA60 위 + 당일 하락 없음 + 손실 0.5% 미만)
    const autoShouldRevertSwing =
      dbMode === 'DEFENSE' && kospiRegime.penalty === 0 && !kospiRegime.todayDown && dailyLoss.dailyPnlPct > -0.5;
    // 자동 SNIPER 전환: 90점+ 고확신 종목이 1개+ → 집중 포착 모드 (v11: 2→1, 실전 SNIPER 활성화 빈도↑)
    const highScoreCount = scores.filter((s) => (s.composite_score ?? 0) >= 90).length;
    const autoShouldSniper =
      dbMode === 'SWING' && highScoreCount >= 1 && !autoShouldDefense && dailyLoss.dailyPnlPct > -1.0;
    // SNIPER→SWING 자동 복귀: DB=SNIPER이지만 90점+ 종목 소멸 시
    const autoShouldRevertFromSniper =
      dbMode === 'SNIPER' && highScoreCount === 0 && !autoShouldDefense;

    const effectiveModeRaw: StrategyMode = isPastScalpDeadline
      ? 'SWING'
      : autoShouldDefense
        ? 'DEFENSE'
        : autoShouldSniper
          ? 'SNIPER'
          : autoShouldRevertFromSniper
            ? 'SWING'
            : autoShouldRevertSwing
              ? 'SWING'
              : scores.length === 0 && mode === 'DEFENSE'
                ? 'SWING'
                : mode;
    // Paper는 Live의 DEFENSE 전파 차단 — 연습은 항상 SWING 이상으로 실행
    const effectiveMode: StrategyMode = ctxIsPaper && effectiveModeRaw === 'DEFENSE' ? 'SWING' : effectiveModeRaw;
    // Paper DB행 자가 복구: Paper 행이 DEFENSE로 오염된 경우 자동으로 SWING 복귀 (멱등 조건)
    if (ctxIsPaper && mode === 'DEFENSE') {
      getPool()
        .query(
          `UPDATE strategy_config SET mode='SWING', updated_at=NOW() WHERE is_active=true AND is_paper=true AND mode='DEFENSE'`,
        )
        .then(({ rowCount }) => {
          if (rowCount && rowCount > 0)
            logger.warn('🩹 Paper DB행 자가복구: DEFENSE→SWING (Live 오염 감지 — 현재 배포로 재발 방지됨)', {
              component: 'TRACK_B',
            });
        })
        .catch(() => {});
    }

    if (isPastScalpDeadline) {
      logger.info('⏰ SCALPING 09:30 이후 → 신규 매수 SWING 기준 전환 (기존 SCALPING 포지션은 강제청산)', {
        component: 'TRACK_B',
      });
      // DB 모드 자동 전환 (SCALPING → SWING) — Live 행만, Paper 행 및 Paper 컨텍스트 모두 차단
      if (!ctxIsPaper)
        getPool()
          .query(
            `UPDATE strategy_config SET mode='SWING', updated_at=NOW() WHERE is_active=true AND mode='SCALPING' AND is_paper=false`,
          )
          .then(({ rowCount }) => {
            if (rowCount && rowCount > 0)
              logger.info('✅ DB 모드 자동전환: SCALPING → SWING (09:30 이후)', { component: 'TRACK_B' });
          })
          .catch((e: Error) => logger.warn(`모드 자동전환 DB 업데이트 실패: ${e.message}`, { component: 'TRACK_B' }));
    } else if (autoShouldDefense) {
      const reason = kospiRegime.flashCrash
        ? '급락 서킷브레이커'
        : `하락장(penalty${kospiRegime.penalty})+당일하락+손실${dailyLoss.dailyPnlPct.toFixed(1)}%`;
      logger.warn(
        `🔴 자동 DEFENSE 모드 전환: ${reason} → 신규 매수 극제한${ctxIsPaper ? ' (Paper: DB쓰기 차단)' : ''}`,
        { component: 'TRACK_B' },
      );
      // DB 모드 전환 (SWING → DEFENSE) — Live 행만, Paper 행 오염 방지 (AND is_paper=false)
      if (!ctxIsPaper)
        getPool()
          .query(
            `UPDATE strategy_config SET mode='DEFENSE', updated_at=NOW() WHERE is_active=true AND mode='SWING' AND is_paper=false`,
          )
          .then(({ rowCount }) => {
            if (rowCount && rowCount > 0)
              logger.warn(`✅ DB 모드 자동전환: SWING → DEFENSE (${reason})`, { component: 'TRACK_B' });
          })
          .catch((e: Error) => logger.warn(`모드 전환 DB 실패: ${e.message}`, { component: 'TRACK_B' }));
    } else if (autoShouldSniper) {
      logger.info(`🎯 자동 SNIPER 모드: 90점+ ${highScoreCount}종목 감지 → 고확신 집중 포착 (TP +8%, SL -3%)`, {
        component: 'TRACK_B',
      });
      // DB 모드 전환 (SWING → SNIPER) — Live 행만
      if (!ctxIsPaper)
        getPool()
          .query(
            `UPDATE strategy_config SET mode='SNIPER', updated_at=NOW() WHERE is_active=true AND mode='SWING' AND is_paper=false`,
          )
          .then(({ rowCount }) => {
            if (rowCount && rowCount > 0)
              logger.info('✅ DB 모드 자동전환: SWING → SNIPER (90점+ 감지)', { component: 'TRACK_B' });
          })
          .catch((e: Error) => logger.warn(`SNIPER 전환 DB 실패: ${e.message}`, { component: 'TRACK_B' }));
    } else if (autoShouldRevertFromSniper) {
      logger.info('🟢 자동 SWING 복귀: 90점+ 종목 소멸 → SNIPER 해제', { component: 'TRACK_B' });
      // DB 모드 복귀 (SNIPER → SWING) — Live 행만
      if (!ctxIsPaper)
        getPool()
          .query(
            `UPDATE strategy_config SET mode='SWING', updated_at=NOW() WHERE is_active=true AND mode='SNIPER' AND is_paper=false`,
          )
          .then(({ rowCount }) => {
            if (rowCount && rowCount > 0)
              logger.info('✅ DB 모드 자동전환: SNIPER → SWING (90점+ 소멸)', { component: 'TRACK_B' });
          })
          .catch((e: Error) => logger.warn(`SNIPER→SWING 복귀 DB 실패: ${e.message}`, { component: 'TRACK_B' }));
    } else if (autoShouldRevertSwing) {
      logger.info(
        `🟢 자동 SWING 복귀: KOSPI 정상(penalty=0) + 당일 무하락 + 손실${dailyLoss.dailyPnlPct.toFixed(1)}% → DEFENSE 해제${ctxIsPaper ? ' (Paper: DB쓰기 차단)' : ''}`,
        { component: 'TRACK_B' },
      );
      // DB 모드 복귀 (DEFENSE → SWING) — Live 행만, Paper 행 오염 방지 (AND is_paper=false)
      if (!ctxIsPaper)
        getPool()
          .query(
            `UPDATE strategy_config SET mode='SWING', updated_at=NOW() WHERE is_active=true AND mode='DEFENSE' AND is_paper=false`,
          )
          .then(({ rowCount }) => {
            if (rowCount && rowCount > 0)
              logger.info('✅ DB 모드 자동전환: DEFENSE → SWING (시장 정상화)', { component: 'TRACK_B' });
          })
          .catch((e: Error) => logger.warn(`모드 자동복귀 DB 업데이트 실패: ${e.message}`, { component: 'TRACK_B' }));
    } else if (scores.length === 0 && mode === 'DEFENSE') {
      logger.info('⚡ AI 스코어 없음 + DEFENSE 모드 → SWING으로 완화', { component: 'TRACK_B' });
    }

    // 메가캡 보너스/레짐 보정을 반영한 유연한 사전 체크
    // 기존: 고정 threshold → 삼성 68점이면 "후보 없음" → 매수 로직 전체 스킵
    // 개선: 메가캡 종목은 threshold-8, 일반도 threshold-5 여유 (buy-filters에서 정밀 판단)
    const preFilterThreshold = STRATEGY_PARAMS[effectiveMode].buyThreshold - 5;
    // BREAKOUT 모드: AI 점수 불필요 — 기술적 돌파 신호 기반이므로 preFilter 무조건 통과
    const confFloor = ctxIsPaper ? 0.3 : (config.liveRisk?.confFloor ?? 0.45); // Paper: 0.3 / Live: 0.6→0.45 (v11)
    let hasBuyCandidates =
      effectiveMode === 'BREAKOUT' ||
      scores.some((s) => {
        const megaCapReduction = MEGA_CAP_PRIORITY_CODES.has(s.stock_code)
          ? MEGA_CAP_PRIORITY_CODES.get(s.stock_code)!.thresholdReduction
          : 0;
        return (s.composite_score ?? 0) >= preFilterThreshold - megaCapReduction && (s.confidence ?? 0) >= confFloor;
      });
    const hasOpenPositions = openChains.some((c) => Number(c.total_quantity) > 0);
    if (!hasBuyCandidates) {
      logger.info(`⏭️ 매수 후보 없음 → KIS 관심종목 재동기화 (보유종목 ${hasOpenPositions ? '있음' : '없음'})`, {
        component: 'TRACK_B',
      });
      try {
        const { syncInterestGroups } = await import('../../kis/interest-group.js');
        const { added } = await syncInterestGroups();
        if (added.length > 0) {
          logger.info(`📌 신규 ${added.length}종목 감시 편입 (${added.join(', ')})`, { component: 'TRACK_B' });
          const newPrices = await getBatchPrices(added).catch(() => new Map());
          for (const [code, price] of newPrices) {
            livePrices.set(code, price);
            stockCodes.push(code);
          }
          for (const code of added) {
            const candles = await getDailyChart(code, 65).catch(() => []);
            if (candles.length >= 30) chartData.set(code, candles);
          }
          const newScores = await getLatestScores(added).catch(() => []);
          if (newScores.length > 0) {
            scores.push(...newScores);
            hasBuyCandidates = scores.some((s) => {
              const mcr = MEGA_CAP_PRIORITY_CODES.has(s.stock_code)
                ? MEGA_CAP_PRIORITY_CODES.get(s.stock_code)!.thresholdReduction
                : 0;
              return (s.composite_score ?? 0) >= preFilterThreshold - mcr && (s.confidence ?? 0) >= confFloor;
            });
          }
        }
      } catch {
        /* 동기화 실패해도 파이프라인 계속 */
      }
    }

    // 승률 데이터 + 황금비율 배분 설정
    const { getStockWinRates } = await import('../../analysis/win-rate.js');
    const winRates = await getStockWinRates(stockCodes).catch(() => new Map());

    // ── 종목별 실거래 승률 → 스코어 보정 (자기학습 연동) ─────────────
    // 승률 65%+(5건+): +5점 보너스, 승률 35%-(5건+): -8점 페널티
    const stockAccAdjMap = new Map<string, number>();
    try {
      const { rows: accRows } = await getPool().query(
        `SELECT stock_code,
                COUNT(*)::int AS total,
                SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END)::int AS wins
           FROM score_accuracy
          WHERE recorded_at >= NOW() - INTERVAL '90 days'
            AND is_paper = $1
            AND stock_code = ANY($2)
          GROUP BY stock_code
          HAVING COUNT(*) >= 5`,
        [ctxIsPaper, stockCodes],
      );
      for (const r of accRows) {
        const wr = r.wins / r.total;
        if (wr >= 0.65) stockAccAdjMap.set(r.stock_code, 5);
        else if (wr <= 0.35) stockAccAdjMap.set(r.stock_code, -8);
      }
      if (stockAccAdjMap.size > 0) {
        logger.info(
          `📊 종목승률 보정: ${[...stockAccAdjMap.entries()].map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`).join(', ')}`,
          { component: 'TRACK_B' },
        );
      }
    } catch { /* score_accuracy 조회 실패 시 무시 */ }

    // ── 외국인/기관 수급 → AI 스코어 보정 ────────────────────────────
    // 상위 5종목만 조회 (10→5, timeout 3s→1.5s로 속도 최적화)
    const flowAdjMap = new Map<string, number>();
    try {
      const FLOW_SCORE_ADJ: Record<string, number> = {
        STRONG_BUY: 10,
        BUY: 6,
        NEUTRAL: 0,
        SELL: -10,
        STRONG_SELL: -20,
      };
      const flowBatch = sortedWatchlistCodes.slice(0, 5);
      const flowResults = await Promise.allSettled(
        flowBatch.map((code) =>
          Promise.race([
            getInvestorFlow(code, 5).then((f) => {
              const trendAdj = FLOW_SCORE_ADJ[f.trend] ?? 0;
              const streakAdj = f.foreignStreak >= 3 ? 5 : f.foreignStreak <= -3 ? -8 : 0;
              return { code, adj: trendAdj + streakAdj };
            }),
            new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 1500)),
          ]),
        ),
      );
      for (const r of flowResults) {
        if (r.status === 'fulfilled') flowAdjMap.set(r.value.code, r.value.adj);
      }
      if (flowAdjMap.size > 0) {
        logger.info(
          `📊 수급 스코어 보정: ${[...flowAdjMap.entries()]
            .filter(([, v]) => v !== 0)
            .map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`)
            .join(', ')}`,
          { component: 'TRACK_B' },
        );
      }
    } catch {
      /* 수급 실패해도 파이프라인 계속 */
    }

    // STRONG_SELL(-20점) = 외국인+기관 동반 이탈 → 잡주 필터 대상
    const junkStockCodes = new Set([...flowAdjMap.entries()].filter(([, adj]) => adj <= -20).map(([code]) => code));
    if (junkStockCodes.size > 0) {
      logger.info(`🗑️ 잡주 필터 대상(STRONG_SELL): ${[...junkStockCodes].join(', ')}`, { component: 'TRACK_B' });
    }

    // ── KIND 공시 악재 즉각 반응 (신규 매수 차단 + 오픈 포지션 텔레그램 경보) ──
    try {
      const stockMeta = watchlist.map((s) => ({ stockCode: s.stock_code, companyName: s.stock_name }));
      const disclosures = await fetchStockDisclosures(stockMeta);
      const bearishCodes = disclosures.filter((d) => d.hasBearish).map((d) => d.stockCode);

      if (bearishCodes.length > 0) {
        // 악재 공시 종목 → 잡주 필터에 추가 (신규 매수 차단)
        for (const code of bearishCodes) junkStockCodes.add(code);
        logger.warn(`⚠️ KIND 악재 공시 종목 매수 차단: ${bearishCodes.join(', ')}`, { component: 'KRX_DISCLOSURE' });

        // 오픈 포지션과 겹치면 텔레그램 경보
        const openCodes = new Set(openChains.map((c) => c.stock_code));
        const alertCodes = bearishCodes.filter((c) => openCodes.has(c));
        if (alertCodes.length > 0) {
          const alertLines = alertCodes
            .map((code) => {
              const d = disclosures.find((x) => x.stockCode === code);
              return `• ${d?.companyName ?? code}(${code}): ${d?.summary ?? '악재 공시 감지'}`;
            })
            .join('\n');
          sendTelegramMessage(
            `🚨 [KIND 공시 경보] 보유 종목 악재 공시 감지!\n${alertLines}\n\n⚠️ 손절선 도달 전 수동 확인 권장`,
          ).catch(() => {});
        }
      }
    } catch (err) {
      logger.debug(`KIND 공시 Track-B 체크 실패 (스킵): ${err}`, { component: 'KRX_DISCLOSURE' });
    }

    const allocCfg = await import('../../db/client.js')
      .then((m) =>
        m
          .getPool()
          .query('SELECT * FROM portfolio_allocation_config WHERE is_active = true AND is_paper = $1 LIMIT 1', [
            getCtxIsPaper(),
          ]),
      )
      .then((r) => r.rows[0] ?? null)
      .catch(() => null);

    // ── 3-d. 실시간 등락률 상위 종목 동적 편입 ────────────────────────────
    // 조건: KOSPI >= MA60 (하락장 아님) + 일일손실 미차단
    // kospiBoost(MA20>MA60 강세) 뿐 아니라 중립장(penalty=0)에서도 작동
    const watchlistSet = new Set(watchlist.map((w) => w.stock_code));
    if ((kospiRegime.penalty === 0 || isScalpingMode) && !dailyLoss.blocked) {
      try {
        const topGainers = await getChangeRankingStocks(10, 'J');
        const newStocks = topGainers.filter((s) => s.stock_code && !watchlistSet.has(s.stock_code));
        if (newStocks.length > 0) {
          logger.info(`📈 상승장 실시간 편입 후보: ${newStocks.map((s) => s.stock_code).join(', ')}`, {
            component: 'TRACK_B',
          });
          const newPrices = await getBatchPrices(newStocks.map((s) => s.stock_code)).catch(() => new Map());
          for (const [code, price] of newPrices) livePrices.set(code, price);
          for (let i = 0; i < newStocks.length; i += CHART_BATCH) {
            const batch = newStocks.slice(i, i + CHART_BATCH);
            const results = await Promise.allSettled(batch.map((s) => getDailyChart(s.stock_code, 40)));
            for (let j = 0; j < batch.length; j++) {
              const r = results[j];
              if (r.status === 'fulfilled' && r.value.length >= 30) chartData.set(batch[j].stock_code, r.value);
            }
          }
          for (const s of newStocks)
            watchlist.push({
              id: '',
              stock_code: s.stock_code,
              stock_name: s.stock_name,
              market: 'KOSPI' as const,
              is_active: true,
              added_at: '',
              notes: null,
              source: 'AUTO',
            });
          logger.info(`✅ 상승장 동적 편입: ${newStocks.length}개 → 총 후보 ${watchlist.length}개`, {
            component: 'TRACK_B',
          });
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
    if (microCapCodes.length > 0)
      logger.info(`🏚️ 마이크로캡 패널티(-20): ${microCapCodes.join(', ')} (시총 200억 미만)`, { component: 'TRACK_B' });
    if (smallCapCodes.length > 0)
      logger.info(`🏠 소형주 패널티(-10): ${smallCapCodes.join(', ')} (시총 200~500억)`, { component: 'TRACK_B' });

    // ── 신규매수 차단 플래그 (한 곳에서 정의) ──────────────────────────
    // 2026-06 성과 검토: 15:10 → 14:50으로 앞당김 (15:10~15:20 진입 → 강제 청산 -76K 손실)
    //
    // CEO 지시 (2026-06-12): "어떻게 운영되든 오늘 실현 +면 됨"
    //   Why: paper에서 마의시간/장마감 직전 진입이 오늘 -193k 실현손실의 핵심 원인
    //   (7건 중 5건이 12:37, 15:01, 15:22, 15:23 진입 — 전부 금지/제한 시간대)
    //   How: paper도 live와 동일한 시간 가드 적용 — 학습 환경에서도 일관된 운영
    // v12: SWING 종가베팅 창구 15:00~15:20 허용 (AI 검증 — 실전 고수 EOD 진입 구간)
    const isSwingEodBetting = effectiveModeRaw === 'SWING' && kstH === 15 && kstM < 20;
    const isPastClose = kstH >= 14 && !isSwingEodBetting; // v11: 14:50→14:00 / v12: SWING 15:00~15:20 예외
    // v11 시간대별 매수 필터 (손익 최우선):
    // 09:00~10:00 → 전략 무제한 (황금 윈도우, 변동성 피크)
    // 10:00~11:30 → SNIPER 전용 (변동성 축소, 고확신만)
    // 11:30~13:00 → 전면 차단 (점심 유동성 소멸)
    // 13:00~14:00 → SNIPER 전용 (오후 세션 1시간)
    // 14:00~15:00 → 전면 차단
    // 15:00~15:20 → SWING 전용 종가베팅 창구 (v12 신규)
    const isAfterGoldenHour = !isScalpingMode && kstH >= 10;
    const isSniperWindow =
      (kstH === 10 || (kstH === 11 && kstM < 30)) || // 10:00~11:30
      kstH === 13; // 13:00~14:00
    const isLunchBan = isAfterGoldenHour && !(effectiveModeRaw === 'SNIPER' && isSniperWindow);
    const portfolioStress = calcPortfolioStressLevel(openChains, livePrices, totalAssets);
    if (portfolioStress >= 1) {
      logger.warn(`⚠️ 포트폴리오 스트레스 레벨 ${portfolioStress} (미실현 손실 누적)`, { component: 'TRACK_B' });
    }
    // RISK_OFF: 완전 차단 대신 비율 축소로 대응 (조정장에도 % 줄여서 매매)
    // 차단 대상: 장마감, 마의시간, 일일손실초과, 서킷브레이커, 미실현 위험만
    // 🎰 EOD-only 쿨다운 모드: 연패 시 장중 매매 전면 차단 (종가베팅만 허용)
    const { isEodOnlyMode } = await import('../../risk/trade-gate-stats.js');
    const eodOnlyActive = await isEodOnlyMode();
    if (eodOnlyActive) {
      logger.warn('🎰 EOD-only 모드: 장중 신규매수 차단 (종가베팅만 허용)', { component: 'TRACK_B' });
    }

    // 90+ 고확신 종목이 있으면 하락장 차단 우회 (하락장에도 고점수 종목은 역발상 매수 허용)
    const topScore = scores.reduce((mx, s) => Math.max(mx, s.composite_score ?? 0), 0);
    const hasHighConvictionStock = topScore >= 90;
    // SWING 종가 우선: 14:30 이전 신규매수 제한 (스윙=며칠 홀딩 → 당일 노이즈 회피, 종가 확인 후 진입)
    // BREAKOUT 모드는 돌파 순간 포착 필요 → 시간 제한 없음
    // 예외1: AI 70+ 고확신 종목 (95→70 완화: 시장 컨센서스가 강해 즉시 진입 유리)
    // 예외2: KOSPI +1.5%+ 랠리일 → 종가우선 해제 (갭업 랠리 놓치면 안 됨)
    // v10.5: SWING 종가우선 제거 — SWING이 실질적으로 14:30~14:50 20분만 매매 가능했던 버그
    // 기존: 14:30 이전 + 70점 미만 → 차단 → 대부분의 종목이 70 미달 → 전일 매매 불가
    const isSwingEodRestricted = false;
    // 최대 동시 포지션 수 제한 (alloc-risk-cache에서 조회)
    const { getAllocRisk } = await import('../../db/alloc-risk-cache.js');
    const allocRisk = await getAllocRisk(ctxIsPaper);
    const activePositionCount = openChains.filter((c) => c.total_quantity > 0 && c.stock_code !== PARK_STOCK_CODE).length;
    const isMaxPositionsReached = !ctxIsPaper && activePositionCount >= allocRisk.maxPositions;
    if (isMaxPositionsReached) {
      logger.info(`🚫 최대 포지션 수 도달: ${activePositionCount}/${allocRisk.maxPositions} → 신규 매수 차단`, { component: 'TRACK_B' });
    }
    // 🚀 랠리일 감지: KOSPI +1.5%+ 갭업 시 보수적 시간 차단 해제 (갭업 랠리 놓치지 않기)
    const isRallyDay = kospiRegime.todayUp;
    // 랠리일: 개장블록만 09:00-09:10으로 단축 — 마의 시간대는 랠리일이어도 유지
    // (이전: isRallyDay ? false : isLunchBan → 오늘 KOSPI+0.1%만 올라도 10:45 진입 → -405K 손실)
    const isOpeningBlock = isRallyDay ? (kstH === 9 && kstM < 10 && !getCtxIsPaper() && effectiveMode !== 'SCALPING') : isOpeningVolatility;
    const isLunchBlock = isLunchBan; // 랠리일이어도 마의 시간대 항상 적용 (93+ 극초고확신만 예외)
    if (isRallyDay && (isOpeningVolatility || isSwingEodRestricted)) {
      logger.info(`🚀 랠리일(KOSPI+1.5%+): 개장블록/종가우선 해제 → 적극 매수 허용 (마의시간대는 유지)`, { component: 'TRACK_B' });
    }
    const blockNewBuys =
      (!ctxIsPaper && isPastClose) || // Paper: 마감시간 면제 (적극적 매매)
      (!ctxIsPaper && isLunchBlock) || // 점심블록: 랠리일 해제
      isSwingEodRestricted || // SWING 14:30 이전: 종가우선 (랠리일/70+점 예외)
      isOpeningBlock || // 개장블록: 랠리일 09:10으로 단축
      isMaxPositionsReached || // 최대 동시 포지션 수 초과: 신규 매수 차단
      (!ctxIsPaper && dailyLoss.blocked) || // Paper: 일일손실 차단 면제 (데이터 수집 우선)
      (!ctxIsPaper && kospiRegime.flashCrash) || // 급락 서킷브레이커: Live만 차단 (Paper 면제 — 모의자금)
      (!ctxIsPaper && !isKospiOverrideActive() && kospiRegime.todayDown) || // 코스피 당일 -0.3%+ 하락: 신규매수 전면 차단 (고확신 종목은 decision-flow에서 개별 허용)
      (!ctxIsPaper &&
        !isKospiOverrideActive() &&
        kospiRegime.penalty >= 2 &&
        kospiRegime.todayDown) || // 하락장+당일하락: Live만 차단 (고확신 개별 허용은 downstream)
      (!ctxIsPaper && portfolioStress >= 2) || // Paper: 포트스트레스 면제
      (!ctxIsPaper && crashSignal.level === 'CRASH') || // 크래시 시그널 CRASH: 인버스 외 일반 매수 차단
      (!ctxIsPaper && crashSignal.level === 'PANIC') || // 크래시 시그널 PANIC: 전면 매수 차단
      eodOnlyActive; // 🎰 연패 EOD-only 모드 (Paper는 이미 false 반환)

    // ── entry-timing-guard 연결: 이브닝 블록 + 전략 필터 + 기술지표 다중 확증 ──
    // 기존 blockNewBuys 조건에 구조적 가드 추가 (Live만 적용)
    const entryTimingCheck = !ctxIsPaper && !blockNewBuys
      ? checkEntryTiming({ aiScore: topScore, marketCode: 'KR', strategyMode: effectiveMode })
      : null;
    if (entryTimingCheck && !entryTimingCheck.allowed) {
      logger.info(`🛡️ 진입타이밍가드 차단: ${entryTimingCheck.reason}`, { component: 'TRACK_B' });
    }
    const blockNewBuysFinal = blockNewBuys || (entryTimingCheck != null && !entryTimingCheck.allowed);

    // EOD 전용 차단: isPastClose/eodOnlyActive 제외 (14:50+ 종가베팅은 허용)
    // Paper: dailyLoss 면제 (급락 서킷만 유지)
    const blockEodBuys =
      (!ctxIsPaper && dailyLoss.blocked) ||
      (!ctxIsPaper && kospiRegime.flashCrash) ||
      (!ctxIsPaper && kospiRegime.penalty >= 2) || // 약세장(KOSPI<MA60): EOD 대형주 매수도 차단
      (!ctxIsPaper && (crashSignal.level === 'CRASH' || crashSignal.level === 'PANIC')); // 크래시 시그널: EOD 차단

    // RISK_OFF/하락장: 축소하되 기회 유지 (극공포=역발상 매수 기회)
    const macroSizingMult = macroRiskOff ? 0.7 : kospiRegime.penalty >= 2 ? 0.6 : kospiRegime.penalty >= 1 ? 0.8 : 1.0;
    // Adam Khoo 포지션 사이징: bullish → ×1.15, MA200 아래 → ×0.85
    const adamKhooSizingMult = kospiRegime.adamKhoo?.bullish ? 1.15 : kospiRegime.adamKhoo?.belowMa200 ? 0.85 : 1.0;

    if (blockNewBuysFinal && hasHighConvictionStock && kospiRegime.penalty >= 2) {
      logger.info(
        `🔥 하락장 매수차단 중이나 90+점 고확신 종목(top=${topScore}) 존재 — decision-flow에서 개별 허용 예정 (포지션 축소 ×${macroSizingMult})`,
        { component: 'TRACK_B' },
      );
    }
    if (blockNewBuysFinal) {
      const blockReason = isPastClose
        ? '마감시간(14:00+ / SWING 15:00~15:20 예외)'
        : isLunchBan
          ? `시간대차단(SNIPER외 10:00+ / 전면차단 11:30~13:00 / 14:00~15:00 / SWING 15:00~15:20 예외)`
          : isSwingEodRestricted
            ? `SWING 종가우선(14:30 이전, AI 70 미만 [top=${topScore}점], 비랠리일 → 14:30+ 대기)`
            : dailyLoss.blocked
              ? `일일손실초과(${dailyLoss.dailyPnlPct.toFixed(1)}%)`
              : kospiRegime.flashCrash
                ? 'KOSPI급락서킷브레이커'
                : kospiRegime.penalty >= 2 && kospiRegime.todayDown
                  ? `하락장매수차단(penalty${kospiRegime.penalty}+당일하락)`
                  : crashSignal.level === 'CRASH' || crashSignal.level === 'PANIC'
                    ? `🔻 크래시시그널(${crashSignal.level} score=${crashSignal.score})`
                  : entryTimingCheck && !entryTimingCheck.allowed
                    ? `진입타이밍가드(${entryTimingCheck.details.phase})`
                    : eodOnlyActive
                      ? '🎰 EOD-only모드(연패→종가베팅만허용)'
                      : `포트폴리오위험(미실현손실-3.5%↑)`;
      logger.warn(`🚫 신규매수 차단: ${blockReason}`, { component: 'TRACK_B' });
    }
    if (macroSizingMult < 1.0) {
      logger.info(
        `📉 매크로/레짐 포지션 축소: ×${macroSizingMult} (RISK_OFF=${macroRiskOff} penalty=${kospiRegime.penalty})`,
        { component: 'TRACK_B' },
      );
    }

    const todayDate = getKSTNow().toISOString().split('T')[0];
    // KOSPI 레짐에 따른 전종목 점수 감산: 조정장(penalty=1) -10, 하락장(penalty=2) -15, 당일하락(todayDown) -5
    // 이유: AI 점수는 개별 팩터만 반영하며 시장 방향성 무관. 하락장 낙칼 방지를 위해 threshold 상향 대신 점수 직접 감산.
    const kospiPenaltyAdj =
      kospiRegime.penalty >= 2 ? -15 : kospiRegime.penalty >= 1 ? -10 : kospiRegime.todayDown ? -5 : 0;
    if (kospiPenaltyAdj !== 0) {
      logger.info(
        `📉 KOSPI 레짐 점수 보정: penalty=${kospiRegime.penalty} todayDown=${kospiRegime.todayDown} → 전종목 ${kospiPenaltyAdj}점 감산`,
        { component: 'TRACK_B' },
      );
    }
    // Adam Khoo MA20/MA50/MA200 점수 보정: bullish → +5, MA200 아래 → -8
    const adamKhooAdj = kospiRegime.adamKhoo?.bullish ? 5 : kospiRegime.adamKhoo?.belowMa200 ? -8 : 0;
    if (adamKhooAdj !== 0) {
      logger.info(
        `${adamKhooAdj > 0 ? '📈' : '📉'} Adam Khoo 점수 보정: ${adamKhooAdj > 0 ? '+' : ''}${adamKhooAdj}점 (${adamKhooAdj > 0 ? '정배열+우상향' : 'KOSPI < MA200'})`,
        { component: 'TRACK_B' },
      );
    }
    // confidence 임계값: live=0.60 (v3: 0.45→0.60), paper=0.45 (연습매매 활성화)
    const confMin = getCtxIsPaper() ? 0.3 : 0.6; // Paper: 0.45→0.3 (적극적 매매)
    const adjustedScores = scores
      .filter((s: any) => {
        const conf = s.confidence ?? 0;
        if (conf < confMin) return false;
        // AI Loop 블랙리스트: Claude Code가 특정 종목 매수 차단
        const aiBlacklist = getOverride<boolean>(`${s.stock_code}_blacklist`);
        if (aiBlacklist) {
          logger.info(`🤖 AI Loop 블랙리스트: ${s.stock_code} 매수 차단`, { component: 'AI_LOOP' });
          return false;
        }
        return true;
      })
      .map((s: any) => {
        const rawBase = s.composite_score ?? 0;
        // ── Score Staleness Decay: 시간 경과에 따라 점수를 중립(50)으로 감쇠 ──
        // Track A 07:30 생성 → 15:30까지 8시간. 오래된 점수의 신뢰도 하락 반영
        const scoredAt = s.created_at ? new Date(s.created_at).getTime() : 0;
        const ageHours = scoredAt > 0 ? (Date.now() - scoredAt) / 3_600_000 : 0;
        const decayWeight = ageHours <= 2 ? 1.0 : ageHours <= 4 ? 0.88 : ageHours <= 6 ? 0.75 : ageHours <= 24 ? 0.60 : 0.45;
        const base = 50 + (rawBase - 50) * decayWeight; // 중립(50)으로 수렴
        const adj = flowAdjMap.get(s.stock_code) ?? 0;
        const capAdj = marketCapAdjMap.get(s.stock_code) ?? 0;
        // score_date: pg DATE → string (setTypeParser 적용) → "YYYY-MM-DD"
        const scoreDay = s.score_date ? String(s.score_date).slice(0, 10) : null;
        const stale = scoreDay && scoreDay !== todayDate ? -8 : 0;
        if (stale < 0)
          logger.info(`⏳ 스코어 stale 패널티: ${s.stock_code} (${scoreDay} ≠ ${todayDate} → -8점)`, {
            component: 'TRACK_B',
          });
        const macroAdj = macroSnapshot ? getMacroScoreAdjustment(macroSnapshot) : 0;
        const dartAdj = process.env.DART_API_KEY ? getDisclosureScoreAdjustment(s.stock_code) : 0;
        // 대형 우선주(MEGA_CAP): AI 점수 보너스 (변동성 낮아 AI가 보수적 점수 부여하는 보정)
        const megaCapAdj = MEGA_CAP_PRIORITY_CODES.has(s.stock_code)
          ? MEGA_CAP_PRIORITY_CODES.get(s.stock_code)!.bonus // 100% 적용 (대형주 변동성 낮아 보너스 필수)
          : 0;
        // 컨센서스 보정: 애널리스트 투자의견 상향/하향 사이클은 강력한 모멘텀 지표 (논문 검증)
        // BULLISH(상향 우세): +8, BEARISH(하향 우세): -12 (하향은 더 강하게 페널티 — 낙칼 방지)
        const consensusSignal = getConsensusTrend(s.stock_code);
        const consensusAdj = consensusSignal
          ? consensusSignal.trend === 'BULLISH'
            ? 8
            : consensusSignal.trend === 'BEARISH'
              ? -12
              : 0
          : 0;
        // AI Loop 점수 보정: Claude Code가 설정한 종목별 점수 조정 (-20 ~ +20)
        const aiScoreAdj = getOverride<number>(`${s.stock_code}_scoreAdj`) ?? 0;
        if (aiScoreAdj !== 0)
          logger.info(`🤖 AI Loop 점수 보정: ${s.stock_code} → ${aiScoreAdj > 0 ? '+' : ''}${aiScoreAdj}`, {
            component: 'AI_LOOP',
          });
        // 종목별 실거래 승률 보정: 65%+→+5, 35%-→-8 (자기학습 연동)
        const stockAccAdj = stockAccAdjMap.get(s.stock_code) ?? 0;
        // Piotroski F-Score 보정: 8-9 우량 +5, 0-2 취약 -8
        const piotroskiFs = getCachedPiotroskiScore(s.stock_code);
        const piotroskiAdj = piotroskiFs != null
          ? piotroskiFs >= 8 ? 5 : piotroskiFs <= 2 ? -8 : 0
          : 0;
        // Gemini fundamentalScore 보정: 75+→+4, 60+→+2, 30-→-5 (DART 리서치 연동)
        const fundScore = getCachedFundamentalScore(s.stock_code);
        const fundScoreAdj = fundScore != null
          ? fundScore >= 75 ? 4 : fundScore >= 60 ? 2 : fundScore <= 30 ? -5 : 0
          : 0;
        // Community Sentinel: 언급 Z-score + 센티먼트 + FOMO/펌프 감지 (-20 ~ +5)
        const communityAdj = getCommunityScoreAdjustment(s.stock_code);
        // 상대강도(RS): 종목 5일 수익률 vs KOSPI 5일 수익률 (학술 검증된 모멘텀 팩터)
        // KOSPI보다 강한 종목 = 시장 주도, 약한 종목 = 구조적 약세
        const kospi5dRet = kospiRegime.kospi5dReturn ?? 0;
        const stockCandles = chartData.get(s.stock_code);
        const stock5dRet = stockCandles && stockCandles.length >= 6 && stockCandles[5].close > 0
          ? ((stockCandles[0].close - stockCandles[5].close) / stockCandles[5].close) * 100
          : null;
        const relStrengthAdj = stock5dRet != null
          ? (stock5dRet - kospi5dRet) >= 3.0 ? 4     // 시장 대비 3%+ 초과 → 주도주
            : (stock5dRet - kospi5dRet) <= -3.0 ? -6  // 시장 대비 3%+ 부진 → 약세 종목
            : 0
          : 0;
        const totalAdj =
          adj + capAdj + stale + kospiPenaltyAdj + adamKhooAdj + macroAdj + dartAdj + megaCapAdj + consensusAdj + aiScoreAdj + stockAccAdj + piotroskiAdj + fundScoreAdj + communityAdj + relStrengthAdj;
        if (!Number.isFinite(totalAdj)) {
          logger.warn(
            `⚠️ 스코어 보정 NaN 감지: ${s.stock_code} adj=${adj} cap=${capAdj} macro=${macroAdj} dart=${dartAdj} cns=${consensusAdj} ai=${aiScoreAdj} acc=${stockAccAdj} pio=${piotroskiAdj} fund=${fundScoreAdj} cmty=${communityAdj} rs=${relStrengthAdj}`,
            { component: 'TRACK_B' },
          );
          return { stock_code: s.stock_code, score: Math.max(0, Math.round(base)) || 0 };
        }
        const boundedAdj = Math.max(-20, Math.min(25, totalAdj));
        const rawScore = Math.min(100, Math.max(0, base + boundedAdj));
        return { stock_code: s.stock_code, score: Math.round(rawScore) };
      });

    // 적응형 파라미터: DB 명시 설정 > 시장 최적화 자동값 > STRATEGY_PARAMS 기본값
    // DB 설정이 있어도 constants의 값보다 낮아질 수 없음 (floors)
    const adaptP = kospiRegime.adaptive[effectiveMode];
    const baseP = STRATEGY_PARAMS[effectiveMode] as {
      buyThreshold: number;
      takeProfitPct: number;
      stopLossPct: number;
    };
    const adaptThreshold = adaptP?.buyThreshold ?? baseP.buyThreshold;
    const adaptTp = adaptP?.takeProfitPct ?? baseP.takeProfitPct;
    const adaptSl = adaptP?.stopLossPct ?? baseP.stopLossPct;
    // buyThreshold: DB는 상향만 가능 (더 엄격하게만)
    // AI Loop minBuyScore 오버라이드: Claude Code가 시장 상황에 따라 동적 조절
    const aiMinBuyScore = getOverride<number>('minBuyScore');
    const resolvedThreshold =
      aiMinBuyScore != null
        ? aiMinBuyScore // AI Loop이 직접 설정한 값 우선 (55~95 범위 검증됨)
        : strategy?.buy_threshold != null
          ? Math.max(strategy.buy_threshold, adaptThreshold)
          : adaptThreshold;
    // takeProfitPct: DB는 상향만 가능 (더 큰 수익 목표만)
    const resolvedTp = strategy?.take_profit_pct != null ? Math.max(strategy.take_profit_pct, adaptTp) : adaptTp;
    // stopLossPct: DB는 하향만 가능 (더 넓은 손절 허용만) — 타이트하게 조이는 건 금지
    const resolvedSl = strategy?.stop_loss_pct != null ? Math.min(strategy.stop_loss_pct, adaptSl) : adaptSl;

    // 성과 배율: 최근 5거래일 승률/수익 기반 (0.7x ~ 1.2x)
    const perfMult = await getPerformanceMultiplier();
    // 승률 피드백: 최근 30일 실거래 신호별 승률 → 임계값/눌림/거래량 동적 강화
    const winFeedback = await getWinRateFeedback(getCtxIsPaper());
    // Paper 모드: buyThresholdOffset 적용 (80→70 등 하향 → 진입 기회 확대)
    // Live 모드: liveRisk offset(-10) + Paper 실적 기반 크로스 피드백 합산
    const crossBoost = await getCrossModeBoost();
    const liveOffset = !getCtxIsPaper() ? (config.liveRisk?.buyThresholdOffset ?? -10) : 0;
    const paperOffset = getCtxIsPaper() ? (config.paperRisk.buyThresholdOffset ?? 0) : crossBoost.thresholdAdj + liveOffset;
    // Paper 모드: 패배 피드백이 임계값 올리는 것 차단 (학습 목적 — 진입 기회 보존)
    const thresholdBonus = ctxIsPaper ? Math.min(0, winFeedback.thresholdBonus) : winFeedback.thresholdBonus;
    // Live v11: 하한선 50→42 (더 많은 고품질 신호 통과)
    const thresholdFloor = ctxIsPaper ? 50 : 42;
    // 자기학습 인사이트 신호: Track A가 4시간 간격으로 생성한 실거래 패턴 분석 → thresholdAdj 반영
    let insightThresholdAdj = 0;
    try {
      const { getKRInsightSignals } = await import('../overseas/insights-generator.js');
      const signals = await getKRInsightSignals();
      if (signals) {
        insightThresholdAdj = signals.thresholdAdj;
        if (insightThresholdAdj !== 0) {
          logger.info(
            `🧠 자기학습 인사이트 적용: thresholdAdj=${insightThresholdAdj > 0 ? '+' : ''}${insightThresholdAdj} (${signals.updatedAt.slice(0, 16)})`,
            { component: 'TRACK_B' },
          );
        }
      }
    } catch { /* 인사이트 로드 실패 시 무시 */ }
    const feedbackThreshold = Math.max(thresholdFloor, resolvedThreshold + thresholdBonus + paperOffset + insightThresholdAdj);
    if (winFeedback.thresholdBonus > 0 || winFeedback.requirePullback || winFeedback.minVolumeRatio > 1.0) {
      logger.info(`🎯 승률피드백 적용: ${winFeedback.summary}`, { component: 'TRACK_B' });
    }
    // 복리 포지션 사이징: 총자산 20% 기반 (고정 캡 → 동적 스케일링)
    const assetBasedMax = Math.round(totalAssets * 0.2);
    const baseMaxPos = dailyLoss.earlyWarning ? Math.round(assetBasedMax * 0.5) : assetBasedMax;
    // 스트레스 레벨 1 → 포지션 추가 10% 축소
    const stressMult = portfolioStress >= 1 ? 0.9 : 1.0;
    const crossSizingMult = crossBoost.sizingMult;
    const adjMaxPositionKrw = Math.round(baseMaxPos * perfMult * stressMult * crossSizingMult * adamKhooSizingMult);
    if (perfMult !== 1.0 || stressMult !== 1.0 || crossSizingMult !== 1.0 || adamKhooSizingMult !== 1.0) {
      logger.info(
        `📐 maxPositionKrw 조정: ${baseMaxPos.toLocaleString()} × 성과${perfMult}x × 스트레스${stressMult}x${crossSizingMult !== 1.0 ? ` × Paper피드백${crossSizingMult}x` : ''}${adamKhooSizingMult !== 1.0 ? ` × AK${adamKhooSizingMult}x` : ''} = ${adjMaxPositionKrw.toLocaleString()}원`,
        { component: 'TRACK_B' },
      );
    }

    // ── 호가 불균형 보정 + 매도벽 하드 게이트 (상위 5종목) ───────────────
    // bid/ask 비율 ≥ 1.5 → 매수세 강함 +6, ≥ 1.2 → +3
    // bid/ask 비율 ≤ 0.7 → 매도세 강함 -6, ≤ 0.85 → -3
    // bid/ask 비율 ≤ 0.5 → 매도벽 2배+ → 진입 완전 차단 (hard gate)
    const orderbookAdjMap = new Map<string, number>();
    const orderbookBlockedCodes = new Set<string>();
    if (!blockNewBuysFinal) {
      try {
        const topCandidates = adjustedScores
          .filter((s) => s.score >= resolvedThreshold - 10)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
        const obResults = await Promise.allSettled(
          topCandidates.map((s) =>
            Promise.race([
              getOrderbook(s.stock_code).then((ob) => {
                if (!ob || ob.length === 0) return { code: s.stock_code, adj: 0, ratio: 1 };
                const totalBid = ob.reduce((sum, e) => sum + e.bidVolume, 0);
                const totalAsk = ob.reduce((sum, e) => sum + e.askVolume, 0);
                if (totalAsk === 0) return { code: s.stock_code, adj: 0, ratio: 999 };
                const ratio = totalBid / totalAsk;
                const adj = ratio >= 1.5 ? 6 : ratio >= 1.2 ? 3 : ratio <= 0.7 ? -6 : ratio <= 0.85 ? -3 : 0;
                return { code: s.stock_code, adj, ratio };
              }),
              new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 800)),
            ]),
          ),
        );
        for (const r of obResults) {
          if (r.status === 'fulfilled') {
            orderbookAdjMap.set(r.value.code, r.value.adj);
            // 매도벽 하드 게이트: bid/ask ≤ 0.5 → 매도 잔량이 매수의 2배+ → 진입 차단
            if (r.value.ratio <= 0.5) {
              orderbookBlockedCodes.add(r.value.code);
              logger.warn(`🚫 호가 매도벽: ${r.value.code} bid/ask=${r.value.ratio.toFixed(2)} → 진입 차단`, {
                component: 'TRACK_B',
              });
            }
          }
        }
        const nonZero = [...orderbookAdjMap.entries()].filter(([, v]) => v !== 0);
        if (nonZero.length > 0) {
          logger.info(`📋 호가 불균형 보정: ${nonZero.map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`).join(', ')}`, {
            component: 'TRACK_B',
          });
        }
      } catch {
        /* 호가 실패해도 파이프라인 계속 */
      }
    }

    const finalScores =
      orderbookAdjMap.size > 0
        ? adjustedScores.map((s) => {
            const obAdj = orderbookAdjMap.get(s.stock_code) ?? 0;
            return obAdj !== 0 ? { ...s, score: Math.min(100, Math.max(0, s.score + obAdj)) } : s;
          })
        : adjustedScores;

    const filteredWatchlist = watchlist
      .filter((w) => w.stock_code !== PARK_STOCK_CODE)
      .map((w) => ({ stock_code: w.stock_code, stock_name: w.stock_name }));

    // ── KIS 시장 시그널: 상위 5종목 (v6: 3→5 확대, 수급·호가·공매도 정확도 강화) ──
    let marketSignals: Map<string, import('../../kis/market-signals.js').StockSignals> | undefined;
    if (!blockNewBuysFinal) {
      try {
        const topCodes = [...finalScores]
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map((s) => s.stock_code);
        if (topCodes.length > 0) {
          marketSignals = await getBatchStockSignals(topCodes);
          logger.info(`📡 시그널 수집: ${marketSignals.size}/${topCodes.length}개 (상위5)`, { component: 'TRACK_B' });
        }
      } catch (err) {
        logger.warn(`📡 시그널 수집 실패 (계속): ${err}`, { component: 'TRACK_B' });
      }
    }

    const decisions = await technicalFallbackDecisions({
      mode: effectiveMode,
      watchlist: filteredWatchlist,
      livePrices,
      chartData,
      openChains,
      orderableCash,
      maxPositionKrw: adjMaxPositionKrw,
      totalAssets,
      lossBlockedCodes: new Set([...recentLossCodes, ...todayRepeatStopCodes]),
      bigLossBlockedCodes: bigLossBlocked,
      manuallySoldCodes,
      recentlySoldCodes,
      aiScores: finalScores, // AI 꽁돈 진입(>=92점)만 활성화, 손실청산 보조
      takeProfitPct: resolvedTp,
      stopLossPct: resolvedSl,
      buyThreshold: feedbackThreshold,
      winRates,
      requirePullback: false, // 2026-06: 눌림목 필수 해제 — 19단계 필터에서 진입 기회 차단 과다
      minVolumeRatio: Math.max(winFeedback.minVolumeRatio, 1.2), // 거래량 최소 1.2x 보장
      // penalty=1(조정장) 단독으로는 차단 안함 → adaptive threshold +2 로 대응
      // penalty=2(하락장, KOSPI<MA60)만 차단. SCALPING 모드면 macro/regime 면제
      blockNewBuys: blockNewBuysFinal,
      macroSizingMult,
      lossHistory,
      kospiBoost: kospiRegime.boost,
      allocationTarget: allocCfg
        ? {
            stock_pct: Number(allocCfg.stock_pct),
            rebalance_threshold_pct: Number(allocCfg.rebalance_threshold_pct),
            is_active: Boolean(allocCfg.is_active),
          }
        : null,
      currentStockValue,
      junkStockCodes,
      orderbookBlockedCodes,
      marketSignals,
    });

    // ── Paper 모드: BREAKOUT 전략 병행 실행 (다전략 수익 극대화) ──────────────
    // SWING 메인 패스 후 BREAKOUT 패스를 추가 실행 → 돌파 신호 종목 보완 진입
    if (ctxIsPaper && effectiveMode !== 'BREAKOUT' && !blockNewBuysFinal) {
      try {
        const breakoutDecisions = await technicalFallbackDecisions({
          mode: 'BREAKOUT',
          watchlist: filteredWatchlist,
          livePrices,
          chartData,
          openChains,
          orderableCash,
          maxPositionKrw: adjMaxPositionKrw,
          totalAssets,
          lossBlockedCodes: new Set([...recentLossCodes, ...todayRepeatStopCodes]),
          bigLossBlockedCodes: bigLossBlocked,
          manuallySoldCodes,
          recentlySoldCodes,
          aiScores: finalScores,
          takeProfitPct: resolvedTp,
          stopLossPct: resolvedSl,
          buyThreshold: feedbackThreshold,
          winRates,
          requirePullback: false,
          minVolumeRatio: 1.0,
          blockNewBuys: blockNewBuysFinal,
          macroSizingMult,
          lossHistory,
          kospiBoost: kospiRegime.boost,
          allocationTarget: null,
          currentStockValue,
          junkStockCodes,
          orderbookBlockedCodes,
          marketSignals,
        });
        const existingBuyStocks = new Set(
          decisions.filter((d) => d.action === 'BUY' || d.action === 'AVERAGE_DOWN').map((d) => d.stock_code),
        );
        const openChainCodes = new Set(openChains.map((c) => c.stock_code));
        const newBreakoutBuys = breakoutDecisions.filter(
          (d) =>
            (d.action === 'BUY' || d.action === 'AVERAGE_DOWN') &&
            !existingBuyStocks.has(d.stock_code) &&
            !openChainCodes.has(d.stock_code),
        );
        if (newBreakoutBuys.length > 0) {
          logger.info(
            `📈 Paper BREAKOUT 병행 ${newBreakoutBuys.length}건 추가: ${newBreakoutBuys.map((d) => d.stock_code).join(', ')}`,
            { component: 'TRACK_B' },
          );
          decisions.push(...newBreakoutBuys);
        }
      } catch (err) {
        logger.warn(`Paper BREAKOUT 병행 패스 실패 (스킵): ${err}`, { component: 'TRACK_B' });
      }
    }

    // ── Paper 모드: AI 상위픽 자동매수 (데이터 수집 + 점수 정확도 검증) ────
    // v10.4: recentlySoldCodes 쿨다운 체크 추가 (Paper도 churning 방지)
    if (ctxIsPaper && finalScores.length > 0 && orderableCash > 10000) {
      try {
        const openCodes = new Set(openChains.map((c) => c.stock_code));
        const decidedBuyCodes = new Set(
          decisions
            .filter((d) => d.action === 'BUY' || d.action === 'AVERAGE_DOWN')
            .map((d) => d.stock_code),
        );
        const topPick = [...finalScores]
          .sort((a, b) => b.score - a.score)
          .find((s) =>
            !openCodes.has(s.stock_code) &&
            !decidedBuyCodes.has(s.stock_code) &&
            !recentlySoldCodes.has(s.stock_code),
          );
        if (topPick) {
          const priceInfo = livePrices.get(topPick.stock_code);
          const curPrice = priceInfo?.currentPrice ?? 0;
          if (curPrice > 0) {
            const buyAmount = Math.max(Math.min(orderableCash * 0.05, adjMaxPositionKrw), 50000);
            const quantity = Math.floor(buyAmount / curPrice);
            if (quantity >= 1) {
              decisions.push({
                action: 'BUY',
                stock_code: topPick.stock_code,
                quantity,
                price_type: 'MARKET',
                reasoning: `🎯 Paper AI상위픽 자동매수: ${topPick.score}점 (연습 데이터 수집)`,
                confidence: 0.7,
                ai_score: topPick.score,
                strategy_mode: effectiveMode,
                trigger_source: 'PAPER_AUTO_TOP',
              });
              logger.info(
                `🎯 Paper AI상위픽: ${topPick.stock_code} ${quantity}주 @${curPrice.toLocaleString()}원 (score=${topPick.score})`,
                { component: 'TRACK_B' },
              );
            }
          }
        }
      } catch (err) {
        logger.warn(`Paper AI상위픽 자동매수 실패 (스킵): ${err}`, { component: 'TRACK_B' });
      }
    }

    // ── SWING/SNIPER 단계 익절 (3.5%@25%, 6.5%@35%, 10%@100% / 4%@30%, 8%@100%) ──
    try {
      const partialTpDecisions = generatePartialTpDecisions(openChains, livePrices);
      if (partialTpDecisions.length > 0) {
        logger.info(
          `💰 Track B 단계익절 ${partialTpDecisions.length}건: ${partialTpDecisions.map((d) => `${d.stock_code}(${d.action})`).join(', ')}`,
          { component: 'TRACK_B' },
        );
        decisions.push(...partialTpDecisions);
      }
    } catch (err) {
      logger.warn(`단계익절 생성 실패 (스킵): ${err}`, { component: 'TRACK_B' });
    }

    // ── 하락장 수익화 결정 주입 ─────────────────────────────────────────
    // 우선순위: ① 인버스 매수/매도 ② 패닉 긴급축소 (일반 매매 decisions 앞에 삽입)
    // NONE 레벨에서도 항상 호출 — 보유 인버스가 있으면 generateInverseDecisions가 청산 결정 생성
    const inverseDecisions = generateInverseDecisions({
      signal: crashSignal,
      openChains,
      livePrices,
      orderableCash,
      totalAssets,
    });
    if (inverseDecisions.length > 0) {
      logger.info(
        `🔻 인버스 결정 ${inverseDecisions.length}건: ${inverseDecisions.map((d) => `${d.action} ${d.stock_code} ×${d.quantity}`).join(', ')}`,
        { component: 'CRASH_PROFIT' },
      );
      decisions.unshift(...inverseDecisions);
    }

    // 자기헤지 방지: CRASH/PANIC 레벨에서 인버스 매수가 있으면 CASH_PARKING 매수 취소
    // (인버스 보유 중 대형주 매수 = 부의상관 포지션 동시 보유 → 수수료만 낭비)
    if (
      (crashSignal.level === 'CRASH' || crashSignal.level === 'PANIC') &&
      inverseDecisions.some((d) => d.action === 'BUY')
    ) {
      const before = decisions.length;
      const filtered = decisions.filter((d) => !(d.action === 'BUY' && d.trigger_source === 'CASH_PARKING'));
      decisions.splice(0, decisions.length, ...filtered);
      const removed = before - decisions.length;
      if (removed > 0) {
        logger.info(`🛡️ 자기헤지 방지: CASH_PARKING 매수 ${removed}건 취소 (인버스 ${crashSignal.level} 레벨)`, {
          component: 'CASH_MANAGER',
        });
      }
    }

    const panicDecisions = generatePanicSellDecisions(crashSignal, openChains, livePrices);
    if (panicDecisions.length > 0) {
      logger.warn(
        `🚨 패닉 긴급축소 ${panicDecisions.length}건: ${panicDecisions.map((d) => `${d.stock_code} ×${d.quantity}`).join(', ')}`,
        { component: 'CRASH_PROFIT' },
      );
      decisions.unshift(...panicDecisions);
    }

    // AI 손실 조기청산 비활성화 — 정상 조정(-2%)도 강제청산해서 승률 저하 (4월→5월 13%로 하락 원인)
    // 손절은 technical-fallback의 고정 SL(-3%)에만 맡김

    // ── 뉴스 악재 감시: 보유 종목 악재 뉴스 → FORCE_CLOSE ──
    for (const chain of openChains) {
      const alreadyExiting = decisions.some(
        (d) => d.stock_code === chain.stock_code && ['SELL', 'FORCE_CLOSE', 'PARTIAL_SELL'].includes(d.action),
      );
      if (alreadyExiting) continue;
      const liveP = livePrices.get(chain.stock_code);
      if (!liveP || !chain.avg_buy_price) continue;
      const pnlPct = ((liveP.currentPrice - Number(chain.avg_buy_price)) / Number(chain.avg_buy_price)) * 100;
      // 깊은 손실이어도 뉴스 악재 감지 시 즉시 청산 (SL 대기보다 빠른 탈출)
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
      } catch {
        /* 뉴스 실패 시 무시 */
      }
    }

    // ── 고확신 눌림목 텔레그램 알림 (AI 90점+ + truePullbackPattern, 실전 전용) ──
    if (!getCtxIsPaper()) {
      const openStockCodes = new Set(openChains.map((c) => c.stock_code));
      const nameMap = new Map(watchlist.map((w) => [w.stock_code, w.stock_name]));
      const highConvictionCandidates = finalScores.filter((s) => s.score >= 90 && !openStockCodes.has(s.stock_code));
      for (const candidate of highConvictionCandidates) {
        const candles = chartData.get(candidate.stock_code);
        const liveP = livePrices.get(candidate.stock_code);
        if (!candles || candles.length < 30 || !liveP) continue;
        const tech = analyzeTechnicals(candles);
        if (!tech) continue;
        const curPrice = liveP.currentPrice;
        const recentHigh5 = candles.length >= 6 ? Math.max(...candles.slice(1, 6).map((c) => c.high)) : 0;
        const truePullbackPattern =
          tech.sma20 > 0 &&
          recentHigh5 > tech.sma20 * 1.04 &&
          curPrice >= tech.sma20 * 0.98 &&
          curPrice <= tech.sma20 * 1.02;
        if (!truePullbackPattern) continue;
        const now = Date.now();
        const lastAlert = getAlertMap().get(candidate.stock_code) ?? 0;
        if (now - lastAlert < 30 * 60_000) continue; // 30 min cooldown
        getAlertMap().set(candidate.stock_code, now);
        const stockName = nameMap.get(candidate.stock_code) ?? candidate.stock_code;
        const status = blockNewBuysFinal ? `⚠️ 자동매수 차단 중 — 수동 확인` : `✅ 자동매수 대기 중`;
        const msg = [
          `🔥 고확신 눌림목: *${stockName}* (${candidate.stock_code})`,
          `📊 AI점수=${candidate.score} pb=True vol=${tech.volumeRatio.toFixed(1)}x RSI=${tech.rsi14.toFixed(0)}`,
          status,
        ].join('\n');
        sendTelegramMessage(msg).catch(() => {});
        logger.info(
          `📱 텔레그램 고확신 알림: ${candidate.stock_code} AI=${candidate.score}점 pb=True vol=${tech.volumeRatio.toFixed(1)}x`,
          { component: 'TRACK_B' },
        );
      }
    }

    setActiveEngine('technical');
    // adjustedScores = confidence 0.60 필터 통과한 실제 사용 스코어 (scores는 전체 DB 조회수 — 오해 방지용 구분)
    if (hasScores && adjustedScores.length === 0) {
      logger.warn(
        `⚠️ AI 스코어 전량 필터링: DB=${scores.length}개 조회됐으나 confidence<0.60으로 전부 탈락 → 기술지표 단독 매매`,
        { component: 'TRACK_B' },
      );
    }
    logger.info(
      `📊 기술적 지표 매매 실행 [${hasScores ? 'technical+AI힌트' : 'technical'}] (AI점수=${adjustedScores.length}개 사용/${scores.length}개 DB, 결정=${decisions.length}개)`,
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
      kospiRegime: { penalty: kospiRegime.penalty, boost: kospiRegime.boost, todayDown: kospiRegime.todayDown, adamKhooBullish: kospiRegime.adamKhoo?.bullish },
      resolvedSl,
      resolvedTp,
      orderableCash,
      hasBuyCandidates,
      blockNewBuys: blockNewBuysFinal,
      blockEodBuys,
      adjMaxPositionKrw,
      chartData,
      kstH,
      kstM,
      macroRiskOff,
      isPaper: getCtxIsPaper(),
      crashSignal,
      overseasValueKrw,
    });

    // ── 장초반 09:00-09:30 신규 매수 필터링 (매도는 유지, blockNewBuys에도 포함되지만 2차 안전망) ──
    if (isOpeningVolatility) {
      const beforeCount = actionable.length;
      const filtered = actionable.filter((d) => !['BUY', 'AVERAGE_DOWN'].includes(d.action));
      if (filtered.length < beforeCount) {
        logger.info(
          `⏰ 장초반(${kstH}:${String(kstM).padStart(2, '0')}) 매수 ${beforeCount - filtered.length}건 차단 (매도 ${filtered.length}건 유지)`,
          { component: 'TRACK_B' },
        );
      }
      return filtered;
    }

    // ── 당일 수익 자율 퇴장: 목표 수익 도달 시 신규 BUY/AVERAGE_DOWN 차단 (Live만) ──
    const DAILY_PROFIT_STOP_PCT = 2.0;
    if (!ctxIsPaper && dailyLoss.dailyPnlPct >= DAILY_PROFIT_STOP_PCT) {
      const beforeCount = actionable.length;
      const filtered = actionable.filter((d) => !['BUY', 'AVERAGE_DOWN'].includes(d.action));
      if (filtered.length < beforeCount) {
        logger.info(
          `🏁 당일 수익 목표 달성(+${dailyLoss.dailyPnlPct.toFixed(2)}% ≥ +${DAILY_PROFIT_STOP_PCT}%) → 신규 매수 ${beforeCount - filtered.length}건 차단 (매도 유지)`,
          { component: 'TRACK_B' },
        );
      }
      return filtered;
    }

    if (hasBuyCandidates && !actionable.some((d) => ['BUY', 'AVERAGE_DOWN'].includes(d.action))) {
      logger.info('⏭️ 매수 후보 있으나 BUY 결정 없음 → KIS 관심종목 재동기화', { component: 'TRACK_B' });
      import('../../kis/interest-group.js').then((m) => m.syncInterestGroups()).catch(() => {});
    }

    // 유휴 현금 모니터링 로그
    const idleCashPct = totalAssets > 0 ? ((orderableCash / totalAssets) * 100).toFixed(1) : '0.0';
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await logSystem(
      'INFO',
      'TRACK_B',
      `파이프라인 완료 (${elapsed}초): ${decisions.length}개 판단, ${actionable.length}개 실행 대기`,
    );
    const tbModeTag = ctxIsPaper ? '🧪PAPER' : '💰LIVE';
    logger.info(
      `✅ [${tbModeTag}] Track B 완료 (${elapsed}초): 총 ${decisions.length}개 판단, ${actionable.length}개 액션 | 유휴현금 ${idleCashPct}% (${orderableCash.toLocaleString()}원)`,
      { component: 'TRACK_B' },
    );
    if (actionable.length === 0 && decisions.length > 0) {
      logger.info(`⏸️ [${tbModeTag}] Track B: 실행 액션 없음 — 판단 ${decisions.length}건 전부 HOLD/SKIP`, { component: 'TRACK_B' });
    }

    // 데이터 마스터 로그 (비동기, 파이프라인 블로킹 없음)
    logScanSession(
      {
        isPaper: ctxIsPaper,
        effectiveMode,
        kospiPenalty: kospiRegime.penalty,
        kospiBoost: kospiRegime.boost ?? false,
        blockNewBuys: blockNewBuysFinal,
        flashCrash: kospiRegime.flashCrash ?? false,
        dailyPnlPct: dailyLoss.dailyPnlPct,
        totalAssets,
        orderableCash,
        scoresCount: scores.length,
        macroRegime: macroSnapshot?.regime,
        crashSignalLevel: crashSignal?.level,
        adamKhooBullish: kospiRegime.adamKhoo?.bullish ?? null,
        adamKhooBelowMa200: kospiRegime.adamKhoo?.belowMa200 ?? null,
        elapsedMs: Date.now() - startTime,
      },
      actionable,
      actionable.map((d) => {
        const adj = adjustedScores.find((a) => a.stock_code === d.stock_code);
        const raw = scores.find((s) => s.stock_code === d.stock_code);
        return {
          stockCode: d.stock_code,
          aiScoreRaw: raw?.composite_score ?? undefined,
          aiScoreAdjusted: adj?.score ?? undefined,
          confidence: raw?.confidence ?? undefined,
          action: d.action,
          quantity: d.quantity ?? undefined,
          isPaper: ctxIsPaper,
        };
      }),
    ).catch(() => {});

    // ── 매 루프 자기 최적화 (비동기, 파이프라인 블로킹 안 함) ──
    // Paper: 자금 리필 체크 (10분 rate limit 내장)
    if (ctxIsPaper) {
      import('../../risk/paper-balance.js')
        .then((m) => m.checkAndRefillPaper())
        .catch(() => {});
    }
    // 황금비율 자동 조정 (1시간 rate limit)
    import('../../automation/regime-allocator.js')
      .then((m) => m.autoTuneRegimeWeights())
      .catch(() => {});

    return actionable;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await logSystem('ERROR', 'TRACK_B', `파이프라인 실패: ${msg}`);
    logger.error(`❌ Track B 실패: ${msg}`, { component: 'TRACK_B' });
    return [];
  }
}
