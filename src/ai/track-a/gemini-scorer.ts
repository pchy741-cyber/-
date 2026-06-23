import { z } from 'zod';
import { type ScoringResult, ScoringResultSchema } from '../../db/models.js';
import { safeParseScoresJson } from '../../utils/json-repair.js';
import { logger } from '../../utils/logger.js';
import { callVertexGemini } from '../../utils/vertex-gemini.js';
import { buildScoringPrompt, type RegimeHint } from '../prompts/track-a-scoring.js';
import type { GeminiAnalysis } from './gemini.js';

// Gemini 스코어링 응답의 최상위 구조에 대한 스키마 정의
const _GeminiScoringResponseSchema = z.object({
  // scores 배열의 각 항목은 우선 unknown으로 파싱 후 개별적으로 검증
  scores: z.array(z.unknown()),
});

// 배치당 종목 수 — 70개 이하로 분할하여 Gemini 응답 시간 단축
const SCORING_BATCH_SIZE = 70;

/**
 * 단일 배치 스코어링 호출
 */
async function scoreBatch(
  systemPrompt: string,
  sentiment: string,
  stocks: GeminiAnalysis['stocks'],
  batchIdx: number,
  totalBatches: number,
): Promise<ScoringResult[]> {
  const userMessage = `## Gemini 분석 결과 (배치 ${batchIdx + 1}/${totalBatches})
시장 분위기: ${sentiment}

${JSON.stringify(stocks, null, 2)}

위 분석 결과를 바탕으로 각 종목의 점수를 산출해주세요.`;

  const content = await callVertexGemini(systemPrompt, userMessage, {
    temperature: 0.2,
    maxOutputTokens: 16384,
    label: 'TrackA-스코어링',
    useVertex: true,
  });

  // Resilient JSON parsing — 잘린 응답에서도 개별 스코어 복구
  const parsedResponse = safeParseScoresJson(content, `GeminiScoring-B${batchIdx}`);

  if (!parsedResponse || parsedResponse.scores.length === 0) {
    logger.warn(`Gemini 스코어링 배치${batchIdx + 1} 응답 파싱 실패 — 빈 배열`, {
      component: 'TRACK_A',
      rawLength: content.length,
      rawPreview: content.slice(0, 300),
    });
    return [];
  }

  const validScores: ScoringResult[] = [];
  for (const score of parsedResponse.scores) {
    const zod = ScoringResultSchema.safeParse(score);
    if (zod.success) {
      if (zod.data.signal !== 'NO_DATA') {
        validScores.push(zod.data);
      }
    } else {
      const stockCode =
        typeof score === 'object' && score !== null && 'stock_code' in score
          ? String((score as Record<string, unknown>).stock_code)
          : 'UNKNOWN';
      logger.warn(`Gemini 스코어 검증 실패 (${stockCode}): ${zod.error?.message}`, {
        component: 'TRACK_A',
        invalidData: score,
      });
    }
  }

  return validScores;
}

/**
 * Vertex AI Gemini로 종목 스코어링 (배치 분할)
 * 70개씩 나눠서 호출 → 응답 시간 단축 + 출력 토큰 안정성
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

  const allStocks = geminiAnalysis.stocks;
  const totalBatches = Math.ceil(allStocks.length / SCORING_BATCH_SIZE);

  logger.info(`Gemini 스코어링 시작 (${allStocks.length}개 종목, ${totalBatches}배치, 모드: ${mode})`, {
    component: 'TRACK_A',
  });

  // 배치별 순차 호출 (Vertex API rate limit 고려)
  const allScores: ScoringResult[] = [];
  for (let i = 0; i < totalBatches; i++) {
    const batch = allStocks.slice(i * SCORING_BATCH_SIZE, (i + 1) * SCORING_BATCH_SIZE);
    try {
      const scores = await scoreBatch(systemPrompt, geminiAnalysis.market_sentiment, batch, i, totalBatches);
      allScores.push(...scores);
      logger.info(`스코어링 배치${i + 1}/${totalBatches} 완료: ${scores.length}/${batch.length}개`, {
        component: 'TRACK_A',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`스코어링 배치${i + 1}/${totalBatches} 실패: ${msg.slice(0, 200)}`, {
        component: 'TRACK_A',
      });
      // 실패한 배치는 건너뛰고 계속 진행
    }
  }

  const maxScore = allScores.length > 0 ? Math.max(...allScores.map((s) => s.composite_score)) : 0;

  logger.info(`Gemini 스코어링 완료: ${allScores.length}/${allStocks.length}개 유효, 최고점=${maxScore}`, {
    component: 'TRACK_A',
  });

  return allScores;
}
