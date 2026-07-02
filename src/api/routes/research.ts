// 증권사 리서치 노트 — URL 크롤링으로 수집, DB 저장, Track A Gemini 주입
import { Hono } from 'hono';
import { safeQuery as query } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { runDartResearch, runDartResearchBatch, getCachedDartResults } from '../../automation/dart-research.js';
import { runSecResearch, runSecResearchBatch } from '../../automation/sec-research.js';

export const researchRoutes = new Hono();

// ── SSRF 방어: 허용 도메인 화이트리스트 ──
const ALLOWED_DOMAINS = [
  'naver.com', 'finance.naver.com', 'n.news.naver.com', 'm.stock.naver.com',
  'hankyung.com', 'mk.co.kr', 'sedaily.com', 'edaily.co.kr',
  'etnews.com', 'zdnet.co.kr', 'bloter.net',
  'dart.fss.or.kr', 'kind.krx.co.kr',
  'investing.com', 'seekingalpha.com', 'bloomberg.com', 'reuters.com',
  'finance.yahoo.com',
];

function isAllowedDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return ALLOWED_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

// URL에서 텍스트 추출 (메타태그 + 본문 텍스트)
async function crawlUrl(url: string): Promise<{ title: string; content: string }> {
  if (!isAllowedDomain(url)) {
    throw new Error(`허용되지 않은 도메인입니다. 허용 목록: ${ALLOWED_DOMAINS.slice(0, 5).join(', ')} 등`);
  }

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,*/*',
    },
    signal: AbortSignal.timeout(15000),
    redirect: 'manual', // 리다이렉트 자동 추적 차단 (SSRF 방지)
  });

  // 리다이렉트 응답: 대상 도메인도 화이트리스트 검증
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location || !isAllowedDomain(location)) {
      throw new Error('리다이렉트 대상이 허용 도메인이 아닙니다');
    }
    throw new Error(`리다이렉트 감지 (${res.status}→${location}) — 직접 URL을 입력하세요`);
  }

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
    return c.json({ error: 'Internal server error' }, 500);
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
    logger.warn(`리서치 노트 삭제 실패: ${err.message}`, { component: 'RESEARCH' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /api/research/dart/cached — DB 캐시에서 분석 완료된 결과 즉시 반환 (Gemini 호출 없음)
// 퀀트봇 탭 자동 로드용 — 탭 진입 시 수동 클릭 없이 바로 표시
// ⚠️ :stockCode 와일드카드 라우트보다 반드시 위에 등록해야 함
researchRoutes.get('/research/dart/cached', async (c) => {
  try {
    const codesParam = c.req.query('codes');
    if (!codesParam) return c.json({ ok: true, results: [] });
    const codes = codesParam.split(',').filter((c) => /^\d{6}$/.test(c)).slice(0, 30);
    if (codes.length === 0) return c.json({ ok: true, results: [] });
    const results = await getCachedDartResults(codes);
    return c.json({ ok: true, count: results.length, results });
  } catch (err: any) {
    logger.warn(`DART 캐시 조회 실패: ${err.message}`, { component: 'RESEARCH' });
    return c.json({ ok: true, results: [] });
  }
});

// GET /api/research/dart/:stockCode — DART 재무제표 + Gemini AI 분석 (GCP Vertex AI)
// query: year(선택), quarter(선택: annual|h1|q1|q3)
researchRoutes.get('/research/dart/:stockCode', async (c) => {
  try {
    const stockCode = c.req.param('stockCode');
    if (!/^\d{6}$/.test(stockCode)) return c.json({ error: '종목코드 형식 오류 (6자리 숫자)' }, 400);

    const year = c.req.query('year') ?? undefined;
    const rawQ = c.req.query('quarter') ?? 'annual';
    const quarter = ['annual', 'h1', 'q1', 'q3'].includes(rawQ)
      ? (rawQ as 'annual' | 'h1' | 'q1' | 'q3')
      : 'annual';

    logger.info(`DART 리서치 요청: ${stockCode} ${year ?? 'auto'}년 ${quarter}`, { component: 'RESEARCH' });
    const result = await runDartResearch(stockCode, { year, quarter });

    return c.json({ ok: true, result });
  } catch (err: any) {
    logger.warn(`DART 리서치 실패: ${err.message}`, { component: 'RESEARCH' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /api/research/dart/batch — 다수 종목 일괄 DART 분석
researchRoutes.post('/research/dart/batch', async (c) => {
  try {
    const body = await c.req.json<{ stockCodes: string[]; year?: string; quarter?: string }>();
    if (!Array.isArray(body.stockCodes) || body.stockCodes.length === 0) {
      return c.json({ error: 'stockCodes 배열이 필요합니다' }, 400);
    }
    const codes = body.stockCodes.filter((c) => /^\d{6}$/.test(c)).slice(0, 20); // 최대 20종목
    const quarter = ['annual', 'h1', 'q1', 'q3'].includes(body.quarter ?? '')
      ? (body.quarter as 'annual' | 'h1' | 'q1' | 'q3')
      : 'annual';

    logger.info(`DART 배치 리서치 시작: ${codes.length}종목`, { component: 'RESEARCH' });
    const results = await runDartResearchBatch(codes, { year: body.year, quarter });
    return c.json({ ok: true, count: results.length, results });
  } catch (err: any) {
    logger.warn(`DART 배치 리서치 실패: ${err.message}`, { component: 'RESEARCH' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /api/research/sec/:ticker — SEC EDGAR 재무제표 + Gemini AI 분석 (미국주식)
researchRoutes.get('/research/sec/:ticker', async (c) => {
  try {
    const ticker = c.req.param('ticker').toUpperCase();
    if (!/^[A-Z]{1,5}$/.test(ticker)) return c.json({ error: '티커 형식 오류 (1~5자 영문)' }, 400);

    logger.info(`SEC 리서치 요청: ${ticker}`, { component: 'RESEARCH' });
    const result = await runSecResearch(ticker);
    return c.json({ ok: true, result });
  } catch (err: any) {
    logger.warn(`SEC 리서치 실패: ${err.message}`, { component: 'RESEARCH' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /api/research/sec/batch — 다수 미국 종목 일괄 SEC 분석
researchRoutes.post('/research/sec/batch', async (c) => {
  try {
    const body = await c.req.json<{ tickers: string[] }>();
    if (!Array.isArray(body.tickers) || body.tickers.length === 0) {
      return c.json({ error: 'tickers 배열이 필요합니다' }, 400);
    }
    const tickers = body.tickers
      .map((t) => t.toUpperCase())
      .filter((t) => /^[A-Z]{1,5}$/.test(t))
      .slice(0, 10); // 최대 10종목

    logger.info(`SEC 배치 리서치 시작: ${tickers.length}종목`, { component: 'RESEARCH' });
    const results = await runSecResearchBatch(tickers);
    return c.json({ ok: true, count: results.length, results });
  } catch (err: any) {
    logger.warn(`SEC 배치 리서치 실패: ${err.message}`, { component: 'RESEARCH' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});
