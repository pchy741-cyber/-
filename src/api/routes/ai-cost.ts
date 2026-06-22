import { Hono } from 'hono';
import { getMarketSentiment, refreshConsensusSignals } from '../../market/consensus.js';
import { getAiCostSummary } from '../../utils/vertex-gemini.js';
import { safeQuery } from '../../db/pool.js';

const USD_KRW_RATE = 1380;

export const aiCostRoutes = new Hono();

/** GET /api/ai-cost — 오늘 AI 비용 현황 (기존 호환) */
aiCostRoutes.get('/ai-cost', (c) => {
  return c.json(getAiCostSummary());
});

/** GET /api/ai-cost/summary — 오늘 전체 모델별 요약 + 월 누적 */
aiCostRoutes.get('/ai-cost/summary', async (c) => {
  try {
    // 오늘 모델별 집계
    const todayRes = await safeQuery<{
      provider: string; model: string;
      input_tokens: string; output_tokens: string; cost_usd: string; calls: string;
    }>(
      `SELECT provider, model,
              SUM(input_tokens)::TEXT AS input_tokens,
              SUM(output_tokens)::TEXT AS output_tokens,
              SUM(cost_usd)::TEXT AS cost_usd,
              SUM(call_count)::TEXT AS calls
       FROM ai_token_usage
       WHERE created_at >= date_trunc('day', NOW())
       GROUP BY provider, model`,
    );

    const today: Record<string, { inputTokens: number; outputTokens: number; costUsd: number; calls: number }> = {};
    let todayTotalUsd = 0;
    let todayTotalCalls = 0;
    let todayTotalTokens = 0;
    for (const r of todayRes.rows) {
      const key = r.provider;
      const costUsd = parseFloat(r.cost_usd) || 0;
      const inputTokens = parseInt(r.input_tokens) || 0;
      const outputTokens = parseInt(r.output_tokens) || 0;
      const calls = parseInt(r.calls) || 0;
      if (today[key]) {
        today[key].inputTokens += inputTokens;
        today[key].outputTokens += outputTokens;
        today[key].costUsd += costUsd;
        today[key].calls += calls;
      } else {
        today[key] = { inputTokens, outputTokens, costUsd, calls };
      }
      todayTotalUsd += costUsd;
      todayTotalCalls += calls;
      todayTotalTokens += inputTokens + outputTokens;
    }

    // 이번 달 누적
    const monthRes = await safeQuery<{ total_usd: string }>(
      `SELECT COALESCE(SUM(cost_usd), 0)::TEXT AS total_usd
       FROM ai_token_usage
       WHERE created_at >= date_trunc('month', NOW())`,
    );
    const monthTotalUsd = parseFloat(monthRes.rows[0]?.total_usd ?? '0');

    // 인메모리 Gemini 데이터 병합 (DB에 아직 flush 안 된 건)
    const geminiMem = getAiCostSummary();
    if (!today['gemini'] && geminiMem.today.calls > 0) {
      today['gemini'] = {
        inputTokens: geminiMem.today.inputTokens,
        outputTokens: geminiMem.today.outputTokens,
        costUsd: geminiMem.today.estimatedCostUsd,
        calls: geminiMem.today.calls,
      };
      todayTotalUsd += geminiMem.today.estimatedCostUsd;
    }

    return c.json({
      today,
      todayTotalUsd,
      todayTotalKrw: Math.round(todayTotalUsd * USD_KRW_RATE),
      todayTotalCalls,
      todayTotalTokens,
      monthTotalUsd,
      monthTotalKrw: Math.round(monthTotalUsd * USD_KRW_RATE),
      exchangeRate: USD_KRW_RATE,
    });
  } catch (err) {
    // DB 미연결 시 인메모리 데이터만 반환
    const gemini = getAiCostSummary();
    return c.json({
      today: {
        gemini: {
          inputTokens: gemini.today.inputTokens,
          outputTokens: gemini.today.outputTokens,
          costUsd: gemini.today.estimatedCostUsd,
          calls: gemini.today.calls,
        },
      },
      todayTotalUsd: gemini.today.estimatedCostUsd,
      todayTotalKrw: Math.round(gemini.today.estimatedCostUsd * USD_KRW_RATE),
      todayTotalCalls: gemini.today.calls,
      todayTotalTokens: gemini.today.totalTokens,
      monthTotalUsd: gemini.today.estimatedCostUsd,
      monthTotalKrw: Math.round(gemini.today.estimatedCostUsd * USD_KRW_RATE),
      exchangeRate: USD_KRW_RATE,
    });
  }
});

/** GET /api/ai-cost/history?days=30 — 일별 추이 데이터 (차트용) */
aiCostRoutes.get('/ai-cost/history', async (c) => {
  const days = Math.min(parseInt(c.req.query('days') ?? '30') || 30, 90);

  try {
    const res = await safeQuery<{
      day: string; provider: string; model: string;
      input_tokens: string; output_tokens: string; cost_usd: string; calls: string;
    }>(
      `SELECT
         to_char(day, 'YYYY-MM-DD') AS day,
         provider, model,
         input_tokens::TEXT, output_tokens::TEXT, cost_usd::TEXT, calls::TEXT
       FROM ai_token_daily
       WHERE day >= NOW() - INTERVAL '1 day' * $1
       ORDER BY day`,
      [days],
    );

    // 일별로 그룹핑
    const dayMap = new Map<string, {
      providers: Record<string, { inputTokens: number; outputTokens: number; costUsd: number; calls: number }>;
      totalUsd: number;
    }>();

    for (const r of res.rows) {
      if (!dayMap.has(r.day)) {
        dayMap.set(r.day, { providers: {}, totalUsd: 0 });
      }
      const entry = dayMap.get(r.day)!;
      const costUsd = parseFloat(r.cost_usd) || 0;
      const inputTokens = parseInt(r.input_tokens) || 0;
      const outputTokens = parseInt(r.output_tokens) || 0;
      const calls = parseInt(r.calls) || 0;

      if (entry.providers[r.provider]) {
        entry.providers[r.provider].inputTokens += inputTokens;
        entry.providers[r.provider].outputTokens += outputTokens;
        entry.providers[r.provider].costUsd += costUsd;
        entry.providers[r.provider].calls += calls;
      } else {
        entry.providers[r.provider] = { inputTokens, outputTokens, costUsd, calls };
      }
      entry.totalUsd += costUsd;
    }

    const daily = [...dayMap.entries()].map(([day, data]) => ({
      day,
      providers: data.providers,
      totalUsd: data.totalUsd,
      totalKrw: Math.round(data.totalUsd * USD_KRW_RATE),
    }));

    return c.json({ daily, exchangeRate: USD_KRW_RATE });
  } catch {
    return c.json({ daily: [], exchangeRate: USD_KRW_RATE });
  }
});

/** GET /api/consensus — 컨센서스 시그널 현황 */
aiCostRoutes.get('/consensus', async (c) => {
  const signals = await refreshConsensusSignals();
  const sentiment = getMarketSentiment();
  const list = [...signals.values()].sort((a, b) => b.netScore - a.netScore);
  return c.json({
    total: list.length,
    sentiment,
    bullish: list.filter((s) => s.trend === 'BULLISH'),
    bearish: list.filter((s) => s.trend === 'BEARISH'),
    neutral: list.filter((s) => s.trend === 'NEUTRAL').length,
  });
});
