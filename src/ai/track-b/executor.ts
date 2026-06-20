import Anthropic from '@anthropic-ai/sdk';
import { setClaudeStatus } from '../../cache/ai-status.js';
import { STRATEGY_PARAMS } from '../../config/constants.js';
import { config } from '../../config/index.js';
import { type TradeDecision, TradeDecisionSchema } from '../../db/models.js';
import { callClaudeCli, isClaudeCliEnabled } from '../../utils/claude-cli.js';
import { logger } from '../../utils/logger.js';
import { buildExecutionPrompt } from '../prompts/track-b-execution.js';
import { BUY_BLOCKED_CODES } from './trading-rules.js';

// Lazy init — 키 변경 시 자동 반영
function getAnthropic(): Anthropic | null {
  if (isClaudeCliEnabled()) return null; // CLI 모드에서는 SDK 불필요
  const key = config.ai.anthropicKey || process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith('your_')) return null;
  return new Anthropic({ apiKey: key });
}

interface ClaudeExecutionOutput {
  decisions: TradeDecision[];
}

/**
 * Claude 3.5 Sonnet으로 매매 실행 판단
 * - 캐싱된 스코어 + 실시간 시세 컨텍스트를 입력
 * - 엄격한 JSON 스키마 검증으로 환각 방지
 * - 최대 3회 재시도 (유효성 검증 실패 시)
 */
export async function runClaudeExecution(params: {
  mode: string;
  context: string;
  customPrompt?: string;
}): Promise<TradeDecision[]> {
  const { mode, context, customPrompt } = params;

  const useCli = isClaudeCliEnabled();
  const anthropic = getAnthropic();
  if (!useCli && !anthropic) {
    logger.warn('Anthropic API 키 미설정 & CLI 비활성 — Claude 매매 판단 스킵 (HOLD 반환)', { component: 'TRACK_B' });
    return [];
  }

  const strategyParams = STRATEGY_PARAMS[mode as keyof typeof STRATEGY_PARAMS] ?? STRATEGY_PARAMS.SWING;
  const basePrompt = buildExecutionPrompt(mode, strategyParams);
  const systemPrompt = customPrompt ? `${basePrompt}\n\n${customPrompt}` : basePrompt;

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`Claude 실행 판단 시작 (시도 ${attempt}/${MAX_RETRIES}, 모드: ${mode}, ${useCli ? 'CLI' : 'API'})`, {
        component: 'TRACK_B',
      });

      let rawText: string;

      if (useCli) {
        // Max 구독 CLI 모드
        rawText = await callClaudeCli({ systemPrompt, userPrompt: context });
      } else {
        // API 키 모드
        const response = await anthropic!.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          temperature: 0.1,
          system: systemPrompt,
          messages: [{ role: 'user', content: context }],
        });

        const textBlock = response.content.find((block) => block.type === 'text');
        if (!textBlock || textBlock.type !== 'text') {
          throw new Error('Claude 응답에 텍스트가 없습니다');
        }
        rawText = textBlock.text;
      }

      // JSON 블록 추출 (```json ... ``` 또는 순수 JSON)
      const jsonMatch = rawText.match(/```json\s*([\s\S]*?)```/) || rawText.match(/(\{[\s\S]*\})/);
      if (!jsonMatch) {
        throw new Error('Claude 응답에서 JSON을 찾을 수 없습니다');
      }

      const parsed = JSON.parse(jsonMatch[1]) as ClaudeExecutionOutput;

      // Zod로 각 결정 엄격 검증
      const validDecisions: TradeDecision[] = [];
      const invalidCount = { count: 0 };

      for (const decision of parsed.decisions) {
        const result = TradeDecisionSchema.safeParse(decision);
        if (result.success) {
          validDecisions.push(result.data);
        } else {
          invalidCount.count++;
          logger.warn(`Claude 결정 검증 실패 (${decision.stock_code ?? 'unknown'}): ${result.error.message}`, {
            component: 'TRACK_B',
          });
        }
      }

      // 전부 실패하면 재시도
      if (validDecisions.length === 0 && parsed.decisions.length > 0) {
        throw new Error(`모든 결정이 검증 실패 (${invalidCount.count}개)`);
      }

      // CEO 지시: 차단 종목 BUY 필터링
      const filtered = validDecisions.filter((d) => {
        if (d.action === 'BUY' && d.stock_code && BUY_BLOCKED_CODES.has(d.stock_code)) {
          logger.warn(`🚫 Claude BUY 차단: ${d.stock_code} — 매수 금지 목록`, { component: 'TRACK_B' });
          return false;
        }
        return true;
      });

      logger.info(
        `Claude 판단 완료: ${filtered.length}개 유효 결정 ` +
          `(BUY: ${filtered.filter((d) => d.action === 'BUY').length}, ` +
          `SELL: ${filtered.filter((d) => ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action)).length}, ` +
          `HOLD: ${filtered.filter((d) => d.action === 'HOLD').length})`,
        { component: 'TRACK_B' },
      );

      setClaudeStatus('ok');
      return filtered;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Claude 실행 시도 ${attempt} 실패: ${msg}`, { component: 'TRACK_B' });

      // 크레딧 소진 — 재시도 불필요, 즉시 종료
      if (msg.includes('credit balance is too low') || msg.includes('insufficient_credits')) {
        logger.error('Claude API 크레딧 소진 — Gemini로 폴백', { component: 'TRACK_B' });
        setClaudeStatus('no_credit', msg);
        return [];
      }

      if (attempt === MAX_RETRIES) {
        logger.error(`Claude 실행 최종 실패 (${MAX_RETRIES}회 시도)`, { component: 'TRACK_B' });
        setClaudeStatus('error', msg);
        return [];
      }
    }
  }

  setClaudeStatus('error');
  return [];
}
