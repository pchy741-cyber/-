import { Hono } from 'hono';
import { getAiCostSummary } from '../../utils/vertex-gemini.js';

export const aiCostRoutes = new Hono();

/** GET /api/ai-cost — 오늘 AI 비용 현황 */
aiCostRoutes.get('/ai-cost', (c) => {
  return c.json(getAiCostSummary());
});
