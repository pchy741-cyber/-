'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Panel, Spinner } from '@/components/ui';
import { api } from '../lib/utils';
import { toDisplayName } from '../lib/helpers';
import { TodayThemePanel } from './news/TodayThemePanel';
import { NewsSummaryPanel } from './news/NewsSummaryPanel';

import type { WatchlistItem } from '../types';

interface RegimeSummary { summary: string; regime: string; score: number; recommended: string; reasons: string[]; usMarket?: { trend: string; spy: number; qqq: number; breadth: string } | null }
interface YTVideo { title: string; link: string; channel: string; publishedAt: string; sentiment: 'bullish' | 'bearish' | 'neutral'; sentimentScore: number }
interface StockNewsEntry { stockCode: string; items: Array<{ title: string; link?: string; publishedAt?: string }> }
interface MacroHeadlineItem { title: string; link: string; source: string; publishedAt: string; relativeTime?: string }

/** 상대 시간 (KST) */
function relativeTime(t: string): string {
  const diff = Date.now() - new Date(t).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}시간 전`;
  return `${Math.floor(hrs / 24)}일 전`;
}

function NewsView({ watchlist, setWatchlist, viewMode = 'live' }: { watchlist: WatchlistItem[]; setWatchlist: React.Dispatch<React.SetStateAction<WatchlistItem[]>>; viewMode?: string }) {
  const [stockNews, setStockNews] = useState<StockNewsEntry[]>([]);
  const [macroNews, setMacroNews] = useState<MacroHeadlineItem[]>([]);
  const [summary, setSummary] = useState<string>('');
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryHeadlines, setSummaryHeadlines] = useState(0);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryRefreshing, setSummaryRefreshing] = useState(false);
  const [summaryGeminiOk, setSummaryGeminiOk] = useState(false);
  const [summaryStale, setSummaryStale] = useState(false);
  const [geminiTest, setGeminiTest] = useState<{ ok: boolean; latencyMs: number; model: string; error: string | null; errorDetail: string | null; rawError: string; response?: string } | null>(null);
  const [geminiTesting, setGeminiTesting] = useState(false);
  const [aiEngineStatus, setAiEngineStatus] = useState<{ gemini: string; claude: string; activeEngine: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [macroLoading, setMacroLoading] = useState(true);
  const [theme, setTheme] = useState<{ theme: string; reason: string; stocks: Array<{ code: string; name: string; market: string }> } | null>(null);
  const [themeLoading, setThemeLoading] = useState(true);
  const [addingCode, setAddingCode] = useState<string | null>(null);
  const [regime, setRegime] = useState<RegimeSummary | null>(null);
  const [ytVideos, setYtVideos] = useState<YTVideo[]>([]);
  const [ytLoading, setYtLoading] = useState(true);
  const [expandedStock, setExpandedStock] = useState<string | null>(null);

  const getStockName = (code: string) => {
    const item = watchlist.find((s) => s.stock_code === code);
    return toDisplayName(item?.stock_name, code);
  };

  const isInWatchlist = (code: string) => watchlist.some((s) => s.stock_code === code);

  const addThemeStock = async (stock: { code: string; name: string; market: string }) => {
    if (isInWatchlist(stock.code)) return;
    setAddingCode(stock.code);
    try {
      await api('/watchlist', { method: 'POST', body: JSON.stringify({ stock_code: stock.code, stock_name: stock.name, market: stock.market }) });
      const w = await api(`/watchlist?viewMode=${viewMode}`);
      setWatchlist(Array.isArray(w) ? w : []);
    } catch { /* ignore */ }
    finally { setAddingCode(null); }
  };

  const testGemini = () => {
    setGeminiTesting(true);
    setGeminiTest(null);
    api('/ai/gemini-test', { timeout: 15000 })
      .then((d: { ok: boolean; latencyMs: number; model: string; error: string | null; errorDetail: string | null; rawError: string; response?: string }) => setGeminiTest(d))
      .catch(() => setGeminiTest({ ok: false, latencyMs: 0, model: '', error: 'network', errorDetail: '서버에 연결할 수 없습니다', rawError: '' }))
      .finally(() => setGeminiTesting(false));
  };

  const fetchSummaryRef = useRef<((force: boolean) => void) | undefined>(undefined);
  fetchSummaryRef.current = (force = false) => {
    setSummaryRefreshing(force);
    if (!force) setSummaryLoading(true);
    api(`/news/summary${force ? '?refresh=1' : ''}`, { timeout: 45000 })
      .then((data: { summary?: string; error?: string; headlineCount?: number; geminiOk?: boolean; stale?: boolean }) => {
        setSummary(typeof data?.summary === 'string' ? data.summary : '');
        setSummaryError(data?.error ?? null);
        setSummaryHeadlines(data?.headlineCount ?? 0);
        setSummaryGeminiOk(!!data?.geminiOk);
        setSummaryStale(!!data?.stale);
      })
      .catch(() => { setSummary(''); setSummaryError('network'); setSummaryGeminiOk(false); setSummaryStale(false); })
      .finally(() => { setSummaryLoading(false); setSummaryRefreshing(false); });
  };
  const fetchSummary = useCallback((force: boolean) => fetchSummaryRef.current?.(force), []);

  useEffect(() => {
    const loadAll = () => {
      api('/news').then((d: StockNewsEntry[]) => setStockNews(Array.isArray(d) ? d : [])).catch(() => setStockNews([])).finally(() => setLoading(false));
      api('/news/macro').then((d: { headlines?: MacroHeadlineItem[] }) => setMacroNews(Array.isArray(d?.headlines) ? d.headlines.filter((h) => h && typeof h.title === 'string') : [])).catch(() => setMacroNews([])).finally(() => setMacroLoading(false));
      fetchSummaryRef.current?.(false);
      api('/ai-status').then((d: { gemini: string; claude: string; activeEngine: string }) => setAiEngineStatus(d)).catch(() => {});
      api('/news/theme', { timeout: 35000 }).then((d: { theme?: string; reason?: string; stocks?: Array<{ code: string; name: string; market: string }> }) => setTheme(d?.theme ? d as { theme: string; reason: string; stocks: Array<{ code: string; name: string; market: string }> } : null)).catch(() => setTheme(null)).finally(() => setThemeLoading(false));
      api('/news/regime-summary').then((d: RegimeSummary & { usMarket?: RegimeSummary['usMarket'] }) => setRegime(d?.summary ? d : null)).catch(() => {});
      api('/news/youtube').then((d: { videos?: YTVideo[] }) => setYtVideos(Array.isArray(d?.videos) ? d.videos : [])).catch(() => setYtVideos([])).finally(() => setYtLoading(false));
    };
    loadAll();
    const interval = setInterval(loadAll, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const regimeGradient = !regime ? '' :
    regime.regime === 'BULLISH' ? 'from-emerald-500/10 via-emerald-500/5 to-transparent' :
    regime.regime === 'BEARISH' ? 'from-rose-500/10 via-rose-500/5 to-transparent' :
    regime.regime === 'PANIC' ? 'from-red-500/15 via-red-500/5 to-transparent' :
    'from-slate-500/10 via-slate-500/5 to-transparent';

  const regimeBorder = !regime ? 'border-slate-700/40' :
    regime.regime === 'BULLISH' ? 'border-emerald-500/20' :
    regime.regime === 'BEARISH' ? 'border-rose-500/20' :
    regime.regime === 'PANIC' ? 'border-red-500/25' :
    'border-slate-700/40';

  const regimeIcon = !regime ? '' :
    regime.regime === 'BULLISH' ? '📈' :
    regime.regime === 'BEARISH' ? '📉' :
    regime.regime === 'PANIC' ? '🚨' : '📊';

  const regimeLabel = !regime ? '' :
    regime.regime === 'BULLISH' ? '상승장' :
    regime.regime === 'BEARISH' ? '하락장' :
    regime.regime === 'PANIC' ? '패닉장' : '보합장';

  const usMarket = regime?.usMarket;
  const usTrendLabel = !usMarket ? '' :
    usMarket.trend === 'BULLISH' ? '상승' :
    usMarket.trend === 'BEARISH' ? '하락' : '보합';
  const usTrendColor = !usMarket ? '' :
    usMarket.trend === 'BULLISH' ? 'text-emerald-400' :
    usMarket.trend === 'BEARISH' ? 'text-rose-400' : 'text-slate-400';

  const todayStr = new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });

  // 센티멘트 게이지 (유튜브 기반)
  const sentimentData = (() => {
    if (ytVideos.length === 0) return null;
    const bull = ytVideos.filter(v => v.sentiment === 'bullish').length;
    const bear = ytVideos.filter(v => v.sentiment === 'bearish').length;
    const total = ytVideos.length;
    const bullPct = Math.round((bull / total) * 100);
    const bearPct = Math.round((bear / total) * 100);
    return { bull, bear, neutral: total - bull - bear, bullPct, bearPct, total };
  })();

  const totalNewsCount = stockNews.reduce((sum, e) => sum + (e.items?.length ?? 0), 0) + macroNews.length;

  return (
    <div className="space-y-4">
      {/* ═══ 상단 장세 히어로 — 국내 + 해외 ═══ */}
      {regime && (
        <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-r ${regimeGradient} border ${regimeBorder}`}>
          {/* 날짜 + 배경 아이콘 */}
          <div className="absolute top-0 right-0 w-32 h-32 opacity-10 text-7xl flex items-center justify-center pointer-events-none">
            {regimeIcon}
          </div>

          <div className="p-5 pb-3">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xl">{regimeIcon}</span>
              <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                regime.regime === 'BULLISH' ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' :
                regime.regime === 'BEARISH' ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30' :
                regime.regime === 'PANIC' ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                'bg-slate-800 text-slate-400 border border-slate-700'
              }`}>{regimeLabel}</span>
              <span className="text-[10px] text-slate-500">{regime.recommended}</span>
              {regime.score !== 0 && (
                <span className="text-[10px] text-slate-600">({regime.score > 0 ? '+' : ''}{regime.score})</span>
              )}
              <span className="text-[10px] text-slate-600 ml-auto">{todayStr}</span>
            </div>
            <p className="text-sm text-slate-200 leading-relaxed font-medium">{regime.summary}</p>
            {regime.reasons.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {regime.reasons.slice(0, 5).map((r, i) => (
                  <span key={i} className="text-[10px] px-2 py-0.5 rounded-md bg-white/[0.04] text-slate-400 border border-white/[0.06]">{r}</span>
                ))}
              </div>
            )}
          </div>

          {/* 국내/해외 + 센티멘트 하단 바 */}
          <div className="border-t border-white/[0.06] px-5 py-3 flex items-center gap-4 flex-wrap">
            {/* 국내장 */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-500 font-medium">🇰🇷 국내</span>
              <span className={`text-[11px] font-bold ${
                regime.regime === 'BULLISH' ? 'text-emerald-400' :
                regime.regime === 'BEARISH' ? 'text-rose-400' :
                regime.regime === 'PANIC' ? 'text-red-400' : 'text-slate-300'
              }`}>{regimeLabel}</span>
            </div>

            <div className="w-px h-4 bg-white/[0.08]" />

            {/* 해외장 */}
            {usMarket ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-slate-500 font-medium">🇺🇸 미국</span>
                <span className={`text-[11px] font-bold ${usTrendColor}`}>{usTrendLabel}</span>
                <span className={`text-[10px] ${usMarket.spy >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  SPY {usMarket.spy >= 0 ? '+' : ''}{usMarket.spy.toFixed(1)}%
                </span>
                <span className={`text-[10px] ${usMarket.qqq >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  QQQ {usMarket.qqq >= 0 ? '+' : ''}{usMarket.qqq.toFixed(1)}%
                </span>
                <span className="text-[9px] text-slate-600">({usMarket.breadth})</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-slate-500 font-medium">🇺🇸 미국</span>
                <span className="text-[10px] text-slate-600">—</span>
              </div>
            )}

            {/* 센티멘트 미니 게이지 */}
            {sentimentData && (
              <>
                <div className="w-px h-4 bg-white/[0.08]" />
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-500 font-medium">🎬 센티</span>
                  <div className="relative w-16 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div className="absolute left-0 top-0 h-full bg-emerald-500/70 rounded-l-full w-[var(--w)]" style={{ '--w': `${sentimentData.bullPct}%` } as React.CSSProperties} />
                    <div className="absolute right-0 top-0 h-full bg-rose-500/70 rounded-r-full w-[var(--w)]" style={{ '--w': `${sentimentData.bearPct}%` } as React.CSSProperties} />
                  </div>
                  <span className="text-[9px] text-emerald-400 font-bold">{sentimentData.bullPct}%</span>
                  <span className="text-[9px] text-slate-600">/</span>
                  <span className="text-[9px] text-rose-400 font-bold">{sentimentData.bearPct}%</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ═══ 2단 그리드: AI요약 + 테마 ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <NewsSummaryPanel
          summary={summary} summaryError={summaryError} summaryLoading={summaryLoading}
          summaryRefreshing={summaryRefreshing} summaryHeadlines={summaryHeadlines}
          summaryGeminiOk={summaryGeminiOk} summaryStale={summaryStale}
          aiEngineStatus={aiEngineStatus} geminiTest={geminiTest} geminiTesting={geminiTesting}
          testGemini={testGemini} fetchSummary={fetchSummary}
        />
        <TodayThemePanel theme={theme} themeLoading={themeLoading} isInWatchlist={isInWatchlist} addingCode={addingCode} addThemeStock={addThemeStock} />
      </div>

      {/* ═══ 유튜브 시황 — 카드형 ═══ */}
      <div className="rounded-2xl bg-white/[0.02] border border-white/[0.06] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.04]">
          <span className="text-sm">🎬</span>
          <span className="text-sm font-semibold text-slate-200">유튜브 시황</span>
          {!ytLoading && <span className="text-[10px] text-slate-500 ml-auto">{ytVideos.length}건</span>}
        </div>
        <div className="p-3">
          {ytLoading ? (
            <div className="flex justify-center py-6">
              <Spinner size="lg" color="red" />
            </div>
          ) : ytVideos.length === 0 ? (
            <p className="text-xs text-slate-600 text-center py-4">유튜브 영상이 없습니다</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ytVideos.map((v, i) => {
                const sentColor = v.sentiment === 'bullish' ? 'border-l-emerald-500/60' :
                  v.sentiment === 'bearish' ? 'border-l-rose-500/60' : 'border-l-slate-600/40';
                const sentBg = v.sentiment === 'bullish' ? 'bg-emerald-950/20' :
                  v.sentiment === 'bearish' ? 'bg-rose-950/20' : 'bg-white/[0.02]';
                return (
                  <a key={i} href={v.link} target="_blank" rel="noopener noreferrer"
                    className={`block rounded-xl border-l-[3px] ${sentColor} ${sentBg} px-3 py-2.5 hover:brightness-125 transition-all group`}>
                    <p className="text-xs text-slate-200 line-clamp-2 group-hover:text-white leading-relaxed">{v.title}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[10px] text-slate-500 truncate">{v.channel}</span>
                      {v.publishedAt && <span className="text-[9px] text-slate-600 ml-auto shrink-0">{relativeTime(v.publishedAt)}</span>}
                      <span className={`text-[9px] font-bold shrink-0 ${
                        v.sentiment === 'bullish' ? 'text-emerald-400' : v.sentiment === 'bearish' ? 'text-rose-400' : 'text-slate-500'
                      }`}>{v.sentiment === 'bullish' ? '강세' : v.sentiment === 'bearish' ? '약세' : '중립'}</span>
                    </div>
                  </a>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ═══ 매크로 뉴스 — 타임라인 스타일 ═══ */}
      <div className="rounded-2xl bg-white/[0.02] border border-white/[0.06] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.04]">
          <span className="text-sm">🌍</span>
          <span className="text-sm font-semibold text-slate-200">글로벌 매크로</span>
          {!macroLoading && <span className="text-[10px] text-slate-500 ml-auto">{macroNews.length}건</span>}
        </div>
        <div className="p-4">
          {macroLoading ? (
            <div className="flex justify-center py-4">
              <Spinner size="lg" />
            </div>
          ) : macroNews.length === 0 ? (
            <p className="text-xs text-slate-600 text-center py-3">수집된 매크로 뉴스가 없습니다</p>
          ) : (
            <div className="space-y-0.5">
              {macroNews.map((item, i) => {
                const timeStr = item.publishedAt ? relativeTime(item.publishedAt) : item.relativeTime ?? '';
                return (
                  <div key={i} className="flex items-start gap-2.5 py-1.5 group">
                    <div className="w-1 h-1 rounded-full bg-blue-500/50 mt-2 shrink-0 group-hover:bg-blue-400 transition-colors" />
                    <div className="flex-1 min-w-0 text-[13px]">
                      {item.link ? (
                        <a href={item.link} target="_blank" rel="noopener noreferrer"
                          className="text-slate-300 hover:text-blue-300 hover:underline transition-colors">{item.title}</a>
                      ) : (
                        <span className="text-slate-300">{item.title}</span>
                      )}
                    </div>
                    <div className="shrink-0 flex items-center gap-1.5 mt-0.5">
                      {item.source && <span className="text-[10px] text-slate-600">{item.source}</span>}
                      {timeStr && <span className="text-[10px] text-slate-700">{timeStr}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ═══ 종목별 뉴스 — 아코디언 카드 ═══ */}
      <div className="rounded-2xl bg-white/[0.02] border border-white/[0.06] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.04]">
          <span className="text-sm">📰</span>
          <span className="text-sm font-semibold text-slate-200">감시 종목 뉴스</span>
          {!loading && (
            <span className="text-[10px] text-slate-500 ml-auto">{stockNews.length}종목 · {totalNewsCount}건</span>
          )}
        </div>
        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner size="lg" />
          </div>
        ) : stockNews.length === 0 ? (
          <p className="text-xs text-slate-600 text-center py-6">오늘 수집된 종목 뉴스가 없습니다</p>
        ) : (
          <div className="divide-y divide-white/[0.03]">
            {stockNews.map((entry) => {
              const isExpanded = expandedStock === entry.stockCode;
              const displayItems = isExpanded ? entry.items : entry.items.slice(0, 3);
              return (
                <div key={entry.stockCode}>
                  <button
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors text-left"
                    onClick={() => setExpandedStock(isExpanded ? null : entry.stockCode)}
                  >
                    <span className="text-sm font-bold text-slate-100">{getStockName(entry.stockCode)}</span>
                    <span className="text-[10px] text-slate-600 bg-slate-800/80 rounded px-1.5 py-0.5">{entry.stockCode}</span>
                    <span className="text-[10px] text-slate-500 ml-auto">{entry.items.length}건</span>
                    <span className="text-[10px] text-slate-600">{isExpanded ? '▲' : '▼'}</span>
                  </button>
                  <div className={`px-4 pb-3 space-y-1 ${isExpanded ? '' : 'max-h-[120px] overflow-hidden relative'}`}>
                    {displayItems.map((item, i) => (
                      <div key={i} className="flex items-start gap-2 py-1">
                        <div className="w-1 h-1 rounded-full bg-slate-600 mt-2 shrink-0" />
                        <div className="flex-1 min-w-0 text-xs">
                          {item.link ? (
                            <a href={item.link} target="_blank" rel="noopener noreferrer"
                              className="text-slate-300 hover:text-blue-300 hover:underline transition-colors line-clamp-2">{item.title}</a>
                          ) : (
                            <span className="text-slate-300 line-clamp-2">{item.title}</span>
                          )}
                        </div>
                        {item.publishedAt && (
                          <span className="text-[9px] text-slate-600 shrink-0 mt-0.5">
                            {new Date(item.publishedAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                      </div>
                    ))}
                    {!isExpanded && entry.items.length > 3 && (
                      <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-[#0a0a0f] to-transparent pointer-events-none" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 퀀트봇 → 별도 탭(research)으로 이동, 뉴스 중복 제거 */}
    </div>
  );
}

export default NewsView;
