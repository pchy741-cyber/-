import { XMLParser } from 'fast-xml-parser';
import { getActiveWatchlist } from '../db/client.js';
import { logger } from '../utils/logger.js';

/**
 * 뉴스 RSS 자동 수집기
 *
 * 장중 15분마다 실행 → 감시 종목 관련 뉴스를 자동 수집
 * Track A 파이프라인의 additionalSources로 자동 주입
 *
 * 소스:
 * - Google News RSS (한국 금융 뉴스)
 * - 네이버 금융 뉴스 RSS
 */

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
});

// 수집된 뉴스 메모리 캐시 (당일만 유지)
let todayNews: Map<string, NewsItem[]> = new Map();
let lastCollectDate = '';

interface NewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: string;
  stockCode?: string;
  relevance: 'HIGH' | 'MEDIUM' | 'LOW';
}

/**
 * Google News RSS 수집 (안정적 XML 파싱)
 */
async function fetchGoogleNews(query: string): Promise<NewsItem[]> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} 주식`)}&hl=ko&gl=KR&ceid=KR:ko`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'QUANTOPS/0.2.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return [];

    const xml = await res.text();
    const parsed = xmlParser.parse(xml);

    const items: NewsItem[] = [];
    const rssItems = parsed?.rss?.channel?.item;
    if (!rssItems) return [];

    const itemArray = Array.isArray(rssItems) ? rssItems : [rssItems];

    for (const item of itemArray.slice(0, 5)) {
      const title = cleanTitle(String(item.title ?? ''));
      const link = String(item.link ?? '');
      const pubDate = String(item.pubDate ?? '');

      if (title && title.length > 5) {
        items.push({
          title,
          link,
          source: 'Google News',
          publishedAt: pubDate,
          relevance: 'MEDIUM',
        });
      }
    }

    return items;
  } catch (error) {
    logger.warn(`뉴스 수집 실패 (${query}): ${error}`, { component: 'NEWS' });
    return [];
  }
}

/**
 * 네이버 금융 뉴스 RSS 수집 (보조 소스)
 */
async function fetchNaverNews(stockName: string): Promise<NewsItem[]> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${stockName} site:naver.com`)}&hl=ko&gl=KR&ceid=KR:ko`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'QUANTOPS/0.2.0' },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return [];

    const xml = await res.text();
    const parsed = xmlParser.parse(xml);

    const rssItems = parsed?.rss?.channel?.item;
    if (!rssItems) return [];

    const itemArray = Array.isArray(rssItems) ? rssItems : [rssItems];

    return itemArray.slice(0, 3).map((item: any) => ({
      title: cleanTitle(String(item.title ?? '')),
      link: String(item.link ?? ''),
      source: 'Naver',
      publishedAt: String(item.pubDate ?? ''),
      relevance: 'MEDIUM' as const,
    })).filter((item: NewsItem) => item.title.length > 5);
  } catch {
    return [];
  }
}

/** CDATA 및 HTML 태그 정리 */
function cleanTitle(title: string): string {
  return title
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

/**
 * 감시 종목별 뉴스 일괄 수집
 */
export async function collectWatchlistNews(): Promise<string> {
  const today = new Date().toISOString().split('T')[0];

  // 날짜 바뀌면 캐시 초기화
  if (lastCollectDate !== today) {
    todayNews = new Map();
    lastCollectDate = today;
  }

  const watchlist = await getActiveWatchlist();
  if (watchlist.length === 0) return '';

  let newCount = 0;

  // 종목별 뉴스 수집 (3개씩 배치, rate limit 대응)
  const batchSize = 3;
  for (let i = 0; i < watchlist.length; i += batchSize) {
    const batch = watchlist.slice(i, i + batchSize);

    const results = await Promise.allSettled(
      batch.flatMap((stock) => [
        fetchGoogleNews(stock.stock_name),
        fetchNaverNews(stock.stock_name),
      ]),
    );

    // 2개씩 묶어서 (Google + Naver) 합산
    for (let j = 0; j < batch.length; j++) {
      const stockCode = batch[j].stock_code;
      const existing = todayNews.get(stockCode) ?? [];

      const googleResult = results[j * 2];
      const naverResult = results[j * 2 + 1];

      const newItems: NewsItem[] = [];
      if (googleResult.status === 'fulfilled') newItems.push(...googleResult.value);
      if (naverResult.status === 'fulfilled') newItems.push(...naverResult.value);

      // 중복 제거
      const filtered = newItems.filter((item) => !existing.some((e) => e.title === item.title));
      if (filtered.length > 0) {
        todayNews.set(stockCode, [...existing, ...filtered]);
        newCount += filtered.length;
      }
    }

    // rate limit
    if (i + batchSize < watchlist.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (newCount > 0) {
    logger.info(`📰 뉴스 ${newCount}건 신규 수집 (총 ${getTotalNewsCount()}건)`, { component: 'NEWS' });
  }

  return formatNewsForAI();
}

/**
 * AI 파이프라인용 뉴스 텍스트 포맷
 */
function formatNewsForAI(): string {
  if (todayNews.size === 0) return '오늘 수집된 뉴스 없음';

  const lines: string[] = ['## 오늘 자동 수집된 뉴스'];

  for (const [stockCode, items] of todayNews.entries()) {
    if (items.length === 0) continue;
    lines.push(`\n### ${stockCode}`);
    for (const item of items.slice(0, 3)) {
      lines.push(`- ${item.title} (${item.source})`);
    }
  }

  return lines.join('\n');
}

function getTotalNewsCount(): number {
  let count = 0;
  for (const items of todayNews.values()) {
    count += items.length;
  }
  return count;
}

/**
 * 오늘 수집된 뉴스 반환 (API용)
 */
export function getTodayNews(): Map<string, NewsItem[]> {
  return todayNews;
}
