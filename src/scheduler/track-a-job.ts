import { runTrackAPipeline } from '../ai/track-a/pipeline.js';
import { refreshConsensusSignals } from '../market/consensus.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { reportError, reportSuccess } from '../risk/kill-switch.js';
import { logger } from '../utils/logger.js';

let isRunning = false;

export async function runTrackAJob(additionalSources?: string): Promise<void> {
  if (isRunning) {
    logger.warn('Track A 이미 실행 중 — 스킵', { component: 'SCHEDULER' });
    return;
  }

  isRunning = true;
  const start = Date.now();

  try {
    // 컨센서스 시그널 갱신 (4시간 캐시, Track A와 동기화)
    await refreshConsensusSignals().catch((e) => logger.warn(`컨센서스 갱신 스킵: ${e}`, { component: 'CONSENSUS' }));

    await runTrackAPipeline(additionalSources);
    reportSuccess();

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    await sendTelegramMessage(`✅ Track A 분석 완료 (${elapsed}초)`).catch(() => {});
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await reportError('TRACK_A', msg);
    await sendTelegramMessage(`❌ Track A 실패: ${msg}`).catch(() => {});
  } finally {
    isRunning = false;
  }
}
