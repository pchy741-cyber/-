/**
 * GPT-4o Track A 스코어러
 * 앙상블 모드에서 병렬 실행되는 독립 스코어러
 * OPENAI_API_KEY 미설정 시 자동 스킵 (에러 아님)
 */
import OpenAI from 'openai';
import type { ScoringResult } from '../../db/models.js';
import type { DailyCandle } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { buildScoringPrompt, type RegimeHint } from '../prompts/track-a-scoring.js';

const COMP = 'TRACK_A_GPT';
const MODEL = 'o3'; // Track A 2차 검증 — 고품질 추론
const BATCH_SIZE = 15; // o3 토큰 절약: 배치 크기 절반

interface WatchlistItem {
  stock_code: string;
  stock_name: string;
}

/** 차트 데이터를 토큰 절약형 텍스트로 변환 */
function buildChartSummary(batch: WatchlistItem[], chartData: Map<string, DailyCandle[]>): string {
  return batch
    .map((w) => {
      const candles = chartData.get(w.stock_code) ?? [];
      if (candles.length < 5) return `${w.stock_code}(${w.stock_name}): 데이터부족`;
      const recent = candles.slice(0, 10); // 최근 10일 (candles[0] = 최신)
      const latest = recent[0];
      const prev5 = recent[Math.min(4, recent.length - 1)];
      const change5d = prev5.close > 0 ? (((latest.close - prev5.close) / prev5.close) * 100).toFixed(1) : '?';
      const avgVol = recent.slice(1).reduce((a, c) => a + c.volume, 0) / Math.max(1, recent.length - 1);
      const volRatio = avgVol > 0 ? (latest.volume / avgVol).toFixed(1) : '?';
      const high = Math.max(...candles.slice(0, 30).map((c) => c.high));
      const dropPct = high > 0 ? (((latest.close - high) / high) * 100).toFixed(1) : '?';
      return `${w.stock_code}(${w.stock_name}): 현재가${latest.close.toLocaleString()} 5일${change5d}% 고점대비${dropPct}% 거래량${volRatio}x 5일종가:${recent
        .slice(0, 5)
        .map((c) => c.close)
        .join(',')}`;
    })
    .join('\n');
}

export async function runGPTScoring(
  mode: string,
  watchlist: WatchlistItem[],
  chartData: Map<string, DailyCandle[]>,
  regimeHint?: RegimeHint,
): Promise<ScoringResult[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.info('GPT 스코어러 스킵: OPENAI_API_KEY 미설정', { component: COMP });
    return [];
  }

  const client = new OpenAI({ apiKey, timeout: 60_000 });
  const systemPrompt = buildScoringPrompt(mode, regimeHint);
  const results: ScoringResult[] = [];

  for (let i = 0; i < watchlist.length; i += BATCH_SIZE) {
    const batch = watchlist.slice(i, i + BATCH_SIZE);
    const chartSummary = buildChartSummary(batch, chartData);

    const userMessage = `## 차트 데이터 (${batch.length}개 종목, 모드: ${mode})
${chartSummary}

위 데이터를 바탕으로 각 종목의 점수를 산출해주세요.`;

    try {
      const res = await client.chat.completions.create({
        model: MODEL,
        max_completion_tokens: 4096, // o3: max_completion_tokens 사용 (temperature 미지원)
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      });

      const text = res.choices[0]?.message?.content ?? '';
      // JSON 추출 (코드블록 or 직접 JSON)
      const jsonMatch = text.match(/\{[\s\S]*"scores"\s*:\s*\[[\s\S]*\]\s*\}/);
      if (!jsonMatch) {
        logger.warn(`GPT 배치 ${i + 1} JSON 파싱 실패`, { component: COMP, rawPreview: text.slice(0, 200) });
        continue;
      }

      const parsed = JSON.parse(jsonMatch[0]) as { scores: Array<Record<string, unknown>> };
      for (const item of parsed.scores) {
        const code = String(item.stock_code ?? '');
        if (!batch.some((w) => w.stock_code === code)) continue;
        const signal = String(item.signal ?? 'HOLD');
        const validSignals = ['BUY', 'SELL', 'HOLD', 'STRONG_BUY', 'STRONG_SELL', 'NO_DATA'];
        if (signal === 'NO_DATA') continue;

        results.push({
          stock_code: code,
          composite_score: Math.max(0, Math.min(100, Math.round(Number(item.composite_score ?? 50)))),
          fundamental_score: Math.max(0, Math.min(100, Math.round(Number(item.fundamental_score ?? 50)))),
          technical_score: Math.max(0, Math.min(100, Math.round(Number(item.technical_score ?? 50)))),
          sentiment_score: Math.max(0, Math.min(100, Math.round(Number(item.sentiment_score ?? 50)))),
          signal: (validSignals.includes(signal) ? signal : 'HOLD') as ScoringResult['signal'],
          confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.6))),
          reasoning: `[GPT] ${String(item.reasoning ?? '').slice(0, 200)}`,
          target_price: item.target_price != null ? Number(item.target_price) : undefined,
          stop_loss_price: item.stop_loss_price != null ? Number(item.stop_loss_price) : undefined,
        });
      }

      logger.info(`GPT 배치 ${Math.floor(i / BATCH_SIZE) + 1}: ${parsed.scores.length}개 스코어`, { component: COMP });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`GPT 배치 ${Math.floor(i / BATCH_SIZE) + 1} 실패: ${msg.slice(0, 150)}`, { component: COMP });
    }
  }

  logger.info(`GPT Track A 완료: ${results.length}개 스코어`, { component: COMP });
  return results;
}
