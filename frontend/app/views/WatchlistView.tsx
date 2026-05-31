'use client';

import React, { useState, useRef } from 'react';
import { Panel, EmptyMsg } from '@/components/ui';
import { api } from '../lib/utils';
import { toDisplayName } from '../lib/helpers';
import StockCard from './watchlist/StockCard';
import StockAnalysisPanel from './watchlist/StockAnalysisPanel';
import SoldStocksPanel from './watchlist/SoldStocksPanel';
import { USWatchlistPanel } from './watchlist/USWatchlistPanel';

function WatchlistView({ watchlist, setWatchlist, dash, usDash, toast, confirm, onRefresh, viewMode = 'live' }: any) {
  const usW = usDash?.watchlist || [];
  const chains = dash?.chains || [];
  const getWatchlistName = (code: string) => {
    const item = watchlist.find((s: any) => s.stock_code === code);
    return toDisplayName(item?.stock_name, code);
  };
  const [selectedStock, setSelectedStock] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<any>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const [fastAnalyzing, setFastAnalyzing] = useState<Set<string>>(new Set());

  const loadAnalysis = async (code: string) => {
    if (selectedStock === code) { setSelectedStock(null); return; }
    analysisAbortRef.current?.abort();
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    setSelectedStock(code);
    setAnalysisLoading(true);
    try {
      const data = await api(`/stock/${code}/analysis`);
      if (!controller.signal.aborted) setAnalysis(data);
    } catch { if (!controller.signal.aborted) setAnalysis(null); }
    finally { clearTimeout(timeout); if (!controller.signal.aborted) setAnalysisLoading(false); }
  };

  // ── 종목 검색 자동완성 ──
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ code: string; name: string; market: string }>>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedResult, setSelectedResult] = useState<{ code: string; name: string; market: string } | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearchInput = (q: string) => {
    setSearchQuery(q);
    setSelectedResult(null);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (q.length < 1) { setSearchResults([]); setShowDropdown(false); return; }
    searchTimerRef.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const results = await api(`/search/stock?q=${encodeURIComponent(q)}`);
        setSearchResults(Array.isArray(results) ? results : []);
        setShowDropdown(true);
      } catch { setSearchResults([]); }
      finally { setSearchLoading(false); }
    }, 300);
  };

  const pickResult = (r: { code: string; name: string; market: string }) => {
    setSelectedResult(r);
    setSearchQuery(`${r.name} (${r.code})`);
    setShowDropdown(false);
  };

  const addStock = async () => {
    const target = selectedResult ?? (searchQuery.replace(/\D/g, '').length === 6
      ? { code: searchQuery.replace(/\D/g, ''), name: '', market: 'KOSPI' } : null);
    if (!target) { toast('종목명 또는 6자리 코드를 입력 후 목록에서 선택하세요', 'err'); return; }
    try {
      const result = await api('/watchlist', { method: 'POST', body: JSON.stringify({ stock_code: target.code, stock_name: target.name, market: target.market }) });
      setSearchQuery(''); setSelectedResult(null); setSearchResults([]);
      // 빠른 분석 인디케이터 (3분간 표시)
      if (result?.ok) {
        setFastAnalyzing((prev) => new Set(prev).add(target.code));
        setTimeout(() => setFastAnalyzing((prev) => { const next = new Set(prev); next.delete(target.code); return next; }), 180_000);
      }
      const w = await api('/watchlist'); setWatchlist(Array.isArray(w) ? w : []);
    } catch (err: any) { toast(err.message, 'err'); }
  };

  const del = async (code: string) => {
    if (!await confirm({ title: `${code} 삭제`, description: '감시목록에서 삭제합니다', confirmLabel: '삭제', confirmVariant: 'danger' })) return;
    await api(`/watchlist/${code}`, { method: 'DELETE' });
    setWatchlist((prev: any[]) => prev.filter(s => s.stock_code !== code));
  };

  // 스코어 스파크라인 캐시
  const [sparklines, setSparklines] = useState<Map<string, number[]>>(new Map());
  React.useEffect(() => {
    const codes = watchlist.map((s: any) => s.stock_code).filter((c: string) => /^[0-9]{6}$/.test(c));
    codes.forEach((code: string) => {
      api(`/stock/${code}/score-history`).then((rows: any) => {
        if (Array.isArray(rows) && rows.length >= 2) {
          setSparklines((prev) => new Map(prev).set(code, rows.map((r: any) => Number(r.score))));
        }
      }).catch(() => {});
    });
  }, [watchlist]);

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* 추가 폼 */}
      <div className="flex flex-wrap gap-2 items-end">
        <div className="relative flex-1 min-w-[220px]">
          <input
            value={searchQuery}
            onChange={(e) => handleSearchInput(e.target.value)}
            onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
            onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
            placeholder="종목명 또는 코드 검색 (예: 삼성전자, 005930)"
            className="w-full bg-white/[0.05] ring-1 ring-white/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all pr-8"
          />
          {searchLoading && <div className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />}
          {showDropdown && searchResults.length > 0 && (
            <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-[#0f1422] ring-1 ring-white/[0.08] rounded-xl shadow-xl shadow-black/40 overflow-hidden">
              {searchResults.map((r) => (
                <button key={r.code} type="button" onMouseDown={() => pickResult(r)}
                  className="w-full text-left px-3 py-2.5 text-sm hover:bg-white/[0.06] flex items-center justify-between gap-2 transition-colors">
                  <span className="font-medium text-slate-200">{r.name}</span>
                  <span className="text-[11px] text-slate-500 shrink-0">{r.code} · {r.market}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={addStock} className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium whitespace-nowrap transition-all shadow-sm">
          추가
        </button>
      </div>

      {/* 종목 상세 분석 */}
      {selectedStock && (
        <StockAnalysisPanel
          stockName={getWatchlistName(selectedStock)}
          analysis={analysis}
          isLoading={analysisLoading}
        />
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-5">
        {/* 국내 */}
        <KRWatchlistPanel
          watchlist={watchlist}
          chains={chains}
          dash={dash}
          sparklines={sparklines}
          selectedStock={selectedStock}
          fastAnalyzing={fastAnalyzing}
          onSelect={loadAnalysis}
          onDelete={del}
        />

        {/* 미국 */}
        <USWatchlistPanel usW={usW} />
      </div>

      {/* 최근 매도 추적 */}
      <SoldStocksPanel
        toast={toast}
        viewMode={viewMode}
        onReAdd={async () => {
          const w = await api(`/watchlist?viewMode=${viewMode}`); setWatchlist(Array.isArray(w) ? w : []);
        }}
      />
    </div>
  );
}

// ── 국내 감시목록 패널 ──
function KRWatchlistPanel({ watchlist, chains, dash, sparklines, selectedStock, fastAnalyzing, onSelect, onDelete }: any) {
  const [krFilter, setKrFilter] = useState<'전체' | 'KOSPI' | 'KOSDAQ' | '투자중' | '매수근접' | '최근매도'>('전체');
  const krFiltered = watchlist.filter((s: any) => {
    if (krFilter === '전체') return true;
    if (krFilter === 'KOSPI') return s.market === 'KOSPI' || (!s.market && /^[013]/.test(s.stock_code));
    if (krFilter === 'KOSDAQ') return s.market === 'KOSDAQ' || (!s.market && /^[278]/.test(s.stock_code));
    if (krFilter === '투자중') return chains.some((ch: any) => ch.stock_code === s.stock_code && ch.status !== 'CLOSED');
    if (krFilter === '매수근접') {
      const sc = dash?.scores?.find((sc: any) => sc.stock_code === s.stock_code);
      return sc && Number(sc.composite_score) >= 78;
    }
    if (krFilter === '최근매도') return s.last_sell_at != null;
    return true;
  });
  const KR_FILTERS: Array<typeof krFilter> = ['전체', 'KOSPI', 'KOSDAQ', '투자중', '매수근접', '최근매도'];

  const sorted = [...krFiltered].sort((a: any, b: any) => {
    const chainA = chains.find((ch: any) => ch.stock_code === a.stock_code);
    const chainB = chains.find((ch: any) => ch.stock_code === b.stock_code);
    if (chainA && !chainB) return -1;
    if (!chainA && chainB) return 1;
    const valA = dash?.scores?.find((sc: any) => sc.stock_code === a.stock_code)?.composite_score ?? -1;
    const valB = dash?.scores?.find((sc: any) => sc.stock_code === b.stock_code)?.composite_score ?? -1;
    return Number(valB) - Number(valA);
  });

  return (
    <Panel title="로봇이 감시하는 종목들" badge={`${krFiltered.length}/${watchlist.length}종목`}>
      <div className="px-3 pt-3 pb-1 flex gap-1 flex-wrap">
        {KR_FILTERS.map(f => (
          <button key={f} onClick={() => setKrFilter(f)}
            className={`text-[10px] px-2 py-1 rounded-lg transition-all ${krFilter === f ? 'bg-violet-600 text-white' : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]'}`}>
            {f}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 p-3">
        {sorted.map((s: any) => (
          <StockCard
            key={s.stock_code}
            stock={s}
            score={dash?.scores?.find((sc: any) => sc.stock_code === s.stock_code)}
            chain={chains.find((ch: any) => ch.stock_code === s.stock_code)}
            sparkline={sparklines.get(s.stock_code)}
            isSelected={selectedStock === s.stock_code}
            fastAnalyzing={fastAnalyzing.has(s.stock_code)}
            onClick={() => onSelect(s.stock_code)}
            onDelete={onDelete}
          />
        ))}
        {krFiltered.length === 0 && watchlist.length === 0 && <div className="col-span-2"><EmptyMsg>종목을 추가하면 로봇이 24시간 감시합니다</EmptyMsg></div>}
        {krFiltered.length === 0 && watchlist.length > 0 && <div className="col-span-2"><EmptyMsg>해당 조건의 종목이 없습니다</EmptyMsg></div>}
      </div>
    </Panel>
  );
}

export default WatchlistView;
