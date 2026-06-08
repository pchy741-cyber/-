'use client';

import React, { useState, useEffect } from 'react';
import { Panel } from '@/components/ui';
import { api } from '../lib/utils';
import { toDisplayName } from '../lib/helpers';
import { TodayThemePanel } from './news/TodayThemePanel';
import { NewsSummaryPanel } from './news/NewsSummaryPanel';

interface RegimeSummary { summary: string; regime: string; score: number; recommended: string; reasons: string[] }
interface YTVideo { title: string; link: string; channel: string; publishedAt: string; sentiment: 'bullish' | 'bearish' | 'neutral'; sentimentScore: number }

function NewsView({ watchlist, setWatchlist }: { watchlist: any[]; setWatchlist: (v: any) => void }) {
  const [stockNews, setStockNews] = useState<any[]>([]);
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

  // 장세 한마디
  const [regime, setRegime] = useState<RegimeSummary | null>(null);
  // 유튜브
  const [ytVideos, setYtVideos] = useState<YTVideo[]>([]);
  const [ytLoading, setYtLoading] = useState(true);

  const getStockName = (code: string) => {
    const item = watchlist.find((s: any) => s.stock_code === code);
    return toDisplayName(item?.stock_name, code);
  };

  const isInWatchlist = (code: string) => watchlist.some((s: any) => s.stock_code === code);

  const addThemeStock = async (stock: { code: string; name: string; market: string }) => {
    if (isInWatchlist(stock.code)) return;
    setAddingCode(stock.code);
    try {
      await api('/watchlist', { method: 'POST', body: JSON.stringify({ stock_code: stock.code, stock_name: stock.name, market: stock.market }) });
      const w = await api('/watchlist');
      setWatchlist(Array.isArray(w) ? w : []);
    } catch { /* 이미 있거나 실패 */ }
    finally { setAddingCode(null); }
  };

  const testGemini = () => {
    setGeminiTesting(true);
    setGeminiTest(null);
    api('/ai/gemini-test', { timeout: 15000 })
      .then((d: any) => setGeminiTest(d))
      .catch(() => setGeminiTest({ ok: false, latencyMs: 0, model: '', error: 'network', errorDetail: '서버에 연결할 수 없습니다', rawError: '' }))
      .finally(() => setGeminiTesting(false));
  };

  const fetchSummary = (force = false) => {
    setSummaryRefreshing(force);
    if (!force) setSummaryLoading(true);
    api(`/news/summary${force ? '?refresh=1' : ''}`, { timeout: 45000 })
      .then((data: any) => {
        setSummary(typeof data?.summary === 'string' ? data.summary : '');
        setSummaryError(data?.error ?? null);
        setSummaryHeadlines(data?.headlineCount ?? 0);
      })
      .catch(() => { setSummary(''); setSummaryError('network'); })
      .finally(() => { setSummaryLoading(false); setSummaryRefreshing(false); });
  };

  useEffect(() => {
    api('/news')
      .then((data: any) => setStockNews(Array.isArray(data) ? data : []))
      .catch(() => setStockNews([]))
      .finally(() => setLoading(false));

    api('/news/macro')
      .then((data: any) => setMacroNews(Array.isArray(data?.headlines) ? data.headlines : []))
      .catch(() => setMacroNews([]))
      .finally(() => setMacroLoading(false));

    fetchSummary(false);

    api('/ai-status')
      .then((d: any) => setAiEngineStatus(d))
      .catch(() => {});

    api('/news/theme', { timeout: 35000 })
      .then((data: any) => setTheme(data?.theme ? data : null))
      .catch(() => setTheme(null))
      .finally(() => setThemeLoading(false));

    // 장세 한마디
    api('/news/regime-summary')
      .then((d: any) => setRegime(d?.summary ? d : null))
      .catch(() => {});

    // 유튜브 시황
    api('/news/youtube')
      .then((d: any) => setYtVideos(Array.isArray(d?.videos) ? d.videos : []))
      .catch(() => setYtVideos([]))
      .finally(() => setYtLoading(false));
  }, []);

  const regimeIcon = regime ? (
    regime.regime === 'BULLISH' ? '🟢' :
    regime.regime === 'BEARISH' ? '🔴' :
    regime.regime === 'PANIC' ? '💀' : '⚪'
  ) : '';

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* 장세 한마디 */}
      {regime && (
        <div className="rounded-xl bg-slate-900/80 border border-slate-800/60 p-4 flex items-start gap-3">
          <span className="text-2xl leading-none mt-0.5">{regimeIcon}</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-slate-200 leading-relaxed">{regime.summary}</p>
            {regime.reasons.length > 0 && (
              <p className="text-[11px] text-slate-500 mt-1">{regime.reasons.slice(0, 3).join(' · ')}</p>
            )}
          </div>
          <span className={`text-xs font-medium px-2 py-0.5 rounded ${
            regime.regime === 'BULLISH' ? 'bg-emerald-900/50 text-emerald-400' :
            regime.regime === 'BEARISH' ? 'bg-rose-900/50 text-rose-400' :
            regime.regime === 'PANIC' ? 'bg-red-900/60 text-red-400' :
            'bg-slate-800 text-slate-400'
          }`}>{regime.recommended}</span>
        </div>
      )}

      <TodayThemePanel theme={theme} themeLoading={themeLoading} isInWatchlist={isInWatchlist} addingCode={addingCode} addThemeStock={addThemeStock} />

      <NewsSummaryPanel
        summary={summary} summaryError={summaryError} summaryLoading={summaryLoading}
        summaryRefreshing={summaryRefreshing} summaryHeadlines={summaryHeadlines}
        aiEngineStatus={aiEngineStatus} geminiTest={geminiTest} geminiTesting={geminiTesting}
        testGemini={testGemini} fetchSummary={fetchSummary}
      />

      {/* 유튜브 시황 */}
      <Panel title="유튜브 시황" badge={ytLoading ? '로딩 중' : `${ytVideos.length}건`}>
        <div className="p-4">
          {ytLoading ? (
            <div className="flex justify-center py-4">
              <div className="w-5 h-5 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : ytVideos.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-3">유튜브 영상이 없습니다</p>
          ) : (
            <ul className="space-y-2">
              {ytVideos.map((v, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className={`shrink-0 mt-0.5 text-xs font-bold ${
                    v.sentiment === 'bullish' ? 'text-emerald-400' :
                    v.sentiment === 'bearish' ? 'text-rose-400' : 'text-slate-600'
                  }`}>
                    {v.sentiment === 'bullish' ? '▲' : v.sentiment === 'bearish' ? '▼' : '—'}
                  </span>
                  <span className="flex-1 min-w-0">
                    <a href={v.link} target="_blank" rel="noopener noreferrer"
                       className="text-slate-300 hover:text-white hover:underline line-clamp-2">{v.title}</a>
                    <span className="text-slate-600 text-[10px] ml-1.5">{v.channel}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      {/* 매크로/시황 뉴스 */}
      <Panel title="시황 · 매크로 뉴스">
        <div className="p-4">
          {macroLoading ? (
            <div className="flex justify-center py-6">
              <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : macroNews.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-4">수집된 매크로 뉴스가 없습니다</p>
          ) : (
            <ul className="space-y-2">
              {macroNews.map((line, i) => {
                const match = line.match(/^\[(.+?)\]\((.+?)\)(\s*—\s*(.*))?$/);
                if (match) {
                  return (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span className="text-slate-600 shrink-0 mt-0.5">•</span>
                      <span>
                        <a href={match[2]} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 hover:underline">{match[1]}</a>
                        {match[4] && <span className="text-slate-500 text-xs ml-1">— {match[4]}</span>}
                      </span>
                    </li>
                  );
                }
                return (
                  <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                    <span className="text-slate-600 shrink-0 mt-0.5">•</span>
                    <span>{line}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Panel>

      {/* 종목별 뉴스 */}
      <Panel title="감시 종목 뉴스" badge={loading ? '로딩 중' : `${stockNews.length}종목`}>
        <div className="divide-y divide-slate-800/40">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : stockNews.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-6">오늘 수집된 종목 뉴스가 없습니다</p>
          ) : (
            stockNews.map((entry: any) => (
              <div key={entry.stockCode} className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-semibold text-white">{getStockName(entry.stockCode)}</span>
                  <span className="text-[10px] text-slate-500 bg-slate-800 rounded px-1.5 py-0.5">{entry.stockCode}</span>
                  <span className="text-[10px] text-slate-600 ml-auto">{entry.items.length}건</span>
                </div>
                <ul className="space-y-1.5">
                  {entry.items.map((item: any, i: number) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <span className="text-slate-600 shrink-0 mt-0.5">•</span>
                      <span className="flex-1 min-w-0">
                        {item.link ? (
                          <a href={item.link} target="_blank" rel="noopener noreferrer" className="text-slate-300 hover:text-white hover:underline line-clamp-2">{item.title}</a>
                        ) : (
                          <span className="text-slate-300 line-clamp-2">{item.title}</span>
                        )}
                        {item.publishedAt && (
                          <span className="text-slate-600 ml-1">{new Date(item.publishedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </Panel>
    </div>
  );
}

export default NewsView;
