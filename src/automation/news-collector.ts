import { getActiveWatchlist } from '../db/client.js';
import { logger } from '../utils/logger.js';

// import { parse as parseXml } from 'fast-xml-parser'; // TODO: Add fast-xml-parser for robust parsing

/**
 * 뉴스 RSS 자동 수집기
 *
 * 장중 15분마다 실행 → 감시 종목 관련 뉴스를 자동 수집
 * Track A 파이프라인의 additionalSources로 자동 주입
 *
 * 소스:
 * - 네이버 금융 뉴스 RSS
 * - 한국거래소 공시 (DART)
 * - TODO: DART API 연동하여 공시정보 직접 수집 (자사주 매입, 대규모 계약 등)
 */

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
 * 네이버 금융 뉴스 RSS 수집
 */
async function fetchNaverFinanceNews(query: string): Promise<NewsItem[]> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} 주식`)}&hl=ko&gl=KR&ceid=KR:ko`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'QUANTOPS/0.2.0' },
      signal: AbortSignal.timeout(10000), // 10초 타임아웃
    });

    if (!res.ok) return [];

    const xml = await res.text();

    // 간단한 XML 파싱 (의존성 없이).
    // 참고: 이 방식은 RSS 구조 변경에 취약합니다.
    // 향후 fast-xml-parser와 같은 라이브러리로 교체하는 것을 권장합니다.
    const items: NewsItem[] = [];
    const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

    for (const match of itemMatches) {
      const content = match[1];
      const title =
        content
          .match(/<title>([\s\S]*?)<\/title>/)?.[1]
          ?.replace(/<!\[CDATA\[|\]\]>/g, '')
          .trim() ?? '';
      const link = content.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? '';
      const pubDate = content.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? '';

      if (title) {
        items.push({
          title,
          link,
          source: 'Google News',
          publishedAt: pubDate,
          relevance: 'MEDIUM',
        });
      }
    }

    return items.slice(0, 5); // 종목당 최대 5개
  } catch (error) {
    logger.warn(`뉴스 수집 실패 (${query}): ${error}`, { component: 'NEWS' });
    return [];
  }
}

/**
 * TODO: DART 공시 정보 수집
 */
async function _fetchDartDisclosures(_stockCode: string): Promise<NewsItem[]> {
  // DART API (Open DART)를 사용하여 주요 공시 (e.g., 단일판매공급계약, 자기주식취득)를 가져오는 로직 구현
  return [];
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

    const results = await Promise.allSettled(batch.map((stock) => fetchNaverFinanceNews(stock.stock_name)));

    results.forEach((result, idx) => {
      const stockCode = batch[idx].stock_code;
      if (result.status === 'fulfilled' && result.value.length > 0) {
        const existing = todayNews.get(stockCode) ?? [];
        const newItems = result.value.filter((item) => !existing.some((e) => e.title === item.title));
        todayNews.set(stockCode, [...existing, ...newItems]);
        newCount += newItems.length;
      }
    });

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
      // 종목당 3개까지만 AI에 전달
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
