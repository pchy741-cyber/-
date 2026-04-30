import { z } from 'zod';
import { type ScoringResult, ScoringResultSchema } from '../../db/models.js';
import { logger } from '../../utils/logger.js';
import { callVertexGemini } from '../../utils/vertex-gemini.js';
import { buildScoringPrompt } from '../prompts/track-a-scoring.js';
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
}): Promise<ScoringResult[]> {
  const { mode, geminiAnalysis, customPrompt } = params;

  const basePrompt = buildScoringPrompt(mode);
  const systemPrompt = customPrompt ? `${basePrompt}\n\n${customPrompt}` : basePrompt;

  logger.info(`Gemini 스코어링 시작 (${geminiAnalysis.stocks.length}개 종목, 모드: ${mode})`, {
    component: 'TRACK_A',
  });

  const userMessage = `## Gemini 분석 결과
시장 분위기: ${geminiAnalysis.market_sentiment}

${JSON.stringify(geminiAnalysis.stocks, null, 2)}

위 분석 결과를 바탕으로 각 종목의 점수를 산출해주세요.`;

  const content = await callVertexGemini(systemPrompt, userMessage, { temperature: 0.2 });

  try {
    // 1. 마크다운 코드 블록에서 JSON 문자열 추출
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (!jsonMatch) {
      logger.error('Gemini 스코어링 응답에서 JSON 블록을 찾을 수 없음', { component: 'TRACK_A', raw: content });
      throw new Error('Gemini scoring response does not contain a JSON block.');
    }
    const jsonText = jsonMatch[1] ?? jsonMatch[0];

    // 2. JSON 텍스트 파싱
    const parsedJson = JSON.parse(jsonText);

    // 3. Zod를 사용하여 최상위 구조 검증
    const responseParseResult = GeminiScoringResponseSchema.safeParse(parsedJson);
    if (!responseParseResult.success) {
      logger.warn('Gemini 스코어링 응답이 예상 스키마와 다름 (scores 배열 부재)', {
        component: 'TRACK_A',
        error: responseParseResult.error.message,
        rawPreview: jsonText.slice(0, 300),
      });
      return []; // 구조가 잘못된 경우 빈 배열 반환
    }

    // 4. 각 개별 스코어 객체 검증
    const validScores: ScoringResult[] = [];
    for (const score of responseParseResult.data.scores) {
      const zod = ScoringResultSchema.safeParse(score);
      if (zod.success) {
        // 0점짜리 스코어는 특정 항목 분석 실패를 의미할 수 있으므로 필터링
        if (zod.data.composite_score > 0) {
          validScores.push(zod.data);
        } else {
          const stockCode = typeof score === 'object' && score !== null && 'stock_code' in score ? String((score as any).stock_code) : 'UNKNOWN';
          logger.warn(`Gemini 스코어 0점 무효화 (${stockCode}): composite_score=${zod.data.composite_score}`, {
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
      `Gemini 스코어링 완료: ${validScores.length}/${responseParseResult.data.scores.length}개 유효, 최고점=${maxScore}`,
      { component: 'TRACK_A' },
    );

    return validScores;
  } catch (e) {
    logger.error('Gemini 스코어링 JSON 파싱 또는 처리 실패', { component: 'TRACK_A', raw: content, error: (e as Error).message });
    throw new Error('Failed to parse or process Gemini scoring response.');
  }
}
