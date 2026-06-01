import { z } from 'zod';
import { type ScoringResult, ScoringResultSchema } from '../../db/models.js';
import { safeParseScoresJson } from '../../utils/json-repair.js';
import { logger } from '../../utils/logger.js';
import { callVertexGemini } from '../../utils/vertex-gemini.js';
import { buildScoringPrompt, type RegimeHint } from '../prompts/track-a-scoring.js';
import type { GeminiAnalysis } from './gemini.js';

// Gemini 스코어링 응답의 최상위 구조에 대한 스키마 정의
const GeminiScoringResponseSchema = z.object({
  // scores 배열의 각 항목은 우선 unknown으로 파싱 후 개별적으로 검증
  scores: z.array(z.unknown()),
});

/**
 * Vertex AI Gemini로 종목 스코어링 (GPT 대체)
 */
export async function runGeminiScoring(params: {
  mode: string;
  geminiAnalysis: GeminiAnalysis;
  customPrompt?: string;
  regimeHint?: RegimeHint;
}): Promise<ScoringResult[]> {
  const { mode, geminiAnalysis, customPrompt, regimeHint } = params;

  const basePrompt = buildScoringPrompt(mode, regimeHint);
  const systemPrompt = customPrompt ? `${basePrompt}\n\n${customPrompt}` : basePrompt;

  logger.info(`Gemini 스코어링 시작 (${geminiAnalysis.stocks.length}개 종목, 모드: ${mode})`, {
    component: 'TRACK_A',
  });

  const userMessage = `## Gemini 분석 결과
시장 분위기: ${geminiAnalysis.market_sentiment}

${JSON.stringify(geminiAnalysis.stocks, null, 2)}

위 분석 결과를 바탕으로 각 종목의 점수를 산출해주세요.`;

  const content = await callVertexGemini(systemPrompt, userMessage, { temperature: 0.2 });

  // Resilient JSON parsing — 잘린 응답에서도 개별 스코어 복구
  const parsedResponse = safeParseScoresJson(content, 'GeminiScoring');

  if (!parsedResponse || parsedResponse.scores.length === 0) {
    logger.warn('Gemini 스코어링 응답에서 스코어를 추출할 수 없음 — 빈 배열 반환', {
      component: 'TRACK_A',
      rawLength: content.length,
      rawPreview: content.slice(0, 500),
    });
    return []; // throw 대신 빈 배열 반환 — 파이프라인이 폴백으로 진행
  }

  // 각 개별 스코어 객체 검증 (Zod)
  const validScores: ScoringResult[] = [];
  for (const score of parsedResponse.scores) {
    const zod = ScoringResultSchema.safeParse(score);
    if (zod.success) {
      if (zod.data.signal !== 'NO_DATA') {
        validScores.push(zod.data);
      } else {
        const stockCode = typeof score === 'object' && score !== null && 'stock_code' in score ? String((score as any).stock_code) : 'UNKNOWN';
        logger.info(`Gemini 스코어 NO_DATA 제외 (${stockCode}): 데이터 부족 신호`, {
          component: 'TRACK_A',
        });
      }
    } else {
      const stockCode = typeof score === 'object' && score !== null && 'stock_code' in score ? String((score as any).stock_code) : 'UNKNOWN';
      logger.warn(`Gemini 스코어 검증 실패 (${stockCode}): ${zod.error?.message}`, {
        component: 'TRACK_A',
        invalidData: score,
      });
    }
  }

  const maxScore = validScores.length > 0 ? Math.max(...validScores.map((s) => s.composite_score)) : 0;

  logger.info(
    `Gemini 스코어링 완료: ${validScores.length}/${parsedResponse.scores.length}개 유효, 최고점=${maxScore}`,
    { component: 'TRACK_A' },
  );

  return validScores;
}
