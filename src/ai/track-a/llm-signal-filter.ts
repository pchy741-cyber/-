/**
 * LLM 신호 검증 필터 — 빠른 재스코어링(quick-rescore) 전용
 *
 * 근거(딥리서치, 2026-07-01):
 * - LLM은 "직접 판단자"보다 "이미 나온 신호를 검증/필터링하는 도구"로 쓸 때 성과가 좋음
 *   (LLM+베이지안망 하이브리드가 순수 LLM 단독보다 수익률/샤프비율 2배 이상 — arXiv:2512.01123)
 * - "여러 모델을 그냥 앙상블로 더하면 좋아진다"는 가설은 검증 실패 다수 (0-3, 0-2표 기각)
 *   → 필터링 없이 소스만 늘리면 노이즈 증가 + 수익률 저하 사례도 있음
 * - 1분(황금구간) 주기는 LLM 호출 지연(2~5초)이 기회 유효시간을 초과할 위험 (QuantAgent, arXiv:2509.09995)
 *   → 5분 이상 주기에서만 사용
 *
 * 그래서: RSS+이벤트 필터를 이미 통과한 소수 후보에만, "이 신호가 노이즈가 아닌지" 검증하는
 * 좁은 역할로 GPT-4o-mini를 사용. 전체 워치리스트를 매번 재평가하는 별도 앙상블이 아님.
 */
import OpenAI from 'openai';
import type { ScoringResult } from '../../db/models.js';
import { logger } from '../../utils/logger.js';
import { logTokenUsage, calcGptCost } from '../../utils/ai-token-logger.js';

const COMP = 'LLM_SIGNAL_FILTER';
const MODEL = 'gpt-4o-mini';
const API_TIMEOUT_MS = 15_000; // 빠른 재스코어링 주기 안에 들어와야 하므로 타이트하게
const MAX_CANDIDATES_PER_RUN = 5; // 후보 전체가 아니라 상위 소수만 검증 (지연시간·비용 통제)
const REJECT_PENALTY = 20; // REJECT 시 감산 — BUY_THRESHOLD(68) 아래로 확실히 내림

function getClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.startsWith('your_')) return null;
  return new OpenAI({ apiKey: key, timeout: API_TIMEOUT_MS });
}

/**
 * RSS+이벤트 필터를 통과한 후보들을 GPT-4o-mini로 검증.
 * VALID → 원 점수 유지 + 검증 태그, REJECT → 감산 + 사유 반영.
 * API 키 없거나 실패 시 원본 그대로 반환 (파이프라인 차단 없음).
 */
export async function filterCandidatesWithLLM(candidates: ScoringResult[]): Promise<ScoringResult[]> {
  if (candidates.length === 0) return candidates;

  const client = getClient();
  if (!client) return candidates;

  const targets = candidates.slice(0, MAX_CANDIDATES_PER_RUN);
  const rest = candidates.slice(MAX_CANDIDATES_PER_RUN);

  const filtered = await Promise.allSettled(
    targets.map(async (c) => {
      try {
        const prompt = `한국 주식 단타 신호를 검증해줘. 아래 신호가 실제 거래 기회인지, 노이즈/과열/거짓신호인지 판단.

종목코드: ${c.stock_code}
스코어: ${c.composite_score}점 (기술 ${c.technical_score}, 펀더멘털 ${c.fundamental_score}, 심리 ${c.sentiment_score})
근거: ${c.reasoning}

JSON만 출력 (코드블록 없이): {"verdict":"VALID"|"REJECT","reason":"한 줄 이유"}`;

        const start = Date.now();
        const res = await client.chat.completions.create({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: 80,
        });
        const elapsed = Date.now() - start;

        const text = res.choices[0]?.message?.content ?? '';
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        const verdict = parsed.verdict === 'REJECT' ? 'REJECT' : 'VALID';
        const reason = String(parsed.reason ?? '').slice(0, 60);

        const usage = res.usage;
        if (usage) {
          const cost = calcGptCost(usage.prompt_tokens, usage.completion_tokens);
          logTokenUsage({
            provider: 'gpt',
            model: MODEL,
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            costUsd: cost,
            label: 'signal_filter',
          });
        }

        if (verdict === 'REJECT') {
          logger.info(`🔍 GPT검증 REJECT: ${c.stock_code} (${elapsed}ms) — ${reason}`, { component: COMP });
          return {
            ...c,
            composite_score: Math.max(0, c.composite_score - REJECT_PENALTY),
            signal: 'HOLD' as const,
            reasoning: `${c.reasoning} | [GPT검증:REJECT] ${reason}`,
          };
        }
        logger.info(`✅ GPT검증 VALID: ${c.stock_code} (${elapsed}ms) — ${reason}`, { component: COMP });
        return { ...c, reasoning: `${c.reasoning} | [GPT검증:VALID] ${reason}` };
      } catch (e) {
        // 검증 실패 시 원본 신호 그대로 통과 (필터가 파이프라인을 막으면 안 됨)
        logger.debug(`GPT검증 실패 (원본 유지): ${c.stock_code} — ${e}`, { component: COMP });
        return c;
      }
    }),
  );

  const validatedResults = filtered.map((r, i) => (r.status === 'fulfilled' ? r.value : targets[i]));
  return [...validatedResults, ...rest];
}
