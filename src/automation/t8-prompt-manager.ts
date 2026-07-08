/**
 * T8: 프롬프트 정합성 관리 에이전트 (claude-fable-5)
 *
 * 주 1회(일요일) 실행 — 지시탭 4종 + 참고소스 + config 수치를 Fable-5에 넘겨:
 *  1) [제안] 지시탭 4종의 정합성 검사 → 탭당 최대 1건 PENDING 제안 (텔레그램 승인 대기)
 *  2) [자동, 웹검색 ON일 때만] 참고소스 팩트 갱신 → 카드 일괄 교체
 *  3) 요약 텔레그램 발송
 *
 * ⚠️ 안전 원칙:
 *  - 지시탭은 절대 직접 수정하지 않는다. 제안(PENDING)만 → 사람이 텔레그램으로 승인해야 라이브 반영.
 *  - 참고소스 자동 교체는 팩트 갱신에 웹검색이 필수 → T8_WEB_SEARCH=true 일 때만 동작(기본 off).
 *    (미검증 웹 팩트를 라이브 매매 분석 프롬프트에 주입하는 위험 차단)
 *  - 매매/자금이동은 절대 수행하지 않는다.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { buildPromptContext, submitProposal } from '../api/routes/prompt-manager.js';
import { config } from '../config/index.js';
import { replaceFableCards } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { validateCards } from '../utils/prompt-guard.js';

const MODEL_PRIMARY = 'claude-fable-5';
const MODEL_FALLBACK = 'claude-opus-4-8'; // Fable 거부/실패 시 폴백
const WEB_SEARCH = process.env.T8_WEB_SEARCH === 'true';

const CardSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1).max(1500),
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const ProposalSchema = z.object({
  tab: z.enum(['strategy', 'risk', 'analysis', 'trading']),
  new_text: z.string().min(1),
  reason: z.string().min(1),
});
const T8OutputSchema = z.object({
  source_replacements: z.array(CardSchema).max(6).default([]),
  proposals: z.array(ProposalSchema).max(4).default([]),
  summary: z.array(z.string()).max(6).default([]),
});
type T8Output = z.infer<typeof T8OutputSchema>;

export interface T8RunResult {
  ran: boolean;
  model?: string;
  replacedSources: number;
  proposalsCreated: number;
  proposalsSkipped: number;
  summary: string[];
  error?: string;
}

function buildSystemPrompt(webSearch: boolean): string {
  return [
    '너는 ai-auto-bot 프롬프트 정합성 관리자(T8)다. 주 1회 지시탭 4종(strategy/risk/analysis/trading)과 참고소스, config 수치를 검토한다.',
    '입력은 user 메시지의 JSON (tabs, sources, config)이다.',
    '',
    '[제안 — 지시탭 4종] 아래 4종을 검사하고, 발견 시 탭당 최대 1건, 가장 심각한 것만 제안한다:',
    ' a. config 수치와 충돌하는 프롬프트 수치 (예: 프롬프트 30% vs config 25%)',
    ' b. 시효 지난 문장 (섹터 뷰·시장 국면 언급 — 참고소스로 갈 팩트가 지시탭에 있는 경우 포함)',
    ' c. 탭 간 상호 모순 (같은 항목에 다른 수치·다른 규칙)',
    ' d. 실행 불가 지시 (봇 데이터에 없는 것을 확인하라는 문장, 매도/자금이동 지시)',
    ' 각 proposal.reason에 근거를 명시한다. proposal.new_text는 해당 탭 전문(수정본 전체)이다.',
    '',
    webSearch
      ? '[자동 — 참고소스] 만료 지난/임박 카드를 웹 검색으로 팩트 갱신해 source_replacements에 최신 카드 전체 세트를 담는다. 규칙: 팩트만, 지시문 금지, 카드당 5문장 이내, title은 [카테고리] 접두사, expires_at은 YYYY-MM-DD.'
      : '[참고소스] 웹 검색 비활성 상태다. source_replacements는 빈 배열로 두고, 만료/임박 카드가 있으면 summary에 보고만 한다.',
    '',
    '원칙: 지시탭을 직접 수정하지 않는다(제안만). 근거 없이 문체 취향으로 제안하지 않는다. 검사 결과 깨끗하면 제안 0건이 정답이다.',
    '매매·자금이동은 절대 지시하지 않는다.',
    '',
    '출력: 아래 JSON 객체 하나만 반환한다. 코드펜스·설명·서론 금지.',
    '{ "source_replacements": [{"title","body","expires_at"}], "proposals": [{"tab","new_text","reason"}], "summary": ["..."] }',
    'summary는 한국어 5줄 이내: "자동 교체 n장 / 제안 n건(탭명+한줄사유) / 이상 없음 항목".',
  ].join('\n');
}

/** 모델 1회 호출 (서버 web_search 툴 사용 시 pause_turn 루프) */
async function callModel(
  anthropic: Anthropic,
  model: string,
  system: string,
  userContent: string,
  webSearch: boolean,
): Promise<{ text: string; refused: boolean }> {
  const tools = webSearch ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }] : undefined;
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content: userContent }];

  for (let round = 0; round < 5; round++) {
    // Fable-5: temperature/thinking 미지정 (400 방지). tools/모델 문자열은 SDK 0.37 타입 우회.
    const req: Record<string, unknown> = { model, max_tokens: 16000, system, messages };
    if (tools) req.tools = tools;
    const resp = (await anthropic.messages.create(req as never)) as {
      stop_reason?: string;
      content?: Array<{ type: string; text?: string }>;
    };

    if (resp.stop_reason === 'refusal') return { text: '', refused: true };
    if (resp.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: resp.content });
      continue;
    }
    const text = (resp.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
    return { text, refused: false };
  }
  return { text: '', refused: false };
}

/** 모델 텍스트에서 JSON 객체 추출 + 스키마 검증 */
function parseT8(text: string): T8Output | null {
  let jsonStr = text.trim();
  const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonStr = fence[1].trim();
  const first = jsonStr.indexOf('{');
  const last = jsonStr.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  jsonStr = jsonStr.slice(first, last + 1);
  try {
    return T8OutputSchema.parse(JSON.parse(jsonStr));
  } catch {
    return null;
  }
}

export async function runT8PromptManager(opts?: { trigger?: string; dryRun?: boolean }): Promise<T8RunResult> {
  const trigger = opts?.trigger ?? 'cron';
  const empty: T8RunResult = { ran: false, replacedSources: 0, proposalsCreated: 0, proposalsSkipped: 0, summary: [] };

  const key = config.ai.anthropicKey || process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith('your_')) {
    logger.warn('[T8] ANTHROPIC_API_KEY 미설정 — T8 스킵', { component: 'FABLE' });
    return { ...empty, error: 'no_api_key' };
  }

  logger.info(`[T8] 주간 프롬프트 감사 시작 (trigger=${trigger}, webSearch=${WEB_SEARCH})`, { component: 'FABLE' });
  const anthropic = new Anthropic({ apiKey: key });
  const ctx = await buildPromptContext();
  const system = buildSystemPrompt(WEB_SEARCH);
  const userContent = `다음은 현재 봇 상태다. 검토하고 JSON으로만 응답하라.\n\n${JSON.stringify(ctx, null, 2)}`;

  // Fable-5 → 실패/거부/파싱실패 시 Opus 4.8 폴백
  let modelUsed = '';
  let out: T8Output | null = null;
  for (const model of [MODEL_PRIMARY, MODEL_FALLBACK]) {
    try {
      const { text, refused } = await callModel(anthropic, model, system, userContent, WEB_SEARCH);
      if (refused) {
        logger.warn(`[T8] ${model} 응답 거부(refusal) — 폴백`, { component: 'FABLE' });
        continue;
      }
      out = parseT8(text);
      if (out) {
        modelUsed = model;
        break;
      }
      logger.warn(`[T8] ${model} JSON 파싱 실패 — 폴백`, { component: 'FABLE' });
    } catch (e) {
      logger.warn(`[T8] ${model} 호출 실패: ${e} — 폴백`, { component: 'FABLE' });
    }
  }
  if (!out) {
    await sendTelegramMessage('⚠️ *T8 주간 감사 실패* — 모델 응답 파싱 불가 (Fable/Opus 모두)').catch(() => {});
    return { ...empty, error: 'model_failed' };
  }

  // 1) 참고소스 자동 교체 (웹검색 ON + dryRun 아님)
  let replaced = 0;
  if (WEB_SEARCH && !opts?.dryRun) {
    // S1: route와 동일 검증(인젝션/형식) 통과분만 반영 — 웹소스 카드 무필터 주입 차단
    const { valid, rejected } = validateCards(out.source_replacements);
    if (rejected > 0) logger.warn(`[T8] 소스카드 ${rejected}장 검증 탈락(인젝션/형식)`, { component: 'FABLE' });
    if (valid.length > 0) {
      try {
        await replaceFableCards(valid);
        replaced = valid.length;
        logger.info(`[T8] 참고소스 ${replaced}장 자동 교체`, { component: 'FABLE' });
      } catch (e) {
        logger.error(`[T8] 참고소스 교체 실패: ${e}`, { component: 'FABLE' });
      }
    }
  }

  // 2) 지시탭 제안 (submitProposal이 검증·탭당 중복·텔레그램 처리)
  let created = 0;
  let skipped = 0;
  if (!opts?.dryRun) {
    for (const p of out.proposals) {
      // C3: 한 건 실패가 전체 루프를 중단시키지 않도록 격리
      try {
        const res = await submitProposal({ tab: p.tab, new_text: p.new_text, reason: p.reason, proposedBy: 't8' });
        if (res.status === 'created') created++;
        else skipped++;
      } catch (e) {
        skipped++;
        logger.error(`[T8] 제안 저장 실패 [${p.tab}]: ${e}`, { component: 'FABLE' });
      }
    }
  }

  // 3) 요약 텔레그램
  const summaryLines =
    out.summary.length > 0 ? out.summary : [`자동 교체 ${replaced}장 / 제안 ${created}건 / 스킵 ${skipped}건`];
  const tgSummary = [
    `🧭 *T8 주간 프롬프트 감사* (${modelUsed}${opts?.dryRun ? ', dryRun' : ''})`,
    '',
    ...summaryLines,
  ].join('\n');
  await sendTelegramMessage(tgSummary).catch(() => {});
  logger.info(`[T8] 완료 — 교체 ${replaced} / 제안 ${created} / 스킵 ${skipped}`, { component: 'FABLE' });

  return {
    ran: true,
    model: modelUsed,
    replacedSources: replaced,
    proposalsCreated: created,
    proposalsSkipped: skipped,
    summary: summaryLines,
  };
}
