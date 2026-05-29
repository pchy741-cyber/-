'use client';

import React, { useState, useEffect, useRef } from 'react';
import { ConfirmModal } from '@/components/ui';
import { api, BACKEND_URL } from './lib/utils';
import { useToast } from './lib/hooks';

import HomeView from './views/HomeView';
import TradesView from './views/TradesView';
import JournalView from './views/JournalView';
import WatchlistView from './views/WatchlistView';
import NewsView from './views/NewsView';
import SettingsView from './views/SettingsView';
import ScreenshotReview from './components/ScreenshotReview';

// ═══════════════════════════════════════
// Dashboard — thin shell
// ═══════════════════════════════════════

type Tab = 'home' | 'trades' | 'journal' | 'watchlist' | 'news' | 'settings';

export default function Dashboard() {
  const { show: toast, ToastContainer } = useToast();
  const [tab, setTab] = useState<Tab>('home');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [health, setHealth] = useState<any>(null);
  const [dash, setDash] = useState<any>(null);
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [strategy, setStrategy] = useState<any>(null);
  const [trades, setTrades] = useState<any[]>([]);
  const [killSwitch, setKillSwitch] = useState<any>(null);
  const [secrets, setSecrets] = useState<any>(null);
  const [usDash, setUsDash] = useState<any>(null);

  const [withdrawConfig, setWithdrawConfig] = useState<any>(null);
  const [withdrawHistory, setWithdrawHistory] = useState<any[]>([]);
  const [allocConfig, setAllocConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [modeToggling, setModeToggling] = useState(false);
  const [liveConfirmOpen, setLiveConfirmOpen] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [loopStatus, setLoopStatus] = useState<any>(null);
  const notebookRef = useRef<HTMLTextAreaElement>(null);
  const geminiRef = useRef<HTMLTextAreaElement>(null);
  const gptRef = useRef<HTMLTextAreaElement>(null);
  const claudeRef = useRef<HTMLTextAreaElement>(null);

  // SSR-safe: always start as 'live' to avoid hydration mismatch
  // localStorage 복원은 useEffect에서 처리 (아래 참조)
  const [viewMode, setViewMode] = useState<'live'|'paper'>('live');
  const [marketTab, setMarketTab] = useState<'KR'|'US'>('KR');

  const loadingRef = useRef(false);
  const loadGenRef = useRef(0);
  const staticLoadedRef = useRef(false);
  const tradesLoadedRef = useRef(false);
  const tradesLastFetchRef = useRef(0);
  const modeTogglingRef = useRef(false);
  const viewModeRef = useRef<'live'|'paper'>('live');

  const loadStatic = async (gen: number, vmOverride?: string) => {
    const vm = vmOverride ?? viewModeRef.current;
    const [w, s, t, sec, wc, wh] = await Promise.allSettled([
      api(`/watchlist?viewMode=${vm}`), api('/strategy'),
      api(`/trades?limit=100&viewMode=${vm}`), api('/secrets'),
      api('/withdraw/config').catch(() => null),
      api('/withdraw/history').catch(() => []),
    ]);
    if (loadGenRef.current !== gen) return;
    if (w.status === 'fulfilled') setWatchlist(Array.isArray(w.value) ? w.value : []);
    if (s.status === 'fulfilled') setStrategy(s.value);
    if (t.status === 'fulfilled' && Array.isArray(t.value)) {
      setTrades(t.value);
      tradesLoadedRef.current = true;
      tradesLastFetchRef.current = Date.now();
    }
    if (sec.status === 'fulfilled') setSecrets(sec.value);
    if (wc.status === 'fulfilled' && wc.value) setWithdrawConfig(wc.value);
    if (wh.status === 'fulfilled') setWithdrawHistory(Array.isArray(wh.value) ? wh.value : []);
    staticLoadedRef.current = true;
  };

  const refreshTrades = (gen: number, vmOverride?: string) => {
    const vm = vmOverride ?? viewModeRef.current;
    api(`/trades?limit=100&viewMode=${vm}`).then((t: any) => {
      if (loadGenRef.current !== gen) return;
      if (Array.isArray(t)) {
        setTrades(t);
        tradesLoadedRef.current = true;
        tradesLastFetchRef.current = Date.now();
      }
    }).catch(() => {});
  };

  const load = async (forceStatic = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const gen = ++loadGenRef.current;
    const vm = viewModeRef.current; // 호출 시점 스냅샷 — async 중 ref 변경돼도 안전
    const ifCurrent = <T,>(setter: (v: T) => void) => (v: T) => {
      if (loadGenRef.current === gen) setter(v);
    };
    try {
      setLoading(true);
      const [h, d, k] = await Promise.allSettled([
        api('/health'), api(`/dashboard?viewMode=${vm}`), api('/kill-switch'),
      ]);
      if (gen !== loadGenRef.current) return;
      if (h.status === 'fulfilled') setHealth(h.value);
      // 대시보드: 응답이 유효할 때만 교체 (null/undefined면 이전 데이터 보존)
      if (d.status === 'fulfilled' && d.value) setDash(d.value);
      if (k.status === 'fulfilled') setKillSwitch(k.value);
      setLastUpdate(new Date());
      setLoading(false);

      if (!staticLoadedRef.current || forceStatic) {
        loadStatic(gen, vm).catch(() => {});
      } else {
        const tradesStaleSec = (Date.now() - tradesLastFetchRef.current) / 1000;
        if (!tradesLoadedRef.current || tradesStaleSec > 60) {
          refreshTrades(gen, vm);
        }
      }

      // 해외 대시보드: viewMode에 따라 매번 갱신
      // switchView()에서 setUsDash(null)을 선행하므로 모드 간 cross-contamination 없음
      api(`/overseas/dashboard?viewMode=${vm}`).then(ifCurrent((us: any) => {
        if (!us) return; // API 실패 → 이전 데이터 유지
        setUsDash(us);
      })).catch(() => {});
      if (!staticLoadedRef.current) {
        api('/portfolio/allocation').then(ifCurrent((ac: any) => { if (ac) setAllocConfig(ac); })).catch(() => {});
      }
    } catch (err) { setLoading(false); console.error('[QUANTOPS] 데이터 로드 실패:', err); }
    finally { loadingRef.current = false; }
  };

  // localStorage에서 viewMode 복원 (SSR hydration 이후, load 전에 ref 세팅)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('quantops_viewMode');
      if (saved === 'paper' || saved === 'live') {
        viewModeRef.current = saved;
        if (saved !== 'live') setViewMode(saved);
      }
    } catch {}
  }, []);

  useEffect(() => {
    load(true);
    const getInterval = () => {
      const h = new Date().getHours(), m = new Date().getMinutes();
      const mins = h * 60 + m;
      const isMarket = mins >= 9 * 60 && mins < 15 * 60 + 30;
      const visible = document.visibilityState === 'visible';
      if (!visible) return 300000;
      return isMarket ? 20000 : 120000;
    };
    let iv: ReturnType<typeof setInterval>;
    const schedule = () => { iv = setInterval(() => { load(); clearInterval(iv); schedule(); }, getInterval()); };
    schedule();
    const onVisibility = () => { clearInterval(iv); schedule(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  // SSE 실시간 스트림 — viewMode 변경 시 재연결 + 에러 복구
  useEffect(() => {
    const vm = viewMode;
    const base = BACKEND_URL.endsWith('/') ? BACKEND_URL.slice(0, -1) : BACKEND_URL;
    let es: EventSource | null = null;
    let prevChainCount = -1;
    let prevOverseasCount = -1;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      es = new EventSource(`${base}/api/stream?viewMode=${vm}`, { withCredentials: true });

      es.addEventListener('update', (e: MessageEvent) => {
        retryCount = 0; // 성공 시 재시도 카운터 리셋
        try {
          const data = JSON.parse(e.data);
          // trades: 머지 패턴 (기존 데이터 보존 + 새 데이터 추가)
          if (Array.isArray(data.recentTrades) && data.recentTrades.length > 0) {
            setTrades(prev => {
              const incomingMap = new Map<string, any>(data.recentTrades.map((t: any) => [String(t.id), t]));
              const existingIds = new Set(prev.map((t: any) => String(t.id)));
              const updated = prev.map((t: any) => {
                const fresh = incomingMap.get(String(t.id));
                return fresh ? { ...t, ...fresh } : t;
              });
              const brandNew = data.recentTrades.filter((t: any) => !existingIds.has(String(t.id)));
              return brandNew.length > 0 ? [...brandNew, ...updated].slice(0, 200) : updated;
            });
          }
          if (data.strategy) {
            setStrategy((prev: any) => prev ? { ...prev, ...data.strategy } : data.strategy);
          }
          // 체인 수 or 해외 holdings 수 변동 시 전체 갱신 (데이터 보존 패턴)
          const chainsChanged = prevChainCount !== -1 && data.activeChains !== prevChainCount;
          const overseasChanged = prevOverseasCount !== -1 && data.overseasHoldingCount !== undefined && data.overseasHoldingCount !== prevOverseasCount;
          if (chainsChanged || overseasChanged) {
            api(`/dashboard?viewMode=${vm}`).then((d: any) => { if (d) setDash(d); }).catch(() => {});
            api(`/trades?limit=200&viewMode=${vm}`).then((t: any) => { if (Array.isArray(t) && t.length > 0) setTrades(t); }).catch(() => {});
            api(`/overseas/dashboard?viewMode=${vm}`).then((us: any) => {
              if (us) setUsDash(us);
            }).catch(() => {});
          }
          prevChainCount = data.activeChains ?? prevChainCount;
          if (data.overseasHoldingCount !== undefined) prevOverseasCount = data.overseasHoldingCount;
          if (data.loopMode) setLoopStatus(data.loopMode);
        } catch { /* ignore */ }
      });

      es.onerror = () => {
        // 에러 시 기존 상태 보존하고 지수 백오프 재연결
        es?.close();
        if (disposed) return;
        retryCount = Math.min(retryCount + 1, 5);
        const delay = Math.min(2000 * Math.pow(2, retryCount), 30000);
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [viewMode]);

  const isKillActive = killSwitch?.kr?.active || killSwitch?.overseas?.active;
  const toggleKill = async (scope?: 'KR' | 'OVERSEAS') => {
    const active = scope
      ? killSwitch?.[scope.toLowerCase()]?.active
      : isKillActive;
    await api(`/kill-switch/${active ? 'deactivate' : 'activate'}`, {
      method: 'POST',
      body: JSON.stringify({ force: true, ...(scope ? { scope } : {}) }),
    });
    const k = await api('/kill-switch'); setKillSwitch(k);
  };

  const doSwitchMode = async (mode: 'paper' | 'live') => {
    modeTogglingRef.current = true;
    setModeToggling(true);
    try {
      await api('/trading-mode', { method: 'POST', body: JSON.stringify({ mode }) });
      setDash((d: any) => d ? { ...d, tradingMode: mode } : d);
      toast(mode === 'live' ? '실전모드로 전환됐습니다' : '연습모드로 전환됐습니다', 'ok');
      loadingRef.current = false;
      tradesLoadedRef.current = false;
      load(false);
    } catch (e: any) {
      toast('모드 전환 실패: ' + (e?.message ?? ''), 'err');
    } finally {
      modeTogglingRef.current = false;
      setModeToggling(false);
    }
  };

  const switchMode = (mode: 'paper' | 'live') => {
    if (dash?.tradingMode === mode || modeTogglingRef.current) return;
    if (mode === 'live') { setLiveConfirmOpen(true); return; }
    doSwitchMode('paper');
  };

  const switchView = (mode: 'live' | 'paper') => {
    if (viewModeRef.current === mode) return;
    viewModeRef.current = mode;
    setViewMode(mode);
    try { localStorage.setItem('quantops_viewMode', mode); } catch {}
    // 모드 전환 시 국내/해외 데이터 즉시 초기화 — 이전 모드 데이터 잔류 방지
    // (paper ↔ live 전환 시 이전 포지션/현금이 잠깐 보이는 크로스오염 차단)
    setDash(null);
    setUsDash(null);
    loadingRef.current = false;
    tradesLoadedRef.current = false;
    staticLoadedRef.current = false;
    load(true);
  };

  const navItems: { id: Tab; label: string; icon: string }[] = [
    { id: 'home', label: '대시보드', icon: '📊' },
    { id: 'trades', label: '매매내역', icon: '📋' },
    { id: 'journal', label: '매매일지', icon: '📓' },
    { id: 'watchlist', label: '감시목록', icon: '👁' },
    { id: 'news', label: '뉴스', icon: '📰' },
    { id: 'settings', label: '설정', icon: '⚙️' },
  ];

  // ═══════════════════════════════════════
  // LAYOUT — 모드별 테마 색상
  // ═══════════════════════════════════════
  const isPaper = viewMode === 'paper';
  const isUS = marketTab === 'US';
  // 4가지 조합: 실전국내(cool blue), 실전해외(cool purple), 연습국내(warm amber), 연습해외(warm olive)
  const theme = isPaper
    ? isUS ? { bg: '#0a0906', side: '#100f08', main1: '#0a0906', main2: '#0f0e08', accent: 'amber', border: 'amber-500/[0.06]', bar: 'from-amber-700/40 via-amber-500/60 to-amber-700/40' }
           : { bg: '#0d0a06', side: '#12100a', main1: '#0d0a06', main2: '#11100a', accent: 'amber', border: 'amber-500/[0.06]', bar: 'from-amber-600/60 via-amber-400/80 to-amber-600/60' }
    : isUS ? { bg: '#080610', side: '#0e0a1a', main1: '#080610', main2: '#0c0a18', accent: 'violet', border: 'violet-500/[0.06]', bar: 'from-indigo-600/50 via-violet-500/60 to-indigo-600/50' }
           : { bg: '#06080f', side: '#0a0e1a', main1: '#06080f', main2: '#0a0e1a', accent: 'blue', border: 'white/[0.04]', bar: '' };

  return (
    <div className="flex flex-col h-screen text-slate-100 overflow-hidden transition-colors duration-500" style={{ backgroundColor: theme.bg }}>
      {(isPaper || isUS) && (
        <div className={`h-1 w-full bg-gradient-to-r ${theme.bar} shrink-0`} />
      )}
      <div className="flex flex-1 min-h-0">
      <ToastContainer />
      <ConfirmModal
        open={liveConfirmOpen}
        onClose={() => setLiveConfirmOpen(false)}
        onConfirm={() => { setLiveConfirmOpen(false); doSwitchMode('live'); }}
        title="실전모드로 전환"
        description="실제 돈으로 거래합니다. 실전모드로 전환하시겠습니까?"
        confirmLabel="실전 전환"
        confirmVariant="danger"
      />
      {mobileMenu && <div className="fixed inset-0 bg-black/60 z-40 lg:hidden" onClick={() => setMobileMenu(false)} />}

      {/* Left Sidebar */}
      <aside className={`fixed lg:static inset-y-0 left-0 z-50 w-[220px] backdrop-blur-xl flex flex-col shrink-0 transform transition-all duration-500 ${mobileMenu ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`} style={{ backgroundColor: theme.side + 'f2', borderRight: `1px solid ${isPaper ? 'rgba(245,158,11,0.06)' : isUS ? 'rgba(139,92,246,0.06)' : 'rgba(255,255,255,0.04)'}` }}>
        <div className="px-5 py-5 border-b border-white/[0.04]">
          <h1 className="text-lg font-black tracking-tight bg-gradient-to-r from-blue-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent">QUANTOPS</h1>
          <p className="text-[10px] text-slate-600 mt-0.5 font-medium">AI 자동매매 v0.2</p>
        </div>

        <div className="px-4 py-3.5 space-y-2.5 border-b border-white/[0.04]">
          {[
            { ok: health?.status === 'ok', label: health?.status === 'ok' ? '정상 작동' : '오류 발생' },
            { ok: health?.marketOpen, label: `한국 ${health?.marketOpen ? '거래 중' : '쉬는 중'}` },
            { ok: health?.usMarketOpen, label: `미국 ${health?.usMarketOpen ? '거래 중' : '쉬는 중'}` },
            { ok: dash?.tradingMode !== 'paper', label: dash?.tradingMode === 'paper' ? '연습 거래 중' : '실전 거래 중', amber: dash?.tradingMode === 'paper' },
            { ok: viewMode === 'live', label: viewMode === 'paper' ? '연습 보기 중' : '실전 보기', amber: viewMode === 'paper' },
          ].map((s, i) => (
            <div key={i} className="flex items-center gap-2.5 text-[11px]">
              <span className={`w-1.5 h-1.5 rounded-full ${s.amber ? 'bg-amber-400' : s.ok ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              <span className="text-slate-500 font-medium">{s.label}</span>
            </div>
          ))}
        </div>

        <nav className="flex-1 p-2.5 space-y-0.5">
          {navItems.map(item => (
            <button key={item.id} onClick={() => { setTab(item.id); setMobileMenu(false); }}
              className={`w-full text-left px-4 py-2.5 rounded-xl text-[13px] flex items-center gap-3 transition-all duration-150 ${tab === item.id ? 'bg-blue-500/10 text-blue-400 font-semibold ring-1 ring-blue-500/20' : 'text-slate-500 hover:bg-white/[0.03] hover:text-slate-300'}`}>
              <span className="text-sm">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="p-3 border-t border-white/[0.04] space-y-2">
          <button onClick={() => toggleKill()}
            className={`w-full py-3 rounded-xl text-xs font-bold transition-all ${isKillActive ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/30' : 'bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-400'}`}>
            {isKillActive ? '⏸ 매매 중단 중' : '▶ 자동매매 중'}
          </button>
          {isKillActive && (
            <div className="flex gap-1">
              {killSwitch?.kr?.active && (
                <button onClick={() => toggleKill('KR')} className="flex-1 py-1.5 rounded-lg text-[10px] font-bold bg-amber-600/80 hover:bg-amber-500 text-white transition-all">
                  국내 해제
                </button>
              )}
              {killSwitch?.overseas?.active && (
                <button onClick={() => toggleKill('OVERSEAS')} className="flex-1 py-1.5 rounded-lg text-[10px] font-bold bg-violet-600/80 hover:bg-violet-500 text-white transition-all">
                  해외 해제
                </button>
              )}
            </div>
          )}
          <button onClick={() => load(true)} className="w-full py-2 rounded-xl text-[10px] text-slate-600 hover:text-slate-400 bg-white/[0.02] hover:bg-white/[0.04] transition-all font-medium">
            새로고침 · {lastUpdate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="lg:hidden flex items-center gap-3 px-4 py-3 border-b transition-colors duration-500" style={{ backgroundColor: theme.side, borderColor: isPaper ? 'rgba(245,158,11,0.08)' : isUS ? 'rgba(139,92,246,0.08)' : 'rgba(51,65,85,0.4)' }}>
          <button onClick={() => setMobileMenu(true)} className="text-slate-400">
            <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
          </button>
          <span className="font-bold text-sm bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">QUANTOPS</span>
          <div className="flex items-center gap-1 mx-auto bg-[#0a0e1a] rounded-lg p-0.5 border border-white/[0.06]">
            <button onClick={() => switchView('live')}
              className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${viewMode === 'live' ? 'bg-emerald-500/20 text-emerald-300' : 'text-slate-600 hover:text-slate-400'}`}>
              실전
            </button>
            <button onClick={() => switchView('paper')}
              className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${viewMode === 'paper' ? 'bg-amber-500/20 text-amber-300' : 'text-slate-600 hover:text-slate-400'}`}>
              연습
            </button>
          </div>
          <button onClick={() => toggleKill()} className={`px-4 py-2 rounded-xl text-xs font-bold min-h-[36px] whitespace-nowrap ${isKillActive ? 'bg-rose-600 text-white' : 'bg-emerald-900/40 text-emerald-400'}`}>
            {isKillActive ? '⏸ 중단 중' : '▶ 자동 중'}
          </button>
        </header>

        <header className="hidden lg:flex items-center justify-center h-12 border-b shrink-0 relative transition-colors duration-500" style={{ backgroundColor: theme.side + '99', borderColor: isPaper ? 'rgba(245,158,11,0.06)' : isUS ? 'rgba(139,92,246,0.06)' : 'rgba(255,255,255,0.04)' }}>
          <div className="absolute left-4 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[10px] text-slate-500 font-medium">
              거래: {dash?.tradingMode === 'paper' ? '연습 중' : '실전 중'}
            </span>
          </div>
          <div className="flex items-center gap-1 bg-[#06080f]/80 rounded-xl p-1 border border-white/[0.06]">
            <button onClick={() => switchView('live')}
              className={`px-6 py-1.5 rounded-lg text-xs font-bold tracking-wide transition-all duration-200 ${
                viewMode === 'live'
                  ? 'bg-emerald-500/20 text-emerald-300 shadow-sm ring-1 ring-emerald-500/20'
                  : 'text-slate-600 hover:text-slate-400 hover:bg-white/[0.03]'
              }`}>
              실전 보기
            </button>
            <button onClick={() => switchView('paper')}
              className={`px-6 py-1.5 rounded-lg text-xs font-bold tracking-wide transition-all duration-200 ${
                viewMode === 'paper'
                  ? 'bg-amber-500/20 text-amber-300 shadow-sm ring-1 ring-amber-500/20'
                  : 'text-slate-600 hover:text-slate-400 hover:bg-white/[0.03]'
              }`}>
              연습 보기
            </button>
          </div>
          <div className="absolute right-4 flex items-center gap-2">
            {marketTab === 'US' && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-violet-500/10 border border-violet-500/20 rounded-lg">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />
                <span className="text-[10px] text-violet-400 font-semibold">해외</span>
              </div>
            )}
            {viewMode === 'paper' && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                <span className="text-[10px] text-amber-400 font-semibold">연습</span>
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto transition-colors duration-500" style={{ background: `linear-gradient(to bottom right, ${theme.main1}, ${theme.main2}, ${theme.main1})` }}>
          {loading && !dash ? (
            <div className="flex items-center justify-center h-full">
              <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="p-4 sm:p-6 lg:p-8 max-w-[1200px] mx-auto">
              {tab === 'home' && <HomeView dash={dash} health={health} killSwitch={killSwitch} trades={trades} usDash={usDash} withdrawConfig={withdrawConfig} watchlist={watchlist} strategy={strategy} setStrategy={setStrategy} toast={toast} onRefresh={load} allocConfig={allocConfig} setAllocConfig={setAllocConfig} onGoToSettings={() => setTab('settings')} viewMode={viewMode} onMarketTabChange={setMarketTab} />}
              {tab === 'trades' && <TradesView trades={trades} watchlist={watchlist} />}
              {tab === 'journal' && <JournalView viewMode={viewMode} />}
              {tab === 'watchlist' && <WatchlistView watchlist={watchlist} setWatchlist={setWatchlist} dash={dash} usDash={usDash} toast={toast} onRefresh={load} viewMode={viewMode} />}
              {tab === 'news' && <NewsView watchlist={watchlist} setWatchlist={setWatchlist} />}
              {tab === 'settings' && <SettingsView strategy={strategy} setStrategy={setStrategy} secrets={secrets} notebookRef={notebookRef} geminiRef={geminiRef} gptRef={gptRef} claudeRef={claudeRef} killSwitch={killSwitch} toggleKill={toggleKill} withdrawConfig={withdrawConfig} setWithdrawConfig={setWithdrawConfig} withdrawHistory={withdrawHistory} setWithdrawHistory={setWithdrawHistory} allocConfig={allocConfig} setAllocConfig={setAllocConfig} toast={toast} />}
            </div>
          )}
        </main>
      </div>
      <ScreenshotReview currentTab={tab} setTab={setTab} viewMode={viewMode} dash={dash} health={health} trades={trades} killSwitch={killSwitch} strategy={strategy} switchViewMode={switchView} loopStatus={loopStatus} toast={toast} />
      </div>
    </div>
  );
}
