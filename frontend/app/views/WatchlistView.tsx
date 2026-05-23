'use client';

import React, { useState, useRef } from 'react';
import { Panel, Indicator, EmptyMsg } from '@/components/ui';
import { api, fmt, fmtPct, fmtWon, pc, pbg } from '../lib/utils';
import { toDisplayName } from '../lib/helpers';
import { US_SECTOR_MAP, US_SECTORS } from '../panels/OverseasScorePanel';

function WatchlistView({ watchlist, setWatchlist, dash, usDash, toast, onRefresh }: any) {
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

  const loadAnalysis = async (code: string) => {
    if (selectedStock === code) { setSelectedStock(null); return; }
    // 이전 요청 취소
    analysisAbortRef.current?.abort();
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    // 10초 타임아웃
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
  const searchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (!target) { alert('종목명 또는 6자리 코드를 입력 후 목록에서 선택하세요'); return; }
    try {
      await api('/watchlist', { method: 'POST', body: JSON.stringify({ stock_code: target.code, stock_name: target.name, market: target.market }) });
      setSearchQuery(''); setSelectedResult(null); setSearchResults([]);
      const w = await api('/watchlist'); setWatchlist(Array.isArray(w) ? w : []);
    } catch (err: any) { alert(err.message); }
  };

  const del = async (code: string) => {
    if (!confirm(`${code} 삭제?`)) return;
    await api(`/watchlist/${code}`, { method: 'DELETE' });
    setWatchlist((prev: any[]) => prev.filter(s => s.stock_code !== code));
  };

  // 스코어 스파크라인 캐시 (종목코드 → 점수 배열)
  const [sparklines, setSparklines] = React.useState<Map<string, number[]>>(new Map());
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

  const [syncing, setSyncing] = useState(false);
  const syncKIS = async () => {
    setSyncing(true);
    try {
      const r = await api('/watchlist/sync', { method: 'POST' });
      alert(r.message || `동기화 완료: ${r.added?.length || 0}종목 추가`);
      const w = await api('/watchlist'); setWatchlist(Array.isArray(w) ? w : []);
    } catch (err: any) { alert(`동기화 실패: ${err.message}`); }
    finally { setSyncing(false); }
  };

  const t = analysis?.technicals;
  const f = analysis?.flow;
  const sh = analysis?.shorts;
  const con = analysis?.consensus;

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* 추가 폼 + KIS 동기화 */}
      <div className="flex flex-wrap gap-2 items-end">
        <div className="relative flex-1 min-w-[220px]">
          <input
            value={searchQuery}
            onChange={(e) => handleSearchInput(e.target.value)}
            onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
            onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
            placeholder="종목명 또는 코드 검색 (예: 삼성전자, 005930)"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm placeholder:text-slate-600 focus:border-blue-500 focus:outline-none pr-8"
          />
          {searchLoading && <div className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />}
          {showDropdown && searchResults.length > 0 && (
            <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl overflow-hidden">
              {searchResults.map((r) => (
                <button key={r.code} type="button" onMouseDown={() => pickResult(r)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-slate-700 flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-200">{r.name}</span>
                  <span className="text-[11px] text-slate-500 shrink-0">{r.code} · {r.market}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={addStock} className="px-5 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium whitespace-nowrap">
          추가
        </button>
      </div>

      {/* 종목 상세 분석 패널 */}
      {selectedStock && (
        <Panel title={`${getWatchlistName(selectedStock)} 종목 분석`}>
          {analysisLoading ? (
            <div className="p-8 text-center"><div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto" /></div>
          ) : t ? (
            <div className="p-4 sm:p-5 space-y-5">
              {/* 차트 분석 지표 */}
              <div>
                <h4 className="text-xs font-semibold text-slate-400 mb-3">차트 건강 상태</h4>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
                  <Indicator label="과열/침체" value={t.rsi14 != null ? Number(t.rsi14).toFixed(0) : '-'} sub={Number(t.rsi14) > 70 ? '너무 올랐음' : Number(t.rsi14) < 30 ? '많이 빠짐 (기회)' : '적정 수준'} color={Number(t.rsi14) > 70 ? 'rose' : Number(t.rsi14) < 30 ? 'emerald' : 'slate'} />
                  <Indicator label="추세 방향" value={Number(t.macdHistogram) > 0 ? '상승' : '하락'} sub={t.macdCrossover === 'golden' ? '상승 전환!' : t.macdCrossover === 'dead' ? '하락 전환' : '유지 중'} color={Number(t.macdHistogram) > 0 ? 'emerald' : 'rose'} />
                  <Indicator label="가격 위치" value={t.bollingerPosition != null ? Number(t.bollingerPosition).toFixed(0) + '%' : '-'} sub={Number(t.bollingerPosition) > 80 ? '고가 영역' : Number(t.bollingerPosition) < 20 ? '저가 영역' : '중간'} color={Number(t.bollingerPosition) > 80 ? 'rose' : Number(t.bollingerPosition) < 20 ? 'emerald' : 'slate'} />
                  <Indicator label="추세 강도" value={t.adx14 != null ? Number(t.adx14).toFixed(0) : '-'} sub={Number(t.adx14) > 25 ? '뚜렷한 방향' : '방향 없음'} color={Number(t.adx14) > 25 ? 'blue' : 'slate'} />
                  <Indicator label="AI 종합" value={t.score != null ? Number(t.score).toFixed(0) + '점' : '-'} sub={Number(t.score) > 20 ? '매수 유리' : Number(t.score) < -20 ? '매수 위험' : '관망'} color={Number(t.score) > 20 ? 'emerald' : Number(t.score) < -20 ? 'rose' : 'slate'} />
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-3 text-center text-[11px]">
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">5일 평균가</span><b>{Number(t.sma5 ?? 0).toLocaleString()}</b></div>
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">20일 평균가</span><b>{Number(t.sma20 ?? 0).toLocaleString()}</b></div>
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">60일 평균가</span><b>{Number(t.sma60 ?? 0).toLocaleString()}</b></div>
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">거래량 변화</span><b className={Number(t.volumeRatio) > 2 ? 'text-amber-400' : ''}>{Number(t.volumeRatio ?? 0).toFixed(1)}배</b></div>
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">매수/매도 힘</span><b>{Number(t.stochasticK ?? 0).toFixed(0)}</b></div>
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">변동성</span><b>{Number(t.atr14 ?? 0).toFixed(0)}</b></div>
                </div>
                {t.goldenCross && <p className="text-[11px] text-emerald-400 mt-2">단기 평균이 장기 평균을 돌파 — 상승 신호</p>}
                {t.deathCross && <p className="text-[11px] text-rose-400 mt-2">단기 평균이 장기 평균 아래로 — 하락 신호</p>}
              </div>

              {/* 큰손 동향 + 공매도 + 증권사 의견 */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* 큰손 동향 */}
                <div className="bg-slate-900/40 rounded-xl p-4">
                  <h4 className="text-xs font-semibold text-slate-400 mb-2">큰손(외국인/기관) 동향</h4>
                  {f ? (
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between"><span className="text-slate-500">외국인</span><span className={f.foreignNet > 0 ? 'text-emerald-400' : 'text-rose-400'}>{f.foreignNet > 0 ? '사는 중 +' : '파는 중 '}{f.foreignNet?.toLocaleString()}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">기관</span><span className={f.institutionNet > 0 ? 'text-emerald-400' : 'text-rose-400'}>{f.institutionNet > 0 ? '사는 중 +' : '파는 중 '}{f.institutionNet?.toLocaleString()}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">연속 매수</span><span className="font-bold">{f.foreignStreak ?? 0}일째</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">흐름</span><span className={f.trend === 'STRONG_BUY' || f.trend === 'BUY' ? 'text-emerald-400' : f.trend === 'SELL' || f.trend === 'STRONG_SELL' ? 'text-rose-400' : 'text-slate-400'}>{f.trend === 'STRONG_BUY' ? '강하게 사는 중' : f.trend === 'BUY' ? '사는 중' : f.trend === 'SELL' ? '파는 중' : f.trend === 'STRONG_SELL' ? '강하게 파는 중' : '관망'}</span></div>
                    </div>
                  ) : <p className="text-[11px] text-slate-600">시장 마감 시간</p>}
                </div>

                {/* 하락 베팅 (공매도) */}
                <div className="bg-slate-900/40 rounded-xl p-4">
                  <h4 className="text-xs font-semibold text-slate-400 mb-2">하락에 베팅하는 세력</h4>
                  {sh ? (
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between"><span className="text-slate-500">하락 베팅 비율</span><span className={sh.riskLevel === 'HIGH' ? 'text-rose-400 font-bold' : ''}>{Number(sh.shortRatio ?? 0).toFixed(1)}%</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">추세</span><span>{sh.isIncreasing ? '늘어나는 중' : '줄어드는 중'}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">위험도</span><span className={sh.riskLevel === 'HIGH' ? 'text-rose-400' : sh.riskLevel === 'MEDIUM' ? 'text-amber-400' : 'text-emerald-400'}>{sh.riskLevel === 'HIGH' ? '높음 (주의)' : sh.riskLevel === 'MEDIUM' ? '보통' : '낮음 (안전)'}</span></div>
                    </div>
                  ) : <p className="text-[11px] text-slate-600">시장 마감 시간</p>}
                </div>

                {/* 증권사 의견 */}
                <div className="bg-slate-900/40 rounded-xl p-4">
                  <h4 className="text-xs font-semibold text-slate-400 mb-2">증권사 전문가 의견</h4>
                  {con ? (
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between"><span className="text-slate-500">예상 목표가</span><span className="font-bold">{con.targetPrice?.toLocaleString()}원</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">얼마나 오를 수 있나</span><span className={con.upsidePct > 0 ? 'text-emerald-400' : 'text-rose-400'}>{Number(con.upsidePct) > 0 ? '+' : ''}{Number(con.upsidePct ?? 0).toFixed(1)}%</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">전문가 의견</span><span>사라 {con.buyCount}명 · 보유 {con.holdCount}명 · 팔아라 {con.sellCount}명</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">종합</span><span className={con.consensusRating === 'STRONG_BUY' || con.consensusRating === 'BUY' ? 'text-emerald-400' : 'text-slate-400'}>{con.consensusRating === 'STRONG_BUY' ? '적극 매수' : con.consensusRating === 'BUY' ? '매수' : con.consensusRating === 'HOLD' ? '보유' : con.consensusRating === 'SELL' ? '매도' : '의견 없음'}</span></div>
                    </div>
                  ) : <p className="text-[11px] text-slate-600">데이터 없음</p>}
                </div>
              </div>
            </div>
          ) : <EmptyMsg>시장 마감 시간이거나 데이터가 부족합니다</EmptyMsg>}
        </Panel>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-5">
        {/* 국내 */}
        {(() => {
          const [krFilter, setKrFilter] = React.useState<'전체' | 'KOSPI' | 'KOSDAQ' | '투자중' | '매수근접' | '최근매도'>('전체');
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
          const KR_FILTER_OPTIONS: Array<'전체' | 'KOSPI' | 'KOSDAQ' | '투자중' | '매수근접' | '최근매도'> = ['전체', 'KOSPI', 'KOSDAQ', '투자중', '매수근접', '최근매도'];
          return (
        <Panel title="로봇이 감시하는 종목들" badge={`${krFiltered.length}/${watchlist.length}종목`}>
          <div className="px-3 pt-3 pb-1 flex gap-2 flex-wrap items-center">
            <div className="flex gap-1 flex-wrap">
              {KR_FILTER_OPTIONS.map(f => (
                <button key={f} onClick={() => setKrFilter(f)}
                  className={`text-[10px] px-2 py-1 rounded-lg transition-all ${krFilter === f ? 'bg-violet-600 text-white' : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]'}`}>
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 p-3">
            {[...krFiltered].sort((a: any, b: any) => {
              const chainA = chains.find((ch: any) => ch.stock_code === a.stock_code);
              const chainB = chains.find((ch: any) => ch.stock_code === b.stock_code);
              if (chainA && !chainB) return -1;
              if (!chainA && chainB) return 1;
              const scoreA = dash?.scores?.find((sc: any) => sc.stock_code === a.stock_code);
              const scoreB = dash?.scores?.find((sc: any) => sc.stock_code === b.stock_code);
              const valA = scoreA ? Number(scoreA.composite_score) : -1;
              const valB = scoreB ? Number(scoreB.composite_score) : -1;
              return valB - valA;
            }).map((s: any) => {
              const score = dash?.scores?.find((sc: any) => sc.stock_code === s.stock_code);
              const chain = chains.find((ch: any) => ch.stock_code === s.stock_code);
              const isSelected = selectedStock === s.stock_code;
              const scoreVal = score ? Number(score.composite_score) : -1;
              const displayName = toDisplayName(s.stock_name, s.stock_code);
              const sellPct: number | undefined = s.last_sell_pct != null ? Number(s.last_sell_pct) : undefined;
              const lastSellPrice: number | undefined = s.last_sell_price != null ? Number(s.last_sell_price) : undefined;
              const curScorePrice = dash?.scores?.find((sc: any) => sc.stock_code === s.stock_code)?.currentPrice;
              const postSellPct: number | undefined = (lastSellPrice && curScorePrice && lastSellPrice > 0)
                ? ((curScorePrice - lastSellPrice) / lastSellPrice) * 100
                : undefined;

              let statusColor = 'text-slate-500';
              let statusLabel = '대기';
              let borderClass = 'border-white/[0.06]';
              if (chain) { statusColor = 'text-emerald-400'; statusLabel = '투자 중'; borderClass = 'border-emerald-500/30'; }
              else if (scoreVal >= 80) { statusColor = 'text-amber-400'; statusLabel = '매수 근접'; borderClass = 'border-amber-500/30'; }
              else if (scoreVal >= 0) { statusColor = 'text-blue-400'; statusLabel = '감시 중'; }

              return (
                <div key={s.stock_code} onClick={() => loadAnalysis(s.stock_code)}
                  className={`relative group rounded-xl border px-3 py-3 cursor-pointer hover:bg-white/[0.03] transition-colors ${isSelected ? 'bg-blue-950/20 border-blue-500/40' : borderClass}`}>
                  <div className="flex items-start justify-between gap-1">
                    <span className="font-bold text-[13px] truncate leading-tight">{displayName}</span>
                    <span className={`text-[9px] font-semibold shrink-0 mt-0.5 ${statusColor}`}>{statusLabel}</span>
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-2">
                    <span>{chain ? `평단 ${Number(chain.avg_buy_price).toLocaleString()}원` : scoreVal >= 0 ? `AI ${scoreVal}점` : '점수 없음'}</span>
                    {(() => {
                      const pts = sparklines.get(s.stock_code);
                      if (!pts || pts.length < 2) return null;
                      const min = Math.min(...pts); const max = Math.max(...pts);
                      const range = max - min || 1;
                      const w = 40; const h = 16;
                      const xs = pts.map((_, i) => (i / (pts.length - 1)) * w);
                      const ys = pts.map((v) => h - ((v - min) / range) * h);
                      const d = xs.map((x, i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' ');
                      const trend = pts[pts.length - 1] >= pts[0] ? '#10b981' : '#f43f5e';
                      return (
                        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
                          <path d={d} fill="none" stroke={trend} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      );
                    })()}
                  </div>
                  {sellPct != null && (
                    <div className="mt-1 flex flex-col gap-0.5">
                      <div className={`text-[10px] font-medium ${sellPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        매도수익 {sellPct >= 0 ? '+' : ''}{sellPct.toFixed(1)}%
                      </div>
                      {postSellPct != null && (
                        <div className={`text-[10px] ${postSellPct >= 0 ? 'text-amber-400' : 'text-sky-400'}`}>
                          매도 후 {postSellPct >= 0 ? '↑+' : '↓'}{postSellPct.toFixed(1)}%
                        </div>
                      )}
                    </div>
                  )}
                  {s.source && s.source !== 'MANUAL' && (
                    <div className="mt-1">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                        s.source === 'KIS_SYNC' ? 'bg-blue-500/15 text-blue-400' : 'bg-violet-500/15 text-violet-400'
                      }`}>
                        {s.source === 'KIS_SYNC' ? 'KIS관심그룹' : '자동편입'}
                      </span>
                    </div>
                  )}
                  <button onClick={(e) => { e.stopPropagation(); del(s.stock_code); }}
                    className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-[9px] text-rose-400 hover:text-rose-300 transition-opacity leading-none">✕</button>
                </div>
              );
            })}
            {krFiltered.length === 0 && watchlist.length === 0 && <div className="col-span-2"><EmptyMsg>종목을 추가하면 로봇이 24시간 감시합니다</EmptyMsg></div>}
            {krFiltered.length === 0 && watchlist.length > 0 && <div className="col-span-2"><EmptyMsg>해당 조건의 종목이 없습니다</EmptyMsg></div>}
          </div>
        </Panel>
          );
        })()}

        {/* 미국 — 기술점수 포함 */}
        {(() => {
          const [usScores, setUsScores] = React.useState<any[]>([]);
          const [scoresLoading, setScoresLoading] = React.useState(false);

          React.useEffect(() => {
            // usDash watchlist에 이미 score가 있으면 그대로 사용
            const hasScores = usW.some((s: any) => typeof s.score === 'number');
            if (hasScores) { setUsScores(usW); return; }
            // 없으면 온디맨드 계산 요청
            setScoresLoading(true);
            api('/overseas/scores').then((data: any) => {
              if (Array.isArray(data) && data.length > 0) {
                // usDash watchlist 가격정보와 병합
                const scoreMap = new Map(data.map((s: any) => [s.code, s]));
                const merged = (usW.length > 0 ? usW : data).map((s: any) => {
                  const sc = scoreMap.get(s.code ?? s.stock_code);
                  return sc ? { ...s, score: sc.score, signal: sc.signal, rsi: sc.rsi } : s;
                });
                setUsScores(merged.length > 0 ? merged : data);
              } else if (usW.length > 0) {
                setUsScores(usW);
              }
            }).catch(() => { if (usW.length > 0) setUsScores(usW); })
            .finally(() => setScoresLoading(false));
          }, [usW]);

          const [usSector, setUsSector] = React.useState('전체');
          const allDisplayList = usScores.length > 0 ? usScores : usW;
          const displayList = usSector === '전체' ? allDisplayList : allDisplayList.filter((s: any) => US_SECTOR_MAP[s.code ?? s.stock_code] === usSector);
          return (
            <Panel title="🇺🇸 미국주식 감시" badge={scoresLoading ? '계산 중...' : `${displayList.length}/${allDisplayList.length}종목`}>
              {/* 섹터 필터 */}
              <div className="px-3 pt-3 pb-1 flex gap-1 flex-wrap">
                {US_SECTORS.map(s => (
                  <button key={s} onClick={() => setUsSector(s)}
                    className={`text-[10px] px-2 py-1 rounded-lg transition-all ${usSector === s ? 'bg-blue-600 text-white' : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]'}`}>
                    {s}
                  </button>
                ))}
              </div>
              {scoresLoading && allDisplayList.length === 0 && (
                <div className="flex items-center gap-2 px-4 py-3 text-[11px] text-slate-500">
                  <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                  기술지표 자동 계산 중 (AI 없이 차트 분석)...
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3">
                {displayList.map((s: any) => {
                  const code = s.code ?? s.stock_code;
                  const name = s.name ?? code;
                  const usDisplayName = toDisplayName(name, code);
                  const score = typeof s.score === 'number' ? s.score : null;
                  const signal = s.signal ?? '';
                  const rsi = typeof s.rsi === 'number' ? s.rsi : null;
                  const sectorTag = US_SECTOR_MAP[code] ?? '';
                  const signalColor = signal === 'STRONG_BUY' ? 'text-emerald-300' : signal === 'BUY' ? 'text-emerald-400' : signal === 'SELL' || signal === 'STRONG_SELL' ? 'text-rose-400' : 'text-slate-500';
                  const scoreBg = score !== null ? (score >= 40 ? 'bg-emerald-500/10 border-emerald-500/20' : score <= -20 ? 'bg-rose-500/10 border-rose-500/20' : 'bg-white/[0.03] border-slate-700/30') : `${pbg(s.changePct)} border-slate-700/30`;
                  return (
                    <div key={code} className={`rounded-lg border p-3 ${scoreBg}`}>
                      <div className="flex items-center justify-between gap-1 mb-0.5">
                        <span className="font-bold text-sm truncate">{usDisplayName}</span>
                        <span className={`text-[10px] font-medium shrink-0 ${pc(s.changePct)}`}>{fmtPct(s.changePct)}</span>
                      </div>
                      {sectorTag && <div className="text-[9px] text-slate-600 mb-1">{sectorTag}</div>}
                      <div className="text-base font-bold">{s.price > 0 ? `$${s.price.toFixed(2)}` : '-'}</div>
                      {score !== null && (
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${signalColor} bg-white/[0.04]`}>
                            {signal === 'STRONG_BUY' ? '강매수' : signal === 'BUY' ? '매수' : signal === 'HOLD' ? '관망' : signal === 'SELL' ? '매도' : signal === 'STRONG_SELL' ? '강매도' : signal}
                          </span>
                          <span className={`text-[9px] font-semibold ${score >= 40 ? 'text-emerald-400' : score <= -20 ? 'text-rose-400' : 'text-slate-400'}`}>{score >= 0 ? '+' : ''}{Math.round(score)}점</span>
                          {rsi !== null && <span className="text-[9px] text-slate-600">RSI {Math.round(rsi)}</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
                {displayList.length === 0 && !scoresLoading && <div className="col-span-3"><EmptyMsg>데이터 없음</EmptyMsg></div>}
              </div>
            </Panel>
          );
        })()}
      </div>
    </div>
  );
}

export default WatchlistView;
