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
import { logger } from '../utils/logger.js';
import { runHoldingCheckJob } from './holding-check-job.js';
import { runSnapshotJob } from './snapshot-job.js';
import { runTrackAJob } from './track-a-job.js';
import { runTrackBJob } from './track-b-job.js';
import { runOverseasJob } from './overseas-job.js';
import { syncInterestGroups, syncHoldingsToWatchlist, fixWatchlistNames } from '../kis/interest-group.js';
import { runUnfilledOrderCheck } from './unfilled-order-job.js';
import { runPreMarketQuickScore } from '../automation/pre-market-quick-score.js';
import { warmupOpeningBell, runOpeningBellCycle } from './opening-bell-job.js';
import { runHotSectorWatchlist } from '../automation/hot-sector-watchlist.js';

/**
 * 타임아웃을 적용하여 작업 실행 (지정 시간 초과 시 에러 로그 후 스킵)
 */
function withTimeout<T>(label: string, fn: () => Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 타임아웃 (${timeoutMs / 1000}초 초과)`)), timeoutMs);
  });
  return Promise.race([fn(), timeout])
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
 * ├─ 09:00~15:30 ── Track B 10분 간격 (Claude 실행)
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

  // 12:00 — Track A 점심 재분석 (장중 흐름 반영)
  cron.schedule(
    '0 12 * * 1-5',
    () => {
      logger.info('⏰ Track A (점심 재분석)', { component: 'SCHEDULER' });
      withTimeout('Track A 점심', () => runTrackAJob(), 300_000);
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 14:00 — Track A 오후 재분석 (마감 전 포지션 점검)
  cron.schedule(
    '0 14 * * 1-5',
    () => {
      logger.info('⏰ Track A (오후 재분석)', { component: 'SCHEDULER' });
      withTimeout('Track A 오후', () => runTrackAJob(), 300_000);
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 08:00 — 장세 자동 감지 → SWING/DEFENSE 자동 전환
  cron.schedule(
    '0 8 * * 1-5',
    () => {
      autoSwitchStrategy().catch((e) => logger.error(`장세 감지 실패: ${e}`, { component: 'SCHEDULER' }));
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
      resetDailyErrorCount();
      if (isKillSwitchActive()) {
        logger.info('🔄 Kill Switch 자동 리셋 시도 (새 장)', { component: 'SCHEDULER' });
        await deactivateKillSwitch(false); // 수동 발동 중이면 내부에서 거부됨
      }
    },
    { timezone: MARKET.TIMEZONE },
  );

  // ═══════════════════════════════════════════
  //  장중 실시간 자동화
  // ═══════════════════════════════════════════

  // Track B 중복 실행 방지 mutex
  let _trackBRunning = false;
  const runTrackBSafe = () => {
    if (_trackBRunning) {
      logger.warn('⏭️ Track B 이미 실행 중 — 스킵 (중복 방지)', { component: 'SCHEDULER' });
      return;
    }
    _trackBRunning = true;
    withTimeout('Track B', () => runTrackBJob(), 480_000)
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

  // ⚡ 09:00~09:10 — 개장 초단타 전용: 1분 간격 (캐시 차트 + Gemini 실시간 판단)
  cron.schedule(
    '0,1,2,3,4,5,6,7,8,9,10,11,12 9 * * 1-5',
    () => {
      runOpeningBellCycle().catch(e => logger.error(`개장 사이클 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🔔 09:00 개장 즉시 — 기존 Track B도 병행 (SCALPING 모드 자동 강제)
  cron.schedule(
    '0 9 * * 1-5',
    () => {
      logger.info('🔔 개장 Track B 선제 실행 (09:00)', { component: 'SCHEDULER' });
      runTrackBSafe();
    },
    { timezone: MARKET.TIMEZONE },
  );

  // Track B — 장중 10분 간격 (핵심: Claude 매매 판단)
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

  // 스나이퍼 — 30분 간격 (+2분 오프셋)
  cron.schedule(
    '2,32 9-15 * * 1-5',
    () => {
      withTimeout('스나이퍼', () => runSniperScan(), 180_000);
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 미체결 주문 자동 취소 — 장중 10분 간격 (Track B :00,:10... 과 겹침 방지 → +5분 오프셋)
  cron.schedule(
    '5,15,25,35,45,55 9-15 * * 1-5',
    () => {
      runUnfilledOrderCheck().catch((e) => logger.error(`미체결 체크 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 보유일 손절 체크 — 장중 매시 30분
  cron.schedule(
    '30 9-15 * * 1-5',
    () => {
      runHoldingCheckJob().catch((e) => logger.error(`보유일 체크 실패: ${e}`, { component: 'SCHEDULER' }));
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

  // 12:05 — Track A 장중 분석 (오전장 결과 반영, 오후 매매 판단 업데이트)
  cron.schedule(
    '5 12 * * 1-5',
    () => {
      logger.info('⏰ Track A (장중)', { component: 'SCHEDULER' });
      runTrackAJob().catch((e) => logger.error(`Track A 실패: ${e}`, { component: 'SCHEDULER' }));
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

  // 15:40 — 일일 자동 리포트 (Telegram)
  cron.schedule(
    '40 15 * * 1-5',
    () => {
      generateDailyReport().catch((e) => logger.error(`리포트 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 18:00 — Track A 장후 분석
  cron.schedule(
    SCHEDULE.TRACK_A_CRON[2],
    () => {
      logger.info('⏰ Track A (장후)', { component: 'SCHEDULER' });
      runTrackAJob().catch((e) => logger.error(`Track A 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // ═══════════════════════════════════════════
  //  상시 + 주간
  // ═══════════════════════════════════════════

  // Self-Healing — 20분 간격 상시 (24/7, API 비용 절감)
  cron.schedule(
    '*/20 * * * *',
    () => {
      runSelfHealing().catch((e) => logger.error(`Self-heal 실패: ${e}`, { component: 'SCHEDULER' }));
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

  // 🧠 자기학습 — 평일 18:30 (Track A 장후 분석 완료 후, 당일 매매 패턴 즉시 반영)
  cron.schedule(
    '30 18 * * 1-5',
    () => {
      runDailyLearning().catch((e) => logger.error(`자기학습 실패: ${e}`, { component: 'SCHEDULER' }));
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

  // ═══════════════════════════════════════════
  //  🌏 해외 주식 (미국/일본/대만)
  // ═══════════════════════════════════════════

  // 🇯🇵 일본(KST 09:00~15:30) + 🇹🇼 대만(KST 10:00~14:30) — 30분 간격 (+9분 오프셋)
  // 일본 오전장(09~11:30) + 오후장(12:30~15:30), 대만(10~14:30) 통합 커버
  cron.schedule(
    '9,39 9-15 * * 1-5',
    () => {
      runOverseasJob().catch((e) => logger.error(`아시아주식 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

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
      resetDailyErrorCount();
      if (isKillSwitchActive()) {
        logger.info('🔄 Kill Switch 자동 리셋 시도 (미국장 준비)', { component: 'SCHEDULER' });
        await deactivateKillSwitch(false); // 수동 발동 중이면 내부에서 거부됨
      }
      // 미국장 세션 캐시 초기화 — 22:30 첫 사이클에서 전 종목 재스캔
      const { resetUSSessionCache } = await import('./overseas-job.js');
      resetUSSessionCache();
      logger.info('🇺🇸 미국장 세션 캐시 초기화 (22:30 전체 스캔 준비 — 서머타임 대응)', { component: 'SCHEDULER' });
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 미국 주식 분석 — 미국 장중 15분 간격 (서머타임: KST 22:30~05:00 / 표준시: 23:30~06:00)
  // 22시대: 15분 / 23~5시: 매 15분 / 6시대: 0,15,30,45분 (표준시 보정)
  cron.schedule(
    '0,15,30,45 22 * * 1-5',
    () => {
      runOverseasJob().catch((e) => logger.error(`미국주식 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );
  cron.schedule(
    '0,15,30,45 23 * * 1-5',
    () => {
      runOverseasJob().catch((e) => logger.error(`미국주식 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );
  cron.schedule(
    '0,15,30,45 0-5 * * 2-6',
    () => {
      runOverseasJob().catch((e) => logger.error(`미국주식 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );
  cron.schedule(
    '0,15,30,45 6 * * 2-6',
    () => {
      runOverseasJob().catch((e) => logger.error(`미국주식 실패: ${e}`, { component: 'SCHEDULER' }));
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

  // 데이터 아카이빙 — 매주 일요일 02:00
  cron.schedule(
    '0 2 * * 0',
    () => {
      archiveOldData().catch((e) => logger.error(`아카이빙 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 서버 시작 시 1회 즉시 실행 (이름 깨진 종목 즉시 정리)
  setTimeout(() => {
    fixWatchlistNames().catch((e) => logger.error(`종목명 보정(시작시) 실패: ${e}`, { component: 'SCHEDULER' }));
  }, 10_000); // 10초 후 (DB 연결 안정화 대기)

  logger.info('✅ 스케줄러 등록 완료 (자동화 모듈 14개 + 미국주식)', { component: 'SCHEDULER' });
  logger.info('  Track A: 07:30/18:00 | Track B: 10분 | 뉴스: 15분', { component: 'SCHEDULER' });
  logger.info('  이상감지: 5분 | 장세전환: 08:00/12:00 | 리포트: 15:40', { component: 'SCHEDULER' });
  logger.info('  🎯 스나이퍼: 15분 (수급/기술/공시 고확률 자동 진입)', { component: 'SCHEDULER' });
  logger.info('  Self-Heal: 10분 | 아카이빙: 일요일 02:00', { component: 'SCHEDULER' });
  logger.info('  🌏 해외주식: 🇯🇵🇹🇼 09:00~15:00 + 🇺🇸 23:30~06:30 15분 (기술적 지표)', { component: 'SCHEDULER' });
}
