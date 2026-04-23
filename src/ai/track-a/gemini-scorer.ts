import { type ScoringResult, ScoringResultSchema } from '../../db/models.js';
import { logger } from '../../utils/logger.js';
import { callVertexGemini } from '../../utils/vertex-gemini.js';
import { buildScoringPrompt } from '../prompts/track-a-scoring.js';
import type { GeminiAnalysis } from './gemini.js';

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
    // Gemini가 마크다운 코드블록으로 JSON을 감쌀 수 있음 — 추출 후 파싱
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    const jsonText = jsonMatch ? jsonMatch[1] ?? jsonMatch[0] : content;
    const parsed = JSON.parse(jsonText) as { scores?: unknown };
    const rawScores = Array.isArray(parsed?.scores) ? parsed.scores : [];

    if (!Array.isArray(parsed?.scores)) {
      logger.warn('Gemini 스코어링 응답에 scores 배열이 없음 → fallback 진행', {
        component: 'TRACK_A',
        rawPreview: jsonText.slice(0, 300),
      });
    }

    const validScores: ScoringResult[] = [];
    for (const score of rawScores) {
      const stockCode =
        typeof score === 'object' && score !== null && 'stock_code' in score
          ? String((score as { stock_code?: string }).stock_code ?? 'UNKNOWN')
          : 'UNKNOWN';
      const zod = ScoringResultSchema.safeParse(score);
      if (zod.success && zod.data.composite_score > 0) {
        validScores.push(zod.data);
      } else if (zod.success && zod.data.composite_score <= 0) {
        logger.warn(`Gemini 스코어 0점 무효화 (${stockCode}): composite_score=${zod.data.composite_score} → 기술적 지표 fallback`, {
          component: 'TRACK_A',
        });
      } else {
        logger.warn(`Gemini 스코어 검증 실패 (${stockCode}): ${zod.error?.message}`, {
          component: 'TRACK_A',
        });
      }
    }

    const maxScore = validScores.length > 0
      ? Math.max(...validScores.map((s) => s.composite_score))
      : 0;

    logger.info(
      `Gemini 스코어링 완료: ${validScores.length}개 유효, ` +
        `최고점=${maxScore}`,
      { component: 'TRACK_A' },
    );

    return validScores;
  } catch {
    logger.error('Gemini 스코어링 JSON 파싱 실패', { component: 'TRACK_A', raw: content });
    throw new Error('Gemini 스코어링 응답이 올바른 JSON이 아닙니다');
  }
}
