/**
 * 선물 자동매매 스케줄러 잡
 * 기능 플래그: overseas_futures (OFF by default)
 * 스케줄: 미국 장중 10분 간격 (+5분 오프셋)
 */
import { runWithMode } from '../config/context.js';
import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { loadFuturesConfig, monitorFuturesTPSL, executeFuturesEntry } from './futures/auto-executor.js';

const COMP = 'FUTURES';

export async function runFuturesJob(): Promise<void> {
  const { rows: flagRows } = await getPool().query(
    "SELECT enabled FROM feature_flags WHERE key = 'overseas_futures'",
  );
  if (flagRows[0]?.enabled !== true) return;

  logger.info('📈 선물 자동매매 시작', { component: COMP });

  // Paper → Live 순차 실행 (각 모드별 config 별도 로드)
  await runWithMode(true, async () => {
    try {
      const config = await loadFuturesConfig(); // paper 예산 로드
      if (config.allocatedKrw <= 0) return;
      await monitorFuturesTPSL();
      await executeFuturesEntry(config);
    } catch (e) {
      logger.error(`선물 paper 실패: ${e}`, { component: COMP });
    }
  });

  await runWithMode(false, async () => {
    try {
      const config = await loadFuturesConfig(); // live 예산 로드
      if (config.allocatedKrw <= 0) return;
      await monitorFuturesTPSL();
      await executeFuturesEntry(config);
    } catch (e) {
      logger.error(`선물 live 실패: ${e}`, { component: COMP });
    }
  });

  logger.info('📈 선물 자동매매 완료', { component: COMP });
}
