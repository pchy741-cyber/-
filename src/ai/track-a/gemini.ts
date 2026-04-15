import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAuth } from 'google-auth-library';
import { config } from '../../config/index.js';
import type { DailyCandle } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { buildGeminiPrompt } from '../prompts/track-a-analysis.js';

// Gemini API Key가 있으면 Google AI SDK 사용, 없으면 Vertex AI 시도
const USE_VERTEX_AI = false; // Vertex AI 비활성화 — Google AI SDK (API Key) 사용

const VERTEX_PROJECT_ID = 'quantops-trading';
const VERTEX_LOCATION = 'us-central1';
const VERTEX_MODEL = 'gemini-2.0-flash';
const VERTEX_ENDPOINT = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_MODEL}:generateContent`;

// Lazy init — 키 변경 시 자동 반영
function getGenAI(): GoogleGenerativeAI | null {
  const key = config.ai.geminiKey || process.env.GEMINI_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 10) return null;
  return new GoogleGenerativeAI(key);
}
const auth = USE_VERTEX_AI ? new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }) : null;

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
  additionalSources?: string; // CEO가 입력한 유튜브/리포트 텍스트
  customPrompt?: string; // CEO 커스텀 프롬프트 (대시보드에서 입력)
}): Promise<GeminiAnalysis> {
  const { mode, watchlist, chartData, additionalSources, customPrompt } = params;

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

      return `${stock.stock_name}(${stock.stock_code}):
  최근 종가: ${latest?.close}, 52주 고가: ${high52w}, 고점 대비: ${dropFromHigh}%
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
    `Gemini 분석 시작 (${watchlist.length}개 종목, 모드: ${mode}, engine: ${USE_VERTEX_AI ? 'VertexAI' : 'GoogleAI'})`,
    { component: 'TRACK_A' },
  );

  const genAI = getGenAI();
  if (!genAI && !USE_VERTEX_AI) {
    throw new Error('Gemini API 키 미설정 — Track A Gemini 분석 스킵');
  }

  const responseText = USE_VERTEX_AI
    ? await callVertexAI(systemPrompt, userMessage)
    : await callGoogleAI(genAI!, systemPrompt, userMessage);

  try {
    const parsed = JSON.parse(responseText) as GeminiAnalysis;
    logger.info(`Gemini 분석 완료: market_sentiment=${parsed.market_sentiment}`, {
      component: 'TRACK_A',
    });
    return parsed;
  } catch {
    logger.error('Gemini JSON 파싱 실패', { component: 'TRACK_A', raw: responseText });
    throw new Error('Gemini 응답이 올바른 JSON이 아닙니다');
  }
}

// ── Google AI SDK 경로 (API 키 사용, 로컬/외부 환경) ──
async function callGoogleAI(genAI: GoogleGenerativeAI, systemPrompt: string, userMessage: string): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
    },
  });

  const result = await model.generateContent([systemPrompt, userMessage]);
  return result.response.text();
}

// ── Vertex AI REST 경로 (서비스 계정 사용, Cloud Run 환경) ──
async function callVertexAI(systemPrompt: string, userMessage: string): Promise<string> {
  const client = await auth!.getClient();
  const accessToken = (await client.getAccessToken()).token;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: systemPrompt }, { text: userMessage }],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
    },
  };

  const response = await fetch(VERTEX_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Vertex AI 호출 실패', {
      component: 'TRACK_A',
      status: response.status,
      error: errorText,
    });
    throw new Error(`Vertex AI API 오류 (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Vertex AI 응답에 텍스트가 없습니다');
  }
  return text;
}
