import { Hono } from 'hono';
import { getAiCostSummary } from '../../utils/vertex-gemini.js';
import { refreshConsensusSignals, getMarketSentiment } from '../../market/consensus.js';

export const aiCostRoutes = new Hono();

/** GET /api/ai-cost — 오늘 AI 비용 현황 */
aiCostRoutes.get('/ai-cost', (c) => {
  return c.json(getAiCostSummary());
});

/** GET /api/consensus — 컨센서스 시그널 현황 */
aiCostRoutes.get('/consensus', async (c) => {
  const signals = await refreshConsensusSignals();
  const sentiment = getMarketSentiment();
  const list = [...signals.values()].sort((a, b) => b.netScore - a.netScore);
  return c.json({
    total: list.length,
    sentiment,
    bullish: list.filter(s => s.trend === 'BULLISH'),
    bearish: list.filter(s => s.trend === 'BEARISH'),
    neutral: list.filter(s => s.trend === 'NEUTRAL').length,
  });
});
