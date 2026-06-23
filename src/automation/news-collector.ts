import { XMLParser } from 'fast-xml-parser';
import { getActiveWatchlist } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { getKSTNow } from '../utils/time.js';

/**
 * 뉴스 RSS 자동 수집기
 *
 * 장중 15분마다 실행 → 감시 종목 관련 뉴스를 자동 수집
 * Track A 파이프라인의 additionalSources로 자동 주입
 *
 * 매크로 뉴스: Reuters · CNBC · AP Finance · MarketWatch · 연합뉴스 (글로벌 신뢰도)
 *            YouTube: 한경글로벌마켓 · 슈카월드 · 월가월부 · 한국경제TV · Yahoo Finance · CNBC TV
 * 종목 뉴스:   연합뉴스 · 한국경제 · 매일경제 · 서울경제만 수집
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
let lastNewsSuccessAt = 0; // 마지막 성공적 수집 타임스탬프 (ms) — 0 = 아직 수집 안됨
const NEWS_MAX_ENTRIES = 500; // 하루 최대 뉴스 엔트리 수 (메모리 누수 방지)

/** 마지막 뉴스 수집 성공 시각 (ms). 0이면 오늘 아직 수집 안됨. */
export function getLastNewsCollectedAt(): number {
  return lastNewsSuccessAt;
}

interface NewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: string;
  stockCode?: string;
  relevance: 'HIGH' | 'MEDIUM' | 'LOW';
}

// ─── 글로벌 매크로 뉴스 RSS 피드 ──────────────────────────────────────────────
// 시장 실제 영향력 있는 신뢰도 높은 소스만 포함
const MACRO_RSS_FEEDS = [
  // Reuters
  { url: 'https://feeds.reuters.com/reuters/businessNews', source: 'Reuters Business', max: 5 },
  { url: 'https://feeds.reuters.com/reuters/markets', source: 'Reuters Markets', max: 5 },
  // CNBC
  {
    url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664',
    source: 'CNBC Markets',
    max: 5,
  },
  {
    url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258',
    source: 'CNBC Finance',
    max: 3,
  },
  // AP Finance
  { url: 'https://feeds.apnews.com/rss/finance', source: 'AP Finance', max: 4 },
  // MarketWatch
  { url: 'https://feeds.marketwatch.com/marketwatch/topstories/', source: 'MarketWatch', max: 4 },
  // Yonhap (연합뉴스) — 한국 공신력 1위
  { url: 'https://www.yonhapnewstv.co.kr/browse/feed/?cat=0&category=economy', source: '연합뉴스', max: 4 },
  // YouTube — 미국 증시 한국어 해설
  {
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCWskYkV4c4S9D__rsfOl2JA',
    source: '한경글로벌마켓',
    max: 4,
  },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCsJ6RuBiTVWRX156FVbeaGg', source: '슈카월드', max: 3 },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCIipmgxpUxDmPP-ma3Ahvbw', source: '월가월부', max: 4 },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCF8AeLlUbEpKju6v1H6p8Eg', source: '한국경제TV', max: 3 },
  // YouTube — 미국 증시 영어 (US stocks)
  {
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCEAZeUIeJs0IjQiqTCdVSIg',
    source: 'Yahoo Finance',
    max: 3,
  },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCvJJ_dzjViJCoLf5uKUTwoA', source: 'CNBC TV', max: 2 },
] as const;

// 한국 종목 뉴스: 공신력 있는 경제지만 허용
const STOCK_NEWS_ALLOWED_DOMAINS = [
  'yonhapnews.co.kr',
  'yna.co.kr',
  'hankyung.com',
  'mk.co.kr',
  'sedaily.com',
  'einews.com',
  'etnews.com',
  'edaily.co.kr',
  'newsis.com',
  'news1.kr',
];

/** RSS XML을 파싱해서 NewsItem 배열로 변환 */
async function fetchRSSFeed(url: string, source: string, maxItems = 5): Promise<NewsItem[]> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIBot/0.5.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];

    const xml = await res.text();
    const parsed = xmlParser.parse(xml);

    const rssItems = parsed?.rss?.channel?.item ?? parsed?.feed?.entry;
    if (!rssItems) return [];

    const itemArray = Array.isArray(rssItems) ? rssItems : [rssItems];

    return itemArray
      .slice(0, maxItems)
      .map((item: any) => {
        const title = cleanTitle(String(item.title ?? ''));
        // Atom <link href="..."> vs RSS <link>
        const link = String(item.link?.['@_href'] ?? item.link ?? '');
        const pubDate = String(item.pubDate ?? item.updated ?? item.published ?? '');
        return { title, link, source, publishedAt: pubDate, relevance: 'HIGH' as const };
      })
      .filter((item) => item.title.length > 8);
  } catch (err) {
    logger.debug(`RSS 피드 조회 실패 (${source}): ${err}`, { component: 'NEWS' });
    return [];
  }
}

/**
 * 종목 뉴스: Google News RSS → 공신력 있는 도메인만 필터
 */
async function fetchStockNews(stockName: string): Promise<NewsItem[]> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${stockName} 주가 실적`)}&hl=ko&gl=KR&ceid=KR:ko`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIBot/0.5.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];

    const xml = await res.text();
    const parsed = xmlParser.parse(xml);

    const rssItems = parsed?.rss?.channel?.item;
    if (!rssItems) return [];

    const itemArray = Array.isArray(rssItems) ? rssItems : [rssItems];

    const results: NewsItem[] = [];
    for (const item of itemArray.slice(0, 15)) {
      const title = cleanTitle(String(item.title ?? ''));
      const link = String(item.link ?? '');
      const pubDate = String(item.pubDate ?? '');

      // 도메인 필터: 공신력 있는 출처만
      const isAllowed = STOCK_NEWS_ALLOWED_DOMAINS.some((domain) => link.includes(domain));
      if (!isAllowed) continue;

      if (title.length > 8) {
        results.push({ title, link, source: 'Stock News', publishedAt: pubDate, relevance: 'HIGH' });
      }
      if (results.length >= 5) break;
    }

    // 도메인 필터 통과 항목이 없으면 연합뉴스 직접 검색 시도
    if (results.length === 0) {
      const ynaUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(stockName)}&hl=ko&gl=KR&ceid=KR:ko&as_sites=yna.co.kr`;
      const ynaItems = await fetchRSSFeed(ynaUrl, '연합뉴스', 3);
      results.push(...ynaItems);
    }

    return results;
  } catch (err) {
    logger.debug(`종목 뉴스 조회 실패 (${stockName}): ${err}`, { component: 'NEWS' });
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
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * 감시 종목별 뉴스 일괄 수집
 */
export async function collectWatchlistNews(): Promise<string> {
  const today = getKSTNow().toISOString().split('T')[0];

  if (lastCollectDate !== today) {
    todayNews = new Map();
    lastCollectDate = today;
  }

  const watchlist = await getActiveWatchlist();
  if (watchlist.length === 0) return '';

  let newCount = 0;

  const batchSize = 3;
  for (let i = 0; i < watchlist.length; i += batchSize) {
    const batch = watchlist.slice(i, i + batchSize);

    const results = await Promise.allSettled(batch.map((stock) => fetchStockNews(stock.stock_name)));

    for (let j = 0; j < batch.length; j++) {
      const stockCode = batch[j].stock_code;
      const existing = todayNews.get(stockCode) ?? [];
      const result = results[j];

      if (result.status === 'fulfilled' && result.value.length > 0) {
        const filtered = result.value.filter((item) => !existing.some((e) => e.title === item.title));
        if (filtered.length > 0) {
          // 전체 뉴스 수 체크 — 최대 한도 초과 시 가장 오래된 종목 뉴스부터 제거
          const totalCount = getTotalNewsCount();
          if (totalCount + filtered.length > NEWS_MAX_ENTRIES) {
            // 가장 오래된 종목 키부터 제거 (Map 순서 = 삽입 순서)
            const keysToEvict = [...todayNews.keys()];
            let evicted = 0;
            for (const evictKey of keysToEvict) {
              if (totalCount - evicted + filtered.length <= NEWS_MAX_ENTRIES) break;
              const items = todayNews.get(evictKey);
              evicted += items?.length ?? 0;
              todayNews.delete(evictKey);
            }
          }
          todayNews.set(stockCode, [...existing, ...filtered]);
          newCount += filtered.length;
        }
      }
    }

    if (i + batchSize < watchlist.length) {
      await sleep(1000);
    }
  }

  if (newCount > 0) {
    lastNewsSuccessAt = Date.now();
    logger.info(`📰 뉴스 ${newCount}건 신규 수집 (총 ${getTotalNewsCount()}건)`, { component: 'NEWS' });
  } else if (getTotalNewsCount() > 0) {
    // 신규는 없지만 기존 뉴스 있음 → 수집기는 정상 작동 중
    lastNewsSuccessAt = Date.now();
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

// ─── 매크로 뉴스 캐시 ───────────────────────────────────────────────────────
let macroNewsCache: { headlines: MacroHeadline[]; collectedAt: number } = { headlines: [], collectedAt: 0 };

export interface MacroHeadline {
  title: string;
  link: string;
  source: string;
  publishedAt: string;
}

/** 매크로 뉴스 헤드라인 원본 배열 반환 (AI 프롬프트 주입용) */
export async function getMacroHeadlines(): Promise<MacroHeadline[]> {
  // 캐시 유효하면 즉시 반환
  if (Date.now() - macroNewsCache.collectedAt < 30 * 60 * 1000 && macroNewsCache.headlines.length > 0) {
    return macroNewsCache.headlines;
  }
  // 캐시 만료 → 수집 트리거 후 반환
  await collectMacroNews().catch(() => '');
  return macroNewsCache.headlines;
}

/**
 * 글로벌 매크로 뉴스 수집
 * Reuters · CNBC · AP Finance · MarketWatch · 연합뉴스
 * 캐시: 30분 유효
 */
export async function collectMacroNews(): Promise<string> {
  const now = Date.now();
  if (now - macroNewsCache.collectedAt < 30 * 60 * 1000 && macroNewsCache.headlines.length > 0) {
    return formatMacroForAPI(macroNewsCache.headlines);
  }

  const headlines: MacroHeadline[] = [];

  const results = await Promise.allSettled(
    MACRO_RSS_FEEDS.map((feed) => fetchRSSFeed(feed.url, feed.source, feed.max)),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const item of result.value) {
        headlines.push({ title: item.title, link: item.link, source: item.source, publishedAt: item.publishedAt });
      }
    }
  }

  macroNewsCache = { headlines, collectedAt: now };
  logger.info(`📰 매크로 뉴스 ${headlines.length}건 수집 (Reuters/CNBC/AP/MarketWatch/연합뉴스)`, {
    component: 'NEWS',
  });
  return formatMacroForAPI(headlines);
}

/** API 응답용: "[title](link) — source" 마크다운 형태 */
function formatMacroForAPI(headlines: MacroHeadline[]): string {
  if (headlines.length === 0) return '';
  return headlines.map((h) => `- [${h.title}](${h.link || '#'}) — ${h.source}`).join('\n');
}
