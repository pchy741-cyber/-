/**
 * 뉴스 캐시 서비스 — dashboard-news.ts에서 추출
 * API 라우트와 스케줄러/AI/automation 모두에서 사용하는 공유 레이어
 */
import { logger } from '../utils/logger.js';

// ── 캐시 변수 ──
let _newsSummaryCache: { summary: string; fetchedAt: number; source: 'gemini' | 'fallback' | '' } = {
  summary: '',
  fetchedAt: 0,
  source: '',
};
export const NEWS_SUMMARY_TTL = 120 * 60 * 1000;
let _summaryRefreshing = false;

export interface NewsTheme {
  theme: string;
  reason: string;
  stocks: Array<{ code: string; name: string; market: string }>;
}
let _newsThemeCache: { data: NewsTheme | null; fetchedAt: number; market: 'KR' | 'US' } = { data: null, fetchedAt: 0, market: 'KR' };
export const NEWS_THEME_TTL = 120 * 60 * 1000;
let _themeRefreshing = false;

// ── 유튜브 캐시 ──
interface YouTubeVideo {
  title: string;
  link: string;
  channel: string;
  publishedAt: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  sentimentScore: number;
}
let _ytCache: { videos: YouTubeVideo[]; fetchedAt: number } = { videos: [], fetchedAt: 0 };
export const YT_TTL = 30 * 60 * 1000;

export const YT_CHANNELS = [
  { id: 'UChlv4GSd7OQl3js-jkLOnFA', name: '삼프로TV' },
  { id: 'UCWskYkV4c4S9D__rsfOl2JA', name: '한경글로벌마켓' },
  { id: 'UCvil4OAt-zShzkKHsg9EQAw', name: '김작가TV' },
];
export const BULL_KW = [
  '상승장',
  '불장',
  '랠리',
  '반등',
  '매수',
  '저점',
  '신고가',
  '급등',
  '기회',
  '회복',
  '돌파',
  '호재',
  '최고',
];
export const BEAR_KW = ['폭락', '하락장', '공포', '위기', '매도', '급락', '붕괴', '추락', '침체', '위험', '악재', '하락'];

// ── 상대시간 포맷 (v22: "방금", "2시간 전", "어제") ──
export function formatRelativeTime(pubMs: number, nowMs: number): string {
  if (!pubMs || isNaN(pubMs)) return '';
  const diffMs = nowMs - pubMs;
  if (diffMs < 0) return '방금';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  return `${Math.floor(days / 7)}주 전`;
}

// ── 한글 뉴스 요약 (Gemini OFF 폴백) ──
function generateFreeKoreanSummary(headlineLines: string[]): string {
  const koreanLines = headlineLines.filter((l) => /[\u3131-\uD7A3]/.test(l));
  const englishLines = headlineLines.filter((l) => !/[\u3131-\uD7A3]/.test(l));
  const all = [...koreanLines, ...englishLines];
  const allText = all.join(' ').toLowerCase();

  let bull = 0,
    bear = 0;
  for (const kw of BULL_KW) if (allText.includes(kw)) bull++;
  for (const kw of BEAR_KW) if (allText.includes(kw)) bear++;
  for (const kw of ['rally', 'rise', 'surge', 'gain', 'record', 'bull']) if (allText.includes(kw)) bull++;
  for (const kw of ['fall', 'drop', 'plunge', 'fear', 'crash', 'bear', 'sell-off']) if (allText.includes(kw)) bear++;

  const mood = bull > bear + 1 ? '긍정적' : bear > bull + 1 ? '부정적' : '혼조';

  const extract = (lines: string[], n: number) =>
    lines
      .slice(0, n)
      .map((l) => {
        const m = l.match(/^- \[(.+?)\]/);
        return m?.[1] || '';
      })
      .filter(Boolean);

  const topKr = extract(koreanLines, 2);
  const topEn = extract(englishLines, 2);

  let summary = `글로벌 시장 분위기는 ${mood}입니다.`;
  if (topKr.length > 0) summary += ` 국내: ${topKr.join(', ')}.`;
  if (topEn.length > 0) summary += ` 해외: ${topEn.join(', ')}.`;
  return summary;
}

// ── 유튜브 영상 가져오기 (공유 로직) ──
export async function fetchYouTubeVideos(): Promise<YouTubeVideo[]> {
  if (_ytCache.videos.length > 0 && Date.now() - _ytCache.fetchedAt < YT_TTL) {
    return _ytCache.videos;
  }
  const cutoff = Date.now() - 72 * 3600_000;
  const videos: YouTubeVideo[] = [];
  const feeds = await Promise.allSettled(
    YT_CHANNELS.map(async (ch) => {
      const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const xml = await res.text();
      const entries = [
        ...xml.matchAll(
          /<entry>[\s\S]*?<link[^>]*href="([^"]*)"[^>]*\/>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<published>([\s\S]*?)<\/published>[\s\S]*?<\/entry>/g,
        ),
      ];
      return entries
        .filter((e) => new Date(e[3]).getTime() > cutoff)
        .slice(0, 5)
        .map((e) => ({ title: e[2].trim(), link: e[1], channel: ch.name, publishedAt: e[3].trim() }));
    }),
  );
  for (const r of feeds) {
    if (r.status !== 'fulfilled') continue;
    for (const v of r.value) {
      let score = 0;
      for (const kw of BULL_KW) if (v.title.includes(kw)) score++;
      for (const kw of BEAR_KW) if (v.title.includes(kw)) score--;
      videos.push({
        ...v,
        sentimentScore: score,
        sentiment: score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral',
      });
    }
  }
  videos.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  _ytCache = { videos, fetchedAt: Date.now() };
  return videos;
}

// ── 시간대별 시장 판별 (KST 기준) ──
function getCurrentMarket(): 'KR' | 'US' {
  const now = new Date();
  const kstH = new Date(now.getTime() + 9 * 3600_000).getUTCHours();
  return kstH >= 8 && kstH < 16 ? 'KR' : 'US';
}

// ── 오늘의 테마 생성 (공용 함수 — API + 프리페치 공유) ──
export async function generateNewsTheme(macroRaw?: string, forceMarket?: 'KR' | 'US'): Promise<NewsTheme | null> {
  const targetMarket = forceMarket ?? getCurrentMarket();

  if (_newsThemeCache.data && Date.now() - _newsThemeCache.fetchedAt < NEWS_THEME_TTL && _newsThemeCache.market === targetMarket) {
    return _newsThemeCache.data;
  }

  const raw = macroRaw ?? await Promise.race([
    import('../automation/news-collector.js').then((m) => m.collectMacroNews()),
    new Promise<string>((resolve) => setTimeout(() => resolve(''), 20000)),
  ]);
  if (!raw) return null;

  const headlines = raw
    .split('\n')
    .filter((l) => l.startsWith('- [') || (l.startsWith('- ') && l.length > 10))
    .map((l) => {
      const m = l.match(/^- \[(.+?)\]\(.+?\)\s*[—-]\s*(.+)$/);
      return m ? `${m[1]} (${m[2]})` : l.replace(/^- /, '');
    })
    .slice(0, 20)
    .join('\n');

  if (!headlines) return null;

  const { config } = await import('../config/index.js');
  if (!config.geminiEnabled) return null;

  const { callVertexGemini: callVertexTheme } = await import('../utils/vertex-gemini.js');

  const isUS = targetMarket === 'US';
  const themeUserMsg = isUS
    ? `아래 글로벌 금융 뉴스 헤드라인을 분석해서 오늘 미국 주식시장에서 가장 주목받을 테마/섹터를 1개 선정하고, 관련 미국 상장주 3~5개를 추천하세요.

헤드라인:
${headlines}

반드시 아래 JSON 형식으로만 응답하세요:
{
  "theme": "테마명 (예: AI Chips, EV, Cybersecurity, Cloud 등)",
  "reason": "한 문장으로 이 테마를 선택한 이유 (투자자 관점, 한국어)",
  "stocks": [
    {"code": "NVDA", "name": "NVIDIA", "market": "NASDAQ"},
    {"code": "MSFT", "name": "Microsoft", "market": "NASDAQ"}
  ]
}

주의: code는 반드시 실제 미국 상장 티커(symbol), market은 NASDAQ 또는 NYSE`
    : `아래 글로벌 금융 뉴스 헤드라인을 분석해서 오늘 한국 주식시장에서 가장 주목받을 테마/섹터를 1개 선정하고, 관련 한국 상장주 3~5개를 추천하세요.

헤드라인:
${headlines}

반드시 아래 JSON 형식으로만 응답하세요:
{
  "theme": "테마명 (예: AI 반도체, 방산, 2차전지, 바이오 등)",
  "reason": "한 문장으로 이 테마를 선택한 이유 (투자자 관점)",
  "stocks": [
    {"code": "005930", "name": "삼성전자", "market": "KOSPI"},
    {"code": "000660", "name": "SK하이닉스", "market": "KOSPI"}
  ]
}

주의: code는 반드시 실제 한국거래소 6자리 종목코드, market은 KOSPI 또는 KOSDAQ`;

  const systemMsg = isUS
    ? '당신은 미국 주식시장 전문가입니다. 뉴스 헤드라인을 분석하여 테마와 종목을 추천합니다.'
    : '당신은 한국 주식시장 전문가입니다. 뉴스 헤드라인을 분석하여 테마와 종목을 추천합니다.';

  const text = await Promise.race([
    callVertexTheme(systemMsg, themeUserMsg, { temperature: 0.2, label: `뉴스-테마-${targetMarket}` }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('theme_timeout_20s')), 20000)),
  ]);

  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
  const jsonText = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;

  const data = JSON.parse(jsonText.trim()) as NewsTheme;
  if (!data.theme || !Array.isArray(data.stocks)) throw new Error('invalid');

  _newsThemeCache = { data, fetchedAt: Date.now(), market: targetMarket };
  logger.info(`🎯 오늘의 테마 [${targetMarket}]: ${data.theme} (${data.stocks.length}종목)`, { component: 'NEWS_THEME' });
  return data;
}

// ── 뉴스 테마/감성 데이터 export (overseas-job에서 사용) ──
/** 캐시된 뉴스 테마 반환 (2h TTL, 없으면 null) */
export function getCachedNewsTheme(): NewsTheme | null {
  if (Date.now() - _newsThemeCache.fetchedAt > NEWS_THEME_TTL) return null;
  return _newsThemeCache.data;
}

/** 캐시된 뉴스 요약 반환 */
export function getCachedNewsSummary(): string | null {
  if (Date.now() - _newsSummaryCache.fetchedAt > NEWS_SUMMARY_TTL) return null;
  return _newsSummaryCache.summary || null;
}

// ── 해외장 테마 프리페치 (16:00 KST — 국내장 종료 후 해외장 전환) ──
export async function prefetchOverseasTheme(): Promise<void> {
  try {
    await generateNewsTheme(undefined, 'US');
    logger.info(`🌍 해외장 테마 전환 완료: ${_newsThemeCache.data?.theme || 'SKIP'}`, { component: 'NEWS_PREFETCH' });
  } catch (e) {
    logger.warn(`해외 테마 전환 실패: ${e}`, { component: 'NEWS_PREFETCH' });
  }
}

/** 백그라운드 요약 리프레시 (stale-while-revalidate) */
export function refreshSummaryInBackground(): void {
  if (_summaryRefreshing) return;
  _summaryRefreshing = true;
  (async () => {
    try {
      const { collectMacroNews } = await import('../automation/news-collector.js');
      const raw = await Promise.race([
        collectMacroNews(),
        new Promise<string>((resolve) => setTimeout(() => resolve(''), 20000)),
      ]);
      if (!raw) return;
      const headlineLines = raw.split('\n').filter((l) => l.startsWith('- ['));
      if (headlineLines.length === 0) return;

      const headlines = headlineLines
        .map((l) => {
          const m = l.match(/^- \[(.+?)\]\(.+?\)\s*—\s*(.+)$/);
          return m ? `${m[1]} (${m[2]})` : l.replace(/^- /, '');
        })
        .join('\n');

      const { config } = await import('../config/index.js');
      if (!config.geminiEnabled) {
        const summary = generateFreeKoreanSummary(headlineLines);
        if (summary) _newsSummaryCache = { summary, fetchedAt: Date.now(), source: 'fallback' };
        return;
      }

      const { callVertexGemini } = await import('../utils/vertex-gemini.js');
      const summary = await Promise.race([
        callVertexGemini(
          '당신은 주식 투자 전문가입니다. 뉴스를 투자자 관점에서 간결하게 요약합니다.',
          `아래는 오늘 글로벌 금융 뉴스 헤드라인입니다. 주식 투자에 영향을 미치는 핵심 내용만 뽑아서 한국어로 자연스럽게 2~3문장으로 요약해 주세요. 투자자 관점에서 오늘 시장 분위기와 주요 이슈를 간결하게 서술하세요.\n\n${headlines}`,
          { temperature: 0.2, label: '뉴스-요약-SWR' },
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve(''), 15000)),
      ]);
      if (summary) _newsSummaryCache = { summary, fetchedAt: Date.now(), source: 'gemini' };
    } catch (e) {
      logger.debug(`뉴스 요약 백그라운드 리프레시 실패: ${e}`, { component: 'NEWS_SUMMARY' });
    } finally {
      _summaryRefreshing = false;
    }
  })();
}

// ── 스케줄러용 프리페치 (08:00 캐시 워밍) ──
export async function prefetchAllNews(): Promise<void> {
  try {
    // 1. 매크로 뉴스 RSS 수집
    const { collectMacroNews } = await import('../automation/news-collector.js');
    const raw = await Promise.race([
      collectMacroNews(),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 15000)),
    ]);

    // 2. 뉴스 요약 캐시 워밍
    if (raw) {
      const headlineLines = raw.split('\n').filter((l) => l.startsWith('- ['));
      if (headlineLines.length > 0) {
        const { config } = await import('../config/index.js');
        if (!config.geminiEnabled) {
          const summary = generateFreeKoreanSummary(headlineLines);
          if (summary) _newsSummaryCache = { summary, fetchedAt: Date.now(), source: 'fallback' };
        } else {
          try {
            const headlines = headlineLines
              .map((l) => {
                const m = l.match(/^- \[(.+?)\]\(.+?\)\s*—\s*(.+)$/);
                return m ? `${m[1]} (${m[2]})` : l.replace(/^- /, '');
              })
              .join('\n');
            const { callVertexGemini } = await import('../utils/vertex-gemini.js');
            const summary = await Promise.race([
              callVertexGemini(
                '당신은 주식 투자 전문가입니다.',
                `오늘 글로벌 금융 뉴스를 투자자 관점에서 한국어 2~3문장으로 요약하세요.\n\n${headlines}`,
                { temperature: 0.2, label: '뉴스-프리페치' },
              ),
              new Promise<string>((resolve) => setTimeout(() => resolve(''), 12000)),
            ]);
            if (summary) _newsSummaryCache = { summary, fetchedAt: Date.now(), source: 'gemini' };
          } catch {
            /* Gemini 실패 시 무시 */
          }
        }
      }
    }

    // 3. 오늘의 테마 자동 생성
    try {
      await generateNewsTheme(raw || undefined);
    } catch (e) {
      logger.debug(`테마 자동생성 실패 (무시): ${e}`, { component: 'NEWS_PREFETCH' });
    }

    // 4. 유튜브 캐시 워밍
    await fetchYouTubeVideos();

    logger.info(
      `📰 뉴스 프리페치 완료: 요약=${_newsSummaryCache.summary ? 'OK' : 'SKIP'} 테마=${_newsThemeCache.data?.theme || 'SKIP'} 유튜브=${_ytCache.videos.length}건`,
      { component: 'NEWS_PREFETCH' },
    );
  } catch (e) {
    logger.warn(`뉴스 프리페치 실패: ${e}`, { component: 'NEWS_PREFETCH' });
  }
}

// ── 내부 캐시 접근자 (dashboard-news 라우트 핸들러에서 사용) ──
export function getNewsSummaryCache() { return _newsSummaryCache; }
export function setNewsSummaryCache(v: typeof _newsSummaryCache) { _newsSummaryCache = v; }
export function getNewsThemeCache() { return _newsThemeCache; }
export function isThemeRefreshing() { return _themeRefreshing; }
export function setThemeRefreshing(v: boolean) { _themeRefreshing = v; }
export function getCurrentMarketFn() { return getCurrentMarket(); }
