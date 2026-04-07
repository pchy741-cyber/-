import OpenAI from 'openai';
import { config } from '../../config/index.js';
import { type ScoringResult, ScoringResultSchema } from '../../db/models.js';
import { logger } from '../../utils/logger.js';
import { buildScoringPrompt } from '../prompts/track-a-scoring.js';
import type { GeminiAnalysis } from './gemini.js';

const hasOpenAIKey = config.ai.openaiKey && !config.ai.openaiKey.startsWith('your_');
const openai = hasOpenAIKey ? new OpenAI({ apiKey: config.ai.openaiKey }) : null;

interface ScoringOutput {
  scores: ScoringResult[];
}

/**
 * GPT-4o로 종목 스코어링
 * - Gemini 분석 결과를 입력받아 종목별 점수 산출
 * - Structured Output (JSON Mode) 활용
 */
export async function runGPTScoring(params: {
  mode: string;
  geminiAnalysis: GeminiAnalysis;
  customPrompt?: string;
}): Promise<ScoringResult[]> {
  const { mode, geminiAnalysis, customPrompt } = params;

  const basePrompt = buildScoringPrompt(mode);
  const systemPrompt = customPrompt ? `${basePrompt}\n\n${customPrompt}` : basePrompt;

  if (!openai) {
    throw new Error('OpenAI API 키 미설정 — GPT 스코어링 스킵');
  }

  logger.info(`GPT-4o 스코어링 시작 (${geminiAnalysis.stocks.length}개 종목, 모드: ${mode})`, {
    component: 'TRACK_A',
  });

  // OpenAI Structured Output — JSON Schema 강제 (2025 최신)
  // json_object보다 강력: 스키마 위반 시 API가 자동 재생성
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-2024-11-20',
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'stock_scoring',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            scores: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  stock_code: { type: 'string' },
                  stock_name: { type: 'string' },
                  composite_score: { type: 'number' },
                  fundamental_score: { type: 'number' },
                  technical_score: { type: 'number' },
                  sentiment_score: { type: 'number' },
                  confidence: { type: 'number' },
                  signal: { type: 'string', enum: ['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL', 'NO_DATA'] },
                  target_price: { type: 'number' },
                  stop_loss_price: { type: 'number' },
                  reasoning: { type: 'string' },
                },
                required: [
                  'stock_code',
                  'stock_name',
                  'composite_score',
                  'fundamental_score',
                  'technical_score',
                  'sentiment_score',
                  'confidence',
                  'signal',
                  'target_price',
                  'stop_loss_price',
                  'reasoning',
                ],
                additionalProperties: false,
              },
            },
          },
          required: ['scores'],
          additionalProperties: false,
        },
      },
    },
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `## Gemini 분석 결과
시장 분위기: ${geminiAnalysis.market_sentiment}

${JSON.stringify(geminiAnalysis.stocks, null, 2)}

위 분석 결과를 바탕으로 각 종목의 점수를 산출해주세요.`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('GPT-4o 응답이 비어있습니다');
  }

  try {
    const parsed = JSON.parse(content) as ScoringOutput;

    // Zod로 각 스코어 검증
    const validScores: ScoringResult[] = [];
    for (const score of parsed.scores) {
      const result = ScoringResultSchema.safeParse(score);
      if (result.success) {
        validScores.push(result.data);
      } else {
        logger.warn(`스코어 검증 실패 (${score.stock_code}): ${result.error.message}`, {
          component: 'TRACK_A',
        });
      }
    }

    logger.info(
      `GPT-4o 스코어링 완료: ${validScores.length}개 유효, ` +
        `최고점=${Math.max(...validScores.map((s) => s.composite_score))}`,
      { component: 'TRACK_A' },
    );

    return validScores;
  } catch {
    logger.error('GPT-4o JSON 파싱 실패', { component: 'TRACK_A', raw: content });
    throw new Error('GPT-4o 응답이 올바른 JSON이 아닙니다');
  }
}
