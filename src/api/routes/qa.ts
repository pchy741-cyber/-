import { Hono } from 'hono';
import { getLatestQAReport, getQAReports, runQAWatchdog } from '../../automation/qa-watchdog.js';
import { logger } from '../../utils/logger.js';

export const qaRoutes = new Hono();

/** 최근 QA 리포트 목록 */
qaRoutes.get('/qa/reports', async (c) => {
  return c.json(await getQAReports());
});

/** 최신 QA 리포트 1개 (사이드바용) */
qaRoutes.get('/qa/latest', async (c) => {
  return c.json(await getLatestQAReport());
});

/** QA 건강도 통합 (QA 스코어 + copilot-lite 결합) */
qaRoutes.get('/qa/health', async (c) => {
  try {
    const [qaReport, liteResult] = await Promise.all([
      getLatestQAReport(),
      import('../../api/routes/review/copilot-lite.js')
        .then(m => m.getCopilotLiteScore(true))
        .catch(() => ({ score: 100, issues: [], actions: [] })),
    ]);
    // QA(DB 정합성) + copilot-lite(리스크) 통합 스코어
    const qaScore = qaReport?.score ?? 100;
    const liteScore = liteResult.score;
    const combinedScore = Math.max(0, Math.round((qaScore + liteScore) / 2));
    return c.json({
      score: combinedScore,
      qaScore,
      liteScore,
      qa: qaReport,
      lite: liteResult,
      status: combinedScore >= 80 ? 'pass' : combinedScore >= 50 ? 'warn' : 'fail',
    });
  } catch {
    return c.json({ score: 0, status: 'fail', error: 'Internal error' }, 500);
  }
});

/** 수동 QA 실행 */
qaRoutes.post('/qa/run', async (c) => {
  runQAWatchdog().catch((e) => logger.error(`QA Watchdog 실행 실패: ${e}`, { component: 'QA' }));
  return c.json({ ok: true, message: 'QA Watchdog 실행 시작' });
});
