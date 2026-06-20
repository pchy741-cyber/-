'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Panel } from '@/components/ui';
import { api } from '../lib/utils';
import { toDisplayName } from '../lib/helpers';
import { TodayThemePanel } from './news/TodayThemePanel';
import { NewsSummaryPanel } from './news/NewsSummaryPanel';
import { ResearchBotPanel } from './news/ResearchBotPanel';
import type { WatchlistItem } from '../types';

interface RegimeSummary { summary: string; regime: string; score: number; recommended: string; reasons: string[] }
interface YTVideo { title: string; link: string; channel: string; publishedAt: string; sentiment: 'bullish' | 'bearish' | 'neutral'; sentimentScore: number }
interface StockNewsEntry { stockCode: string; items: Array<{ title: string; link?: string; publishedAt?: string }> }

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
  const [macroNews, setMacroNews] = useState<string[]>([]);
  const [summary, setSummary] = useState<string>('');
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryHeadlines, setSummaryHeadlines] = useState(0);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryRefreshing, setSummaryRefreshing] = useState(false);
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

  const fetchSummaryRef = useRef<(force: boolean) => void>();
  fetchSummaryRef.current = (force = false) => {
    setSummaryRefreshing(force);
    if (!force) setSummaryLoading(true);
    api(`/news/summary${force ? '?refresh=1' : ''}`, { timeout: 45000 })
      .then((data: { summary?: string; error?: string; headlineCount?: number }) => {
        setSummary(typeof data?.summary === 'string' ? data.summary : '');
        setSummaryError(data?.error ?? null);
        setSummaryHeadlines(data?.headlineCount ?? 0);
      })
      .catch(() => { setSummary(''); setSummaryError('network'); })
      .finally(() => { setSummaryLoading(false); setSummaryRefreshing(false); });
  };
  const fetchSummary = useCallback((force: boolean) => fetchSummaryRef.current?.(force), []);

  useEffect(() => {
    const loadAll = () => {
      api('/news').then((d: StockNewsEntry[]) => setStockNews(Array.isArray(d) ? d : [])).catch(() => setStockNews([])).finally(() => setLoading(false));
      api('/news/macro').then((d: { headlines?: string[] }) => setMacroNews(Array.isArray(d?.headlines) ? d.headlines : [])).catch(() => setMacroNews([])).finally(() => setMacroLoading(false));
      fetchSummaryRef.current?.(false);
      api('/ai-status').then((d: { gemini: string; claude: string; activeEngine: string }) => setAiEngineStatus(d)).catch(() => {});
      api('/news/theme', { timeout: 35000 }).then((d: { theme?: string; reason?: string; stocks?: Array<{ code: string; name: string; market: string }> }) => setTheme(d?.theme ? d as { theme: string; reason: string; stocks: Array<{ code: string; name: string; market: string }> } : null)).catch(() => setTheme(null)).finally(() => setThemeLoading(false));
      api('/news/regime-summary').then((d: { summary?: string }) => setRegime(d?.summary ? d as RegimeSummary : null)).catch(() => {});
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
      {/* ═══ 상단 장세 + 센티멘트 히어로 ═══ */}
      {regime && (
        <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-r ${regimeGradient} border ${regimeBorder} p-5`}>
          <div className="absolute top-0 right-0 w-32 h-32 opacity-10 text-7xl flex items-center justify-center pointer-events-none">
            {regimeIcon}
          </div>
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xl">{regimeIcon}</span>
                <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                  regime.regime === 'BULLISH' ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' :
                  regime.regime === 'BEARISH' ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30' :
                  regime.regime === 'PANIC' ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                  'bg-slate-800 text-slate-400 border border-slate-700'
                }`}>{regime.recommended}</span>
                {regime.score !== 0 && (
                  <span className="text-[10px] text-slate-500 ml-1">점수 {regime.score}</span>
                )}
              </div>
              <p className="text-sm text-slate-200 leading-relaxed font-medium">{regime.summary}</p>
              {regime.reasons.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {regime.reasons.slice(0, 4).map((r, i) => (
                    <span key={i} className="text-[10px] px-2 py-0.5 rounded-md bg-white/[0.04] text-slate-400 border border-white/[0.06]">{r}</span>
                  ))}
                </div>
              )}
            </div>

            {/* 센티멘트 미니 게이지 */}
            {sentimentData && (
              <div className="shrink-0 w-24 text-center">
                <div className="text-[9px] text-slate-500 mb-1.5 font-medium tracking-wider">SENTIMENT</div>
                <div className="relative h-2 rounded-full bg-slate-800 overflow-hidden mb-1.5">
                  <div className="absolute left-0 top-0 h-full bg-emerald-500/70 rounded-l-full transition-all" style={{ width: `${sentimentData.bullPct}%` }} />
                  <div className="absolute right-0 top-0 h-full bg-rose-500/70 rounded-r-full transition-all" style={{ width: `${sentimentData.bearPct}%` }} />
                </div>
                <div className="flex justify-between text-[9px]">
                  <span className="text-emerald-400 font-bold">{sentimentData.bullPct}%</span>
                  <span className="text-rose-400 font-bold">{sentimentData.bearPct}%</span>
                </div>
                <div className="text-[9px] text-slate-600 mt-0.5">{sentimentData.total}개 영상</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ 2단 그리드: AI요약 + 테마 ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <NewsSummaryPanel
          summary={summary} summaryError={summaryError} summaryLoading={summaryLoading}
          summaryRefreshing={summaryRefreshing} summaryHeadlines={summaryHeadlines}
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
              <div className="w-5 h-5 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
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
              <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : macroNews.length === 0 ? (
            <p className="text-xs text-slate-600 text-center py-3">수집된 매크로 뉴스가 없습니다</p>
          ) : (
            <div className="space-y-1">
              {macroNews.map((line, i) => {
                const match = line.match(/^\[(.+?)\]\((.+?)\)(\s*—\s*(.*))?$/);
                return (
                  <div key={i} className="flex items-start gap-2.5 py-1.5 group">
                    <div className="w-1 h-1 rounded-full bg-blue-500/50 mt-2 shrink-0 group-hover:bg-blue-400 transition-colors" />
                    <div className="flex-1 min-w-0 text-[13px]">
                      {match ? (
                        <>
                          <a href={match[2]} target="_blank" rel="noopener noreferrer"
                            className="text-slate-300 hover:text-blue-300 hover:underline transition-colors">{match[1]}</a>
                          {match[4] && <span className="text-slate-600 text-[11px] ml-1.5">— {match[4]}</span>}
                        </>
                      ) : (
                        <span className="text-slate-300">{line}</span>
                      )}
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
            <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
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

      {/* ═══ 퀀트 리서치 봇 ═══ */}
      <ResearchBotPanel />
    </div>
  );
}

export default NewsView;
