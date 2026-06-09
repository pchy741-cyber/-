/**
 * Groq 뉴스 감성 분석 (무료 LLM)
 *
 * 뉴스 수집 우선순위:
 *   1. SerpApi Google News (SERPAPI_KEY 있으면) — 구조화, 정확
 *   2. Google News RSS 폴백 — API 키 불필요
 *
 * - Groq Llama 3.3 70B로 감성 분석 → -100~100 점수
 * - 배치 처리: 전 종목을 한 번의 Groq 호출로 처리 (rate limit 보호)
 * - 1시간 캐시 (SerpApi 월 250 한도 보호)
 */

import { logger } from '../../utils/logger.js';

export interface GroqNewsSentiment {
  stockCode: string;
  companyName: string;
  score: number;        // -100(극부정) ~ 100(극긍정)
  summary: string;
  articleCount: number;
  newsSource: 'serpapi' | 'rss';
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const _cache = new Map<string, { data: GroqNewsSentiment; fetchedAt: number }>();

// ── SerpApi Google News 수집 ──────────────────────────────────────
async function fetchNewsViaSerpApi(companyName: string): Promise<string[]> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error('SERPAPI_KEY 미설정');

  const q = encodeURIComponent(`${companyName} 주식`);
  const url = `https://serpapi.com/search.json?engine=google_news&q=${q}&hl=ko&gl=KR&api_key=${apiKey}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`SerpApi News HTTP ${res.status}`);

  const data = (await res.json()) as {
    news_results?: Array<{ title?: string; snippet?: string }>;
  };

  return (data.news_results ?? [])
    .slice(0, 7)
    .map((n) => n.title ?? n.snippet ?? '')
    .filter(Boolean);
}

// ── Google News RSS 폴백 ──────────────────────────────────────────
async function fetchNewsViaRss(companyName: string): Promise<string[]> {
  const query = encodeURIComponent(`${companyName} 주식`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=ko&gl=KR&ceid=KR:ko`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) return [];

  const xml = await res.text();
  const titles: string[] = [];
  const re = /<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const t = m[1].trim();
    if (!t.includes('Google 뉴스') && !t.includes('Google News')) titles.push(t);
    if (titles.length >= 5) break;
  }
  return titles;
}

async function fetchHeadlines(
  companyName: string,
): Promise<{ headlines: string[]; source: 'serpapi' | 'rss' }> {
  if (process.env.SERPAPI_KEY) {
    try {
      const headlines = await fetchNewsViaSerpApi(companyName);
      return { headlines, source: 'serpapi' };
    } catch (err) {
      logger.debug(`SerpApi 뉴스 실패 → RSS 폴백 (${companyName}): ${err}`, {
        component: 'GROQ_NEWS',
      });
    }
  }
  const headlines = await fetchNewsViaRss(companyName);
  return { headlines, source: 'rss' };
}

// ── Groq 배치 감성 분석 ───────────────────────────────────────────
async function analyzeWithGroq(
  items: Array<{ stockCode: string; companyName: string; headlines: string[] }>,
): Promise<Record<string, { score: number; summary: string }>> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return {};

  const { default: OpenAI } = await import('openai');
  const groq = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' });

  const prompt = `다음 한국 주식 종목들의 최신 뉴스 헤드라인을 분석해 투자 감성 점수를 매겨주세요.

${items
  .map(
    (it) => `종목: ${it.companyName} (${it.stockCode})
헤드라인:
${it.headlines.length > 0 ? it.headlines.map((h) => `- ${h}`).join('\n') : '- (헤드라인 없음)'}`,
  )
  .join('\n\n')}

각 종목에 대해 JSON으로 응답하세요:
{
  "종목코드": { "score": -100~100, "summary": "한줄요약(20자이내)" }
}
score 기준: 100(극호재), 50(호재), 0(중립), -50(악재), -100(극악재)`;

  const resp = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 1024,
  });

  const text = resp.choices[0]?.message?.content ?? '{}';
  return JSON.parse(text);
}

/**
 * 감시목록 종목들의 뉴스 감성 분석
 * GROQ_API_KEY 없으면 빈 배열 반환 (파이프라인 차단 없음)
 */
export async function analyzeNewsWithGroq(
  stocks: Array<{ stockCode: string; companyName: string }>,
): Promise<GroqNewsSentiment[]> {
  if (!process.env.GROQ_API_KEY) {
    logger.debug('GROQ_API_KEY 미설정 → Groq 뉴스 분석 스킵', { component: 'GROQ_NEWS' });
    return [];
  }

  try {
    const now = Date.now();

    const cached = stocks
      .map((s) => {
        const hit = _cache.get(s.stockCode);
        return hit && now - hit.fetchedAt < CACHE_TTL_MS ? hit.data : null;
      })
      .filter(Boolean) as GroqNewsSentiment[];

    const stale = stocks.filter((s) => {
      const hit = _cache.get(s.stockCode);
      return !hit || now - hit.fetchedAt >= CACHE_TTL_MS;
    });

    if (stale.length === 0) return cached;

    // 최대 10종목 (rate limit 보호)
    const targets = stale.slice(0, 10);
    const headlineResults = await Promise.allSettled(
      targets.map((s) => fetchHeadlines(s.companyName)),
    );

    const items = targets.map((s, i) => ({
      stockCode: s.stockCode,
      companyName: s.companyName,
      headlines:
        headlineResults[i].status === 'fulfilled'
          ? headlineResults[i].value.headlines
          : [],
    }));
    const sources = targets.map((_, i) =>
      headlineResults[i].status === 'fulfilled'
        ? headlineResults[i].value.source
        : ('rss' as const),
    );

    const groqResult = await analyzeWithGroq(items);

    const fresh: GroqNewsSentiment[] = items.map((it, i) => {
      const gr = groqResult[it.stockCode] ?? { score: 0, summary: '데이터 없음' };
      const sentiment: GroqNewsSentiment = {
        stockCode: it.stockCode,
        companyName: it.companyName,
        score: Math.max(-100, Math.min(100, Number(gr.score) || 0)),
        summary: String(gr.summary ?? ''),
        articleCount: it.headlines.length,
        newsSource: sources[i],
      };
      _cache.set(it.stockCode, { data: sentiment, fetchedAt: now });
      return sentiment;
    });

    const serpCount = fresh.filter((f) => f.newsSource === 'serpapi').length;
    logger.info(
      `Groq 뉴스 분석 ${fresh.length}종목 완료 (SerpApi ${serpCount}건, RSS ${fresh.length - serpCount}건, 캐시 ${cached.length}건)`,
      { component: 'GROQ_NEWS' },
    );

    return [...cached, ...fresh];
  } catch (err) {
    logger.warn(`Groq 뉴스 분석 실패 (스킵): ${err}`, { component: 'GROQ_NEWS' });
    return [];
  }
}
