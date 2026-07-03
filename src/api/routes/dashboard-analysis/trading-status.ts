import { Hono } from 'hono';
import { getDefenseParkState } from '../../../ai/track-b/defense-park.js';
import { getAiStatus } from '../../../cache/ai-status.js';
import { getScoresWithFallback } from '../../../cache/redis.js';
import { runWithMode } from '../../../config/context.js';
import { getActiveStrategy, getActiveWatchlist } from '../../../db/client.js';
import { isMarketOpen } from '../../../kis/market.js';
import { getKillSwitchStatusAll } from '../../../risk/kill-switch.js';
import { getOpenMarketRegions } from '../../../shared/overseas/market-time.js';
import { isLiveEnabled, resolveRequestMode } from '../../guards/live-pin.js';

export const tradingStatusRoutes = new Hono();

// 통합 헬퍼 사용 — viewMode/mode 양쪽 지원
const resolveViewIsPaper = resolveRequestMode;

// ── 매매 상태 진단 (왜 매수 안 하는지) ──
tradingStatusRoutes.get('/trading-status', async (c) => {
  try {
    const viewIsPaper = resolveViewIsPaper(c);
    // runWithMode: getRecentLossStocks/getCooldownStatus/isEodOnlyMode 등이
    // getCtxIsPaper()로 모드를 읽으므로 올바른 컨텍스트 주입 필수
    return runWithMode(viewIsPaper, async () => {
    const [
      killSwitch,
      defensePark,
      strategy,
      watchlist,
      recentLossCodes,
      kospiRegime,
      cooldownStatus,
      eodOnly,
    ] = await Promise.all([
      Promise.resolve(getKillSwitchStatusAll()),
      getDefenseParkState().catch(() => ({ isActive: false, entryReason: null })),
      getActiveStrategy().catch(() => null),
      // v10.11: watchlist 1회만 조회 (기존: 2회 중복 DB 쿼리)
      getActiveWatchlist().catch(() => []),
      (async () => {
        const { getRecentLossStocks } = await import('../../../db/client.js');
        return getRecentLossStocks(7).catch(() => new Set<string>());
      })(),
      (async () => {
        const { fetchKospiRegime } = await import('../../../ai/track-b/market-regime.js');
        return fetchKospiRegime().catch(() => ({
          penalty: 0,
          boost: false,
          todayDown: false,
          flashCrash: false,
          adaptive: {},
          atrPct: 1.0,
        }));
      })(),
      (async () => {
        const { getCooldownStatus } = await import('../../../risk/trade-gate-stats.js');
        return getCooldownStatus().catch(() => null);
      })(),
      (async () => {
        const { isEodOnlyMode } = await import('../../../risk/trade-gate-stats.js');
        return isEodOnlyMode().catch(() => false);
      })(),
    ]);
    // v10.11: watchlist 결과로 scores 계산 (중복 DB 쿼리 제거)
    const scores = await getScoresWithFallback((watchlist as any[]).map((w: any) => w.stock_code)).catch(() => []);

    const mode = (strategy?.mode ?? 'SWING') as string;
    const { STRATEGY_PARAMS } = await import('../../../config/constants.js');
    const defaultThreshold = (STRATEGY_PARAMS as any)[mode]?.buyThreshold ?? 62;
    const buyThreshold = strategy?.buy_threshold ?? defaultThreshold;
    const krMarketOpen = isMarketOpen();
    const openRegions = getOpenMarketRegions();
    const usMarketOpen = openRegions.has('US') || openRegions.has('US_EXTENDED');
    const anyMarketOpen = krMarketOpen || openRegions.size > 0;
    // 하위호환: marketOpen = 국내 OR 해외 어느 것이든 열려있으면 true
    const marketOpen = anyMarketOpen;

    const blocks: { reason: string; detail: string; severity: 'warn' | 'info' | 'ok' }[] = [];

    if (killSwitch.kr.active) {
      blocks.push({
        reason: '긴급정지 [국내] (Kill Switch)',
        detail: killSwitch.kr.reason ?? '수동 발동',
        severity: 'warn',
      });
    }
    if (killSwitch.overseas.active) {
      blocks.push({
        reason: '긴급정지 [해외] (Kill Switch)',
        detail: killSwitch.overseas.reason ?? '수동 발동',
        severity: 'warn',
      });
    }

    if (defensePark.isActive) {
      blocks.push({
        reason: '방어 파킹 중',
        detail: defensePark.entryReason ?? '하락세 감지 → 현금 ETF 보호',
        severity: 'warn',
      });
    }

    if (!krMarketOpen && !usMarketOpen) {
      blocks.push({ reason: '전체 장 마감', detail: '국내·해외 모두 마감 시간', severity: 'info' });
    } else if (!krMarketOpen && usMarketOpen) {
      blocks.push({ reason: '국내 장 마감', detail: `해외 시장 운영 중 (${[...openRegions].join('/')})`, severity: 'info' });
    } else if (krMarketOpen && !usMarketOpen) {
      blocks.push({ reason: '해외 장 마감', detail: '국내 시장 운영 중 (09:00~15:30)', severity: 'info' });
    }

    if (mode === 'DEFENSE') {
      blocks.push({
        reason: 'DEFENSE 모드',
        detail: `AI 점수 ${buyThreshold}점 이상만 진입 — 기준 매우 높음`,
        severity: 'warn',
      });
    }

    // KOSPI 레짐 블록 (Live 전용)
    if (kospiRegime.flashCrash) {
      blocks.push({
        reason: '🚨 KOSPI 급락 서킷브레이커',
        detail: '5분 내 1%+ 하락 감지 — 신규 매수 전면 차단 (자동 해제)',
        severity: 'warn',
      });
    } else if (kospiRegime.penalty >= 2 && kospiRegime.todayDown) {
      blocks.push({
        reason: `📉 하락장 매수 차단 (penalty ${kospiRegime.penalty})`,
        detail: `KOSPI MA60 하회 + 당일 하락 — Live 신규 매수 차단 (Paper는 정상 운영)`,
        severity: 'warn',
      });
    } else if (kospiRegime.penalty >= 1) {
      blocks.push({
        reason: `⚠️ KOSPI 약세 조정 중 (penalty ${kospiRegime.penalty})`,
        detail: 'KOSPI MA20~MA60 사이 — 진입 기준 상향 (자동)',
        severity: 'info',
      });
    } else if (kospiRegime.todayDown) {
      blocks.push({
        reason: '📊 KOSPI 당일 소폭 하락',
        detail: '당일 -0.3% 이하 — 임계값 소폭 조정 (자동)',
        severity: 'info',
      });
    }

    // EOD-only 모드
    if (eodOnly) {
      blocks.push({
        reason: `🎰 EOD-only 모드 (${cooldownStatus?.consecutive ?? '?'}연패)`,
        detail: '연패 누적 → 장중 매수 차단, 14:50 이후 종가베팅만 허용',
        severity: 'warn',
      });
    }

    const candidates = scores.filter((s: any) => (s.composite_score ?? 0) >= buyThreshold);
    const topScore = scores.length > 0 ? Math.max(...scores.map((s: any) => s.composite_score ?? 0)) : 0;
    if (scores.length === 0) {
      blocks.push({
        reason: 'AI 스코어 없음',
        detail: 'Track A 미실행 or 캐시 만료 — 기술적 지표 fallback 사용 중',
        severity: 'info',
      });
    } else if (candidates.length === 0) {
      blocks.push({
        reason: `매수 후보 없음 (최고 ${topScore}점)`,
        detail: `현재 임계치 ${buyThreshold}점 — 모든 감시 종목 점수 미달`,
        severity: 'warn',
      });
    }

    if (recentLossCodes.size > 0) {
      const watchCodes = new Set(watchlist.map((w: any) => w.stock_code));
      const bannedInWatch = [...recentLossCodes].filter((c) => watchCodes.has(c));
      if (bannedInWatch.length > 0) {
        blocks.push({
          reason: `손실 밴 ${bannedInWatch.length}종목`,
          detail: `7일 내 손절 ${bannedInWatch.length}종목 재진입 금지: ${bannedInWatch.slice(0, 3).join(', ')}`,
          severity: 'info',
        });
      }
    }

    if (watchlist.length < 3) {
      blocks.push({
        reason: '감시목록 부족',
        detail: `현재 ${watchlist.length}종목 — 3종목 이상 권장`,
        severity: 'warn',
      });
    }

    const hasHardBlock = blocks.some(
      (b) =>
        b.severity === 'warn' &&
        (b.reason.includes('긴급정지') ||
          b.reason.includes('방어 파킹') ||
          b.reason.includes('후보 없음') ||
          b.reason.includes('DEFENSE') ||
          b.reason.includes('하락장') ||
          b.reason.includes('서킷') ||
          b.reason.includes('EOD-only')),
    );
    const overallStatus: 'ACTIVE' | 'WATCHING' | 'BLOCKED' =
      killSwitch.kr.active || killSwitch.overseas.active || defensePark.isActive || kospiRegime.flashCrash
        ? 'BLOCKED'
        : hasHardBlock
          ? 'WATCHING'
          : 'ACTIVE';

    const aiEngineStatus = getAiStatus();
    const geminiBlocked = aiEngineStatus.gemini === 'quota' || aiEngineStatus.gemini === 'error';
    const claudeBlocked = aiEngineStatus.claude === 'no_credit' || aiEngineStatus.claude === 'error';
    if (geminiBlocked && claudeBlocked) {
      blocks.push({
        reason: 'AI 엔진 전체 실패',
        detail: '기술적 지표 fallback으로 자동 매매 계속 진행 중 — AI 점수 기반 필터만 비활성 (30분 후 자동 재시도)',
        severity: 'info',
      });
    } else if (geminiBlocked) {
      blocks.push({
        reason: 'Gemini 오류/한도',
        detail: `${aiEngineStatus.gemini === 'quota' ? '무료 할당량 초과' : '연결 오류'} — 30분 후 자동 재시도`,
        severity: 'info',
      });
    }

    // v10.10.4: Live 모드 비활성화 상태 진단
    if (!viewIsPaper && !isLiveEnabled()) {
      blocks.push({
        reason: '실전모드 비활성화',
        detail: 'LIVE_ENABLED=false — 설정에서 Live를 켜야 실전 매수 가능',
        severity: 'warn',
      });
    }

    // 정합성 검증 결과 + QA 최신 리포트 추가
    let consistencyResult = null;
    let qaLatest = null;
    try {
      const { getLatestConsistencyResult } = await import('../../../scheduler/consistency-validator.js');
      consistencyResult = getLatestConsistencyResult();
    } catch { /* 아직 실행 전 */ }
    try {
      const { getLatestQAReport } = await import('../../../automation/qa-watchdog.js');
      qaLatest = await getLatestQAReport();
    } catch { /* QA 미실행 */ }

    return c.json({
      overallStatus,
      mode,
      buyThreshold,
      marketOpen,
      krMarketOpen,
      usMarketOpen,
      openMarkets: [...openRegions],
      topScore,
      candidateCount: candidates.length,
      watchlistCount: watchlist.length,
      lossBlockedCount: recentLossCodes.size,
      aiEngine: { claude: aiEngineStatus.claude, gemini: aiEngineStatus.gemini, active: aiEngineStatus.activeEngine },
      kospiRegime: {
        penalty: kospiRegime.penalty,
        todayDown: kospiRegime.todayDown,
        flashCrash: kospiRegime.flashCrash,
        boost: kospiRegime.boost,
      },
      eodOnly,
      consecutiveLosses: cooldownStatus?.consecutive ?? 0,
      blocks,
      consistency: consistencyResult,
      qaLatest: qaLatest ? { status: qaLatest.status, critical: qaLatest.critical, warning: qaLatest.warning, runAt: qaLatest.runAt } : null,
    });
    }); // runWithMode
  } catch (err) {
    return c.json({ overallStatus: 'UNKNOWN', blocks: [], error: 'Internal server error' });
  }
});

// ── 정합성 수동 전수조사 (즉시 실행) ──
tradingStatusRoutes.post('/consistency/run', async (c) => {
  try {
    const { runConsistencyValidator, getLatestConsistencyResult } = await import('../../../scheduler/consistency-validator.js');
    await runConsistencyValidator();
    return c.json({ ok: true, result: getLatestConsistencyResult() });
  } catch (e: any) {
    return c.json({ error: e.message || 'Internal server error' }, 500);
  }
});

// ── 정합성 최신 결과 조회 ──
tradingStatusRoutes.get('/consistency/latest', async (c) => {
  try {
    const { getLatestConsistencyResult } = await import('../../../scheduler/consistency-validator.js');
    return c.json(getLatestConsistencyResult() ?? { status: 'not_run', issues: [] });
  } catch {
    return c.json({ status: 'not_run', issues: [] });
  }
});

// ── Dream Entry 극단 진입점 조회 ──
tradingStatusRoutes.get('/dream-entries', async (c) => {
  try {
    const { getDreamEntries } = await import('../../../scheduler/dream-entry-job.js');
    return c.json(getDreamEntries());
  } catch {
    return c.json({ entries: [], calculatedAt: null });
  }
});
