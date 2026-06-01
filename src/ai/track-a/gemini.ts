import { config } from '../../config/index.js';
import type { DailyCandle } from '../../kis/market.js';
import { safeParseJson } from '../../utils/json-repair.js';
import { logger } from '../../utils/logger.js';
import { buildGeminiPrompt } from '../prompts/track-a-analysis.js';
import { analyzeTechnicals } from '../../analysis/indicators.js';

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

      // 눌림목 신호: MA 이탈 후 반등 (최적 진입 타이밍 확인)
      const tech = candles.length >= 30 ? analyzeTechnicals(candles) : null;
      const pullbackStr = tech?.pullbackSignal ? '눌림목_확인=true' : '눌림목_확인=false';
      const rsiStr = tech ? ` RSI=${tech.rsi14.toFixed(0)}` : '';
      const volStr = tech ? ` 거래량비율=${tech.volumeRatio.toFixed(1)}x` : '';

      return `${stock.stock_name}(${stock.stock_code}):
  최근 종가: ${latest?.close}, 52주 고가: ${high52w}, 고점 대비: ${dropFromHigh}%${dvrText}
  ${pullbackStr}${rsiStr}${volStr}
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

  // Resilient JSON parsing — Gemini 응답이 깨져도 최대한 복구
  const parsed = safeParseJson<GeminiAnalysis>(responseText, 'GeminiAnalysis');

  if (parsed && parsed.market_sentiment && Array.isArray(parsed.stocks)) {
    logger.info(`Gemini 분석 완료: market_sentiment=${parsed.market_sentiment}, stocks=${parsed.stocks.length}개`, {
      component: 'TRACK_A',
    });
    return parsed;
  }

  // Partial recovery: JSON은 파싱됐지만 구조가 불완전한 경우
  if (parsed && typeof parsed === 'object') {
    const recovered: GeminiAnalysis = {
      market_sentiment: (parsed as any).market_sentiment ?? 'neutral',
      stocks: Array.isArray((parsed as any).stocks) ? (parsed as any).stocks : [],
    };
    if (recovered.stocks.length > 0) {
      logger.warn(`Gemini 분석 부분 복구: market_sentiment=${recovered.market_sentiment}, stocks=${recovered.stocks.length}개`, {
        component: 'TRACK_A',
      });
      return recovered;
    }
  }

  // 완전 실패 시 빈 분석 결과 반환 (throw 하지 않음 — 파이프라인 계속 진행)
  logger.error('Gemini JSON 파싱 실패 — 빈 분석 결과로 계속 진행', {
    component: 'TRACK_A',
    rawLength: responseText.length,
    rawPreview: responseText.slice(0, 500),
  });
  return {
    market_sentiment: 'neutral',
    stocks: watchlist.map((w) => ({
      stock_code: w.stock_code,
      stock_name: w.stock_name,
      data_available: false,
      analysis: null,
    })),
  };
}

