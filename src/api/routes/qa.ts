import { Hono } from 'hono';
import { getLatestQAReport, getQAReports, runQAWatchdog } from '../../automation/qa-watchdog.js';
import { logger } from '../../utils/logger.js';

export const qaRoutes = new Hono();

/** 최근 QA 리포트 목록 */
qaRoutes.get('/qa/reports', (c) => {
  return c.json(getQAReports());
});

/** 최신 QA 리포트 1개 (사이드바용) */
qaRoutes.get('/qa/latest', (c) => {
  return c.json(getLatestQAReport());
});

/** 수동 QA 실행 */
qaRoutes.post('/qa/run', async (c) => {
  runQAWatchdog().catch((e) => logger.error(`QA Watchdog 실행 실패: ${e}`, { component: 'QA' }));
  return c.json({ ok: true, message: 'QA Watchdog 실행 시작' });
});
