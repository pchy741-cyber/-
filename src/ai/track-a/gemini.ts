import { config } from '../../config/index.js';
import type { DailyCandle } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { buildGeminiPrompt } from '../prompts/track-a-analysis.js';

export interface GeminiAnalysis {
  market_sentiment: 'bullish' | 'neutral' | 'bearish' | 'panic';
  stocks: Array<{
    stock_code: string;
    stock_name: string;
    data_available: boolean;
    analysis: {
      key_facts: string[];
      institutional_foreign_flow: string;
      consecutive_buy_days: number;
      earnings_change_pct: number | null;
      recent_news: string[];
      support_level: number;
      resistance_level: number;
      high_52w: number;
      drop_from_high_pct: number;
      negative_factors: string[];
      positive_factors: string[];
    } | null;
  }>;
}

/**
 * Gemini 1.5 Pro로 종목 데이터 정제
 * - CEO 프롬프트 + 차트 데이터 + 추가 소스를 입력
 * - 팩트 기반 구조화된 분석 결과 출력
 */
export async function runGeminiAnalysis(params: {
  mode: string;
  watchlist: Array<{ stock_code: string; stock_name: string }>;
  chartData: Map<string, DailyCandle[]>;
  dividendData?: Map<string, number>; // 종목별 배당수익률 (%)
  additionalSources?: string; // CEO가 입력한 유튜브/리포트 텍스트
  customPrompt?: string; // CEO 커스텀 프롬프트 (대시보드에서 입력)
}): Promise<GeminiAnalysis> {
  const { mode, watchlist, chartData, dividendData, additionalSources, customPrompt } = params;

  // 기본 프롬프트 + CEO 커스텀 프롬프트 병합 (항상 기본이 베이스)
  const basePrompt = buildGeminiPrompt(mode);
  const systemPrompt = customPrompt ? `${basePrompt}\n\n${customPrompt}` : basePrompt;

  // 차트 데이터를 텍스트로 변환
  const chartSummary = watchlist
    .map((stock) => {
      const candles = chartData.get(stock.stock_code) ?? [];
      if (candles.length === 0) return `${stock.stock_name}(${stock.stock_code}): 차트 데이터 없음`;

      const latest = candles[0];
      const _oldest = candles[candles.length - 1];
      const high52w = Math.max(...candles.map((c) => c.high));
      const dropFromHigh = latest ? (((latest.close - high52w) / high52w) * 100).toFixed(1) : 'N/A';

      const dvr = dividendData?.get(stock.stock_code) ?? 0;
      const dvrText = dvr > 0 ? `, 배당수익률: ${dvr.toFixed(2)}%` : '';
      return `${stock.stock_name}(${stock.stock_code}):
  최근 종가: ${latest?.close}, 52주 고가: ${high52w}, 고점 대비: ${dropFromHigh}%${dvrText}
  최근 5일 거래량: ${candles
    .slice(0, 5)
    .map((c) => c.volume)
    .join(', ')}
  최근 5일 종가: ${candles
    .slice(0, 5)
    .map((c) => c.close)
    .join(', ')}`;
    })
    .join('\n\n');

  const userMessage = `## 감시 종목 차트 데이터
${chartSummary}

## 추가 소스 (CEO 제공)
${additionalSources ?? '추가 소스 없음'}

위 데이터를 분석하여 종목별 팩트를 추출해주세요.`;

  logger.info(
    `Gemini 분석 시작 (${watchlist.length}개 종목, 모드: ${mode}, engine: AI Studio)`,
    { component: 'TRACK_A' },
  );

  const { callVertexGemini } = await import('../../utils/vertex-gemini.js');
  const responseText = await callVertexGemini(systemPrompt, userMessage, { temperature: 0.1 });

  try {
    // Gemini가 마크다운 코드블록으로 JSON을 감쌀 수 있음 — 추출 후 파싱
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/) ?? responseText.match(/(\{[\s\S]*\})/);
    const jsonText = jsonMatch ? jsonMatch[1] ?? jsonMatch[0] : responseText;
    const parsed = JSON.parse(jsonText) as GeminiAnalysis;
    logger.info(`Gemini 분석 완료: market_sentiment=${parsed.market_sentiment}`, {
      component: 'TRACK_A',
    });
    return parsed;
  } catch {
    logger.error('Gemini JSON 파싱 실패', { component: 'TRACK_A', raw: responseText });
    throw new Error('Gemini 응답이 올바른 JSON이 아닙니다');
  }
}

