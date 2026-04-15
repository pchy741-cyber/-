import { GoogleGenerativeAI } from '@google/generative-ai';
import { setGeminiStatus } from '../../cache/ai-status.js';
import { config } from '../../config/index.js';
import { type TradeDecision, TradeDecisionSchema } from '../../db/models.js';
import { logger } from '../../utils/logger.js';
import { buildExecutionPrompt } from '../prompts/track-b-execution.js';
import { BUY_BLOCKED_CODES } from './trading-rules.js';

function getGenAI(): GoogleGenerativeAI | null {
  const key = config.ai.geminiKey || process.env.GEMINI_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 10) return null;
  return new GoogleGenerativeAI(key);
}

/**
 * Gemini 2.5 Pro로 매매 실행 판단 (Claude 대체)
 * Claude와 동일한 프롬프트/스키마 사용
 */
export async function runGeminiExecution(params: {
  mode: string;
  context: string;
  customPrompt?: string;
}): Promise<TradeDecision[]> {
  const { mode, context, customPrompt } = params;

  const genAI = getGenAI();
  if (!genAI) {
    logger.warn('Gemini API 키 미설정 — Gemini 매매 판단 스킵', { component: 'TRACK_B' });
    return [];
  }

  const basePrompt = buildExecutionPrompt(mode);
  const systemPrompt = customPrompt ? `${basePrompt}\n\n${customPrompt}` : basePrompt;

  logger.info(`Gemini 실행 판단 시작 (모드: ${mode})`, { component: 'TRACK_B' });

  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
    },
  });

  const MAX_RETRIES = 2;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent([systemPrompt, context]);
      const rawText = result.response.text();

      const parsed = JSON.parse(rawText) as { decisions: TradeDecision[] };

      const validDecisions: TradeDecision[] = [];
      for (const decision of parsed.decisions) {
        const zod = TradeDecisionSchema.safeParse(decision);
        if (zod.success) {
          validDecisions.push(zod.data);
        } else {
          logger.warn(`Gemini 결정 검증 실패 (${decision.stock_code ?? 'unknown'}): ${zod.error.message}`, {
            component: 'TRACK_B',
          });
        }
      }

      // CEO 지시: 차단 종목 BUY 필터링
      const filtered = validDecisions.filter((d) => {
        if (d.action === 'BUY' && d.stock_code && BUY_BLOCKED_CODES.has(d.stock_code)) {
          logger.warn(`🚫 AI BUY 차단: ${d.stock_code} — 매수 금지 목록`, { component: 'TRACK_B' });
          return false;
        }
        return true;
      });

      if (filtered.length === 0 && parsed.decisions.length > 0) {
        throw new Error(`모든 결정이 검증 실패 또는 차단 (${parsed.decisions.length}개)`);
      }

      logger.info(
        `Gemini 판단 완료: ${filtered.length}개 유효 결정 ` +
          `(BUY: ${filtered.filter((d) => d.action === 'BUY').length}, ` +
          `SELL: ${filtered.filter((d) => ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action)).length}, ` +
          `HOLD: ${filtered.filter((d) => d.action === 'HOLD').length})`,
        { component: 'TRACK_B' },
      );

      setGeminiStatus('ok');
      return filtered;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Gemini 실행 시도 ${attempt} 실패: ${msg}`, { component: 'TRACK_B' });

      // 무료 할당량 초과
      if (msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429')) {
        setGeminiStatus('quota', msg);
        return [];
      }

      if (attempt === MAX_RETRIES) {
        setGeminiStatus('error', msg);
        return [];
      }
    }
  }

  setGeminiStatus('error');
  return [];
}
