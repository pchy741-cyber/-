import { Hono } from 'hono';
import { getMacroSnapshot } from '../../automation/macro-data.js';
import {
  type NewsTheme,
  fetchYouTubeVideos,
  formatRelativeTime,
  generateNewsTheme,
  getCachedNewsTheme,
  getCachedNewsSummary,
  getNewsSummaryCache,
  getNewsThemeCache,
  isThemeRefreshing,
  getCurrentMarketFn,
  NEWS_SUMMARY_TTL,
  NEWS_THEME_TTL,
  prefetchAllNews,
  prefetchOverseasTheme,
  refreshSummaryInBackground,
  setNewsSummaryCache,
  setThemeRefreshing,
} from '../../shared/news-cache.js';
import { logger } from '../../utils/logger.js';

export const dashboardNewsRoutes = new Hono();

// ── 매크로 환경 ──
dashboardNewsRoutes.get('/macro', async (c) => {
  try {
    const macro = await getMacroSnapshot();
    return c.json(macro);
  } catch {
    return c.json({ regime: 'NEUTRAL', fearGreedIndex: 50 });
  }
});

// ── 오늘 수집된 뉴스 피드 (v22: 날짜 포함 + 최신순) ──
dashboardNewsRoutes.get('/news', async (c) => {
  try {
    const { getTodayNews } = await import('../../automation/news-collector.js');
    const newsMap = getTodayNews();
    const now = Date.now();
    const result: Array<{
      stockCode: string;
      stockName?: string;
      items: Array<{ title: string; link: string; publishedAt: string; relativeTime: string }>;
    }> = [];
    for (const [stockCode, items] of newsMap.entries()) {
      if (items.length > 0) {
        const mapped = items.slice(0, 10).map((item) => {
          const pubMs = new Date(item.publishedAt).getTime();
          return {
            title: item.title,
            link: item.link,
            publishedAt: item.publishedAt,
            relativeTime: formatRelativeTime(pubMs, now),
          };
        });
        mapped.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
        result.push({ stockCode, items: mapped });
      }
    }
    result.sort((a, b) => b.items.length - a.items.length);
    return c.json(result);
  } catch {
    return c.json([], 200);
  }
});

// ── 매크로 뉴스 피드 (v22: 날짜 포함 구조체) ──
dashboardNewsRoutes.get('/news/macro', async (c) => {
  try {
    const { getMacroHeadlines } = await import('../../automation/news-collector.js');
    const headlines = await Promise.race([
      getMacroHeadlines(),
      new Promise<Array<{ title: string; link: string; source: string; publishedAt: string }>>((resolve) =>
        setTimeout(() => resolve([]), 8000),
      ),
    ]);
    const now = Date.now();
    const result = headlines.map((h) => {
      const pubMs = new Date(h.publishedAt).getTime();
      return {
        title: h.title,
        link: h.link,
        source: h.source,
        publishedAt: h.publishedAt,
        relativeTime: formatRelativeTime(pubMs, now),
      };
    });
    result.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    return c.json({ headlines: result, fetchedAt: new Date().toISOString() });
  } catch {
    return c.json({ headlines: [], fetchedAt: new Date().toISOString() });
  }
});

// ── 장세 한마디 (한글 종합) ──
dashboardNewsRoutes.get('/news/regime-summary', async (c) => {
  try {
    const { detectMarketRegime, generateMarketSummaryKorean } = await import('../../automation/market-regime.js');
    const regime = await detectMarketRegime();

    let usMarket: { trend: string; spy: number; qqq: number; breadth: string } | null = null;
    try {
      const { getUSSectorSignals } = await import('../../market/us-sector-signals.js');
      const snap = await getUSSectorSignals();
      usMarket = {
        trend: snap.marketTrend,
        spy: snap.indices.find((i) => i.symbol === 'SPY')?.changePct ?? 0,
        qqq: snap.indices.find((i) => i.symbol === 'QQQ')?.changePct ?? 0,
        breadth: `${snap.bullishCount}/${snap.totalCount}`,
      };
    } catch { /* US 데이터 실패 시 무시 */ }

    return c.json({
      summary: generateMarketSummaryKorean(regime),
      regime: regime.regime,
      score: regime.score,
      recommended: regime.recommendedMode,
      reasons: regime.reasons,
      usMarket,
    });
  } catch {
    return c.json({ summary: '', regime: 'NEUTRAL', score: 0, recommended: 'SWING', reasons: [], usMarket: null });
  }
});

// ── AI 뉴스 분석 (v22.1: FinBERT+Gemini 하이브리드) ──
dashboardNewsRoutes.get('/news/ai-analysis', async (c) => {
  try {
    const { analyzeNewsHeadlines, getCachedNewsAnalysis } = await import('../../automation/news-analyzer.js');

    let analysis = getCachedNewsAnalysis();
    if (!analysis) {
      analysis = await analyzeNewsHeadlines();
    }

    return c.json({
      overallSentiment: analysis.overallSentiment,
      regimeAdjustment: analysis.regimeAdjustment,
      marketImpactSummary: analysis.marketImpactSummary,
      analysisSource: analysis.analysisSource,
      headlineCount: analysis.headlines.length,
      headlines: analysis.headlines.map((h) => ({
        title: h.title,
        sentiment: h.sentiment,
        impact: h.impact,
        category: h.category,
        summary: h.summary,
        isSystemicRisk: h.isSystemicRisk,
        source: h.source,
      })),
      analyzedAt: new Date(analysis.analyzedAt).toISOString(),
    });
  } catch (err) {
    logger.error(`AI 뉴스 분석 API 실패: ${err}`, { component: 'NEWS_AI' });
    return c.json({
      overallSentiment: 0,
      regimeAdjustment: 0,
      marketImpactSummary: '',
      analysisSource: 'error',
      headlineCount: 0,
      headlines: [],
      analyzedAt: null,
    });
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
    const cache = getNewsSummaryCache();
    if (cache.summary) {
      const isStale = Date.now() - cache.fetchedAt >= NEWS_SUMMARY_TTL;
      if (isStale && !forceRefresh) {
        refreshSummaryInBackground();
        return c.json({
          summary: cache.summary,
          geminiOk: cache.source === 'gemini',
          error: null,
          headlineCount: 0,
          cached: true,
          stale: true,
        });
      }
      if (!isStale && !forceRefresh) {
        return c.json({
          summary: cache.summary,
          geminiOk: cache.source === 'gemini',
          error: null,
          headlineCount: 0,
          cached: true,
          stale: false,
        });
      }
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

    const headlineLines = raw.split('\n').filter((l) => l.startsWith('- ['));
    const headlineCount = headlineLines.length;

    if (headlineCount === 0) {
      return c.json({ summary: '', geminiOk: false, error: 'rss_failed', headlineCount: 0, cached: false });
    }

    const headlines = headlineLines
      .map((l) => {
        const m = l.match(/^- \[(.+?)\]\(.+?\)\s*—\s*(.+)$/);
        return m ? `${m[1]} (${m[2]})` : l.replace(/^- /, '');
      })
      .join('\n');

    const { config } = await import('../../config/index.js');
    if (!config.geminiEnabled) {
      // generateFreeKoreanSummary is internal to shared/news-cache — use refreshSummaryInBackground
      // For sync fallback, replicate the simple logic inline
      const koreanLines = headlineLines.filter((l) => /[\u3131-\uD7A3]/.test(l));
      const topKr = koreanLines.slice(0, 2).map((l) => { const m = l.match(/^- \[(.+?)\]/); return m?.[1] || ''; }).filter(Boolean);
      const summary = `글로벌 시장 분위기는 혼조입니다.${topKr.length > 0 ? ` 국내: ${topKr.join(', ')}.` : ''}`;
      if (summary) setNewsSummaryCache({ summary, fetchedAt: Date.now(), source: 'fallback' });
      return c.json({ summary, geminiOk: false, error: null, headlineCount, cached: false, stale: false });
    }

    const { callVertexGemini: callVertexNews } = await import('../../utils/vertex-gemini.js');
    const summaryPromise = callVertexNews(
      '당신은 주식 투자 전문가입니다. 뉴스를 투자자 관점에서 간결하게 요약합니다.',
      `아래는 오늘 글로벌 금융 뉴스 헤드라인입니다. 주식 투자에 영향을 미치는 핵심 내용만 뽑아서 한국어로 자연스럽게 2~3문장으로 요약해 주세요. 투자자 관점에서 오늘 시장 분위기와 주요 이슈를 간결하게 서술하세요.\n\n${headlines}`,
      { temperature: 0.2, useVertex: true, label: '뉴스-요약' },
    );

    const summary = await Promise.race([
      summaryPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout_15s')), 15000)),
    ]);
    if (summary) setNewsSummaryCache({ summary, fetchedAt: Date.now(), source: 'gemini' });
    return c.json({
      summary,
      geminiOk: !!summary,
      error: summary ? null : 'gemini_empty',
      headlineCount,
      cached: false,
      stale: false,
    });
  } catch (err) {
    const errStr = String(err);
    logger.error('뉴스 요약 생성 실패', { error: errStr.slice(0, 300), component: 'NEWS_SUMMARY' });
    const error =
      errStr.includes('quota') || errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED')
        ? 'gemini_quota'
        : errStr.includes('timeout')
          ? 'gemini_timeout'
          : 'gemini_failed';
    return c.json({
      summary: '',
      geminiOk: false,
      error,
      headlineCount: 0,
      cached: false,
    });
  }
});

// ── 오늘의 테마 API (v16.2: stale-while-revalidate) ──
dashboardNewsRoutes.get('/news/theme', async (c) => {
  try {
    const targetMarket = getCurrentMarketFn();
    const themeCache = getNewsThemeCache();

    if (themeCache.data && themeCache.market === targetMarket) {
      const isStale = Date.now() - themeCache.fetchedAt >= NEWS_THEME_TTL;
      if (isStale && !isThemeRefreshing()) {
        setThemeRefreshing(true);
        generateNewsTheme()
          .catch((e) => logger.debug(`테마 백그라운드 리프레시 실패: ${e}`, { component: 'NEWS_THEME' }))
          .finally(() => { setThemeRefreshing(false); });
      }
      return c.json(themeCache.data);
    }

    const data = await generateNewsTheme();
    return c.json(data ?? { theme: '', reason: '', stocks: [] });
  } catch (err) {
    logger.error('오늘의 테마 생성 실패', { error: String(err), component: 'NEWS_THEME' });
    return c.json({ theme: '', reason: '', stocks: [] });
  }
});

// ── 하위호환 re-export (기존 import 경로 유지) ──
export {
  type NewsTheme,
  getCachedNewsTheme,
  getCachedNewsSummary,
  prefetchOverseasTheme,
  prefetchAllNews,
  generateNewsTheme,
  refreshSummaryInBackground,
} from '../../shared/news-cache.js';
