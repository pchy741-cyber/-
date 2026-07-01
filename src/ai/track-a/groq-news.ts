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
import { logTokenUsage, calcGroqCost, calcClaudeApiCost } from '../../utils/ai-token-logger.js';

export interface GroqNewsSentiment {
  stockCode: string;
  companyName: string;
  score: number; // -100(극부정) ~ 100(극긍정)
  summary: string;
  articleCount: number;
  newsSource: 'serpapi' | 'rss';
}

// 황금시간(장중): 15분 캐시, 장외: 1시간 캐시
function getCacheTtlMs(): number {
  const now = new Date();
  const kstH = (now.getUTCHours() + 9) % 24;
  const kstM = now.getUTCMinutes();
  const t = kstH * 100 + kstM;
  const inMarket = t >= 900 && t <= 1530;
  return inMarket ? 15 * 60 * 1000 : 60 * 60 * 1000;
}
const CACHE_TTL_MS = 60 * 60 * 1000; // 기본값 (하위호환)
const MAX_BATCH_STOCKS = 10; // 뉴스 배치 최대 종목 수 (rate limit 보호)
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
  // v20: 구글뉴스 RSS는 CDATA 래핑 없이 평문 <title>로 내려와 기존 정규식이 항상 0건 매치였음
  const re = /<title>([^<]+)<\/title>/g;
  let m: RegExpExecArray | null = re.exec(xml);
  while (m !== null) {
    const t = m[1].trim();
    if (!t.includes('Google 뉴스') && !t.includes('Google News')) titles.push(t);
    if (titles.length >= 5) break;
    m = re.exec(xml);
  }
  return titles;
}

async function fetchHeadlines(companyName: string): Promise<{ headlines: string[]; source: 'serpapi' | 'rss' }> {
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

// ── Claude Haiku 배치 감성 분석 (2026-06-29: Groq → Claude 이동) ──
async function analyzeWithClaude(
  items: Array<{ stockCode: string; companyName: string; headlines: string[] }>,
): Promise<Record<string, { score: number; summary: string }>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return analyzeWithGroqFallback(items); // Claude 키 없으면 Groq 폴백

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const prompt = `다음 한국 주식 종목들의 최신 뉴스 헤드라인을 분석해 투자 감성 점수를 매겨주세요.

${items
  .map(
    (it) => `종목: ${it.companyName} (${it.stockCode})
헤드라인:
${it.headlines.length > 0 ? it.headlines.map((h) => `- ${h}`).join('\n') : '- (헤드라인 없음)'}`,
  )
  .join('\n\n')}

각 종목에 대해 JSON으로 응답하세요 (JSON만, 다른 텍스트 금지):
{
  "종목코드": { "score": -100~100, "summary": "한줄요약(20자이내)" }
}
score 기준: 100(극호재), 50(호재), 0(중립), -50(악재), -100(극악재)`;

  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  // 토큰 사용량 기록
  const inputTok = resp.usage?.input_tokens ?? 0;
  const outputTok = resp.usage?.output_tokens ?? 0;
  logTokenUsage({
    provider: 'claude-api', model: 'claude-haiku-4.5',
    inputTokens: inputTok, outputTokens: outputTok,
    costUsd: calcClaudeApiCost(inputTok, outputTok),
    label: 'news',
  });

  const text = resp.content[0]?.type === 'text' ? resp.content[0].text : '{}';
  // JSON 블록 추출 (```json ... ``` 래핑 대응)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn('Claude 뉴스 감성 JSON 추출 실패', { component: 'CLAUDE_NEWS', rawPreview: text.slice(0, 200) });
    return {};
  }
  try {
    return JSON.parse(jsonMatch[0]) as Record<string, { score: number; summary: string }>;
  } catch {
    logger.warn('Claude 뉴스 감성 JSON 파싱 실패', { component: 'CLAUDE_NEWS', rawPreview: text.slice(0, 200) });
    return {};
  }
}

// ── Groq 폴백 (ANTHROPIC_API_KEY 없을 때) ────────────────────────
async function analyzeWithGroqFallback(
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

  if (resp.usage) {
    const inputTok = resp.usage.prompt_tokens ?? 0;
    const outputTok = resp.usage.completion_tokens ?? 0;
    logTokenUsage({
      provider: 'groq', model: 'llama-3.3-70b',
      inputTokens: inputTok, outputTokens: outputTok,
      costUsd: calcGroqCost(inputTok, outputTok),
      label: 'news',
    });
  }

  const text = resp.choices[0]?.message?.content ?? '{}';
  try {
    return JSON.parse(text) as Record<string, { score: number; summary: string }>;
  } catch {
    logger.warn('Groq 감성 응답 JSON 파싱 실패', { component: 'GROQ_NEWS', rawPreview: text.slice(0, 200) });
    return {};
  }
}

// ── 키워드 기반 간이 감성 분석 (GROQ_API_KEY 없을 때 폴백) ──
const BULL_KEYWORDS = ['상승', '급등', '반등', '신고가', '호재', '돌파', '매수', '랠리', '회복', '호실적', '어닝서프라이즈', '수주', '계약', 'surge', 'rally', 'record', 'bullish', 'beat'];
const BEAR_KEYWORDS = ['하락', '급락', '폭락', '악재', '매도', '붕괴', '적자', '하향', '위기', '리스크', '공포', 'plunge', 'crash', 'bearish', 'miss', 'downgrade'];

function keywordSentiment(headlines: string[]): { score: number; summary: string } {
  if (headlines.length === 0) return { score: 0, summary: '뉴스 없음' };
  const text = headlines.join(' ').toLowerCase();
  let bull = 0;
  let bear = 0;
  for (const kw of BULL_KEYWORDS) if (text.includes(kw)) bull++;
  for (const kw of BEAR_KEYWORDS) if (text.includes(kw)) bear++;
  const raw = bull - bear;
  const score = Math.max(-100, Math.min(100, raw * 20));
  const mood = score > 20 ? '긍정' : score < -20 ? '부정' : '중립';
  return { score, summary: `${mood} (헤드라인 ${headlines.length}건, 호재키워드 ${bull}건, 악재 ${bear}건)` };
}

/**
 * 감시목록 종목들의 뉴스 감성 분석
 * GROQ_API_KEY 있으면 → Groq AI 분석
 * GROQ_API_KEY 없으면 → RSS + 키워드 기반 간이 분석 (빈 배열 X)
 */
export async function analyzeNewsWithGroq(
  stocks: Array<{ stockCode: string; companyName: string }>,
): Promise<GroqNewsSentiment[]> {
  const useClaude = !!process.env.ANTHROPIC_API_KEY;
  const useGroq = !useClaude && !!process.env.GROQ_API_KEY;
  if (!useClaude && !useGroq) {
    logger.info('ANTHROPIC/GROQ API_KEY 미설정 → RSS + 키워드 기반 감성 분석 폴백', { component: 'CLAUDE_NEWS' });
  }

  try {
    const now = Date.now();
    const ttl = getCacheTtlMs();

    const cached = stocks
      .map((s) => {
        const hit = _cache.get(s.stockCode);
        return hit && now - hit.fetchedAt < ttl ? hit.data : null;
      })
      .filter(Boolean) as GroqNewsSentiment[];

    const stale = stocks.filter((s) => {
      const hit = _cache.get(s.stockCode);
      return !hit || now - hit.fetchedAt >= ttl;
    });

    if (stale.length === 0) return cached;

    // 최대 10종목 (rate limit 보호)
    const targets = stale.slice(0, MAX_BATCH_STOCKS);
    const headlineResults = await Promise.allSettled(targets.map((s) => fetchHeadlines(s.companyName)));

    const items = targets.map((s, i) => ({
      stockCode: s.stockCode,
      companyName: s.companyName,
      headlines: headlineResults[i].status === 'fulfilled' ? headlineResults[i].value.headlines : [],
    }));
    const sources = targets.map((_, i) =>
      headlineResults[i].status === 'fulfilled' ? headlineResults[i].value.source : ('rss' as const),
    );

    const groqResult = useClaude ? await analyzeWithClaude(items) : useGroq ? await analyzeWithGroqFallback(items) : {};

    const fresh: GroqNewsSentiment[] = items.map((it, i) => {
      const gr = groqResult[it.stockCode] ?? keywordSentiment(it.headlines);
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
    const engine = useClaude ? 'Claude' : useGroq ? 'Groq' : 'Keyword';
    logger.info(
      `${engine} 뉴스 분석 ${fresh.length}종목 완료 (SerpApi ${serpCount}건, RSS ${fresh.length - serpCount}건, 캐시 ${cached.length}건)`,
      { component: 'CLAUDE_NEWS' },
    );

    return [...cached, ...fresh];
  } catch (err) {
    logger.warn(`Groq 뉴스 분석 실패 (스킵): ${err}`, { component: 'GROQ_NEWS' });
    return [];
  }
}
