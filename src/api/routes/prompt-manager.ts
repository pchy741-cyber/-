/**
 * T8: 프롬프트 정합성 관리자 — 봇 측 배선
 * - GET  /api/prompts/context  — 지시탭 4종 + 참고소스 카드(만료일 포함) + config 수치 요약
 * - POST /api/prompts/proposal — 지시탭 변경 제안(PENDING) 저장 + 텔레그램 발송
 * - POST /api/prompts/t8-run   — T8 주간 감사 수동 트리거 (E2E 테스트용)
 * 승인/반려는 텔레그램 /approve_p{id} · /reject_p{id} (src/notifications/telegram.ts).
 * 핵심 로직은 buildPromptContext() · submitProposal()로 추출 — 라우트와 T8 에이전트가 공유.
 */
import { Hono } from 'hono';
import { config } from '../../config/index.js';
import { BEAR_ADAPTIVE, STRATEGY_PARAMS } from '../../config/strategy-params.js';
import { getActiveStrategy, getPool, isMemoryMode } from '../../db/client.js';
import { getPendingByTab, getTabText, insertProposal, isValidTab, tabLabel } from '../../db/repo/prompt-revisions.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';
import { hasPromptInjection, MAX_PROMPT_TEXT } from '../../utils/prompt-guard.js';

export const promptManagerRoutes = new Hono();

const MAX_REASON = 1000;

export interface PromptContext {
  tabs: { strategy: string; risk: string; analysis: string; trading: string };
  sources: Array<{ title: string; body: string | null; source: string | null; expires_at: string | null }>;
  config: Record<string, unknown>;
}

/** 지시탭 4종 + 참고소스 + config 수치 요약 조립 (GET /context 와 T8 에이전트 공용) */
export async function buildPromptContext(): Promise<PromptContext> {
  const strategy = await getActiveStrategy();
  const s = (strategy ?? {}) as Record<string, unknown>;

  const tabs = {
    strategy: await getTabText('strategy'),
    risk: await getTabText('risk'),
    analysis: await getTabText('analysis'),
    trading: await getTabText('trading'),
  };

  // 참고소스: 만료 카드도 포함(T8이 삭제/갱신 판단) — expires_at 노출
  let sources: PromptContext['sources'] = [];
  if (!isMemoryMode()) {
    const { rows } = await getPool().query(
      `SELECT title, body, source, expires_at FROM market_sources
       ORDER BY is_pinned DESC, added_at DESC LIMIT 30`,
    );
    sources = rows;
  }

  // config 수치 요약: 프롬프트와 충돌 검사에 필요한 값만
  const mode = (s.mode as keyof typeof STRATEGY_PARAMS) ?? 'SWING';
  const params = STRATEGY_PARAMS[mode] ?? STRATEGY_PARAMS.SWING;
  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const p = params as Record<string, unknown>;

  const configSummary = {
    mode,
    buyThreshold: num(s.buy_threshold, params.buyThreshold),
    stopLossPct: num(s.stop_loss_pct, params.stopLossPct),
    takeProfitPct: num(s.take_profit_pct, params.takeProfitPct),
    maxHoldingDays: (p.maxHoldingDays as number) ?? null,
    maxDailyTrades: (p.maxDailyTrades as number) ?? null,
    splitCount: (p.splitCount as number) ?? null,
    maxPositionKrw: config.risk.maxPositionKrw,
    regimeOverrides: {
      bear: {
        takeProfitPct: BEAR_ADAPTIVE.TAKE_PROFIT_PCT,
        stopLossPct: BEAR_ADAPTIVE.STOP_LOSS_PCT,
        maxPositionCount: BEAR_ADAPTIVE.MAX_POSITION_COUNT,
        maxHoldingDays: BEAR_ADAPTIVE.MAX_HOLDING_DAYS,
      },
    },
  };

  return { tabs, sources, config: configSummary };
}

export type SubmitResult =
  | { status: 'created'; id: number }
  | { status: 'duplicate'; id: number }
  | { status: 'invalid'; error: string };

/**
 * 지시탭 변경 제안 저장 (검증 + 탭당 PENDING 1건 제한 + 텔레그램 발송).
 * 라우트(POST /proposal)와 T8 에이전트가 공유 — 가드레일 단일화.
 */
export async function submitProposal(input: {
  tab: string;
  new_text: string;
  reason: string;
  proposedBy?: string;
}): Promise<SubmitResult> {
  const { tab, new_text, reason } = input;
  if (!isValidTab(tab)) return { status: 'invalid', error: 'tab은 strategy|risk|analysis|trading 중 하나여야 합니다' };
  if (!new_text || typeof new_text !== 'string' || new_text.trim().length === 0) {
    return { status: 'invalid', error: 'new_text가 필요합니다' };
  }
  if (new_text.length > MAX_PROMPT_TEXT)
    return { status: 'invalid', error: `new_text는 ${MAX_PROMPT_TEXT}자 이내여야 합니다 (현재: ${new_text.length}자)` };
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    return { status: 'invalid', error: 'reason(근거)이 필요합니다' };
  }
  if (reason.length > MAX_REASON) return { status: 'invalid', error: `reason은 ${MAX_REASON}자 이내여야 합니다` };
  if (hasPromptInjection(new_text)) return { status: 'invalid', error: '프롬프트 인젝션 의심 콘텐츠가 감지되었습니다' };
  if (isMemoryMode()) return { status: 'invalid', error: '인메모리 모드 — 제안 저장 불가 (DB 필요)' };

  // 탭당 PENDING 1건 제한 (제안 스팸 방지)
  const existing = await getPendingByTab(tab);
  if (existing) return { status: 'duplicate', id: existing.id };

  const oldText = await getTabText(tab);
  let id: number;
  try {
    id = await insertProposal({ tab, old_text: oldText, new_text, reason });
  } catch (e) {
    // C3: 동시 제안 레이스 → partial unique index 위반(23505) → 409(duplicate)로 매핑
    if ((e as { code?: string })?.code === '23505') {
      const dup = await getPendingByTab(tab);
      return dup
        ? { status: 'duplicate', id: dup.id }
        : { status: 'invalid', error: '동시 제안 충돌 — 잠시 후 재시도' };
    }
    throw e;
  }

  const clip = (t: string): string => (t.length > 200 ? `${t.slice(0, 200)}…` : t) || '(비어있음)';
  const msg = [
    `📝 *프롬프트 변경 제안* [${tabLabel(tab)}] (#${id})`,
    ``,
    `📌 사유: ${reason}`,
    ``,
    `[기존 요약] ${clip(oldText)}`,
    ``,
    `⬇️ 제안 전문(아래 메시지)을 확인한 뒤 승인하세요.`,
    ``,
    `승인: /approve_p${id}`,
    `반려: /reject_p${id}`,
  ].join('\n');
  await sendTelegramMessage(msg).catch((e) => logger.warn(`[T8] 텔레그램 발송 실패: ${e}`, { component: 'FABLE' }));

  // S2: 승인 시 반영되는 것은 8000자 전문이므로 clip만으론 눈뜬장님 승인 위험 → 전문을 청크로 발송.
  const CHUNK = 3500;
  const total = Math.max(1, Math.ceil(new_text.length / CHUNK));
  for (let i = 0; i < total; i++) {
    const part = new_text.slice(i * CHUNK, (i + 1) * CHUNK) || '(비어있음)';
    await sendTelegramMessage(`📄 제안 #${id} [${tabLabel(tab)}] 전문 (${i + 1}/${total})\n\n${part}`).catch(() => {});
  }

  logger.info(`[T8] 제안 #${id} 저장 [${tab}] (by ${input.proposedBy ?? 't8'})`, { component: 'FABLE' });
  return { status: 'created', id };
}

// ── GET /api/prompts/context ──
promptManagerRoutes.get('/prompts/context', async (c) => {
  try {
    return c.json(await buildPromptContext());
  } catch (err) {
    logger.error(`[T8] context 조회 실패: ${err}`, { component: 'FABLE' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── POST /api/prompts/proposal ──
promptManagerRoutes.post('/prompts/proposal', async (c) => {
  let body: { tab?: string; new_text?: string; reason?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  try {
    const res = await submitProposal({ tab: body.tab ?? '', new_text: body.new_text ?? '', reason: body.reason ?? '' });
    if (res.status === 'invalid') {
      return c.json({ error: res.error }, res.error.startsWith('인메모리') ? 503 : 400);
    }
    if (res.status === 'duplicate') {
      return c.json({ error: `미결 제안(#${res.id})이 이미 존재합니다`, pending_id: res.id }, 409);
    }
    return c.json({ ok: true, id: res.id });
  } catch (err) {
    logger.error(`[T8] 제안 저장 실패: ${err}`, { component: 'FABLE' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── POST /api/prompts/t8-run — T8 주간 감사 수동 트리거 (E2E 테스트용) ──
promptManagerRoutes.post('/prompts/t8-run', async (c) => {
  try {
    const { runT8PromptManager } = await import('../../automation/t8-prompt-manager.js');
    const result = await runT8PromptManager({ trigger: 'manual' });
    return c.json({ ok: true, ...result });
  } catch (err) {
    logger.error(`[T8] 수동 실행 실패: ${err}`, { component: 'FABLE' });
    return c.json({ error: String(err) }, 500);
  }
});
