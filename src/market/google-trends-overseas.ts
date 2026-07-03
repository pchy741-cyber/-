/**
 * Google Trends 해외주식 연동 (#6)
 *
 * US Google Trends에서 감시 종목의 트렌딩 여부를 확인하여
 * 매수 스코어 보너스/페널티 적용 소스 데이터 제공
 */
import { logger } from '../utils/logger.js';

export interface OverseasTrendSignal {
  stockCode: string;
  companyName: string;
  rank: number;
  isHot: boolean;
  traffic?: string;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6시간
let _cache: { trends: Array<{ title: string; traffic?: string }>; fetchedAt: number } | null = null;

async function fetchUsTrending(): Promise<Array<{ title: string; traffic?: string }>> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return [];

  try {
    const url = `https://serpapi.com/search.json?engine=google_trends_trending_now&geo=US&hl=en&api_key=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as {
      trending_searches?: Array<{ query: string; search_volume?: string }>;
      daily_searches?: Array<Array<{ title: { query: string }; traffic?: string }>>;
    };

    if (Array.isArray(data.trending_searches)) {
      return data.trending_searches.map((t) => ({ title: t.query, traffic: t.search_volume }));
    }
    if (Array.isArray(data.daily_searches)) {
      return data.daily_searches.flat().map((t) => ({ title: t.title?.query ?? '', traffic: t.traffic }));
    }
    return [];
  } catch (err) {
    logger.debug(`US Google Trends 조회 실패: ${err}`, { component: 'GOOGLE_TRENDS' });
    return [];
  }
}

/**
 * 해외 감시 종목의 Google Trends 트렌딩 신호 확인
 * stockCode + name 매칭 (e.g., NVDA ↔ "NVIDIA", TSLA ↔ "Tesla")
 */
export async function getOverseasTrendSignals(
  stocks: Array<{ code: string; name: string }>,
): Promise<OverseasTrendSignal[]> {
  try {
    if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
      // use cache
    } else {
      const trends = await fetchUsTrending();
      if (trends.length > 0) {
        _cache = { trends, fetchedAt: Date.now() };
        logger.info(`US Google Trends ${trends.length}개 로드`, { component: 'GOOGLE_TRENDS' });
      }
    }

    if (!_cache || _cache.trends.length === 0) return [];

    const signals: OverseasTrendSignal[] = [];
    const trendTitlesLower = _cache.trends.map((t) => t.title.toLowerCase());

    for (const { code, name } of stocks) {
      const codeLower = code.toLowerCase();
      const nameLower = name.toLowerCase().split(' ')[0]; // 첫 단어 매칭 (e.g., "nvidia", "tesla")

      const idx = trendTitlesLower.findIndex(
        (t) => t.includes(codeLower) || t.includes(nameLower) || nameLower.includes(t.slice(0, 4)),
      );

      if (idx >= 0) {
        signals.push({
          stockCode: code,
          companyName: name,
          rank: idx + 1,
          isHot: idx < 20,
          traffic: _cache.trends[idx].traffic,
        });
      }
    }

    return signals;
  } catch (err) {
    logger.debug(`Overseas Trends 조회 실패: ${err}`, { component: 'GOOGLE_TRENDS' });
    return [];
  }
}
