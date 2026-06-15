import { runTrackBPipeline } from '../ai/track-b/pipeline.js';
import { logSystemEvent } from '../api/routes/health.js';
import { INVERSE_ETF_CODES } from '../automation/crash-profit.js';
import { isRiskOffToday } from '../automation/market-routing.js';
import type { StrategyMode } from '../config/constants.js';
import { getCtxIsPaper, runWithMode } from '../config/context.js';
import { getActiveStrategy, getPool } from '../db/client.js';
import { isMarketOpen } from '../kis/market.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { isKillSwitchActive, reportError, reportSuccess } from '../risk/kill-switch.js';
import { tradeExecutor } from '../trading/executor.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';
import { reportNoBuyCandidates } from './loop-mode.js';
import { isOpeningBellCompleted } from './opening-bell-job.js';

const isRunningMap = new Map<'paper' | 'live', boolean>([
  ['paper', false],
  ['live', false],
]);
const runningStartedAtMap = new Map<'paper' | 'live', number>([
  ['paper', 0],
  ['live', 0],
]);
let runGeneration = 0; // 강제 리셋 시 세대 증가 → 이전 실행의 finally가 새 실행을 종료하지 않도록
const MAX_RUNTIME_MS = 10 * 60 * 1000; // 10분 초과 시 강제 해제
const pendingRescanTimers = new Map<'paper' | 'live', ReturnType<typeof setTimeout> | null>(); // 모드별 rescan 타이머

// DB Advisory Lock ID: 'TRB_' 해시 + paper/live 분리
const TRACK_B_LOCK_BASE = 0x54524230; // 'TRB0'

export async function runTrackBJob(): Promise<void> {
  const modeKey: 'paper' | 'live' = getCtxIsPaper() ? 'paper' : 'live';

  // ── 1차 방어: 인메모리 락 (같은 인스턴스 내 동시실행 방지) ──
  if (isRunningMap.get(modeKey)) {
    const elapsed = Date.now() - (runningStartedAtMap.get(modeKey) ?? 0);
    if (elapsed < MAX_RUNTIME_MS) {
      logger.debug(`Track B 이미 실행 중 [${modeKey}] — 스킵`, { component: 'SCHEDULER' });
      return;
    }
    // 강제 리셋: 이전 실행의 finally가 새 실행을 건드리지 못하도록 세대 증가
    runGeneration++;
    logger.warn(
      `⚠️ Track B 잠금 [${modeKey}] ${Math.round(elapsed / 60000)}분 초과 → 강제 해제 (generation=${runGeneration})`,
      { component: 'SCHEDULER' },
    );
    isRunningMap.set(modeKey, false);
  }

  // 장 열림 확인
  if (!isMarketOpen()) {
    logger.debug('📉 장 닫힘 — Track B 스킵', { component: 'SCHEDULER' });
    return;
  }

  // ── 2차 방어: DB Advisory Lock (Cloud Run 다중 인스턴스 동시실행 방지) ──
  const LOCK_ID = TRACK_B_LOCK_BASE + (modeKey === 'paper' ? 1 : 0);
  let lockClient: any = null;
  try {
    lockClient = await getPool().connect();
    const { rows } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_ID]);
    if (!rows[0]?.locked) {
      lockClient.release();
      logger.info(`🔒 다른 인스턴스가 Track B[${modeKey}] 실행 중 — 스킵`, { component: 'SCHEDULER' });
      return;
    }
  } catch (lockErr) {
    // DB 연결 실패 시 인메모리 락만으로 진행 (기존 동작 유지)
    lockClient?.release();
    lockClient = null;
    logger.warn(`Advisory lock 획득 실패 [Track B ${modeKey}] — 인메모리 락으로 진행: ${(lockErr as Error).message}`, {
      component: 'SCHEDULER',
    });
  }

  logger.info('🟢 Track B 실행 시작 (장 열림 확인)', { component: 'SCHEDULER' });

  isRunningMap.set(modeKey, true);
  runningStartedAtMap.set(modeKey, Date.now());
  const myGeneration = runGeneration;

  try {
    // 1. Track B 파이프라인 실행 → 매매 판단
    const decisions = await runTrackBPipeline();
    reportNoBuyCandidates(!decisions.some((d) => d.action === 'BUY' || d.action === 'AVERAGE_DOWN'));

    // Kill Switch 활성 시 매수 차단, 매도(탈출)만 실행
    // 예외: 인버스 ETF 매수는 허용 — 하락장 킬스위치 발동 시에도 수익화 가능해야 함
    const killActive = isKillSwitchActive('KR');
    let filtered = killActive
      ? decisions.filter(
          (d) =>
            ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action) ||
            (d.action === 'BUY' && INVERSE_ETF_CODES.has(d.stock_code)),
        )
      : decisions;

    if (killActive && filtered.length < decisions.length) {
      logger.warn(
        `🛑 Kill Switch 활성 — 매수 ${decisions.length - filtered.length}건 차단, 매도 ${filtered.length}건 실행`,
        { component: 'SCHEDULER' },
      );
    }

    // Risk-Off: 신규 매수 전면 차단 (매도/청산은 허용, 인버스 ETF 매수는 예외)
    if (isRiskOffToday()) {
      const before = filtered.length;
      filtered = filtered.filter(
        (d) =>
          ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action) ||
          (d.action === 'BUY' && INVERSE_ETF_CODES.has(d.stock_code)),
      );
      if (filtered.length < before) {
        logger.info(`🚨 Risk-Off — Track B 매수 ${before - filtered.length}건 차단, 매도 ${filtered.length}건 실행`, {
          component: 'SCHEDULER',
        });
      }
    }

    // 개장벨 시간대 Track B 신규매수 양보 — Opening Bell 완료 시 09:05부터 허용
    const kstNow = getKSTNow();
    const kstH = kstNow.getUTCHours(),
      kstM = kstNow.getUTCMinutes();
    const openingBellDone = isOpeningBellCompleted();
    const blockBuyUntil = openingBellDone ? 5 : 12; // 워밍업 완료 시 09:05부터, 아니면 09:12까지 차단
    if (kstH === 9 && kstM < blockBuyUntil) {
      const before = filtered.length;
      filtered = filtered.filter((d) => d.action !== 'BUY' && d.action !== 'AVERAGE_DOWN');
      if (filtered.length < before) {
        logger.info(`⚡ 개장벨 양보: Track B 매수 ${before - filtered.length}건 스킵 (09:00~09:${String(blockBuyUntil).padStart(2, '0')} 개장벨 우선${openingBellDone ? ', 워밍업완료' : ''})`, {
          component: 'SCHEDULER',
        });
      }
    }

    const mt = modeKey === 'paper' ? 'P' : 'L';
    if (filtered.length === 0) {
      logger.info(`Track B[${mt}]: 실행할 매매 없음`, { component: 'SCHEDULER', mode: mt });
      logSystemEvent(`Track B[${mt}]`, 'success', `스캔 완료 — 매매 없음 (${decisions.length}종목 분석)`);
      reportSuccess();
      return;
    }

    // 2. 전략 모드 확인
    const strategy = await getActiveStrategy();
    const mode = (strategy?.mode ?? 'SWING') as StrategyMode;

    // 2.5. 실행 직전 Kill Switch 재확인 (파이프라인 실행 중 발동 가능)
    if (!killActive && isKillSwitchActive('KR')) {
      const before2 = filtered.length;
      filtered = filtered.filter(
        (d) =>
          ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action) ||
          (d.action === 'BUY' && INVERSE_ETF_CODES.has(d.stock_code)),
      );
      if (filtered.length < before2) {
        logger.warn(`🛑 Kill Switch 실행직전 재감지 — 추가 매수 ${before2 - filtered.length}건 긴급 차단`, { component: 'SCHEDULER' });
      }
    }

    // 3. 매매 실행
    await tradeExecutor.processDecisions(filtered, mode, 'TRACK_B');
    reportSuccess();

    // 4. 시스템 로그 + 텔레그램 알림 (HOLD 제외한 결정만)
    const actionable = decisions.filter((d) => d.action !== 'HOLD');
    if (actionable.length > 0) {
      const summary = actionable.map((d) => `${d.action} ${d.stock_code} x${d.quantity}`).join('\n');
      logSystemEvent(
        `Track B[${mt}]`,
        'success',
        actionable.map((d) => `${d.action} ${d.stock_code} ${d.quantity}주`).join(', '),
      );
      await sendTelegramMessage(`🤖 Track B[${mt}] 실행:\n${summary}`).catch(() => {});
    }

    // 5. 매도 체결 후 60초 뒤 재스캔 — 모드별 타이머 분리 (paper/live 상호 취소 방지)
    const hasSell = decisions.some((d) => d.action === 'SELL');
    if (hasSell) {
      const rescanMode: 'paper' | 'live' = getCtxIsPaper() ? 'paper' : 'live';
      const existingTimer = pendingRescanTimers.get(rescanMode);
      if (existingTimer) clearTimeout(existingTimer);
      pendingRescanTimers.set(
        rescanMode,
        setTimeout(() => {
          pendingRescanTimers.set(rescanMode, null);
          logger.info(`🔄 매도 후 재스캔 (60초, ${rescanMode})`, { component: 'SCHEDULER' });
          runWithMode(rescanMode === 'paper', () => runTrackBJob()).catch((e) => {
            logger.warn(`🔄 매도 후 재스캔 실패: ${e}`, { component: 'SCHEDULER' });
          });
        }, 60_000),
      );
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const mt = modeKey === 'paper' ? 'P' : 'L';
    await reportError('TRACK_B', msg);
    logSystemEvent(`Track B[${mt}]`, 'error', msg.slice(0, 100));
    logger.error(`Track B[${mt}] 작업 실패: ${msg}`, { component: 'SCHEDULER', mode: mt });
  } finally {
    // 내 세대가 현재 세대와 같을 때만 플래그 해제 (강제 리셋 후엔 새 실행이 이미 true)
    if (myGeneration === runGeneration) {
      isRunningMap.set(modeKey, false);
    }
    // DB Advisory Lock 해제
    if (lockClient) {
      try {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
      } catch {
        /* DB 연결 끊김 시 세션 종료로 자동 해제됨 */
      }
      lockClient.release();
    }
  }
}
