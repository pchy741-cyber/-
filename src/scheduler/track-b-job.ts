import { runTrackBPipeline } from '../ai/track-b/pipeline.js';
import type { StrategyMode } from '../config/constants.js';
import { getActiveStrategy } from '../db/client.js';
import { isMarketOpen } from '../kis/market.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { isKillSwitchActive, reportError, reportSuccess } from '../risk/kill-switch.js';
import { tradeExecutor } from '../trading/executor.js';
import { logger } from '../utils/logger.js';

let isRunning = false;
let runningStartedAt = 0;
let runGeneration = 0; // 강제 리셋 시 세대 증가 → 이전 실행의 finally가 새 실행을 종료하지 않도록
const MAX_RUNTIME_MS = 10 * 60 * 1000; // 10분 초과 시 강제 해제

export async function runTrackBJob(): Promise<void> {
  // 동시 실행 방지 — 단, 10분 초과 시 강제 리셋 (API hang 방지)
  if (isRunning) {
    const elapsed = Date.now() - runningStartedAt;
    if (elapsed < MAX_RUNTIME_MS) {
      logger.debug('Track B 이미 실행 중 — 스킵', { component: 'SCHEDULER' });
      return;
    }
    // 강제 리셋: 이전 실행의 finally가 새 실행을 건드리지 못하도록 세대 증가
    runGeneration++;
    logger.warn(`⚠️ Track B 잠금 ${Math.round(elapsed / 60000)}분 초과 → 강제 해제 (generation=${runGeneration})`, { component: 'SCHEDULER' });
    isRunning = false;
  }

  // 장 열림 확인
  if (!isMarketOpen()) {
    logger.debug('📉 장 닫힘 — Track B 스킵', { component: 'SCHEDULER' });
    return;
  }

  logger.info('🟢 Track B 실행 시작 (장 열림 확인)', { component: 'SCHEDULER' });

  isRunning = true;
  runningStartedAt = Date.now();
  const myGeneration = runGeneration;

  try {
    // 1. Track B 파이프라인 실행 → 매매 판단
    const decisions = await runTrackBPipeline();

    // Kill Switch 활성 시 매수 차단, 매도(탈출)만 실행
    const killActive = isKillSwitchActive('KR');
    const filtered = killActive
      ? decisions.filter((d) => ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action))
      : decisions;

    if (killActive && filtered.length < decisions.length) {
      logger.warn(`🛑 Kill Switch 활성 — 매수 ${decisions.length - filtered.length}건 차단, 매도 ${filtered.length}건 실행`, { component: 'SCHEDULER' });
    }

    if (filtered.length === 0) {
      logger.info('Track B: 실행할 매매 없음', { component: 'SCHEDULER' });
      reportSuccess();
      return;
    }

    // 2. 전략 모드 확인
    const strategy = await getActiveStrategy();
    const mode = (strategy?.mode ?? 'SWING') as StrategyMode;

    // 3. 매매 실행
    await tradeExecutor.processDecisions(filtered, mode);
    reportSuccess();

    // 4. 텔레그램 알림 (HOLD 제외한 결정만)
    const actionable = decisions.filter((d) => d.action !== 'HOLD');
    if (actionable.length > 0) {
      const summary = actionable.map((d) => `${d.action} ${d.stock_code} x${d.quantity}`).join('\n');
      await sendTelegramMessage(`🤖 Track B 실행:\n${summary}`).catch(() => {});
    }

    // 5. 매도 체결 후 60초 뒤 즉시 재스캔 (해방된 현금으로 바로 매수 기회 포착)
    const hasSell = decisions.some((d) => d.action === 'SELL');
    if (hasSell) {
      setTimeout(() => {
        logger.info('🔄 매도 후 즉시 재스캔 (60초)', { component: 'SCHEDULER' });
        runTrackBJob().catch(() => {});
      }, 60_000);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await reportError('TRACK_B', msg);
    logger.error(`Track B 작업 실패: ${msg}`, { component: 'SCHEDULER' });
  } finally {
    // 내 세대가 현재 세대와 같을 때만 플래그 해제 (강제 리셋 후엔 새 실행이 이미 isRunning=true)
    if (myGeneration === runGeneration) {
      isRunning = false;
    }
  }
}
