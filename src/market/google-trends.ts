/**
 * Google Trends 한국 실시간 트렌딩 (SerpApi 기반)
 *
 * - SerpApi google_trends_trending_now 엔드포인트 사용 (구조화된 JSON, 안정적)
 * - SERPAPI_KEY 없으면 비공식 RSS 폴백
 * - 6시간 캐시 (월 250회 무료 한도 보호: 하루 4회 × 30일 = 120회)
 */

import { logger } from '../utils/logger.js';

export interface TrendSignal {
  stockCode: string;
  companyName: string;
  rank: number; // 1-based 순위
  isHot: boolean; // rank < 20
  traffic?: string; // 예: "500K+"
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let _cache: { trends: Array<{ title: string; traffic?: string }>; fetchedAt: number } | null = null;

// ── SerpApi Google Trends Trending Now ────────────────────────────
async function fetchViaSerpApi(): Promise<Array<{ title: string; traffic?: string }>> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error('SERPAPI_KEY 미설정');

  const url = `https://serpapi.com/search.json?engine=google_trends_trending_now&geo=KR&hl=ko&api_key=${apiKey}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`SerpApi HTTP ${res.status}`);

  const data = (await res.json()) as {
    trending_searches?: Array<{ query: string; search_volume?: string }>;
    daily_searches?: Array<Array<{ title: { query: string }; traffic?: string }>>;
  };

  // realtime 형식
  if (Array.isArray(data.trending_searches)) {
    return data.trending_searches.map((t) => ({
      title: t.query,
      traffic: t.search_volume,
    }));
  }

  // daily 형식 (fallback)
  if (Array.isArray(data.daily_searches)) {
    return data.daily_searches.flat().map((t) => ({ title: t.title?.query ?? '', traffic: t.traffic }));
  }

  return [];
}

// ── 비공식 RSS 폴백 ───────────────────────────────────────────────
async function fetchViaRss(): Promise<Array<{ title: string }>> {
  const res = await fetch('https://trends.google.com/trends/trendingsearches/daily/rss?geo=KR', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);

  const xml = await res.text();
  const titles: string[] = [];
  const cdataRe = /<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g;
  const plainRe = /<title>([^<]+)<\/title>/g;
  let m: RegExpExecArray | null = cdataRe.exec(xml);
  while (m !== null) {
    titles.push(m[1].trim());
    m = cdataRe.exec(xml);
  }
  if (titles.length === 0) {
    m = plainRe.exec(xml);
    while (m !== null) {
      const t = m[1].trim();
      if (t !== 'Daily Search Trends') titles.push(t);
      m = plainRe.exec(xml);
    }
  }
  return titles.map((t) => ({ title: t }));
}

async function fetchKrTrending(): Promise<Array<{ title: string; traffic?: string }>> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) return _cache.trends;

  let trends: Array<{ title: string; traffic?: string }> = [];
  let source = 'SerpApi';

  try {
    trends = await fetchViaSerpApi();
    logger.info(`Google Trends KR (SerpApi) ${trends.length}개 키워드 로드`, {
      component: 'GOOGLE_TRENDS',
    });
  } catch (err) {
    source = 'RSS폴백';
    logger.warn(`SerpApi 실패 → RSS 폴백: ${err}`, { component: 'GOOGLE_TRENDS' });
    trends = await fetchViaRss();
    logger.info(`Google Trends KR (RSS) ${trends.length}개 키워드 로드`, {
      component: 'GOOGLE_TRENDS',
    });
  }

  _cache = { trends, fetchedAt: Date.now() };
  logger.debug(`Trends 캐시 갱신 (${source})`, { component: 'GOOGLE_TRENDS' });
  return trends;
}

/**
 * 감시목록 종목 → Google Trends 트렌딩 여부 확인
 */
export async function getKrTrendSignals(
  stocks: Array<{ stockCode: string; companyName: string }>,
): Promise<TrendSignal[]> {
  try {
    const trends = await fetchKrTrending();
    const signals: TrendSignal[] = [];

    for (const { stockCode, companyName } of stocks) {
      const key = companyName.slice(0, 4);
      const idx = trends.findIndex((t) => t.title.includes(key) || key.includes(t.title.slice(0, 2)));
      if (idx >= 0) {
        signals.push({
          stockCode,
          companyName,
          rank: idx + 1,
          isHot: idx < 20,
          traffic: trends[idx].traffic,
        });
      }
    }

    return signals;
  } catch (err) {
    logger.warn(`Google Trends 조회 실패 (스킵): ${err}`, { component: 'GOOGLE_TRENDS' });
    return [];
  }
}
