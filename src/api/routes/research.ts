// 증권사 리서치 노트 — URL 크롤링으로 수집, DB 저장, Track A Gemini 주입
import { Hono } from 'hono';
import { safeQuery as query } from '../../db/client.js';
import { logger } from '../../utils/logger.js';

export const researchRoutes = new Hono();

// URL에서 텍스트 추출 (메타태그 + 본문 텍스트)
async function crawlUrl(url: string): Promise<{ title: string; content: string }> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,*/*',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();

  // 제목 추출
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim().slice(0, 200) : '';

  // 스크립트/스타일/태그 제거 후 텍스트만 추출
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 5000); // 최대 5000자

  if (text.length < 50) throw new Error('본문 텍스트가 너무 짧습니다 (로그인 필요 or 빈 페이지)');

  return { title, content: text };
}

// POST /api/research/crawl — URL → 크롤링 → DB 저장
researchRoutes.post('/research/crawl', async (c) => {
  try {
    const body = await c.req.json<{ url: string; memo?: string }>();
    if (!body.url?.trim()) return c.json({ error: 'URL을 입력하세요' }, 400);

    const url = body.url.trim();
    if (!/^https?:\/\//.test(url)) return c.json({ error: 'http(s):// 로 시작하는 URL을 입력하세요' }, 400);

    const { title, content } = await crawlUrl(url);

    const result = await query<{ id: number }>(
      `INSERT INTO broker_research_notes (url, title, content, memo)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [url, title || null, content, body.memo?.trim() || null],
    );

    logger.info(`리서치 크롤링 저장: ${title || url} (${content.length}자)`, { component: 'RESEARCH' });
    return c.json({ ok: true, id: result.rows[0].id, title, length: content.length });
  } catch (err: any) {
    logger.warn(`리서치 크롤링 실패: ${err.message}`, { component: 'RESEARCH' });
    return c.json({ error: err.message ?? '크롤링 실패' }, 500);
  }
});

// GET /api/research/notes — 저장된 노트 목록
researchRoutes.get('/research/notes', async (c) => {
  try {
    const result = await query<{ id: number; url: string; title: string; memo: string; fetched_at: string; length: number }>(
      `SELECT id, url, title, memo, fetched_at, LENGTH(content) AS length
       FROM broker_research_notes
       ORDER BY fetched_at DESC
       LIMIT 50`,
    );
    return c.json({ notes: result.rows });
  } catch (err: any) {
    return c.json({ notes: [] });
  }
});

// DELETE /api/research/notes/:id — 노트 삭제
researchRoutes.delete('/research/notes/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    if (!id) return c.json({ error: '잘못된 ID' }, 400);
    await query('DELETE FROM broker_research_notes WHERE id = $1', [id]);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
