import { runTrackBPipeline } from '../ai/track-b/pipeline.js';
import type { StrategyMode } from '../config/constants.js';
import { getActiveStrategy } from '../db/client.js';
import { isMarketOpen } from '../kis/market.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { isKillSwitchActive, reportError, reportSuccess } from '../risk/kill-switch.js';
import { tradeExecutor } from '../trading/executor.js';
import { logger } from '../utils/logger.js';

let isRunning = false;

export async function runTrackBJob(): Promise<void> {
  // 동시 실행 방지
  if (isRunning) {
    logger.debug('Track B 이미 실행 중 — 스킵', { component: 'SCHEDULER' });
    return;
  }

  // Kill Switch 확인
  if (isKillSwitchActive()) {
    logger.warn('🛑 Kill Switch 활성 — Track B 스킵', { component: 'SCHEDULER' });
    return;
  }

  // 장 열림 확인
  if (!isMarketOpen()) {
    return;
  }

  isRunning = true;

  try {
    // 1. Track B 파이프라인 실행 → 매매 판단
    const decisions = await runTrackBPipeline();

    if (decisions.length === 0) {
      logger.info('Track B: 실행할 매매 없음', { component: 'SCHEDULER' });
      reportSuccess();
      return;
    }

    // 2. 전략 모드 확인
    const strategy = await getActiveStrategy();
    const mode = (strategy?.mode ?? 'SWING') as StrategyMode;

    // 3. 매매 실행
    await tradeExecutor.processDecisions(decisions, mode);
    reportSuccess();

    // 4. 텔레그램 알림 (HOLD 제외한 결정만)
    const summary = decisions.map((d) => `${d.action} ${d.stock_code} x${d.quantity}`).join('\n');
    await sendTelegramMessage(`🤖 Track B 실행:\n${summary}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await reportError('TRACK_B', msg);
    logger.error(`Track B 작업 실패: ${msg}`, { component: 'SCHEDULER' });
  } finally {
    isRunning = false;
  }
}
