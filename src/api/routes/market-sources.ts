/**
 * v27: Fable 스케줄 레이어 API
 * - POST /api/market-sources/replace — Fable 카드 일괄 교체
 * - GET  /api/candidates/today — 오늘 상위 AI 후보 종목
 */
import { Hono } from 'hono';
import { replaceFableCards } from '../../db/repo/market-sources.js';
import { getTopCandidates } from '../../db/repo/ai-scores.js';
import { logger } from '../../utils/logger.js';

export const marketSourcesRoutes = new Hono();

// ── 프롬프트 인젝션 방어 ──
const INJECTION_PATTERNS = [
  /ignore\s+(previous|above|all)/i,
  /system\s*prompt/i,
  /you\s+are\s+(now|a)/i,
  /<\/?script/i,
  /\{\{.*\}\}/,
];

function hasInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}

// ── POST /api/market-sources/replace ──
marketSourcesRoutes.post('/market-sources/replace', async (c) => {
  let body: { cards: Array<{ title: string; body: string; expires_at: string }> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!Array.isArray(body.cards) || body.cards.length === 0) {
    return c.json({ error: 'cards 배열이 필요합니다' }, 400);
  }
  if (body.cards.length > 6) {
    return c.json({ error: '카드는 최대 6개까지 허용됩니다' }, 400);
  }

  // 검증
  for (const card of body.cards) {
    if (!card.title || typeof card.title !== 'string') {
      return c.json({ error: 'title이 필요합니다' }, 400);
    }
    if (!card.title.startsWith('[')) {
      return c.json({ error: `title은 [카테고리] 접두사가 필요합니다: "${card.title}"` }, 400);
    }
    if (!card.body || typeof card.body !== 'string') {
      return c.json({ error: 'body가 필요합니다' }, 400);
    }
    if (card.body.length > 1500) {
      return c.json({ error: `body는 1500자 이내여야 합니다 (현재: ${card.body.length}자)` }, 400);
    }
    if (!card.expires_at || !/^\d{4}-\d{2}-\d{2}$/.test(card.expires_at)) {
      return c.json({ error: 'expires_at은 YYYY-MM-DD 형식이어야 합니다' }, 400);
    }
    // 프롬프트 인젝션 검사
    if (hasInjection(card.title) || hasInjection(card.body)) {
      return c.json({ error: '프롬프트 인젝션 의심 콘텐츠가 감지되었습니다' }, 400);
    }
  }

  try {
    await replaceFableCards(body.cards);
    logger.info(`[Fable] ${body.cards.length}건 카드 교체 완료`, { component: 'FABLE' });
    return c.json({ ok: true, replaced: body.cards.length });
  } catch (err) {
    logger.error(`[Fable] 카드 교체 실패: ${err}`, { component: 'FABLE' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── GET /api/candidates/today ──
marketSourcesRoutes.get('/candidates/today', async (c) => {
  try {
    const candidates = await getTopCandidates(10);
    return c.json({ candidates });
  } catch (err) {
    logger.error(`[Candidates] 조회 실패: ${err}`, { component: 'FABLE' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});
