import cron from 'node-cron';
import { detectAnomalies } from '../automation/anomaly-detector.js';
import { analyzeCapitalFlow } from '../automation/capital-flow.js';
import { generateDailyReport } from '../automation/daily-report.js';
import { analyzeWatchlistConsensus } from '../automation/analyst-consensus.js';
import { monitorDisclosures } from '../automation/dart-monitor.js';
import { checkDinnerMoneyWithdraw } from '../automation/profit-withdraw.js';
import { archiveOldData } from '../automation/data-archiver.js';
import { analyzeWatchlistFlows } from '../automation/investor-flow.js';
import { getMacroSnapshot } from '../automation/macro-data.js';
import { analyzeWatchlistShortSelling } from '../automation/short-selling.js';
import { autoSwitchStrategy } from '../automation/market-regime.js';
import { collectWatchlistNews } from '../automation/news-collector.js';
import { runSelfHealing } from '../automation/self-heal.js';
import { runDailyLearning } from '../automation/self-learning.js';

import { runSniperScan } from '../automation/snipers/runner.js';
import { MARKET, SCHEDULE } from '../config/constants.js';
import { setTradingModeOverride, paperOnly } from '../config/index.js';
import { runWithMode } from '../config/context.js';
import { logger } from '../utils/logger.js';
import { runHoldingCheckJob } from './holding-check-job.js';
import { runSnapshotJob } from './snapshot-job.js';
import { runTrackAJob } from './track-a-job.js';
import { runTrackBJob } from './track-b-job.js';
import { runOverseasJob, runOverseasDual } from './overseas-job.js';
import { syncInterestGroups, syncHoldingsToWatchlist, fixWatchlistNames } from '../kis/interest-group.js';
import { runUnfilledOrderCheck } from './unfilled-order-job.js';
import { runPreMarketQuickScore } from '../automation/pre-market-quick-score.js';
import { warmupOpeningBell, runOpeningBellCycle } from './opening-bell-job.js';
import { runHotSectorWatchlist } from '../automation/hot-sector-watchlist.js';
import { runPortfolioHealthCheck } from '../automation/portfolio-guard.js';
import { runIntegrityCheck } from './integrity-check-job.js';
import { runAutoPilotDual } from '../ai/auto-pilot.js';
import { invalidateBalanceCache } from '../kis/account.js';

/**
 * paper → live 순으로 동일 작업을 실행 (국내 이중 모드 병행운영)
 * overseas-job의 runOverseasDual() 패턴과 동일
 * PAPER_ONLY=true 시 live 스킵 (자율학습 모드 — API 호출·비용 절약)
 */
async function runDomesticDual(label: string, fn: () => Promise<unknown>): Promise<void> {
  // 공휴일·주말 가드 — 한국 장 안 열리는 날은 전체 스킵
  const { isTradingDay } = await import('../utils/holidays.js');
  if (!isTradingDay()) {
    logger.debug(`📅 ${label} 스킵 — 비거래일(공휴일/주말)`, { component: 'SCHEDULER' });
    return;
  }
  await runWithMode(true, async () => {
    try { await fn(); } catch (e) { logger.error(`${label} paper 실패: ${e}`, { component: 'SCHEDULER' }); }
  });
  if (paperOnly) return; // 자율학습 모드: live 완전 스킵
  // paper→live 전환 시 잔고 캐시 무효화 + 3초 쿨다운 (KIS rate limit EGW00201 방지)
  invalidateBalanceCache();
  await new Promise(r => setTimeout(r, 3000));
  await runWithMode(false, async () => {
    try { await fn(); } catch (e) { logger.error(`${label} live 실패: ${e}`, { component: 'SCHEDULER' }); }
  });
}

/**
 * 타임아웃을 적용하여 작업 실행 (지정 시간 초과 시 에러 로그 후 스킵)
 */
function withTimeout<T>(label: string, fn: () => Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`${label} 타임아웃 (${timeoutMs / 1000}초 초과)`));
    }, timeoutMs);
  });
  // 타임아웃 후 백그라운드 작업이 완료돼도 결과 무시 (두 번 실행 방지)
  const guarded = fn().then((r) => timedOut ? undefined : r);
  return Promise.race([guarded, timeout])
    .then((result) => { clearTimeout(timer); return result as T; })
    .catch((e) => {
      clearTimeout(timer);
      logger.error(`${label}: ${e instanceof Error ? e.message : String(e)}`, { component: 'SCHEDULER' });
      return undefined;
    });
}

/**
 * 마스터 스케줄러
 *
 * ┌─ 07:30 ─── Track A 장전 분석 (Gemini → GPT-4o)
 * ├─ 08:00 ─── 장세 자동 감지 → 전략 모드 전환
 * ├─ 08:50 ─── 장시작 스냅샷 + Kill Switch 리셋
 * ├─ 09:00~15:30 ── Track B 3분 간격 (Claude 실행)
 * ├─ 09:00~15:30 ── 뉴스 RSS 15분 간격 자동 수집
 * ├─ 09:00~15:30 ── 이상 감지 5분 간격
 * ├─ 09:30~15:30 ── 보유일 초과 손절 체크 매시
 * ├─ 09:00~15:30 ── 포트폴리오 스냅샷 30분 간격
 * ├─ 15:20 ─── 단타 강제 청산 (오버나잇 방지)
 * ├─ 15:40 ─── 일일 자동 리포트 (Telegram)
 * ├─ 18:00 ─── Track A 장후 분석
 * ├─ 상시 ──── Self-Healing 10분 간격
 * ├─ 18:30 ─── 자기학습 (당일 매매 패턴 분석 → 즉시 반영)
 * └─ 일요일 02:00 ── 데이터 아카이빙 (3개월 초과 삭제)
 */
export function startScheduler(): void {
  logger.info('📅 마스터 스케줄러 시작', { component: 'SCHEDULER' });

  // ═══════════════════════════════════════════
  //  장 시작 전 준비
  // ═══════════════════════════════════════════

  // 07:30 — Track A 장전 분석
  cron.schedule(
    SCHEDULE.TRACK_A_CRON[0],
    () => {
      logger.info('⏰ Track A (장전)', { component: 'SCHEDULER' });
      withTimeout('Track A 장전', () => runTrackAJob(), 300_000);
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 12:30 — Track A 점심 재분석 (장중 흐름 반영, 유일한 장중 AI 분석)
  // ⚡ 비용 최적화: 10:00/14:00 제거 → 07:30 + 12:30 + 18:00 = 3회/일
  //    Track B가 캐시된 점수로 3분 간격 실시간 대응하므로 장중 재분석 1회면 충분
  cron.schedule(
    SCHEDULE.TRACK_A_CRON[2],
    () => {
      logger.info('⏰ Track A (점심 재분석)', { component: 'SCHEDULER' });
      withTimeout('Track A 점심', () => runTrackAJob(), 300_000);
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 📊 크로스마켓 로테이션 — 하루 3회 (08:00 장전, 12:00 장중, 22:00 미국장 전)
  cron.schedule(
    '0 8,12,22 * * 1-5',
    () => {
      import('../automation/cross-market-rotation.js')
        .then(m => m.runRotationCheck())
        .catch(e => logger.error(`로테이션 체크 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 08:00 — 장세 자동 감지 → SWING/DEFENSE 자동 전환
  cron.schedule(
    '0 8 * * 1-5',
    () => {
      autoSwitchStrategy().catch((e) => logger.error(`장세 감지 실패: ${e}`, { component: 'SCHEDULER' }));
      // 뉴스 프리페치 (매크로RSS + 요약 + 유튜브 캐시 워밍 — 앱 열면 즉시 표시)
      import('../api/routes/dashboard-news.js')
        .then(m => m.prefetchAllNews())
        .catch(e => logger.error(`뉴스 프리페치 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 08:25 — 종목명 자동 보정 (장 시작 전, 깨진 이름 / 코드만 저장된 종목 정리)
  cron.schedule(
    '25 8 * * 1-5',
    () => {
      fixWatchlistNames().catch((e) => logger.error(`종목명 보정 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 08:55 — 장전 빠른 스코어링 (08:50 시장발굴 직후 — 09:00 개장 대비)
  cron.schedule(
    '55 8 * * 1-5',
    () => {
      runPreMarketQuickScore().catch((e) => logger.error(`장전 빠른 스코어링 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 08:50 — 장시작 스냅샷 + Kill Switch 리셋
  cron.schedule(
    '50 8 * * 1-5',
    async () => {
      logger.info('📸 장시작 스냅샷', { component: 'SCHEDULER' });
      await runSnapshotJob().catch((e) => logger.error(`스냅샷 실패: ${e}`, { component: 'SCHEDULER' }));

      const { isKillSwitchActive, deactivateKillSwitch, resetDailyErrorCount } = await import('../risk/kill-switch.js');
      // 국내 전용 리셋 (해외는 22:20에 별도 리셋)
      resetDailyErrorCount('KR');
      if (isKillSwitchActive('KR')) {
        logger.info('🔄 Kill Switch 자동 리셋 시도 [국내] (새 장)', { component: 'SCHEDULER' });
        await deactivateKillSwitch(false, 'KR');
      }
    },
    { timezone: MARKET.TIMEZONE },
  );

  // ═══════════════════════════════════════════
  //  장중 실시간 자동화
  // ═══════════════════════════════════════════

  // Track B 중복 실행 방지 mutex (paper → live 순차 실행)
  let _trackBRunning = false;
  let _trackBStartedAt = 0;
  const TRACK_B_MAX_MS = 960_000; // 16분
  const runTrackBSafe = () => {
    // 안전장치: 이전 실행이 TRACK_B_MAX_MS 초과 시 stuck으로 간주, 강제 리셋
    if (_trackBRunning && Date.now() - _trackBStartedAt > TRACK_B_MAX_MS + 30_000) {
      logger.error('🔧 Track B stuck 감지 — 강제 리셋', { component: 'SCHEDULER' });
      _trackBRunning = false;
    }
    if (_trackBRunning) {
      logger.warn('⏭️ Track B 이미 실행 중 — 스킵 (중복 방지)', { component: 'SCHEDULER' });
      return;
    }
    _trackBRunning = true;
    _trackBStartedAt = Date.now();
    withTimeout('Track B dual', () => runDomesticDual('Track B', runTrackBJob), TRACK_B_MAX_MS)
      .catch(e => logger.error(`Track B 실행 오류: ${e}`, { component: 'SCHEDULER' }))
      .finally(() => { _trackBRunning = false; });
  };

  // 🌅 08:55 — 개장 워밍업: 차트+시세 선행 캐시 + Gemini 사전 분석
  cron.schedule(
    '55 8 * * 1-5',
    () => {
      logger.info('🌅 개장 워밍업 시작 (08:55)', { component: 'SCHEDULER' });
      warmupOpeningBell().catch(e => logger.error(`워밍업 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // ⚡ 09:00~09:12 — 개장 초단타 전용: 2분 간격 (paper → live 이중 실행)
  cron.schedule(
    '0,2,4,6,8,10,12 9 * * 1-5',
    () => {
      runDomesticDual('개장벨', runOpeningBellCycle).catch(e => logger.error(`개장 사이클 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🔔 09:00 개장 즉시 — 기존 Track B도 병행 (SCALPING 모드 자동 강제)
  cron.schedule(
    '0 9 * * 1-5',
    () => {
      logger.info('🔔 개장 Track B 선제 실행 (09:00) — 잔고 캐시 초기화', { component: 'SCHEDULER' });
      invalidateBalanceCache(); // 장 개시 시 stale 캐시 제거 → 정산 반영된 최신 잔고 사용
      runTrackBSafe();
    },
    { timezone: MARKET.TIMEZONE },
  );

  // Track B — 장중 3분 간격 (핵심: Claude 매매 판단)
  cron.schedule(
    `*/${SCHEDULE.TRACK_B_INTERVAL_MINUTES} 9-15 * * 1-5`,
    () => { runTrackBSafe(); },
    { timezone: MARKET.TIMEZONE },
  );

  // ── 보조 모듈 (모의투자: rate limit 충돌 방지, Track B와 겹치지 않게 오프셋) ──

  // 뉴스 RSS — 30분 간격 (Track B +3분 오프셋)
  cron.schedule(
    '3,33 9-15 * * 1-5',
    () => {
      collectWatchlistNews().catch((e) => logger.error(`뉴스 수집 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 수급 분석 — 장 시작 전(08:30) + 장 마감 후(15:40) 2회만 (장중 KIS rate limit 보호)
  cron.schedule(
    '30 8 * * 1-5',
    () => { withTimeout('수급 분석 (장전)', () => analyzeWatchlistFlows(), 180_000); },
    { timezone: MARKET.TIMEZONE },
  );
  cron.schedule(
    '40 15 * * 1-5',
    () => { withTimeout('수급 분석 (장후)', () => analyzeWatchlistFlows(), 180_000); },
    { timezone: MARKET.TIMEZONE },
  );

  // DART 공시 — 60분 간격 (+7분 오프셋)
  cron.schedule(
    '7 9,10,11,12,13,14,15 * * 1-5',
    () => {
      withTimeout('DART 공시', () => monitorDisclosures(), 90_000);
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 📈 증권사 목표가 — 하루 2회 (09:30, 14:00)
  cron.schedule(
    '30 9,14 * * 1-5',
    () => {
      withTimeout('목표가 컨센서스', () => analyzeWatchlistConsensus(), 120_000);
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 📉 공매도 — 하루 2회 (10:15, 14:15)
  cron.schedule(
    '15 10,14 * * 1-5',
    () => {
      withTimeout('공매도 분석', () => analyzeWatchlistShortSelling(), 120_000);
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🌍 매크로 — 하루 2회 (08:30, 12:30)
  cron.schedule(
    '30 8,12 * * 1-5',
    () => {
      getMacroSnapshot().catch((e) => logger.error(`매크로 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 이상 감지 — 30분 간격 (+8분 오프셋, 모의투자 rate limit 대응)
  cron.schedule(
    '8,38 9-15 * * 1-5',
    () => {
      detectAnomalies().catch((e) => logger.error(`이상 감지 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 포트폴리오 헬스체크 — 30분 간격 (+12분 오프셋, paper+live 양쪽 집중도/손실 경보)
  cron.schedule(
    '12,42 9-15 * * 1-5',
    () => {
      runDomesticDual('포트폴리오헬스체크', runPortfolioHealthCheck).catch((e) => logger.error(`포트폴리오 헬스체크 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🤖 AutoPilot — 10분 간격 (AI API $0, DB만 읽어서 부담 없음)
  // 시장 레짐 + 승률 + 컨센서스 기반 자동 매매 파라미터 조절
  cron.schedule(
    '*/10 9-15 * * 1-5',
    () => {
      withTimeout('AutoPilot', () => runAutoPilotDual(), 120_000);
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 스나이퍼 — 30분 간격 (+2분 오프셋)
  cron.schedule(
    '2,32 9-15 * * 1-5',
    () => {
      withTimeout('스나이퍼', () => runSniperScan(), 300_000);
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 미체결 주문 자동 취소 — 장중 10분 간격 (Track B 3분 간격과 겹침 방지 → +5분 오프셋)
  cron.schedule(
    '5,15,25,35,45,55 9-15 * * 1-5',
    () => {
      runUnfilledOrderCheck().catch((e) => logger.error(`미체결 체크 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 보유일 손절 체크 — 장중 매시 30분 (paper → live 이중 실행)
  cron.schedule(
    '30 9-15 * * 1-5',
    () => {
      runDomesticDual('보유체크', runHoldingCheckJob).catch((e) => logger.error(`보유일 체크 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 포트폴리오 스냅샷 — 장중 30분 간격
  cron.schedule(
    '*/30 9-15 * * 1-5',
    () => {
      runSnapshotJob().catch((e) => logger.error(`스냅샷 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 💰 자금 흐름 최적화 — 장중 30분 간격 (스냅샷과 오프셋)
  cron.schedule(
    '15,45 9-15 * * 1-5',
    () => {
      analyzeCapitalFlow().catch((e) => logger.error(`자금흐름 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 점심 장세 재확인 — 12:00 (장 중간 모드 재판단)
  cron.schedule(
    '0 12 * * 1-5',
    () => {
      autoSwitchStrategy().catch((e) => logger.error(`장세 재판단 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );


  // ═══════════════════════════════════════════
  //  장 마감 후
  // ═══════════════════════════════════════════

  // 15:20 — 단타 강제 청산 (오버나잇 방지)
  cron.schedule(
    `${MARKET.FORCE_SELL_MINUTE} ${MARKET.FORCE_SELL_HOUR} * * 1-5`,
    () => {
      import('./force-close-job.js').then((m) => m.runForceCloseJob()).catch((e) => logger.error(`강제 청산 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🎰 15:15 — 종가베팅 매수 (거래대금 1,000억+ 주도주, 캔들 상단 20%)
  cron.schedule(
    '15 15 * * 1-5',
    () => {
      import('./eod-betting-job.js')
        .then(m => runDomesticDual('종가베팅', () => m.runEodBettingJob()))
        .catch(e => logger.error(`종가베팅 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🌅 09:02 — 종가베팅 익일 강제매도 (갭수익/손절, 기계적 전량 매도)
  cron.schedule(
    '2 9 * * 1-5',
    () => {
      import('./eod-betting-job.js')
        .then(m => runDomesticDual('종가베팅매도', () => m.runEodMorningSell()))
        .catch(e => logger.error(`종가베팅 매도 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 15:40 — 일일 자동 리포트 (Telegram) + 체결 캐시 정리
  cron.schedule(
    '40 15 * * 1-5',
    () => {
      generateDailyReport().catch((e) => logger.error(`리포트 실패: ${e}`, { component: 'SCHEDULER' }));
      import('../trading/executor.js').then((m) => m.tradeExecutor.clearConfirmedOrders()).catch(e => logger.warn(`체결캐시 클리어 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🌙 15:42, 15:52 — 장후 시간외 줍줍 (급락 종목 시간외 단일가 매수)
  // runDomesticDual로 감싸서 PAPER_ONLY 모드 존중
  cron.schedule(
    '42,52 15 * * 1-5',
    () => {
      runDomesticDual('시간외줍줍', () => import('./after-hours-job.js').then((m) => m.runAfterHoursJob())).catch((e) => logger.error(`시간외 줍줍 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 18:00 — Track A 장후 분석
  cron.schedule(
    SCHEDULE.TRACK_A_CRON[3],
    () => {
      logger.info('⏰ Track A (장후)', { component: 'SCHEDULER' });
      runTrackAJob().catch((e) => logger.error(`Track A 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // ═══════════════════════════════════════════
  //  상시 + 주간
  // ═══════════════════════════════════════════

  // Self-Healing — 20분 간격, 평일 장전~장후 (06~19시)
  cron.schedule(
    '*/20 6-19 * * 1-5',
    () => {
      runSelfHealing().catch((e) => logger.error(`Self-heal 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🔍 데이터 정합성 체크 — 1시간 간격 (DB 쿼리만, 외부 API 0, 비용 0)
  cron.schedule(
    '20 8-16 * * 1-5',
    () => {
      runIntegrityCheck().catch((e) => logger.error(`정합성 체크 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🍚 용돈 이관 — 평일 18:10 (오늘 수익 ≥ 10만원이면 10% 내 계좌로 이관)
  cron.schedule(
    '10 18 * * 1-5',
    () => {
      checkDinnerMoneyWithdraw().catch((e) => logger.error(`용돈 이관 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 💰 배당 자동화 — 평일 16:00 (paper+live 이중 실행: 배당금 동기화 + 배석일 경보 + DRIP)
  cron.schedule(
    '0 16 * * 1-5',
    () => {
      import('./dividend-job.js').then(m =>
        runDomesticDual('배당 자동화', () => m.runDividendJob())
      ).catch(e => logger.error(`배당 자동화 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🧠 자기학습 — 평일 18:30 (Track A 장후 분석 완료 후, 당일 매매 패턴 즉시 반영)
  cron.schedule(
    '30 18 * * 1-5',
    () => {
      runDailyLearning().catch((e) => logger.error(`자기학습 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🔄 Paper 모의자금 리필 체크 — 평일 18:45 (자기학습 직후, 자금 고갈 시 자동 리셋)
  cron.schedule(
    '45 18 * * 1-5',
    async () => {
      try {
        const { checkAndRefillPaper } = await import('../risk/paper-balance.js');
        const { checkAndRefillOverseasPaper } = await import('./overseas/state.js');
        await runWithMode(true, async () => {
          await checkAndRefillPaper();
          await checkAndRefillOverseasPaper();
        });
      } catch (e) {
        logger.error(`Paper 리필 체크 실패: ${e}`, { component: 'SCHEDULER' });
      }
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🔧 Trade Tuner — 평일 19:00 (자기학습 후 SL/TP/Hold 파라미터 자동 최적화)
  cron.schedule(
    '0 19 * * 1-5',
    () => {
      import('./overseas/trade-tuner.js')
        .then(m => m.runTradeTuner(true))
        .catch(e => logger.error(`Trade Tuner 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🎓 전략 졸업 + 강등 검사 + 성과 요약 — 평일 19:15 (Trade Tuner 후)
  cron.schedule(
    '15 19 * * 1-5',
    () => {
      import('../risk/strategy-performance.js')
        .then(m => m.logStrategyPerformanceSummary(30, true))
        .catch(e => logger.error(`전략 성과 요약 실패: ${e}`, { component: 'SCHEDULER' }));
      import('../automation/strategy-graduation.js')
        .then(m => {
          m.autoGraduate().catch(e => logger.error(`전략 졸업 검사 실패: ${e}`, { component: 'SCHEDULER' }));
          m.checkDemotion().catch(e => logger.error(`전략 강등 검사 실패: ${e}`, { component: 'SCHEDULER' }));
        })
        .catch(e => logger.error(`졸업/강등 모듈 로드 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 📈 전략 최적화기 — 평일 19:30 (자기학습 + 졸업 검사 후, TP/SL 그리드 서치)
  cron.schedule(
    '30 19 * * 1-5',
    () => {
      import('../automation/strategy-optimizer.js')
        .then(m => m.runStrategyOptimizer())
        .catch(e => logger.error(`전략 최적화 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🧪 전략 Lab 인사이트 갱신 — 평일 19:40 (최적화 후, 60일 데이터 분석)
  cron.schedule(
    '40 19 * * 1-5',
    () => {
      import('../automation/strategy-lab/insight-engine.js')
        .then(m => m.generateAndStoreInsights(60))
        .catch(e => logger.error(`전략 인사이트 갱신 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 📊 Paper 전략 토너먼트 — 장중 15분 간격 (모든 전략 동시 실행, 성과 비교)
  cron.schedule(
    '7,22,37,52 9-15 * * 1-5',
    () => {
      import('./paper-tournament.js')
        .then(m => m.runPaperTournament())
        .catch(e => logger.error(`Paper 토너먼트 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🔥 10:00 — 핫 업종 자동 워치리스트 편입 (장 초반 30분 흐름 반영)
  cron.schedule(
    '0 10 * * 1-5',
    () => {
      runHotSectorWatchlist().catch((e) => logger.error(`핫 업종 편입 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 10:05 Track A 제거 — 10:00과 5분 간격 중복. KIS API 부하 + Gemini 호출 절약

  // ═══════════════════════════════════════════
  //  🌏 해외 주식 (미국/일본/대만)
  // ═══════════════════════════════════════════

  // 🇯🇵🇹🇼 아시아 해외주식 cron 제거 — 워치리스트 전부 region:'US' (미국 ADR)
  // US 장 시간(22:30~06:00 KST)에만 매매. 아시아 시간 실행은 "종목풀 0" 낭비.

  // 🌏 아시아장 세션 캐시 초기화 — 08:50 (장 시작 전, 당일 스캔 준비)
  cron.schedule(
    '50 8 * * 1-5',
    async () => {
      const { resetAsiaSessionCache } = await import('./overseas-job.js');
      resetAsiaSessionCache();
      logger.info('🌏 아시아장 세션 캐시 초기화 (09:09 첫 스캔 준비)', { component: 'SCHEDULER' });
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🇺🇸 미국 주식 (23:30~06:30 KST)

  // 22:20 — 미국장 전 Kill Switch 리셋 + 세션 캐시 초기화
  // (서머타임: 22:30 개장 / 표준시: 23:30 개장 — 둘 다 커버하기 위해 22:20으로 앞당김)
  cron.schedule(
    '20 22 * * 1-5',
    async () => {
      const { isKillSwitchActive, deactivateKillSwitch, resetDailyErrorCount } = await import('../risk/kill-switch.js');
      // 해외 전용 리셋 (국내는 08:50에 별도 리셋)
      resetDailyErrorCount('OVERSEAS');
      if (isKillSwitchActive('OVERSEAS')) {
        logger.info('🔄 Kill Switch 자동 리셋 시도 [해외] (미국장 준비)', { component: 'SCHEDULER' });
        await deactivateKillSwitch(false, 'OVERSEAS');
      }
      // 미국장 세션 캐시 초기화 — 22:30 첫 사이클에서 전 종목 재스캔
      const { resetUSSessionCache } = await import('./overseas-job.js');
      resetUSSessionCache();
      logger.info('🇺🇸 미국장 세션 캐시 초기화 (22:30 전체 스캔 준비 — 서머타임 대응)', { component: 'SCHEDULER' });
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 미국 개장 즉시 트리거 — DST 자동 감지하여 22:30(서머) 또는 23:30(겨울) 정각 실행
  cron.schedule(
    '30 22 * * 1-5',
    async () => {
      const { isUSDST } = await import('./overseas/session.js');
      if (isUSDST()) {
        logger.info('🇺🇸 서머타임 개장 22:30 즉시 트리거', { component: 'SCHEDULER' });
        runOverseasDual().catch((e) => logger.error(`개장 트리거 실패: ${e}`, { component: 'SCHEDULER' }));
      }
    },
    { timezone: MARKET.TIMEZONE },
  );
  cron.schedule(
    '30 23 * * 1-5',
    async () => {
      const { isUSDST } = await import('./overseas/session.js');
      if (!isUSDST()) {
        logger.info('🇺🇸 겨울시간 개장 23:30 즉시 트리거', { component: 'SCHEDULER' });
        runOverseasDual().catch((e) => logger.error(`개장 트리거 실패: ${e}`, { component: 'SCHEDULER' }));
      }
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 미국 주식 분석 — 미국 장중 10분 간격 (서머타임: KST 22:30~05:00 / 표준시: 23:30~06:00)
  // 5분은 KIS rate limit(초당 거래건수) 초과 유발 → 10분이 현금 유휴 방지 + 안정성 균형점
  cron.schedule(
    '*/10 22 * * 1-5',
    () => {
      runOverseasDual().catch((e) => logger.error(`미국주식 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );
  cron.schedule(
    '*/10 23 * * 1-5',
    () => {
      runOverseasDual().catch((e) => logger.error(`미국주식 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );
  cron.schedule(
    '*/10 0-5 * * 2-6',
    () => {
      runOverseasDual().catch((e) => logger.error(`미국주식 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );
  cron.schedule(
    '*/10 6 * * 2-6',
    () => {
      runOverseasDual().catch((e) => logger.error(`미국주식 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🌙 장외시간 황금시간 — 프리마켓(18:00~22:30) + 포스트마켓(06:30~10:00) 30분 간격
  // 급락 줍줍(-3%↓) + 빅무버(+5%↑) 선점 + 보유종목 익절/손절 감시
  cron.schedule(
    '*/30 18-21 * * 1-5',
    () => {
      runOverseasDual().catch((e) => logger.error(`프리마켓 감시 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );
  cron.schedule(
    '*/30 7-9 * * 2-6',
    () => {
      runOverseasDual().catch((e) => logger.error(`포스트마켓 감시 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🎯 프리마켓 딥바이 — 미장 오픈 직후 (23:31 KST) 프리마켓 종가 -2% 지정가 대기
  cron.schedule(
    '31 23 * * 1-5',
    () => {
      import('./overseas/premarket-dip.js')
        .then(m => m.runPremarketDipBuy(true))
        .catch(e => logger.error(`딥바이 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 📈 선물 자동매매 — 미국 장중 10분 간격 (+5분 오프셋, overseas-job 충돌 방지)
  cron.schedule(
    '5,15,25,35,45,55 22-23 * * 1-5',
    () => {
      import('./futures-job.js')
        .then(m => m.runFuturesJob())
        .catch(e => logger.error(`선물 자동매매 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );
  cron.schedule(
    '5,15,25,35,45,55 0-6 * * 2-6',
    () => {
      import('./futures-job.js')
        .then(m => m.runFuturesJob())
        .catch(e => logger.error(`선물 자동매매 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🇺🇸 미국장 마감 후 미체결 주문 강제 취소 (06:35 KST)
  // 마감 후에도 PENDING 남아있으면 자본이 묶이므로 즉시 정리
  cron.schedule(
    '35 6 * * 2-6',
    async () => {
      logger.info('🇺🇸 미국장 마감 — 미체결 PENDING 주문 강제 취소 시작', { component: 'SCHEDULER' });
      const { cancelAllPendingOverseasOrders } = await import('./overseas-job.js');
      await cancelAllPendingOverseasOrders().catch((e) =>
        logger.error(`미국장 마감 미체결 취소 실패: ${e}`, { component: 'SCHEDULER' }),
      );
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🔄 KIS 관심종목 + 보유종목 동기화 — 매일 08:30, 18:30 (장 전/후)
  cron.schedule(
    '30 8,18 * * 1-5',
    async () => {
      logger.info('🔄 KIS 관심종목/보유종목 동기화', { component: 'SCHEDULER' });
      await syncInterestGroups().catch((e) => logger.error(`관심종목 동기화 실패: ${e}`, { component: 'SCHEDULER' }));
      await syncHoldingsToWatchlist().catch((e) => logger.error(`보유종목 동기화 실패: ${e}`, { component: 'SCHEDULER' }));
      // 동기화 후 즉시 이름 보정 (새로 추가된 종목의 코드→이름 변환)
      await fixWatchlistNames().catch((e) => logger.error(`종목명 보정 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 데이터 아카이빙 — 매주 월요일 02:00 (일→월 변경: 주말 Cloud SQL 중지 유지)
  cron.schedule(
    '0 2 * * 1',
    () => {
      archiveOldData().catch((e) => logger.error(`아카이빙 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 📊 비중 자동조정 — 평일 02:30 (30일 성과 기반, ≤5%p 자동적용, 큰 변동은 승인 필요)
  cron.schedule(
    '30 2 * * 1-5',
    () => {
      import('../automation/cross-market-rotation.js')
        .then(m => m.proposeAllocationRebalance())
        .catch(e => logger.error(`비중 제안 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🌙 주말 동면 — 토요일 09:00 KST: Cloud SQL 중지 + Cloud Run min=0
  cron.schedule(
    '0 9 * * 6',
    async () => {
      logger.info('🌙 주말 동면 cron 트리거', { component: 'SCHEDULER' });
      const { weekendHibernate } = await import('../utils/cloud-sql-wake.js');
      await weekendHibernate().catch(e => logger.error(`주말 동면 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // ☀️ 월요일 기상 — 06:00 KST: Cloud Run min=1 복원 (Cloud SQL은 부팅 시 자동 기상)
  cron.schedule(
    '0 6 * * 1',
    async () => {
      logger.info('☀️ 월요일 기상 cron 트리거', { component: 'SCHEDULER' });
      const { weekdayWakeUp, wakeCloudSqlIfNeeded } = await import('../utils/cloud-sql-wake.js');
      await wakeCloudSqlIfNeeded().catch(e => logger.error(`Cloud SQL 기상 실패: ${e}`, { component: 'SCHEDULER' }));
      await weekdayWakeUp().catch(e => logger.error(`Cloud Run 기상 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 서버 시작 시 1회 즉시 실행 (이름 깨진 종목 즉시 정리)
  setTimeout(() => {
    fixWatchlistNames().catch((e) => logger.error(`종목명 보정(시작시) 실패: ${e}`, { component: 'SCHEDULER' }));
  }, 10_000); // 10초 후 (DB 연결 안정화 대기)

  logger.info('✅ 스케줄러 등록 완료 (자동화 모듈 17개 + 미국주식)', { component: 'SCHEDULER' });
  logger.info(`  Track A: 07:30/12:30/18:00 (3회, 비용최적화) | Track B: ${SCHEDULE.TRACK_B_INTERVAL_MINUTES}분 | 뉴스: 15분`, { component: 'SCHEDULER' });
  logger.info('  이상감지: 30분 | 장세전환: 08:00/12:00 | 리포트: 15:40 | 🌙시간외: 15:42/52 | 🎰종가베팅: 15:15→09:02', { component: 'SCHEDULER' });
  logger.info('  🎯 스나이퍼: 15분 (수급/기술/공시 고확률 자동 진입)', { component: 'SCHEDULER' });
  logger.info('  Self-Heal: 10분 | 아카이빙: 일요일 02:00', { component: 'SCHEDULER' });
  logger.info('  🌏 해외주식: 🇯🇵🇹🇼 09:00~15:00 + 🇺🇸 23:30~06:30 10분 (기술적 지표)', { component: 'SCHEDULER' });
}
