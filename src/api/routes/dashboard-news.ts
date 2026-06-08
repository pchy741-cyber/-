import { Hono } from 'hono';
import { getMacroSnapshot } from '../../automation/macro-data.js';
import { logger } from '../../utils/logger.js';

export const dashboardNewsRoutes = new Hono();

let _newsSummaryCache = { summary: '', fetchedAt: 0 };
const NEWS_SUMMARY_TTL = 120 * 60 * 1000;

interface NewsTheme { theme: string; reason: string; stocks: Array<{ code: string; name: string; market: string }> }
let _newsThemeCache: { data: NewsTheme | null; fetchedAt: number } = { data: null, fetchedAt: 0 };
const NEWS_THEME_TTL = 120 * 60 * 1000;

// ── 유튜브 캐시 ──
interface YouTubeVideo {
  title: string; link: string; channel: string;
  publishedAt: string; sentiment: 'bullish' | 'bearish' | 'neutral'; sentimentScore: number;
}
let _ytCache: { videos: YouTubeVideo[]; fetchedAt: number } = { videos: [], fetchedAt: 0 };
const YT_TTL = 30 * 60 * 1000;

const YT_CHANNELS = [
  { id: 'UChlv4GSd7OQl3js-jkLOnFA', name: '삼프로TV' },
  { id: 'UCWskYkV4c4S9D__rsfOl2JA', name: '한경글로벌마켓' },
  { id: 'UCvil4OAt-zShzkKHsg9EQAw', name: '김작가TV' },
];
const BULL_KW = ['상승장', '불장', '랠리', '반등', '매수', '저점', '신고가', '급등', '기회', '회복', '돌파', '호재', '최고'];
const BEAR_KW = ['폭락', '하락장', '공포', '위기', '매도', '급락', '붕괴', '추락', '침체', '위험', '악재', '하락'];

// ── 한글 뉴스 요약 (Gemini OFF 폴백) ──
function generateFreeKoreanSummary(headlineLines: string[]): string {
  const koreanLines = headlineLines.filter(l => /[\u3131-\uD7A3]/.test(l));
  const englishLines = headlineLines.filter(l => !/[\u3131-\uD7A3]/.test(l));
  const all = [...koreanLines, ...englishLines];
  const allText = all.join(' ').toLowerCase();

  let bull = 0, bear = 0;
  for (const kw of BULL_KW) if (allText.includes(kw)) bull++;
  for (const kw of BEAR_KW) if (allText.includes(kw)) bear++;
  for (const kw of ['rally', 'rise', 'surge', 'gain', 'record', 'bull']) if (allText.includes(kw)) bull++;
  for (const kw of ['fall', 'drop', 'plunge', 'fear', 'crash', 'bear', 'sell-off']) if (allText.includes(kw)) bear++;

  const mood = bull > bear + 1 ? '긍정적' : bear > bull + 1 ? '부정적' : '혼조';

  const extract = (lines: string[], n: number) =>
    lines.slice(0, n).map(l => { const m = l.match(/^\- \[(.+?)\]/); return m?.[1] || ''; }).filter(Boolean);

  const topKr = extract(koreanLines, 2);
  const topEn = extract(englishLines, 2);

  let summary = `글로벌 시장 분위기는 ${mood}입니다.`;
  if (topKr.length > 0) summary += ` 국내: ${topKr.join(', ')}.`;
  if (topEn.length > 0) summary += ` 해외: ${topEn.join(', ')}.`;
  return summary;
}

// ── 유튜브 영상 가져오기 (공유 로직) ──
async function fetchYouTubeVideos(): Promise<YouTubeVideo[]> {
  if (_ytCache.videos.length > 0 && Date.now() - _ytCache.fetchedAt < YT_TTL) {
    return _ytCache.videos;
  }
  const cutoff = Date.now() - 72 * 3600_000;
  const videos: YouTubeVideo[] = [];
  const feeds = await Promise.allSettled(
    YT_CHANNELS.map(async ch => {
      const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      const xml = await res.text();
      const entries = [...xml.matchAll(/<entry>[\s\S]*?<link[^>]*href="([^"]*)"[^>]*\/>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<published>([\s\S]*?)<\/published>[\s\S]*?<\/entry>/g)];
      return entries
        .filter(e => new Date(e[3]).getTime() > cutoff)
        .slice(0, 5)
        .map(e => ({ title: e[2].trim(), link: e[1], channel: ch.name, publishedAt: e[3].trim() }));
    }),
  );
  for (const r of feeds) {
    if (r.status !== 'fulfilled') continue;
    for (const v of r.value) {
      let score = 0;
      for (const kw of BULL_KW) if (v.title.includes(kw)) score++;
      for (const kw of BEAR_KW) if (v.title.includes(kw)) score--;
      videos.push({ ...v, sentimentScore: score, sentiment: score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral' });
    }
  }
  videos.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  _ytCache = { videos, fetchedAt: Date.now() };
  return videos;
}

// ── 매크로 환경 ──
dashboardNewsRoutes.get('/macro', async (c) => {
  try {
    const macro = await getMacroSnapshot();
    return c.json(macro);
  } catch {
    return c.json({ regime: 'NEUTRAL', fearGreedIndex: 50 });
  }
});

// ── 오늘 수집된 뉴스 피드 ──
dashboardNewsRoutes.get('/news', async (c) => {
  try {
    const { getTodayNews } = await import('../../automation/news-collector.js');
    const newsMap = getTodayNews();
    const result: Array<{ stockCode: string; stockName?: string; items: Array<{ title: string; link: string; publishedAt?: string }> }> = [];
    for (const [stockCode, items] of newsMap.entries()) {
      if (items.length > 0) {
        result.push({ stockCode, items: items.slice(0, 10) });
      }
    }
    result.sort((a, b) => b.items.length - a.items.length);
    return c.json(result);
  } catch {
    return c.json([], 200);
  }
});

// ── 매크로 뉴스 피드 ──
dashboardNewsRoutes.get('/news/macro', async (c) => {
  try {
    const { collectMacroNews } = await import('../../automation/news-collector.js');
    const raw = await Promise.race([
      collectMacroNews(),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 8000)),
    ]);
    const lines = raw.split('\n').filter(l => l.startsWith('- [')).map(l => l.replace(/^- /, ''));
    return c.json({ headlines: lines });
  } catch {
    return c.json({ headlines: [] });
  }
});

// ── 장세 한마디 (한글 종합) ──
dashboardNewsRoutes.get('/news/regime-summary', async (c) => {
  try {
    const { detectMarketRegime, generateMarketSummaryKorean } = await import('../../automation/market-regime.js');
    const regime = await detectMarketRegime();
    return c.json({
      summary: generateMarketSummaryKorean(regime),
      regime: regime.regime,
      score: regime.score,
      recommended: regime.recommendedMode,
      reasons: regime.reasons,
    });
  } catch {
    return c.json({ summary: '', regime: 'NEUTRAL', score: 0, recommended: 'SWING', reasons: [] });
  }
});

// ── 유튜브 시황 ──
dashboardNewsRoutes.get('/news/youtube', async (c) => {
  try {
    const videos = await fetchYouTubeVideos();
    return c.json({ videos });
  } catch {
    return c.json({ videos: [] });
  }
});

// ── 매크로 뉴스 AI 한 줄 요약 (Gemini 2.0 Flash) ──
dashboardNewsRoutes.get('/news/summary', async (c) => {
  const forceRefresh = c.req.query('refresh') === '1';
  try {
    if (!forceRefresh && _newsSummaryCache.summary && Date.now() - _newsSummaryCache.fetchedAt < NEWS_SUMMARY_TTL) {
      return c.json({ summary: _newsSummaryCache.summary, geminiOk: true, error: null, headlineCount: 0, cached: true });
    }

    const { collectMacroNews } = await import('../../automation/news-collector.js');
    const raw = await Promise.race([
      collectMacroNews(),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 28000)),
    ]);
    if (!raw) {
      logger.warn('뉴스 요약: RSS 피드 수집 실패 (빈 결과)', { component: 'NEWS_SUMMARY' });
      return c.json({ summary: '', geminiOk: false, error: 'rss_failed', headlineCount: 0, cached: false });
    }

    const headlineLines = raw.split('\n').filter(l => l.startsWith('- ['));
    const headlineCount = headlineLines.length;

    if (headlineCount === 0) {
      return c.json({ summary: '', geminiOk: false, error: 'rss_failed', headlineCount: 0, cached: false });
    }

    const headlines = headlineLines.map(l => {
      const m = l.match(/^\- \[(.+?)\]\(.+?\)\s*—\s*(.+)$/);
      return m ? `${m[1]} (${m[2]})` : l.replace(/^- /, '');
    }).join('\n');

    // Gemini OFF → 한글 키워드 기반 자연스러운 요약
    const { config } = await import('../../config/index.js');
    if (!config.geminiEnabled) {
      const summary = generateFreeKoreanSummary(headlineLines);
      if (summary) _newsSummaryCache = { summary, fetchedAt: Date.now() };
      return c.json({ summary, geminiOk: false, error: null, headlineCount, cached: false });
    }

    const { callVertexGemini: callVertexNews } = await import('../../utils/vertex-gemini.js');
    const summaryPromise = callVertexNews(
      '당신은 주식 투자 전문가입니다. 뉴스를 투자자 관점에서 간결하게 요약합니다.',
      `아래는 오늘 글로벌 금융 뉴스 헤드라인입니다. 주식 투자에 영향을 미치는 핵심 내용만 뽑아서 한국어로 자연스럽게 2~3문장으로 요약해 주세요. 투자자 관점에서 오늘 시장 분위기와 주요 이슈를 간결하게 서술하세요.\n\n${headlines}`,
      { temperature: 0.2 },
    );

    const summary = await Promise.race([
      summaryPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout_15s')), 15000)),
    ]);
    if (summary) _newsSummaryCache = { summary, fetchedAt: Date.now() };
    return c.json({ summary, geminiOk: !!summary, error: summary ? null : 'gemini_empty', headlineCount, cached: false });
  } catch (err) {
    const errStr = String(err);
    logger.error('뉴스 요약 생성 실패', { error: errStr.slice(0, 300), component: 'NEWS_SUMMARY' });
    const error = errStr.includes('quota') || errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED')
      ? 'gemini_quota'
      : errStr.includes('timeout')
        ? 'gemini_timeout'
        : 'gemini_failed';
    return c.json({ summary: '', geminiOk: false, error, errorDetail: errStr.slice(0, 200), headlineCount: 0, cached: false });
  }
});

// ── 오늘의 테마 + 추천 종목 (Gemini 2.0 Flash) ──
dashboardNewsRoutes.get('/news/theme', async (c) => {
  try {
    if (_newsThemeCache.data && Date.now() - _newsThemeCache.fetchedAt < NEWS_THEME_TTL) {
      return c.json(_newsThemeCache.data);
    }

    const { collectMacroNews } = await import('../../automation/news-collector.js');
    const raw = await Promise.race([
      collectMacroNews(),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 20000)),
    ]);
    if (!raw) return c.json({ theme: '', reason: '', stocks: [] });

    const headlines = raw.split('\n')
      .filter(l => l.startsWith('- [') || (l.startsWith('- ') && l.length > 10))
      .map(l => {
        const m = l.match(/^\- \[(.+?)\]\(.+?\)\s*[—-]\s*(.+)$/);
        return m ? `${m[1]} (${m[2]})` : l.replace(/^- /, '');
      }).slice(0, 20).join('\n');

    if (!headlines) return c.json({ theme: '', reason: '', stocks: [] });

    // Gemini OFF → 테마 분석 스킵
    const { config } = await import('../../config/index.js');
    if (!config.geminiEnabled) {
      return c.json({ theme: '', reason: 'Gemini OFF', stocks: [] });
    }

    const { callVertexGemini: callVertexTheme } = await import('../../utils/vertex-gemini.js');

    const themeUserMsg = `아래 글로벌 금융 뉴스 헤드라인을 분석해서 오늘 한국 주식시장에서 가장 주목받을 테마/섹터를 1개 선정하고, 관련 한국 상장주 3~5개를 추천하세요.

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

    const text = await Promise.race([
      callVertexTheme('당신은 한국 주식시장 전문가입니다. 뉴스 헤드라인을 분석하여 테마와 종목을 추천합니다.', themeUserMsg, { temperature: 0.2 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('theme_timeout_20s')), 20000)),
    ]);

    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
    const jsonText = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;

    let data: NewsTheme;
    try {
      data = JSON.parse(jsonText.trim()) as NewsTheme;
      if (!data.theme || !Array.isArray(data.stocks)) throw new Error('invalid');
    } catch {
      logger.warn(`오늘의 테마 JSON 파싱 실패. raw: ${text.slice(0, 200)}`, { component: 'NEWS_THEME' });
      return c.json({ theme: '', reason: '', stocks: [] });
    }

    _newsThemeCache = { data, fetchedAt: Date.now() };
    return c.json(data);
  } catch (err) {
    logger.error('오늘의 테마 생성 실패', { error: String(err), component: 'NEWS_THEME' });
    return c.json({ theme: '', reason: '', stocks: [] });
  }
});

// ── 스케줄러용 프리페치 (08:00 캐시 워밍) ──
export async function prefetchAllNews(): Promise<void> {
  try {
    // 1. 매크로 뉴스 RSS 수집
    const { collectMacroNews } = await import('../../automation/news-collector.js');
    const raw = await Promise.race([
      collectMacroNews(),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 15000)),
    ]);

    // 2. 뉴스 요약 캐시 워밍
    if (raw) {
      const headlineLines = raw.split('\n').filter(l => l.startsWith('- ['));
      if (headlineLines.length > 0) {
        const { config } = await import('../../config/index.js');
        if (!config.geminiEnabled) {
          const summary = generateFreeKoreanSummary(headlineLines);
          if (summary) _newsSummaryCache = { summary, fetchedAt: Date.now() };
        } else {
          try {
            const headlines = headlineLines.map(l => {
              const m = l.match(/^\- \[(.+?)\]\(.+?\)\s*—\s*(.+)$/);
              return m ? `${m[1]} (${m[2]})` : l.replace(/^- /, '');
            }).join('\n');
            const { callVertexGemini } = await import('../../utils/vertex-gemini.js');
            const summary = await Promise.race([
              callVertexGemini(
                '당신은 주식 투자 전문가입니다.',
                `오늘 글로벌 금융 뉴스를 투자자 관점에서 한국어 2~3문장으로 요약하세요.\n\n${headlines}`,
                { temperature: 0.2 },
              ),
              new Promise<string>((resolve) => setTimeout(() => resolve(''), 12000)),
            ]);
            if (summary) _newsSummaryCache = { summary, fetchedAt: Date.now() };
          } catch { /* Gemini 실패 시 무시 */ }
        }
      }
    }

    // 3. 유튜브 캐시 워밍
    await fetchYouTubeVideos();

    logger.info(`📰 뉴스 프리페치 완료: 요약=${_newsSummaryCache.summary ? 'OK' : 'SKIP'} 유튜브=${_ytCache.videos.length}건`, { component: 'NEWS_PREFETCH' });
  } catch (e) {
    logger.warn(`뉴스 프리페치 실패: ${e}`, { component: 'NEWS_PREFETCH' });
  }
}
