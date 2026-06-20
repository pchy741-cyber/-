import { Hono } from 'hono';
import { analyzeTechnicals } from '../../../analysis/indicators.js';
import { fetchAnalystConsensus } from '../../../automation/analyst-consensus.js';
import { getInvestorFlow } from '../../../automation/investor-flow.js';
import { fetchShortSellingData } from '../../../automation/short-selling.js';
import { getPool } from '../../../db/client.js';
import { getDailyChart } from '../../../kis/market.js';
import { resolveRequestMode } from '../../guards/live-pin.js';

export const stockAnalysisRoutes = new Hono();

// 통합 헬퍼 사용 — viewMode/mode 양쪽 지원
const resolveViewIsPaper = resolveRequestMode;

// ── 종목 상세 분석 (기술적 지표 + 수급 + 공매도 + 목표가) ──
stockAnalysisRoutes.get('/stock/:code/analysis', async (c) => {
  const stockCode = c.req.param('code');
  const defaultResult = { technicals: null, flow: null, shorts: null, consensus: null };
  // 모의투자 모드에서는 KIS 공매도 API 미지원 (HTTP404 폭탄 방지)
  const isPaperView = resolveViewIsPaper(c);

  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  try {
    const [chart, flow, shorts, consensus] = await Promise.allSettled([
      withTimeout(getDailyChart(stockCode, 65), 6000),
      withTimeout(
        getInvestorFlow(stockCode, 5).catch(() => null),
        4000,
      ),
      isPaperView
        ? Promise.resolve(null)
        : withTimeout(
            fetchShortSellingData(stockCode, 5).catch(() => null),
            4000,
          ),
      withTimeout(
        fetchAnalystConsensus(stockCode).catch(() => null),
        4000,
      ),
    ]);

    let technicals = null;
    if (chart.status === 'fulfilled' && chart.value.length >= 20) {
      const candles = chart.value.map((c: any) => ({
        date: c.date,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
      technicals = analyzeTechnicals(candles);
    }

    return c.json({
      stockCode,
      technicals,
      flow: flow.status === 'fulfilled' ? flow.value : null,
      shorts: shorts.status === 'fulfilled' ? shorts.value : null,
      consensus: consensus.status === 'fulfilled' ? consensus.value : null,
    });
  } catch {
    return c.json({ stockCode, ...defaultResult });
  }
});

// ── 종목 5일 스코어 이력 (스파크라인용) ──
stockAnalysisRoutes.get('/stock/:code/score-history', async (c) => {
  try {
    const code = c.req.param('code');
    const { rows } = await getPool().query(
      `SELECT composite_score, created_at
         FROM ai_scores
        WHERE stock_code = $1
          AND created_at >= NOW() - INTERVAL '7 days'
        ORDER BY created_at ASC
        LIMIT 10`,
      [code],
    );
    return c.json(rows.map((r: any) => ({ score: Number(r.composite_score), ts: r.created_at })));
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── 종목 AI 점수 세부 분해 (투명성 패널) ──
stockAnalysisRoutes.get('/stock/:code/score-detail', async (c) => {
  try {
    const code = c.req.param('code');
    const { rows } = await getPool().query(
      `SELECT composite_score, fundamental_score, technical_score, sentiment_score, gemini_summary, created_at
         FROM ai_scores
        WHERE stock_code = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [code],
    );
    if (rows.length === 0) return c.json(null);
    const r = rows[0];
    return c.json({
      composite: Number(r.composite_score),
      fundamental: Number(r.fundamental_score),
      technical: Number(r.technical_score),
      sentiment: Number(r.sentiment_score),
      summary: (() => {
        const gs = r.gemini_summary;
        if (!gs) return null;
        const obj =
          typeof gs === 'string'
            ? (() => {
                try {
                  return JSON.parse(gs);
                } catch {
                  return null;
                }
              })()
            : gs;
        if (obj?.key_facts?.length > 0) return (obj.key_facts as string[]).slice(0, 3).join(' · ');
        if (typeof gs === 'string') return gs.slice(0, 200);
        return null;
      })(),
      updatedAt: r.created_at,
    });
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});
