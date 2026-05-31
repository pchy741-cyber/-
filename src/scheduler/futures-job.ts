/**
 * 선물 자동매매 스케줄러 잡
 * 기능 플래그: overseas_futures (OFF by default)
 * 스케줄: 미국 장중 10분 간격 (+5분 오프셋)
 */
import { runWithMode } from '../config/context.js';
import { logger } from '../utils/logger.js';
import { loadFuturesConfig, monitorFuturesTPSL, executeFuturesEntry } from './futures/auto-executor.js';

const COMP = 'FUTURES';

export async function runFuturesJob(): Promise<void> {
  const config = await loadFuturesConfig();
  if (!config.enabled) return;
  if (config.allocatedKrw <= 0) return; // 예산 미할당

  logger.info('📈 선물 자동매매 시작', { component: COMP });

  // Paper → Live 순차 실행
  await runWithMode(true, async () => {
    try {
      await monitorFuturesTPSL();
      await executeFuturesEntry(config);
    } catch (e) {
      logger.error(`선물 paper 실패: ${e}`, { component: COMP });
    }
  });

  await runWithMode(false, async () => {
    try {
      await monitorFuturesTPSL();
      await executeFuturesEntry(config);
    } catch (e) {
      logger.error(`선물 live 실패: ${e}`, { component: COMP });
    }
  });

  logger.info('📈 선물 자동매매 완료', { component: COMP });
}
