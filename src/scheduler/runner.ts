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
import { runDailyLearning } from '../automation/self-learning.js';
import { runWatchlistRotation } from '../automation/watchlist-rotation.js';
import { runSniperScan } from '../automation/snipers/runner.js';
import { MARKET, SCHEDULE } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { runHoldingCheckJob } from './holding-check-job.js';
import { runSnapshotJob } from './snapshot-job.js';
import { runTrackAJob } from './track-a-job.js';
import { runTrackBJob } from './track-b-job.js';
import { runOverseasJob } from './overseas-job.js';
import { syncInterestGroups, syncHoldingsToWatchlist, fixWatchlistNames } from '../kis/interest-group.js';
import { parkIdleCash, unparkForTrading } from '../automation/cash-parking.js';
import { manageUsdParking } from '../automation/usd-parking.js';
import { runUnfilledOrderCheck } from './unfilled-order-job.js';

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
      runTrackAJob().catch((e) => logger.error(`Track A 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 12:00 — Track A 점심 재분석 (장중 흐름 반영)
  cron.schedule(
    '0 12 * * 1-5',
    () => {
      logger.info('⏰ Track A (점심 재분석)', { component: 'SCHEDULER' });
      runTrackAJob().catch((e) => logger.error(`Track A 점심 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 14:00 — Track A 오후 재분석 (마감 전 포지션 점검)
  cron.schedule(
    '0 14 * * 1-5',
    () => {
      logger.info('⏰ Track A (오후 재분석)', { component: 'SCHEDULER' });
      runTrackAJob().catch((e) => logger.error(`Track A 오후 실패: ${e}`, { component: 'SCHEDULER' }));
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

  // 08:45 — 장 시작 전 현금 확보 (ETF 일부 매도 → 오늘 매매 유동성)
  cron.schedule(
    '45 8 * * 1-5',
    () => {
      unparkForTrading().catch((e) => logger.error(`현금 확보 실패: ${e}`, { component: 'SCHEDULER' }));
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

  // 🔔 09:00 개장 즉시 — 초단타 선제 실행 (SCALPING 모드 자동 강제, pipeline 내부에서 처리)
  cron.schedule(
    '0 9 * * 1-5',
    () => {
      logger.info('🔔 개장 초단타 선제 실행 (09:00)', { component: 'SCHEDULER' });
      runTrackBJob().catch((e) => logger.error(`개장 초단타 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // Track B — 장중 10분 간격 (핵심: Claude 매매 판단)
  cron.schedule(
    `*/${SCHEDULE.TRACK_B_INTERVAL_MINUTES} 9-15 * * 1-5`,
    () => {
      runTrackBJob().catch((e) => logger.error(`Track B 실패: ${e}`, { component: 'SCHEDULER' }));
    },
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

  // 수급 분석 — 60분 간격 (+5분 오프셋)
  cron.schedule(
    '5 9,10,11,12,13,14,15 * * 1-5',
    () => {
      withTimeout('수급 분석', () => analyzeWatchlistFlows(), 120_000);
    },
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

  // 현금 파킹 — 매 30분 (장중 전구간, 유휴 현금 → 머니마켓 ETF)
  // 돈이 단 1분도 놀지 않도록 — Track B 5분 사이클과 겹치지 않게 +25분 오프셋
  cron.schedule(
    '25,55 9-14 * * 1-5',
    () => {
      parkIdleCash().catch((e) => logger.error(`현금 파킹 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );
  // 15:10 마지막 파킹 (15:20 강제청산 전)
  cron.schedule(
    '10 15 * * 1-5',
    () => {
      parkIdleCash().catch((e) => logger.error(`현금 파킹(15:10) 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 🇺🇸 USD 장기파킹 — 09:05 매일 (DEFENSE 10일↑ → SPY 매수 / SWING 복귀 3일↑ → SPY 매도)
  cron.schedule(
    '5 9 * * 1-5',
    () => {
      manageUsdParking().catch((e) => logger.error(`USD 파킹 실패: ${e}`, { component: 'SCHEDULER' }));
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

  // Self-Healing — 20분 간격 상시 (24/7, API 비용 절감)
  cron.schedule(
    '*/20 * * * *',
    () => {
      runSelfHealing().catch((e) => logger.error(`Self-heal 실패: ${e}`, { component: 'SCHEDULER' }));
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

  // 🔄 워치리스트 자동 순환 — 일요일 19:00 (14일 평균 40점 미만 종목 비활성화)
  cron.schedule(
    '0 19 * * 0',
    () => {
      runWatchlistRotation().catch((e) => logger.error(`워치리스트 순환 실패: ${e}`, { component: 'SCHEDULER' }));
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

  // 23:20 — 미국장 전 Kill Switch 리셋 + 세션 캐시 초기화
  cron.schedule(
    '20 23 * * 1-5',
    async () => {
      const { isKillSwitchActive, deactivateKillSwitch, resetDailyErrorCount } = await import('../risk/kill-switch.js');
      resetDailyErrorCount();
      if (isKillSwitchActive()) {
        logger.info('🔄 Kill Switch 리셋 (미국장 준비)', { component: 'SCHEDULER' });
        await deactivateKillSwitch();
      }
      // 미국장 세션 캐시 초기화 — 23:30 첫 사이클에서 전 종목 재스캔
      const { resetUSSessionCache } = await import('./overseas-job.js');
      resetUSSessionCache();
      logger.info('🇺🇸 미국장 세션 캐시 초기화 (23:30 전체 스캔 준비)', { component: 'SCHEDULER' });
    },
    { timezone: MARKET.TIMEZONE },
  );

  // 미국 주식 분석 — 미국 장중 30분 간격 (KST 23:30~06:30, API 비용 절감)
  // 23시대: 30분 / 0~5시: 매 30분 / 6시대: 0,30분
  cron.schedule(
    '30 23 * * 1-5',
    () => {
      runOverseasJob().catch((e) => logger.error(`미국주식 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );
  cron.schedule(
    '0,30 0-5 * * 2-6',
    () => {
      runOverseasJob().catch((e) => logger.error(`미국주식 실패: ${e}`, { component: 'SCHEDULER' }));
    },
    { timezone: MARKET.TIMEZONE },
  );
  cron.schedule(
    '0,30 6 * * 2-6',
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
