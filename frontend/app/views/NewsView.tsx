'use client';

import React, { useState, useEffect } from 'react';
import { Panel } from '@/components/ui';
import { api } from '../lib/utils';
import { toDisplayName } from '../lib/helpers';

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
  }, []);

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* 오늘의 테마 */}
      <Panel title="오늘의 테마">
        <div className="p-4">
          {themeLoading ? (
            <div className="flex items-center gap-2 py-2">
              <div className="w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full animate-spin shrink-0" />
              <span className="text-xs text-slate-500">AI가 오늘의 테마를 분석 중...</span>
            </div>
          ) : theme ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-lg font-bold text-violet-300">{theme.theme}</span>
                <span className="text-xs text-slate-400 leading-relaxed">{theme.reason}</span>
              </div>
              <div>
                <p className="text-[11px] text-slate-500 mb-2">이 테마 관련 종목 — 감시목록에 추가해서 자동매매</p>
                <div className="flex flex-wrap gap-2">
                  {theme.stocks.map((s) => {
                    const inList = isInWatchlist(s.code);
                    return (
                      <button
                        key={s.code}
                        onClick={() => addThemeStock(s)}
                        disabled={inList || addingCode === s.code}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          inList
                            ? 'bg-emerald-950/40 border-emerald-700/40 text-emerald-400 cursor-default'
                            : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-violet-900/30 hover:border-violet-600/50'
                        }`}
                      >
                        {addingCode === s.code ? (
                          <span className="w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin" />
                        ) : inList ? (
                          <span className="text-emerald-400">✓</span>
                        ) : (
                          <span className="text-slate-500">+</span>
                        )}
                        <span>{s.name}</span>
                        <span className="text-slate-600">{s.code}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">테마를 분석하지 못했습니다</p>
          )}
        </div>
      </Panel>

      {/* AI 시황 요약 */}
      <Panel title="AI 시황 요약" badge={
        summaryLoading ? undefined :
        summary ? 'Gemini 정상' :
        summaryError === 'rss_failed' ? 'RSS 실패' :
        summaryError === 'gemini_quota' ? 'Gemini 한도 초과' :
        summaryError === 'no_key' ? 'API 키 없음' :
        summaryError ? 'Gemini 오류' : undefined
      } badgeColor={
        summaryLoading ? undefined :
        summary ? 'emerald' : 'rose'
      }>
        <div className="p-4 space-y-3">
          {summaryLoading ? (
            <div className="flex items-center gap-2 py-2">
              <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin shrink-0" />
              <span className="text-xs text-slate-500">Gemini가 뉴스를 분석 중입니다... (최대 45초)</span>
            </div>
          ) : summary ? (
            <p className="text-sm text-slate-200 leading-relaxed">{summary}</p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-slate-400">
                {summaryError === 'rss_failed' && '글로벌 뉴스 RSS 수집에 실패했습니다. 네트워크 상태를 확인하세요.'}
                {summaryError === 'gemini_quota' && 'Gemini API 일일 무료 한도를 초과했습니다. 내일 다시 시도됩니다.'}
                {summaryError === 'no_key' && 'GEMINI_API_KEY가 설정되지 않았습니다.'}
                {summaryError === 'gemini_failed' && `Gemini API 호출에 실패했습니다${summaryHeadlines > 0 ? ` (뉴스 ${summaryHeadlines}건 수집됨)` : ''}.`}
                {summaryError === 'gemini_empty' && 'Gemini가 빈 응답을 반환했습니다.'}
                {summaryError === 'network' && '네트워크 오류로 요약을 불러오지 못했습니다.'}
                {!summaryError && '뉴스 요약을 불러오지 못했습니다.'}
              </p>
            </div>
          )}

          {/* 트레이딩봇 AI 엔진 상태 */}
          {aiEngineStatus && (
            <div className="rounded-lg px-3 py-2 text-xs bg-slate-900/60 border border-slate-700/40 flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-slate-500 shrink-0">트레이딩봇 감지:</span>
              <span className={`flex items-center gap-1 ${aiEngineStatus.gemini === 'ok' ? 'text-emerald-400' : aiEngineStatus.gemini === 'quota' ? 'text-amber-400' : aiEngineStatus.gemini === 'error' ? 'text-rose-400' : 'text-slate-500'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${aiEngineStatus.gemini === 'ok' ? 'bg-emerald-400' : aiEngineStatus.gemini === 'quota' ? 'bg-amber-400' : aiEngineStatus.gemini === 'error' ? 'bg-rose-400' : 'bg-slate-600'}`} />
                Gemini: {aiEngineStatus.gemini === 'ok' ? '정상' : aiEngineStatus.gemini === 'quota' ? '할당량 초과' : aiEngineStatus.gemini === 'error' ? '오류' : aiEngineStatus.gemini}
              </span>
              <span className="text-slate-600">활성: {aiEngineStatus.activeEngine}</span>
            </div>
          )}

          {/* Gemini 직접 연결 테스트 결과 */}
          {geminiTest && (
            <div className={`rounded-lg px-3 py-2.5 text-xs space-y-1.5 border ${geminiTest.ok ? 'bg-emerald-950/40 border-emerald-700/40' : 'bg-rose-950/40 border-rose-700/40'}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`font-semibold ${geminiTest.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {geminiTest.ok ? `✓ 연결 성공 (${geminiTest.model})` : `✗ 연결 실패 (${geminiTest.model})`}
                </span>
                {geminiTest.latencyMs > 0 && (
                  <span className="text-slate-500">{geminiTest.latencyMs.toLocaleString()}ms</span>
                )}
              </div>
              {geminiTest.errorDetail && (
                <p className="text-amber-200/80 leading-relaxed">{geminiTest.errorDetail}</p>
              )}
              {geminiTest.rawError && (
                <pre className="text-rose-300/60 font-mono text-[10px] whitespace-pre-wrap break-all leading-relaxed max-h-20 overflow-y-auto">{geminiTest.rawError}</pre>
              )}
              {geminiTest.response && (
                <p className="text-emerald-300/70">응답: "{geminiTest.response}"</p>
              )}
            </div>
          )}

          {/* 버튼 행 */}
          {!summaryLoading && (
            <div className="flex items-center gap-2 justify-end flex-wrap">
              <button
                onClick={testGemini}
                disabled={geminiTesting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-violet-900/30 border border-violet-700/50 text-violet-300 hover:bg-violet-800/40 disabled:opacity-50 transition-colors"
              >
                {geminiTesting ? (
                  <span className="w-3 h-3 border border-violet-400 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <span>⚡</span>
                )}
                Gemini 연결 테스트
              </button>
              <button
                onClick={() => fetchSummary(true)}
                disabled={summaryRefreshing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 disabled:opacity-50 transition-colors"
              >
                {summaryRefreshing ? (
                  <span className="w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <span>↻</span>
                )}
                다시 불러오기
              </button>
            </div>
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
