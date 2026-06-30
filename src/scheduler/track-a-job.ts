import { runTrackAPipeline } from '../ai/track-a/pipeline.js';
import { refreshStaleNewsScores } from '../ai/track-a/rss-scorer.js';
import { getPool } from '../db/client.js';
import { refreshConsensusSignals } from '../market/consensus.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { reportError, reportSuccess } from '../risk/kill-switch.js';
import { logger } from '../utils/logger.js';

let isRunning = false;
let _runGeneration = 0;
const TRACK_A_TIMEOUT_MS = 15 * 60_000; // 15분 타임아웃 — 크래시 시 좀비 락 방지

export async function runTrackAJob(additionalSources?: string): Promise<void> {
  if (isRunning) {
    logger.warn('Track A 이미 실행 중 — 스킵', { component: 'SCHEDULER' });
    return;
  }

  isRunning = true;
  const gen = ++_runGeneration;
  const start = Date.now();

  const timeoutHandle = setTimeout(() => {
    if (_runGeneration === gen && isRunning) {
      logger.warn('Track A 타임아웃 (15분) — isRunning 강제 해제', { component: 'SCHEDULER' });
      isRunning = false;
    }
  }, TRACK_A_TIMEOUT_MS);

  try {
    // 컨센서스 시그널 갱신 (4시간 캐시, Track A와 동기화)
    await refreshConsensusSignals().catch((e) => logger.warn(`컨센서스 갱신 스킵: ${e}`, { component: 'CONSENSUS' }));

    await runTrackAPipeline(additionalSources);
    reportSuccess();

    // Track A 완료 후 뉴스 캐시 갱신 (fire-and-forget, 최대 10종목)
    getPool()
      .query<{ stock_code: string; stock_name: string }>(`SELECT stock_code, stock_name FROM watchlist WHERE is_active = true LIMIT 30`)
      .then(({ rows }) =>
        refreshStaleNewsScores(
          rows.map((r) => ({ stockCode: r.stock_code, stockName: r.stock_name })),
          10,
        ),
      )
      .then((n) => {
        if (n > 0) logger.info(`📰 Track A 완료 후 뉴스 ${n}종목 갱신`, { component: 'TRACK_A' });
      })
      .catch(() => {});

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    await sendTelegramMessage(`✅ Track A 분석 완료 (${elapsed}초)`).catch(() => {});
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await reportError('TRACK_A', msg);
    await sendTelegramMessage(`❌ Track A 실패: ${msg}`).catch(() => {});
  } finally {
    clearTimeout(timeoutHandle);
    if (_runGeneration === gen) isRunning = false;
  }
}
