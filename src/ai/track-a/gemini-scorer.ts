import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../../config/index.js';
import { type ScoringResult, ScoringResultSchema } from '../../db/models.js';
import { logger } from '../../utils/logger.js';
import { buildScoringPrompt } from '../prompts/track-a-scoring.js';
import type { GeminiAnalysis } from './gemini.js';

function getGenAI(): GoogleGenerativeAI | null {
  const key = config.ai.geminiKey || process.env.GEMINI_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 10) return null;
  return new GoogleGenerativeAI(key);
}

/**
 * Gemini 2.5 Flash로 종목 스코어링 (GPT 대체 — 무료)
 * GPT-4o와 동일한 프롬프트/스키마 사용
 */
export async function runGeminiScoring(params: {
  mode: string;
  geminiAnalysis: GeminiAnalysis;
  customPrompt?: string;
}): Promise<ScoringResult[]> {
  const { mode, geminiAnalysis, customPrompt } = params;

  const genAI = getGenAI();
  if (!genAI) {
    throw new Error('Gemini API 키 미설정 — Gemini 스코어링 스킵');
  }

  const basePrompt = buildScoringPrompt(mode);
  const systemPrompt = customPrompt ? `${basePrompt}\n\n${customPrompt}` : basePrompt;

  logger.info(`Gemini 스코어링 시작 (${geminiAnalysis.stocks.length}개 종목, 모드: ${mode})`, {
    component: 'TRACK_A',
  });

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  });

  const userMessage = `## Gemini 분석 결과
시장 분위기: ${geminiAnalysis.market_sentiment}

${JSON.stringify(geminiAnalysis.stocks, null, 2)}

위 분석 결과를 바탕으로 각 종목의 점수를 산출해주세요.`;

  const result = await model.generateContent([systemPrompt, userMessage]);
  const content = result.response.text();

  try {
    const parsed = JSON.parse(content) as { scores: ScoringResult[] };

    const validScores: ScoringResult[] = [];
    for (const score of parsed.scores) {
      const zod = ScoringResultSchema.safeParse(score);
      if (zod.success) {
        validScores.push(zod.data);
      } else {
        logger.warn(`Gemini 스코어 검증 실패 (${score.stock_code}): ${zod.error.message}`, {
          component: 'TRACK_A',
        });
      }
    }

    logger.info(
      `Gemini 스코어링 완료: ${validScores.length}개 유효, ` +
        `최고점=${Math.max(...validScores.map((s) => s.composite_score))}`,
      { component: 'TRACK_A' },
    );

    return validScores;
  } catch {
    logger.error('Gemini 스코어링 JSON 파싱 실패', { component: 'TRACK_A', raw: content });
    throw new Error('Gemini 스코어링 응답이 올바른 JSON이 아닙니다');
  }
}
