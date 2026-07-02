'use client';

import React, { useState, useEffect } from 'react';
import { api, fmtTime } from '../../lib/utils';
import type { WatchlistItem, UsDashboard, UsWatchlistItem } from '../../types';

interface Note {
  id: number;
  url: string | null;
  title: string | null;
  memo: string | null;
  fetched_at: string;
  length: number;
}

interface DartFinancial {
  revenue: number;
  revenueYoy: number;
  operatingIncome: number;
  operatingIncomeYoy: number;
  operatingMargin: number;
  netIncome: number;
  totalAssets: number;
  totalDebt: number;
  debtRatio: number;
  year: string;
  quarter: string;
}

interface DartResult {
  stockCode: string;
  corpName: string;
  financial?: DartFinancial;
  aiAnalysis?: string;
  fundamentalScore?: number;
  piotroskiScore?: number;
  keyRisks: string[];
  keyStrengths: string[];
  analyzedAt: string;
  earningsDate?: string;       // "2026-07-25" 형식
  earningsDaysLeft?: number;   // 오늘 기준 남은 일수
}


// 추천 금융 사이트 (공신력 + 매매 확률 향상에 유용)
const RECOMMENDED_SITES = [
  // ── 국내 (공신력·이용자 순) ──
  { name: 'DART 전자공시', url: 'https://dart.fss.or.kr', icon: '📋', desc: '금감원 공식 — 실적공시/대량보유/내부거래 (1순위 필수)' },
  { name: '네이버 증권', url: 'https://finance.naver.com', icon: '🟢', desc: '국내 최대 — 실시간시세/차트/뉴스/증권사리포트/종목토론' },
  { name: 'KRX 정보데이터', url: 'https://data.krx.co.kr/contents/MDC/MAIN/main/index.cmd', icon: '📊', desc: '거래소 공식 — 수급/공매도/프로그램매매/시장통계' },
  { name: 'FnGuide', url: 'https://comp.fnguide.com', icon: '📈', desc: '기관급 분석 — 재무비율/컨센서스/밸류에이션 (증권사 동일DB)' },
  { name: '한경 컨센서스', url: 'https://consensus.hankyung.com', icon: '📰', desc: '증권사 리포트 집계 — 목표가/투자의견/실적추정치 비교' },
  // ── 해외/글로벌 (공신력·이용자 순) ──
  { name: 'SEC EDGAR', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=&dateb=&owner=include&count=40&search_text=&action=getcompany', icon: '🇺🇸', desc: '미국 공식 — 10-K/10-Q/Form4/13F (미국주식 1순위)' },
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com', icon: '💰', desc: '세계 최대 금융포털 — 실시간시세/실적/배당/뉴스 (MAU 1억+)' },
  { name: 'TradingView', url: 'https://www.tradingview.com', icon: '📉', desc: '세계 최대 차트 — 기술적분석/글로벌시세/5000만 트레이더' },
  { name: 'Finviz', url: 'https://finviz.com/screener.ashx', icon: '🔍', desc: '미국 스크리너 1위 — 히트맵/펀더멘털/기술적필터/실적캘린더' },
  { name: 'Investing.com', url: 'https://kr.investing.com/economic-calendar', icon: '🌍', desc: '글로벌 경제캘린더 — FOMC/고용/CPI/GDP (4600만 MAU)' },
  { name: 'CNN Fear & Greed', url: 'https://edition.cnn.com/markets/fear-and-greed', icon: '😱', desc: '시장심리 대표지표 — VIX/풋콜비율/정크본드스프레드 종합' },
  { name: 'FRED', url: 'https://fred.stlouisfed.org', icon: '🏛️', desc: '미연준 공식 경제DB — 금리/인플레/실업률/M2 (81만개 시계열)' },
];

// 숫자 포맷 (억 단위)
function fmtBillion(v: number): string {
  const eok = v / 100_000_000;
  if (Math.abs(eok) >= 10000) return `${(eok / 10000).toFixed(1)}조`;
  if (Math.abs(eok) >= 1) return `${eok.toFixed(0)}억`;
  return `${(v / 10000).toFixed(0)}만`;
}

// F-Score 색상
function fScoreColor(f: number): string {
  if (f >= 7) return 'text-emerald-400';
  if (f >= 5) return 'text-amber-400';
  return 'text-rose-400';
}

// 펀더멘털 점수 색상
function fundColor(s: number): string {
  if (s >= 70) return 'text-emerald-400';
  if (s >= 50) return 'text-amber-400';
  return 'text-rose-400';
}

function fundBg(s: number): string {
  if (s >= 70) return 'bg-emerald-500/15 border-emerald-500/30';
  if (s >= 50) return 'bg-amber-500/15 border-amber-500/30';
  return 'bg-rose-500/15 border-rose-500/30';
}

export function ResearchBotPanel() {
  const [url, setUrl] = useState('');
  const [memo, setMemo] = useState('');
  const [crawling, setCrawling] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesLoading, setNotesLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'reports' | 'dart' | 'sec' | 'url'>('dart');

  // 감시목록 동적 로드
  const [krWatchlist, setKrWatchlist] = useState<Array<{ code: string; name: string }>>([]);
  const [usWatchlist, setUsWatchlist] = useState<Array<{ ticker: string; name: string }>>([]);

  // DART 재무분석 상태
  const [dartResults, setDartResults] = useState<DartResult[]>([]);
  const [dartLoading, setDartLoading] = useState(false);
  const [dartError, setDartError] = useState<string | null>(null);
  const [expandedDart, setExpandedDart] = useState<string | null>(null);

  // SEC 재무분석 상태
  const [secResults, setSecResults] = useState<DartResult[]>([]);
  const [secLoading, setSecLoading] = useState(false);
  const [secError, setSecError] = useState<string | null>(null);
  const [expandedSec, setExpandedSec] = useState<string | null>(null);

  // 종목명 lookup
  const krName = (code: string) => krWatchlist.find((s) => s.code === code)?.name ?? code;
  const usName = (ticker: string) => usWatchlist.find((s) => s.ticker === ticker)?.name ?? ticker;

  const loadNotes = async () => {
    try {
      const data = await api('/research/notes');
      setNotes(data.notes ?? []);
    } catch {
      setNotes([]);
    } finally {
      setNotesLoading(false);
    }
  };

  const loadDartReports = async () => {
    setDartLoading(true);
    setDartError(null);
    try {
      const stockCodes = krWatchlist.map((s) => s.code).slice(0, 20);
      if (stockCodes.length === 0) {
        setDartError('감시목록에 KR 종목이 없습니다');
        setDartLoading(false);
        return;
      }
      const data = await api('/research/dart/batch', {
        method: 'POST',
        body: JSON.stringify({ stockCodes }),
        timeout: 90000,
      });
      if (data.ok && Array.isArray(data.results)) {
        setDartResults(data.results);
      } else {
        setDartError(data.error ?? '분석 실패');
      }
    } catch (err: unknown) {
      setDartError(err instanceof Error ? err.message : 'DART 분석 실패');
    } finally {
      setDartLoading(false);
    }
  };

  const loadSecReports = async () => {
    setSecLoading(true);
    setSecError(null);
    try {
      const tickers = usWatchlist.map((s) => s.ticker).slice(0, 10);
      if (tickers.length === 0) {
        setSecError('감시목록에 US 종목이 없습니다');
        setSecLoading(false);
        return;
      }
      const data = await api('/research/sec/batch', {
        method: 'POST',
        body: JSON.stringify({ tickers }),
        timeout: 90000,
      });
      if (data.ok && Array.isArray(data.results)) {
        // SEC 결과를 DartResult 형식으로 매핑
        setSecResults(data.results.map((r: any) => ({
          stockCode: r.ticker,
          corpName: r.companyName,
          financial: r.financial ? {
            revenue: r.financial.revenue,
            revenueYoy: r.financial.revenueYoy,
            operatingIncome: r.financial.operatingIncome,
            operatingIncomeYoy: r.financial.operatingIncomeYoy,
            operatingMargin: r.financial.operatingMargin,
            netIncome: r.financial.netIncome,
            totalAssets: r.financial.totalAssets,
            totalDebt: r.financial.totalLiabilities ?? 0,
            debtRatio: r.financial.debtRatio,
            year: String(r.financial.year),
            quarter: r.financial.quarter,
          } : undefined,
          aiAnalysis: r.aiAnalysis,
          fundamentalScore: r.fundamentalScore,
          piotroskiScore: undefined,
          keyRisks: r.keyRisks ?? [],
          keyStrengths: r.keyStrengths ?? [],
          analyzedAt: r.analyzedAt,
        })));
      } else {
        setSecError(data.error ?? 'SEC 분석 실패');
      }
    } catch (err: unknown) {
      setSecError(err instanceof Error ? err.message : 'SEC 분석 실패');
    } finally {
      setSecLoading(false);
    }
  };

  // 캐시된 DART 결과 자동 로드 (Gemini 호출 없음 — DB 캐시에서 즉시 반환)
  const loadCachedDartResults = async (codes: string[]) => {
    if (codes.length === 0) return;
    try {
      const data = await api(`/research/dart/cached?codes=${codes.slice(0, 30).join(',')}`);
      if (data.ok && Array.isArray(data.results) && data.results.length > 0) {
        setDartResults(data.results);
      }
    } catch { /* 캐시 로드 실패 시 무시 — 수동 버튼으로 폴백 */ }
  };

  useEffect(() => {
    loadNotes();
    // KR 감시목록 로드 → 완료 후 캐시된 DART 결과 자동 로드
    api('/watchlist?viewMode=live')
      .then((items: WatchlistItem[]) => {
        if (Array.isArray(items)) {
          const mapped = items.map((i) => ({ code: i.stock_code, name: String(i.stock_name ?? i.stock_code) }));
          setKrWatchlist(mapped);
          // 탭 진입 시 캐시된 결과 자동 로드 (Gemini 호출 없음)
          loadCachedDartResults(mapped.map((s) => s.code));
        }
      })
      .catch(() => {});
    // US 감시목록 로드
    api('/overseas/dashboard?viewMode=live')
      .then((us: UsDashboard) => {
        if (Array.isArray(us?.watchlist))
          setUsWatchlist(
            (us.watchlist as UsWatchlistItem[]).map((i) => ({ ticker: i.code, name: String(i.name ?? i.code) })),
          );
      })
      .catch(() => {});
  }, []);

  // KR 감시목록 로드 완료 또는 새 종목 추가 → DART 자동 분석
  // prevKrLenRef: 이전 길이 추적 → 증가 시(새 종목 추가) 즉시 재분석 (24h 캐시로 기존 결과는 즉시 반환)
  const prevKrLenRef = React.useRef(0);
  useEffect(() => {
    const prev = prevKrLenRef.current;
    prevKrLenRef.current = krWatchlist.length;
    if (krWatchlist.length > prev && !dartLoading) {
      loadDartReports();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [krWatchlist.length]);

  // US 감시목록 로드 완료 → SEC 자동 분석
  useEffect(() => {
    if (usWatchlist.length > 0 && secResults.length === 0 && !secLoading) {
      loadSecReports();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usWatchlist.length]);

  // stale closure 방지: 최신 함수 ref 유지
  const dartRefetchRef = React.useRef(loadDartReports);
  const secRefetchRef = React.useRef(loadSecReports);
  const dartLoadingRef = React.useRef(dartLoading);
  const secLoadingRef = React.useRef(secLoading);
  const krLenRef = React.useRef(krWatchlist.length);
  const usLenRef = React.useRef(usWatchlist.length);
  useEffect(() => { dartRefetchRef.current = loadDartReports; });
  useEffect(() => { secRefetchRef.current = loadSecReports; });
  useEffect(() => { dartLoadingRef.current = dartLoading; }, [dartLoading]);
  useEffect(() => { secLoadingRef.current = secLoading; }, [secLoading]);
  useEffect(() => { krLenRef.current = krWatchlist.length; }, [krWatchlist.length]);
  useEffect(() => { usLenRef.current = usWatchlist.length; }, [usWatchlist.length]);

  // 30분마다 재분석 (안 잡힌 종목 포함, 24h 캐시로 완료 종목은 즉시 반환)
  useEffect(() => {
    const timer = setInterval(() => {
      if (!dartLoadingRef.current && krLenRef.current > 0) dartRefetchRef.current();
      if (!secLoadingRef.current && usLenRef.current > 0) secRefetchRef.current();
    }, 30 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const crawl = async () => {
    if (!url.trim()) return;
    setCrawling(true);
    setMsg(null);
    try {
      const data = await api('/research/crawl', {
        method: 'POST',
        body: JSON.stringify({ url: url.trim(), memo: memo.trim() || undefined }),
        timeout: 20000,
      });
      if (data.ok) {
        setMsg({ type: 'ok', text: `${data.title || url} (${data.length}자)` });
        setUrl('');
        setMemo('');
        loadNotes();
      } else {
        setMsg({ type: 'err', text: data.error ?? '저장 실패' });
      }
    } catch (err: unknown) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : '크롤링 실패' });
    } finally {
      setCrawling(false);
    }
  };

  const deleteNote = async (id: number) => {
    setDeletingId(id);
    try {
      await api(`/research/notes/${id}`, { method: 'DELETE' });
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch { /* ignore */ } finally {
      setDeletingId(null);
    }
  };

  const fmtSize = (len: number) => {
    if (len >= 10000) return `${(len / 1000).toFixed(0)}K`;
    if (len >= 1000) return `${(len / 1000).toFixed(1)}K`;
    return `${len}`;
  };

  const totalChars = notes.reduce((s, n) => s + (n.length || 0), 0);

  return (
    <div className="rounded-2xl overflow-hidden border border-violet-500/15 bg-gradient-to-br from-violet-950/20 via-slate-950/60 to-transparent">
      {/* 헤더 */}
      <div className="px-4 py-3 border-b border-white/[0.04] flex items-center gap-3">
        <div className="relative">
          <span className="text-lg">🤖</span>
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-violet-500 rounded-full animate-pulse" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold text-slate-100">퀀트 리서치 봇</h3>
          <p className="text-[9px] text-slate-500">DART 재무분석 · Gemini AI · Track A 주입</p>
        </div>
        <div className="flex items-center gap-3 text-[10px]">
          <div className="text-center">
            <div className="text-violet-400 font-bold">{notes.length}</div>
            <div className="text-slate-600">리포트</div>
          </div>
          <div className="text-center">
            <div className="text-cyan-400 font-bold">{dartResults.length}</div>
            <div className="text-slate-600">DART</div>
          </div>
        </div>
      </div>

      {/* 상태 바 — 파이프라인 표시 */}
      <div className="px-4 py-2 bg-white/[0.01] border-b border-white/[0.03] flex items-center gap-4 overflow-x-auto">
        {[
          { label: 'DART API', icon: '📋', active: true },
          { label: 'Gemini 분석', icon: '🧠', active: true },
          { label: 'F-Score', icon: '📊', active: true },
          { label: 'Track A 주입', icon: '💉', active: true },
        ].map((step, i) => (
          <div key={i} className="flex items-center gap-1.5 shrink-0">
            {i > 0 && <span className="text-violet-600 text-[8px]">→</span>}
            <span className="text-[10px]">{step.icon}</span>
            <span className={`text-[10px] font-medium ${step.active ? 'text-violet-300' : 'text-slate-600'}`}>{step.label}</span>
            {step.active && <span className="w-1 h-1 rounded-full bg-emerald-400" />}
          </div>
        ))}
      </div>

      <div className="p-4 space-y-3">
        {/* 4탭 전환 */}
        <div className="flex gap-1 bg-slate-900/50 rounded-lg p-0.5">
          <button
            onClick={() => setActiveTab('dart')}
            className={`flex-1 text-[11px] py-1.5 rounded-md font-medium transition-all ${
              activeTab === 'dart' ? 'bg-cyan-600/30 text-cyan-300' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            KR 재무
          </button>
          <button
            onClick={() => setActiveTab('sec')}
            className={`flex-1 text-[11px] py-1.5 rounded-md font-medium transition-all ${
              activeTab === 'sec' ? 'bg-blue-600/30 text-blue-300' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            US 재무
          </button>
          <button
            onClick={() => setActiveTab('reports')}
            className={`flex-1 text-[11px] py-1.5 rounded-md font-medium transition-all ${
              activeTab === 'reports' ? 'bg-violet-600/30 text-violet-300' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            추천 사이트
          </button>
          <button
            onClick={() => setActiveTab('url')}
            className={`flex-1 text-[11px] py-1.5 rounded-md font-medium transition-all ${
              activeTab === 'url' ? 'bg-violet-600/30 text-violet-300' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            + URL
          </button>
        </div>

        {/* ═══ DART 재무분석 탭 ═══ */}
        {activeTab === 'dart' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-500">
                  {krWatchlist.length > 0
                    ? `감시목록 ${krWatchlist.length}종목`
                    : '감시목록 로딩 중...'}
                </span>
              </div>
              <button
                onClick={loadDartReports}
                disabled={dartLoading}
                className="px-3 py-1.5 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-[11px] font-bold transition-all shadow-lg shadow-cyan-500/10"
              >
                {dartLoading ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 border-[1.5px] border-white border-t-transparent rounded-full animate-spin" />
                    분석 중...
                  </span>
                ) : dartResults.length > 0 ? '새로고침' : 'Gemini 분석 실행'}
              </button>
            </div>

            {dartError && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs bg-rose-950/40 text-rose-400 border border-rose-800/30">
                <span>✗</span>
                <span>{dartError}</span>
              </div>
            )}

            {dartLoading && dartResults.length === 0 && (
              <div className="text-center py-8">
                <div className="w-6 h-6 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mx-auto" />
                <p className="text-xs text-slate-500 mt-3">DART API + Gemini AI 분석 중...</p>
                <p className="text-[10px] text-slate-600 mt-1">최초 실행 시 1~2분 소요 (이후 24h 캐시)</p>
              </div>
            )}

            {!dartLoading && dartResults.length === 0 && !dartError && (
              <div className="text-center py-6">
                <span className="text-3xl opacity-30">📊</span>
                <p className="text-xs text-slate-500 mt-2">감시목록 로드 완료 시 자동 분석 시작됩니다</p>
                <p className="text-[10px] text-slate-600 mt-1">Gemini GCP 크레딧 사용 · 24h 캐시 · 30분 자동 재분석</p>
              </div>
            )}

            {dartResults.length > 0 && (
              <div className="space-y-2">
                {dartResults.map((r) => {
                  const isExpanded = expandedDart === r.stockCode;
                  const f = r.financial;
                  return (
                    <div key={r.stockCode} className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                      {/* 종목 헤더 */}
                      <button
                        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.02] transition-colors text-left"
                        onClick={() => setExpandedDart(isExpanded ? null : r.stockCode)}
                      >
                        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-bold text-slate-100">{krName(r.stockCode) || r.corpName || r.stockCode}</span>
                          <span className="text-[9px] text-slate-600 bg-slate-800/80 rounded px-1.5 py-0.5">{r.stockCode}</span>
                          {/* 실적발표 D-N 배지 */}
                          {r.earningsDaysLeft != null && r.earningsDaysLeft >= 0 && r.earningsDaysLeft <= 30 && (
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border animate-pulse ${
                              r.earningsDaysLeft <= 3
                                ? 'bg-red-500/20 text-red-400 border-red-500/40'
                                : r.earningsDaysLeft <= 7
                                ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                                : 'bg-violet-500/15 text-violet-400 border-violet-500/30'
                            }`}>
                              실적 D-{r.earningsDaysLeft}
                            </span>
                          )}
                        </div>
                        {/* 점수 배지 */}
                        <div className="flex items-center gap-2 shrink-0">
                          {r.fundamentalScore != null && (
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${fundBg(r.fundamentalScore)}`}>
                              펀더멘털 {r.fundamentalScore}
                            </span>
                          )}
                          {r.piotroskiScore != null && (
                            <span className={`text-[10px] font-bold ${fScoreColor(r.piotroskiScore)}`}>
                              F{r.piotroskiScore}
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-slate-600 shrink-0">{isExpanded ? '▲' : '▼'}</span>
                      </button>

                      {/* 확장: 재무 + AI 분석 */}
                      {isExpanded && (
                        <div className="px-3 pb-3 space-y-2.5 border-t border-white/[0.04]">
                          {/* 재무 지표 그리드 */}
                          {f && (
                            <div className="mt-2">
                              <div className="text-[9px] text-slate-600 mb-1.5">{f.year}년 {f.quarter === 'annual' ? '연간' : f.quarter.toUpperCase()} 실적</div>
                              <div className="grid grid-cols-3 gap-1.5">
                                <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
                                  <div className="text-[9px] text-slate-500">매출</div>
                                  <div className="text-[11px] font-bold text-slate-200">{fmtBillion(f.revenue)}</div>
                                  <div className={`text-[9px] font-bold ${f.revenueYoy >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                    {f.revenueYoy >= 0 ? '+' : ''}{f.revenueYoy.toFixed(1)}%
                                  </div>
                                </div>
                                <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
                                  <div className="text-[9px] text-slate-500">영업이익</div>
                                  <div className="text-[11px] font-bold text-slate-200">{fmtBillion(f.operatingIncome)}</div>
                                  <div className={`text-[9px] font-bold ${f.operatingIncomeYoy >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                    {f.operatingIncomeYoy >= 0 ? '+' : ''}{f.operatingIncomeYoy.toFixed(1)}%
                                  </div>
                                </div>
                                <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
                                  <div className="text-[9px] text-slate-500">영업이익률</div>
                                  <div className={`text-[11px] font-bold ${f.operatingMargin >= 15 ? 'text-emerald-400' : f.operatingMargin >= 8 ? 'text-amber-400' : 'text-rose-400'}`}>
                                    {f.operatingMargin.toFixed(1)}%
                                  </div>
                                </div>
                                <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
                                  <div className="text-[9px] text-slate-500">순이익</div>
                                  <div className="text-[11px] font-bold text-slate-200">{fmtBillion(f.netIncome)}</div>
                                </div>
                                <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
                                  <div className="text-[9px] text-slate-500">부채비율</div>
                                  <div className={`text-[11px] font-bold ${f.debtRatio <= 100 ? 'text-emerald-400' : f.debtRatio <= 200 ? 'text-amber-400' : 'text-rose-400'}`}>
                                    {f.debtRatio.toFixed(0)}%
                                  </div>
                                </div>
                                <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
                                  <div className="text-[9px] text-slate-500">총자산</div>
                                  <div className="text-[11px] font-bold text-slate-200">{fmtBillion(f.totalAssets)}</div>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* 강점/리스크 */}
                          {(r.keyStrengths.length > 0 || r.keyRisks.length > 0) && (
                            <div className="grid grid-cols-2 gap-2">
                              {r.keyStrengths.length > 0 && (
                                <div>
                                  <div className="text-[9px] text-emerald-500 font-bold mb-1">강점</div>
                                  {r.keyStrengths.map((s, i) => (
                                    <div key={i} className="flex items-start gap-1 text-[10px] text-slate-300 leading-relaxed">
                                      <span className="text-emerald-500 shrink-0 mt-0.5">+</span>
                                      <span>{s}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {r.keyRisks.length > 0 && (
                                <div>
                                  <div className="text-[9px] text-rose-500 font-bold mb-1">리스크</div>
                                  {r.keyRisks.map((s, i) => (
                                    <div key={i} className="flex items-start gap-1 text-[10px] text-slate-300 leading-relaxed">
                                      <span className="text-rose-500 shrink-0 mt-0.5">-</span>
                                      <span>{s}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {/* AI 분석 */}
                          {r.aiAnalysis && (
                            <div className="bg-cyan-950/20 border border-cyan-800/15 rounded-lg px-3 py-2">
                              <div className="text-[9px] text-cyan-500 font-bold mb-1">Gemini AI 분석</div>
                              <p className="text-[10px] text-slate-300 leading-relaxed whitespace-pre-wrap">{r.aiAnalysis}</p>
                            </div>
                          )}

                          {/* 분석 시각 */}
                          {r.analyzedAt && (
                            <div className="text-[9px] text-slate-600 text-right">
                              분석: {fmtTime(r.analyzedAt)}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ═══ SEC 재무분석 탭 (US) ═══ */}
        {activeTab === 'sec' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-500">
                  {usWatchlist.length > 0
                    ? `US 감시목록 ${usWatchlist.length}종목`
                    : 'US 감시목록 로딩 중...'}
                </span>
              </div>
              <button
                onClick={loadSecReports}
                disabled={secLoading}
                className="px-3 py-1.5 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-[11px] font-bold transition-all shadow-lg shadow-blue-500/10"
              >
                {secLoading ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 border-[1.5px] border-white border-t-transparent rounded-full animate-spin" />
                    분석 중...
                  </span>
                ) : secResults.length > 0 ? '새로고침' : 'SEC 분석 실행'}
              </button>
            </div>

            {secError && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs bg-rose-950/40 text-rose-400 border border-rose-800/30">
                <span>✗</span><span>{secError}</span>
              </div>
            )}

            {secLoading && secResults.length === 0 && (
              <div className="text-center py-8">
                <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto" />
                <p className="text-xs text-slate-500 mt-3">SEC EDGAR + Gemini AI 분석 중...</p>
                <p className="text-[10px] text-slate-600 mt-1">10-K 재무제표 파싱 (24h 캐시)</p>
              </div>
            )}

            {!secLoading && secResults.length === 0 && !secError && (
              <div className="text-center py-6">
                <span className="text-3xl opacity-30">🇺🇸</span>
                <p className="text-xs text-slate-500 mt-2">SEC EDGAR 10-K 재무분석</p>
                <p className="text-[10px] text-slate-600 mt-1">무료 API · Gemini 크레딧 · 실전/연습 공통</p>
              </div>
            )}

            {secResults.length > 0 && (
              <div className="space-y-2">
                {secResults.map((r) => {
                  const isExpanded = expandedSec === r.stockCode;
                  const f = r.financial;
                  return (
                    <div key={r.stockCode} className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                      <button
                        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.02] transition-colors text-left"
                        onClick={() => setExpandedSec(isExpanded ? null : r.stockCode)}
                      >
                        <div className="flex-1 min-w-0 flex items-center gap-2">
                          <span className="text-xs font-bold text-slate-100">{usName(r.stockCode) || r.corpName}</span>
                          <span className="text-[9px] text-blue-400 bg-blue-900/30 rounded px-1.5 py-0.5">{r.stockCode}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {r.fundamentalScore != null && (
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${fundBg(r.fundamentalScore)}`}>
                              펀더멘털 {r.fundamentalScore}
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-slate-600 shrink-0">{isExpanded ? '▲' : '▼'}</span>
                      </button>

                      {isExpanded && (
                        <div className="px-3 pb-3 space-y-2.5 border-t border-white/[0.04]">
                          {f && (
                            <div className="mt-2">
                              <div className="text-[9px] text-slate-600 mb-1.5">FY{f.year} {f.quarter === 'annual' ? 'Annual' : f.quarter} (10-K)</div>
                              <div className="grid grid-cols-3 gap-1.5">
                                <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
                                  <div className="text-[9px] text-slate-500">Revenue</div>
                                  <div className="text-[11px] font-bold text-slate-200">{fmtBillion(f.revenue)}</div>
                                  <div className={`text-[9px] font-bold ${f.revenueYoy >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                    {f.revenueYoy >= 0 ? '+' : ''}{f.revenueYoy.toFixed(1)}%
                                  </div>
                                </div>
                                <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
                                  <div className="text-[9px] text-slate-500">Op. Income</div>
                                  <div className="text-[11px] font-bold text-slate-200">{fmtBillion(f.operatingIncome)}</div>
                                  <div className={`text-[9px] font-bold ${f.operatingIncomeYoy >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                    {f.operatingIncomeYoy >= 0 ? '+' : ''}{f.operatingIncomeYoy.toFixed(1)}%
                                  </div>
                                </div>
                                <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
                                  <div className="text-[9px] text-slate-500">Op. Margin</div>
                                  <div className={`text-[11px] font-bold ${f.operatingMargin >= 15 ? 'text-emerald-400' : f.operatingMargin >= 8 ? 'text-amber-400' : 'text-rose-400'}`}>
                                    {f.operatingMargin.toFixed(1)}%
                                  </div>
                                </div>
                                <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
                                  <div className="text-[9px] text-slate-500">Net Income</div>
                                  <div className="text-[11px] font-bold text-slate-200">{fmtBillion(f.netIncome)}</div>
                                </div>
                                <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
                                  <div className="text-[9px] text-slate-500">Debt Ratio</div>
                                  <div className={`text-[11px] font-bold ${f.debtRatio <= 50 ? 'text-emerald-400' : f.debtRatio <= 70 ? 'text-amber-400' : 'text-rose-400'}`}>
                                    {f.debtRatio.toFixed(0)}%
                                  </div>
                                </div>
                                <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
                                  <div className="text-[9px] text-slate-500">Total Assets</div>
                                  <div className="text-[11px] font-bold text-slate-200">{fmtBillion(f.totalAssets)}</div>
                                </div>
                              </div>
                            </div>
                          )}

                          {(r.keyStrengths.length > 0 || r.keyRisks.length > 0) && (
                            <div className="grid grid-cols-2 gap-2">
                              {r.keyStrengths.length > 0 && (
                                <div>
                                  <div className="text-[9px] text-emerald-500 font-bold mb-1">강점</div>
                                  {r.keyStrengths.map((s, i) => (
                                    <div key={i} className="flex items-start gap-1 text-[10px] text-slate-300 leading-relaxed">
                                      <span className="text-emerald-500 shrink-0 mt-0.5">+</span><span>{s}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {r.keyRisks.length > 0 && (
                                <div>
                                  <div className="text-[9px] text-rose-500 font-bold mb-1">리스크</div>
                                  {r.keyRisks.map((s, i) => (
                                    <div key={i} className="flex items-start gap-1 text-[10px] text-slate-300 leading-relaxed">
                                      <span className="text-rose-500 shrink-0 mt-0.5">-</span><span>{s}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {r.aiAnalysis && (
                            <div className="bg-blue-950/20 border border-blue-800/15 rounded-lg px-3 py-2">
                              <div className="text-[9px] text-blue-500 font-bold mb-1">Gemini AI 분석</div>
                              <p className="text-[10px] text-slate-300 leading-relaxed whitespace-pre-wrap">{r.aiAnalysis}</p>
                            </div>
                          )}

                          {r.analyzedAt && (
                            <div className="text-[9px] text-slate-600 text-right">분석: {fmtTime(r.analyzedAt)}</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ═══ 추천 금융 사이트 탭 ═══ */}
        {activeTab === 'reports' && (
          <div className="space-y-1.5 max-h-[50vh] overflow-y-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: '#4c1d95 transparent' }}>
            {RECOMMENDED_SITES.map((site, i) => (
              <a
                key={i}
                href={site.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 bg-white/[0.02] hover:bg-white/[0.05] rounded-xl px-3 py-2.5 group transition-colors"
              >
                <div className="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
                  <span className="text-[12px]">{site.icon}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-slate-200 font-medium group-hover:text-violet-300 transition-colors">{site.name}</p>
                  <p className="text-[10px] text-slate-500 mt-0.5 truncate">{site.desc}</p>
                </div>
                <span className="text-[10px] text-slate-700 group-hover:text-slate-400 shrink-0 transition-colors">→</span>
              </a>
            ))}
          </div>
        )}

        {/* ═══ 수동 URL 추가 탭 ═══ */}
        {activeTab === 'url' && (
          <div className="space-y-3 max-h-[50vh] overflow-y-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: '#4c1d95 transparent' }}>
            <div className="bg-cyan-950/20 border border-cyan-800/20 rounded-xl p-3">
              <p className="text-[11px] text-cyan-300 font-medium">증권사 리포트 URL 직접 추가</p>
              <p className="text-[10px] text-slate-500 mt-0.5">네이버 금융, 한경, 매경, 전자신문, Seeking Alpha 등의 URL을 크롤링해 Track A에 주입합니다.</p>
            </div>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !crawling && crawl()}
              placeholder="https://finance.naver.com/research/..."
              className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-3.5 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-violet-500/40 transition-colors"
            />
            <div className="flex gap-2">
              <input
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="메모 (선택)"
                className="flex-1 bg-white/[0.03] border border-white/[0.05] rounded-lg px-3 py-2 text-xs text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-violet-500/30 transition-colors"
              />
              <button
                onClick={crawl}
                disabled={crawling || !url.trim()}
                className="px-5 py-2 bg-gradient-to-r from-violet-600 to-violet-500 hover:from-violet-500 hover:to-violet-400 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-sm font-bold transition-all shrink-0 shadow-lg shadow-violet-500/10"
              >
                {crawling ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 border-[1.5px] border-white border-t-transparent rounded-full animate-spin" />
                    수집 중
                  </span>
                ) : '크롤링'}
              </button>
            </div>
            {msg && (
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${msg.type === 'ok' ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-800/30' : 'bg-rose-950/40 text-rose-400 border border-rose-800/30'}`}>
                <span>{msg.type === 'ok' ? '✓' : '✗'}</span>
                <span>{msg.text}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
