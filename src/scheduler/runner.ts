import cron from 'node-cron';
import { detectAnomalies } from '../automation/anomaly-detector.js';
import { analyzeCapitalFlow } from '../automation/capital-flow.js';
import { generateDailyReport } from '../automation/daily-report.js';
import { analyzeWatchlistConsensus } from '../automation/analyst-consensus.js';
import { monitorDisclosures } from '../automation/dart-monitor.js';
import { checkAndReserveProfit } from '../automation/profit-withdraw.js';
import { archiveOldData } from '../automation/data-archiver.js';
import { analyzeWatchlistFlows } from '../automation/investor-flow.js';
import { getMacroSnapshot } from '../automation/macro-data.js';
import { analyzeWatchlistShortSelling } from '../automation/short-selling.js';
import { autoSwitchStrategy } from '../automation/market-regime.js';
import { collectWatchlistNews } from '../automation/news-collector.js';
import { runSelfHealing } from '../automation/self-heal.js';
import { analyzeTradeHistory } from '../automation/self-learning.js';
import { runSniperScan } from '../automation/snipers/runner.js';
import { MARKET, SCHEDULE } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { runHoldingCheckJob } from './holding-check-job.js';
import { runSnapshotJob } from './snapshot-job.js';
import { runTrackAJob } from './track-a-job.js';
import { runTrackBJob } from './track-b-job.js';
import { runOverseasJob } from './overseas-job.js';
import { runUnfilledOrderCheck } from './unfilled-order-job.js';

/**
 * 타임아웃을 적용하여 작업 실행 (지정 시간 초과 시 에러 로그 후 스킵)
 */
function withTimeout<T>(label: string, fn: () => Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return Promise.race([
    fn(),
    new Promise<undefined>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 타임아웃 (${timeoutMs / 1000}초 초과)`)), timeoutMs),
    ),
  ]).catch((e) => {
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
      runTrackAJob().catch((e) => logger.error(`Track A 실패: ${e}`, { component: 'SCHEDULER' }));
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

  // 08:50 — 장시작 스냅샷 + Kill Switch 리셋
  cron.schedule(
    '50 8 * * 1-5',
    async () => {
      logger.info('📸 장시작 스냅샷', { component: 'SCHEDULER' });
      await runSnapshotJob().catch((e) => logger.error(`스냅샷 실패: ${e}`, { component: 'SCHEDULER' }));

      const { isKillSwitchActive, deactivateKillSwitch, resetDailyErrorCount } = await import('../risk/kill-switch.js');
      resetDailyErrorCount();
      if (isKillSwitchActive()) {
        logger.info('🔄 Kill Switch 리셋 (새 장)', { component: 'SCHEDULER' });
        await deactivateKillSwitch();
      }
    },
    { timezone: MARKET.TIMEZONE },
  );

  // ═══════════════════════════════════════════
  //  장중 실시간 자동화
  // ═══════════════════════════════════════════

  // Track B — 장중 10분 간격 (핵심: Claude 매매 판단)
  cron.schedule(
    `*/${SCHEDULE.TRACK_B_INTERVAL_MINUTES} 9-15 * * 1-5`,
    () => {
      runTrackBJob().catch((e) => logger.error(`Track B 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 뉴스 RSS — 장중 15분 간격 자동 수집
  cron.schedule(
    '*/15 9-15 * * 1-5',
    () => {
      collectWatchlistNews().catch((e) => logger.error(`뉴스 수집 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 수급 분석 -- 장중 30분 간격 (2분 타임아웃)
  cron.schedule(
    '5,35 9-15 * * 1-5',
    () => {
      withTimeout('수급 분석', () => analyzeWatchlistFlows(), 120_000);
    },
    { timezone: MARKET.TIMEZONE },
  );

  // DART 공시 모니터링 -- 장중 20분 간격 (90초 타임아웃)
  cron.schedule(
    '*/20 9-16 * * 1-5',
    () => {
      withTimeout('DART 공시', () => monitorDisclosures(), 90_000);
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 📈 증권사 목표가 컨센서스 — 하루 2회 (09:30, 14:00)
  cron.schedule(
    '30 9,0 14 * * 1-5',
    () => {
      withTimeout('목표가 컨센서스', () => analyzeWatchlistConsensus(), 120_000);
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 📉 공매도 데이터 — 장중 60분 간격
  cron.schedule(
    '10 9-15 * * 1-5',
    () => {
      withTimeout('공매도 분석', () => analyzeWatchlistShortSelling(), 120_000);
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🌍 매크로 스냅샷 — 장 시작 전 + 점심 (08:30, 12:30)
  cron.schedule(
    '30 8,30 12 * * 1-5',
    () => {
      getMacroSnapshot().catch((e) => logger.error(`매크로 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 이상 감지 — 장중 5분 간격 (급등/급락/거래량 급증)
  cron.schedule(
    '*/5 9-15 * * 1-5',
    () => {
      detectAnomalies().catch((e) => logger.error(`이상 감지 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 스나이퍼 -- 장중 15분 간격 (3분 타임아웃)
  cron.schedule(
    '*/15 9-15 * * 1-5',
    () => {
      withTimeout('스나이퍼', () => runSniperScan(), 180_000);
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 미체결 주문 자동 취소 — 장중 3분 간격
  cron.schedule(
    '*/3 9-15 * * 1-5',
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

  // ═══════════════════════════════════════════
  //  장 마감 후
  // ═══════════════════════════════════════════

  // 15:20 — 단타 강제 청산 (오버나잇 방지)
  cron.schedule(
    `${MARKET.FORCE_SELL_MINUTE} ${MARKET.FORCE_SELL_HOUR} * * 1-5`,
    () => {
      import('./force-close-job.js').then((m) => m.runForceCloseJob());
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

  // 15:50 — 수익 인출 체크 (장 마감 후 수익률 평가 → 목표 도달 시 인출 예약)
  cron.schedule(
    '50 15 * * 1-5',
    () => {
      checkAndReserveProfit().catch((e) => logger.error(`수익인출 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 18:00 — Track A 장후 분석
  cron.schedule(
    SCHEDULE.TRACK_A_CRON[1],
    () => {
      logger.info('⏰ Track A (장후)', { component: 'SCHEDULER' });
      runTrackAJob().catch((e) => logger.error(`Track A 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // ═══════════════════════════════════════════
  //  상시 + 주간
  // ═══════════════════════════════════════════

  // Self-Healing — 10분 간격 상시 (24/7)
  cron.schedule(
    '*/10 * * * *',
    () => {
      runSelfHealing().catch((e) => logger.error(`Self-heal 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🧠 자기학습 — 매주 일요일 01:00 (과거 매매 패턴 분석 → 다음 주에 반영)
  cron.schedule(
    '0 1 * * 0',
    () => {
      analyzeTradeHistory().catch((e) => logger.error(`자기학습 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // ═══════════════════════════════════════════
  //  🇺🇸 미국 주식 (23:30~06:00 KST)
  // ═══════════════════════════════════════════

  // 미국 주식 분석 — 미국 장중 15분 간격 (KST 23:30~06:00)
  cron.schedule(
    '*/15 23,0-5 * * 1-5',
    () => {
      runOverseasJob().catch((e) => logger.error(`미국주식 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 미국 장 시작 시 1회 (KST 23:30)
  cron.schedule(
    '30 23 * * 1-5',
    () => {
      runOverseasJob().catch((e) => logger.error(`미국주식(장시작) 실패: ${e}`, { component: 'SCHEDULER' }));
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

  logger.info('✅ 스케줄러 등록 완료 (자동화 모듈 14개 + 미국주식)', { component: 'SCHEDULER' });
  logger.info('  Track A: 07:30/18:00 | Track B: 10분 | 뉴스: 15분', { component: 'SCHEDULER' });
  logger.info('  이상감지: 5분 | 장세전환: 08:00/12:00 | 리포트: 15:40', { component: 'SCHEDULER' });
  logger.info('  🎯 스나이퍼: 15분 (수급/기술/공시 고확률 자동 진입)', { component: 'SCHEDULER' });
  logger.info('  Self-Heal: 10분 | 아카이빙: 일요일 02:00', { component: 'SCHEDULER' });
  logger.info('  🇺🇸 미국주식: 23:30~06:00 15분 (기술적 지표)', { component: 'SCHEDULER' });
}
