/**
 * 👽 Reddit WSB 멘션 spike 감지 — 소형주/모멘텀 신호
 *
 * 무료: Reddit OAuth (script app, 무료 발급 https://www.reddit.com/prefs/apps)
 * 무인증 모드: 공개 JSON 엔드포인트 사용 (rate limit 더 낮음)
 *
 * 추적:
 *  - r/wallstreetbets, r/stocks, r/StockMarket
 *  - $TICKER 또는 TICKER (3-5자 대문자) 매칭
 *  - 1시간 윈도우 vs 24시간 평균 → spike ratio
 *
 * Track A/Gemini 미관여 — 독립 momentum signal
 *
 * 활용:
 *  - spike >= 3x 이상 종목 자동 watchlist 추가
 *  - Telegram 알림
 *  - decision-flow의 momentum boost
 */

import { logger } from '../utils/logger.js';

const COMP = 'REDDIT';
const SUBREDDITS = ['wallstreetbets', 'stocks', 'StockMarket'];

// 일반 단어 (false positive 방지)
const STOPWORDS = new Set([
  'I',
  'A',
  'THE',
  'TO',
  'AND',
  'IS',
  'IT',
  'OR',
  'BE',
  'OF',
  'IN',
  'ON',
  'FOR',
  'NOT',
  'WITH',
  'AS',
  'IF',
  'BUT',
  'BY',
  'AT',
  'AN',
  'WE',
  'CAN',
  'GET',
  'GO',
  'SO',
  'NO',
  'DO',
  'UP',
  'MY',
  'ME',
  'OUT',
  'WHO',
  'YOU',
  'OK',
  'TLDR',
  'EDIT',
  'DD',
  'YOLO',
  'WSB',
  'CEO',
  'CFO',
  'COO',
  'IPO',
  'ATH',
  'ATL',
  'EOD',
  'PR',
  'FYI',
  'IMO',
  'IMHO',
  'TBH',
  'RIP',
  'OG',
  'AF',
  'LOL',
  'AI',
  'EV',
  'AR',
  'VR',
  'ML',
  'AM',
  'PM',
  'EPS',
  'PE',
  'PS',
  'PB',
  'EBT',
  'GDP',
  'CPI',
  'FED',
  'ETF',
  'SEC',
  'IRS',
  'IRA',
  'USA',
  'USD',
  'EU',
  'UK',
  'CN',
  'KR',
  'JP',
]);

export interface RedditMentionData {
  ticker: string;
  count1h: number;
  count24h: number;
  spikeRatio: number; // 1h vs 24h 평균
  subreddits: string[];
  /** spike 강도 (1-5, 5가 가장 강함) */
  spikeLevel: number;
  scoreAdjustment: number;
}

// 메모리 캐시 — 1시간 단위
let _cache: { ts: number; data: Map<string, RedditMentionData> } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1시간

async function fetchSubredditPosts(subreddit: string): Promise<string[]> {
  // 공개 JSON (인증 불필요, rate limit 더 낮음)
  const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=100`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'QuantOpsBot/1.0 (research)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logger.debug(`Reddit r/${subreddit} HTTP ${res.status}`, { component: COMP });
      return [];
    }
    const data = (await res.json()) as { data?: { children?: Array<{ data: { title?: string; selftext?: string } }> } };
    const posts = data.data?.children ?? [];
    return posts.map((p) => `${p.data.title ?? ''} ${p.data.selftext ?? ''}`).filter(Boolean);
  } catch (e) {
    logger.debug(`Reddit r/${subreddit} 실패: ${(e as Error).message}`, { component: COMP });
    return [];
  }
}

function extractTickers(texts: string[]): Map<string, number> {
  const counter = new Map<string, number>();
  const tickerRe = /(?:\$([A-Z]{2,5})|\b([A-Z]{3,5})\b)(?![A-Z])/g;
  for (const text of texts) {
    let m: RegExpExecArray | null = tickerRe.exec(text);
    while (m !== null) {
      const t = (m[1] || m[2] || '').toUpperCase();
      if (t.length >= 2 && t.length <= 5 && !STOPWORDS.has(t)) {
        counter.set(t, (counter.get(t) ?? 0) + 1);
      }
      m = tickerRe.exec(text);
    }
  }
  return counter;
}

export async function getRedditMentions(): Promise<Map<string, RedditMentionData>> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.data;
  try {
    // 1시간 윈도우 (current pull) + 24h baseline 추정 (이전 캐시와 비교)
    const allPosts: string[] = [];
    for (const sub of SUBREDDITS) {
      const posts = await fetchSubredditPosts(sub);
      allPosts.push(...posts);
      await new Promise((r) => setTimeout(r, 300)); // rate limit 안전
    }

    const counts1h = extractTickers(allPosts);
    const prevCache = _cache?.data ?? new Map<string, RedditMentionData>();
    const result = new Map<string, RedditMentionData>();

    for (const [ticker, count] of counts1h) {
      if (count < 3) continue; // 최소 3회 멘션
      const prev = prevCache.get(ticker);
      // 24h baseline = 이전 시점 count의 24배 추정 (정확치 않으나 spike 감지엔 충분)
      const baseline = prev ? prev.count24h : count * 6; // 첫 데이터면 평탄 가정
      const count24h = Math.max(baseline, count * 6);
      const spikeRatio = baseline > 0 ? count / (baseline / 24) : 1.0;

      let spikeLevel = 1;
      let scoreAdjustment = 0;
      if (spikeRatio >= 10) {
        spikeLevel = 5;
        scoreAdjustment = 15;
      } else if (spikeRatio >= 5) {
        spikeLevel = 4;
        scoreAdjustment = 10;
      } else if (spikeRatio >= 3) {
        spikeLevel = 3;
        scoreAdjustment = 5;
      } else if (spikeRatio >= 2) {
        spikeLevel = 2;
        scoreAdjustment = 2;
      }

      result.set(ticker, {
        ticker,
        count1h: count,
        count24h,
        spikeRatio,
        subreddits: SUBREDDITS,
        spikeLevel,
        scoreAdjustment,
      });
    }

    _cache = { ts: Date.now(), data: result };
    const spikes = [...result.values()].filter((d) => d.spikeLevel >= 3);
    if (spikes.length > 0) {
      logger.info(
        `🚀 WSB spike 감지: ${spikes
          .slice(0, 5)
          .map((s) => `${s.ticker}(x${s.spikeRatio.toFixed(1)})`)
          .join(', ')}`,
        { component: COMP },
      );
    }
    return result;
  } catch (e) {
    logger.warn(`Reddit 멘션 수집 실패: ${(e as Error).message}`, { component: COMP });
    return _cache?.data ?? new Map();
  }
}

/** 특정 ticker 멘션 정보 */
export async function getMentionForTicker(ticker: string): Promise<RedditMentionData | null> {
  const all = await getRedditMentions();
  return all.get(ticker.toUpperCase()) ?? null;
}
