'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Panel, Card, Indicator, SideBadge, StatusBadge, ModeBadge, EmptyMsg, Sel, NumInput, LoadBtn } from '@/components/ui';

// ═══════════════════════════════════════
// API
// ═══════════════════════════════════════

const BACKEND_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_API_BASE_URL || (window.location.port === '3000' ? 'http://localhost:8080' : window.location.origin))
    : (process.env.NEXT_PUBLIC_API_BASE_URL || '');

async function api(path: string, opts?: RequestInit & { timeout?: number }) {
  const base = BACKEND_URL.endsWith('/') ? BACKEND_URL.slice(0, -1) : BACKEND_URL;
  const ms = opts?.timeout ?? (path.includes('overseas') ? 15000 : 12000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    const { timeout: _, ...fetchOpts } = opts ?? {};
    const res = await fetch(`${base}/api${path}`, { ...fetchOpts, signal: controller.signal, cache: 'no-store', credentials: 'include', headers: { 'Content-Type': 'application/json', ...fetchOpts?.headers } });
    if (res.status === 401) { window.location.href = '/'; throw new Error('UNAUTHORIZED'); }
    if (!res.ok) throw new Error(`API ${path} (${res.status})`);
    return res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

const fmt = (n: number | null | undefined) => n == null ? '-' : n.toLocaleString('ko-KR');
const fmtPct = (n: number | null | undefined) => n == null ? '-' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const fmtWon = (n: number | null | undefined) => n == null ? '-' : Math.round(n).toLocaleString('ko-KR') + '원';
const fmtUsd = (n: number | null | undefined) => n == null ? '-' : '$' + (n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtTime = (t: string | null | undefined) => { if (!t) return '-'; const d = new Date(t); return `${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`; };
const pc = (n: number | null | undefined) => n == null || n === 0 ? 'text-slate-400' : n > 0 ? 'text-emerald-400' : 'text-rose-400';
const pbg = (n: number | null | undefined) => n == null || n === 0 ? '' : n > 0 ? 'bg-emerald-950/30 border-emerald-900/30' : 'bg-rose-950/30 border-rose-900/30';
const KNOWN_STOCK_NAMES: Record<string, string> = {
  AAPL: 'Apple', NVDA: 'NVIDIA', MSFT: 'Microsoft', GOOGL: 'Google',
  AMZN: 'Amazon', TSLA: 'Tesla', META: 'Meta',
  '000100': '유한양행', '000660': 'SK하이닉스', '000720': '현대건설',
  '001040': 'CJ', '003670': '포스코퓨처엠', '005290': '동진쎄미켐',
  '005380': '현대자동차', '005490': 'POSCO홀딩스', '005930': '삼성전자',
  '006400': '삼성SDI', '009150': '삼성전기', '009540': 'HD한국조선해양',
  '010130': '고려아연', '010950': 'S-Oil', '012450': '한화에어로스페이스',
  '017670': 'SK텔레콤', '018260': '삼성에스디에스', '028300': 'HLB',
  '030200': 'KT', '032830': '삼성생명', '034020': '두산에너빌리티',
  '034730': 'SK', '035420': 'NAVER', '035720': '카카오',
  '036490': 'SK머티리얼즈', '042700': '한미반도체', '051910': 'LG화학',
  '055550': '신한지주', '058470': '리노공업', '066570': 'LG전자',
  '068270': '셀트리온', '079550': 'LIG넥스원', '086520': '에코프로',
  '105560': 'KB금융', '112040': '위메이드', '114800': 'KODEX 인버스',
  '161510': 'ARIRANG 단기채권액티브', '196170': '알테오젠',
  '207940': '삼성바이오로직스', '214150': '클래시스', '247540': '에코프로비엠',
  '263750': '펄어비스', '267260': 'HD현대일렉트릭', '277810': '레인보우로보틱스',
  '316140': '우리금융지주', '328130': '루닛', '333940': 'KODEX 단기채권PLUS',
  '336260': '두산퓨얼셀', '336370': '솔루스첨단소재', '357780': '솔브레인',
  '373220': 'LG에너지솔루션', '377300': '카카오페이', '383220': 'F&F',
  '403870': 'HPSP', '454910': '두산로보틱스',
};

function getKnownStockName(code?: unknown): string | undefined {
  const c = String(code ?? '').trim();
  if (!c) return undefined;
  return KNOWN_STOCK_NAMES[c.toUpperCase()] ?? KNOWN_STOCK_NAMES[c];
}

// ── 숫자 롤업 애니메이션 ──
function useCountUp(target: number, duration = 500) {
  const [val, setVal] = React.useState(target);
  const prev = React.useRef(target);
  const mounted = React.useRef(false);
  React.useEffect(() => {
    if (!mounted.current) { mounted.current = true; prev.current = target; setVal(target); return; }
    const from = prev.current;
    const diff = target - from;
    if (Math.abs(diff) < 100) { prev.current = target; setVal(target); return; }
    const steps = Math.ceil(duration / 16);
    let step = 0;
    const id = setInterval(() => {
      step++;
      setVal(Math.round(from + diff * (step / steps)));
      if (step >= steps) { clearInterval(id); prev.current = target; }
    }, 16);
    return () => clearInterval(id);
  }, [target, duration]);
  return val;
}

// ── 토스트 알림 시스템 ──
function useToast() {
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string; type: 'ok' | 'err' | 'info' }>>([]);
  const show = (msg: string, type: 'ok' | 'err' | 'info' = 'ok') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  };
  const ToastContainer = () => (
    <div className="fixed top-4 right-4 z-[999] space-y-2 pointer-events-none">
      {toasts.map(t => (
        <div key={t.id} className={`pointer-events-auto px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg backdrop-blur-md animate-[fadeIn_0.2s_ease] ${
          t.type === 'ok' ? 'bg-emerald-600/90 text-white' : t.type === 'err' ? 'bg-rose-600/90 text-white' : 'bg-blue-600/90 text-white'
        }`}>{t.msg}</div>
      ))}
    </div>
  );
  return { show, ToastContainer };
}


// ═══════════════════════════════════════
// Dashboard
// ═══════════════════════════════════════

type Tab = 'home' | 'trades' | 'watchlist' | 'news' | 'settings';

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
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const notebookRef = useRef<HTMLTextAreaElement>(null);
  const geminiRef = useRef<HTMLTextAreaElement>(null);
  const gptRef = useRef<HTMLTextAreaElement>(null);
  const claudeRef = useRef<HTMLTextAreaElement>(null);

  const loadingRef = useRef(false);
  const load = async () => {
    if (loadingRef.current) return; // 이전 요청 겹침 방지
    loadingRef.current = true;
    try {
      setLoading(true);
      // 1단계: 핵심 데이터 먼저 (화면 표시용)
      const [h, d, k] = await Promise.allSettled([
        api('/health'), api('/dashboard'), api('/kill-switch'),
      ]);
      if (h.status === 'fulfilled') setHealth(h.value);
      if (d.status === 'fulfilled') setDash(d.value);
      if (k.status === 'fulfilled') setKillSwitch(k.value);
      setLastUpdate(new Date());
      setLoading(false); // 핵심 데이터 로드 즉시 화면 표시

      // 2단계: 나머지 데이터 백그라운드 로드 (overseas 제외 — 별도 비동기)
      const [w, s, t, sec, wc, wh] = await Promise.allSettled([
        api('/watchlist'), api('/strategy'),
        api('/trades?limit=200'), api('/secrets'),
        api('/withdraw/config').catch(() => null),
        api('/withdraw/history').catch(() => []),
      ]);
      if (w.status === 'fulfilled') setWatchlist(Array.isArray(w.value) ? w.value : []);
      if (s.status === 'fulfilled') setStrategy(s.value);
      if (t.status === 'fulfilled') setTrades(Array.isArray(t.value) ? t.value : []);
      if (sec.status === 'fulfilled') setSecrets(sec.value);
      if (wc.status === 'fulfilled' && wc.value) setWithdrawConfig(wc.value);
      if (wh.status === 'fulfilled') setWithdrawHistory(Array.isArray(wh.value) ? wh.value : []);
      api('/portfolio/allocation').then(ac => { if (ac) setAllocConfig(ac); }).catch(() => {});

      // 3단계: 미국주식 별도 로드 (느려도 다른 데이터에 영향 없음)
      api('/overseas/dashboard').then(us => { if (us) setUsDash(us); }).catch(() => {});
    } catch (err) { setLoading(false); console.error('[QUANTOPS] 데이터 로드 실패:', err); }
    finally { loadingRef.current = false; }
  };

  useEffect(() => {
    load();
    const getInterval = () => {
      const h = new Date().getHours(), m = new Date().getMinutes();
      const mins = h * 60 + m;
      const isMarket = mins >= 9 * 60 && mins < 15 * 60 + 30;
      const visible = document.visibilityState === 'visible';
      // 탭 보는 중 + 장중: 15초 / 탭 보는 중 + 장외: 90초 / 백그라운드: 3분
      if (!visible) return 180000;
      return isMarket ? 15000 : 90000;
    };
    let iv: ReturnType<typeof setInterval>;
    const schedule = () => { iv = setInterval(() => { load(); clearInterval(iv); schedule(); }, getInterval()); };
    schedule();
    // 탭 전환 시 인터벌 재조정
    const onVisibility = () => { clearInterval(iv); schedule(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  // SSE 실시간 스트림 — 거래 체결 즉시 반영 (폴링 15초 보완)
  useEffect(() => {
    const base = BACKEND_URL.endsWith('/') ? BACKEND_URL.slice(0, -1) : BACKEND_URL;
    const es = new EventSource(`${base}/api/stream`, { withCredentials: true });
    let prevChainCount = -1;

    es.addEventListener('update', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        // 최신 거래내역 즉시 반영
        if (Array.isArray(data.recentTrades) && data.recentTrades.length > 0) {
          setTrades(prev => {
            const existingIds = new Set(prev.map((t: any) => t.id));
            const newTrades = data.recentTrades.filter((t: any) => !existingIds.has(t.id));
            if (newTrades.length === 0) return prev;
            // 새 거래 추가 후 최신순 유지
            return [...newTrades, ...prev].slice(0, 200);
          });
        }
        // 체인 수 변화 시 전체 재조회 (새 포지션 진입/청산)
        if (prevChainCount !== -1 && data.activeChains !== prevChainCount) {
          load();
        }
        prevChainCount = data.activeChains ?? prevChainCount;
      } catch { /* 파싱 오류 무시 */ }
    });

    es.onerror = () => { /* 재연결은 EventSource가 자동 처리 */ };
    return () => es.close();
  }, []);

  // 알림 상태
  const [pushStatus, setPushStatus] = useState<{
    ready: boolean;
    publicKey: string;
    deviceCount: number;
    subscribed: boolean;
    permissionState: NotificationPermission | 'unsupported';
    registering: boolean;
    error: string | null;
  }>({
    ready: false,
    publicKey: '',
    deviceCount: 0,
    subscribed: false,
    permissionState: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
    registering: false,
    error: null,
  });

  // PWA 푸시 알림 상태 초기화 + 자동 등록
  useEffect(() => {
    (async () => {
      if (typeof window === 'undefined') return;
      const supported = 'serviceWorker' in navigator && 'PushManager' in window;
      const perm: NotificationPermission | 'unsupported' = supported
        ? Notification.permission
        : 'unsupported';

      // 서버 상태 조회
      let serverStatus = { ready: false, publicKey: '', deviceCount: 0 };
      try { serverStatus = await api('/push/status'); } catch { /* 서버 미응답 */ }

      // 현재 구독 여부 확인
      let subscribed = false;
      if (supported && perm === 'granted') {
        try {
          const reg = await navigator.serviceWorker.ready;
          const existing = await reg.pushManager.getSubscription();
          subscribed = !!existing;
        } catch { /* ignore */ }
      }

      setPushStatus(prev => ({
        ...prev,
        ...serverStatus,
        subscribed,
        permissionState: perm,
      }));

      // 권한 있고 구독 안 됐으면 자동 등록
      if (supported && perm === 'granted' && !subscribed && serverStatus.ready && serverStatus.publicKey) {
        try {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: serverStatus.publicKey,
          });
          await api('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
          setPushStatus(prev => ({ ...prev, subscribed: true, deviceCount: prev.deviceCount + 1 }));
        } catch (e: any) {
          console.warn('[QUANTOPS] 자동 푸시 등록 실패:', e.message);
        }
      }
    })();
  }, []);


  const toggleKill = async () => {
    const active = killSwitch?.active;
    await api(`/kill-switch/${active ? 'deactivate' : 'activate'}`, { method: 'POST' });
    const k = await api('/kill-switch'); setKillSwitch(k);
  };

  // ── Nav items ──
  const navItems: { id: Tab; label: string; icon: string }[] = [
    { id: 'home', label: '대시보드', icon: '📊' },
    { id: 'trades', label: '매매내역', icon: '📋' },
    { id: 'watchlist', label: '감시목록', icon: '👁' },

    { id: 'news', label: '뉴스', icon: '📰' },
    { id: 'settings', label: '설정', icon: '⚙️' },
  ];

  // ═══════════════════════════════════════
  // LAYOUT
  // ═══════════════════════════════════════

  return (
    <div className="flex h-screen bg-[#06080f] text-slate-100 overflow-hidden">
      <ToastContainer />
      {/* ── Mobile overlay ── */}
      {mobileMenu && <div className="fixed inset-0 bg-black/60 z-40 lg:hidden" onClick={() => setMobileMenu(false)} />}

      {/* ── Left Sidebar ── */}
      <aside className={`fixed lg:static inset-y-0 left-0 z-50 w-[220px] bg-[#0a0e1a]/95 backdrop-blur-xl border-r border-white/[0.04] flex flex-col shrink-0 transform transition-transform duration-200 ${mobileMenu ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        {/* Logo */}
        <div className="px-5 py-5 border-b border-white/[0.04]">
          <h1 className="text-lg font-black tracking-tight bg-gradient-to-r from-blue-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent">QUANTOPS</h1>
          <p className="text-[10px] text-slate-600 mt-0.5 font-medium">AI 자동매매 v0.2</p>
        </div>

        {/* Status */}
        <div className="px-4 py-3.5 space-y-2.5 border-b border-white/[0.04]">
          {[
            { ok: health?.status === 'ok', label: health?.status === 'ok' ? '정상 작동' : '오류 발생' },
            { ok: health?.marketOpen, label: `한국 ${health?.marketOpen ? '거래 중' : '쉬는 중'}` },
            { ok: health?.usMarketOpen, label: `미국 ${health?.usMarketOpen ? '거래 중' : '쉬는 중'}` },
            { ok: dash?.tradingMode !== 'paper', label: dash?.tradingMode === 'paper' ? '연습 모드' : '실전 모드', amber: dash?.tradingMode === 'paper' },
          ].map((s, i) => (
            <div key={i} className="flex items-center gap-2.5 text-[11px]">
              <span className={`w-1.5 h-1.5 rounded-full ${s.amber ? 'bg-amber-400' : s.ok ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              <span className="text-slate-500 font-medium">{s.label}</span>
            </div>
          ))}
        </div>

        {/* Nav */}
        <nav className="flex-1 p-2.5 space-y-0.5">
          {navItems.map(item => (
            <button key={item.id} onClick={() => { setTab(item.id); setMobileMenu(false); }}
              className={`w-full text-left px-4 py-2.5 rounded-xl text-[13px] flex items-center gap-3 transition-all duration-150 ${tab === item.id ? 'bg-blue-500/10 text-blue-400 font-semibold ring-1 ring-blue-500/20' : 'text-slate-500 hover:bg-white/[0.03] hover:text-slate-300'}`}>
              <span className="text-sm">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        {/* Kill Switch — always visible */}
        <div className="p-3 border-t border-white/[0.04] space-y-2">
          <button onClick={toggleKill}
            className={`w-full py-3 rounded-xl text-xs font-bold transition-all ${killSwitch?.active ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/30' : 'bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-400'}`}>
            {killSwitch?.active ? '⏸ 매매 중단 중' : '▶ 자동매매 중'}
          </button>
          <button onClick={load} className="w-full py-2 rounded-xl text-[10px] text-slate-600 hover:text-slate-400 bg-white/[0.02] hover:bg-white/[0.04] transition-all font-medium">
            새로고침 · {lastUpdate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
          </button>
        </div>
      </aside>

      {/* ── Main Content ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="lg:hidden flex items-center gap-3 px-4 py-3 bg-[#0f1320] border-b border-slate-800/40">
          <button onClick={() => setMobileMenu(true)} className="text-slate-400">
            <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
          </button>
          <span className="font-bold text-sm bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">QUANTOPS</span>
          <button onClick={toggleKill} className={`ml-auto px-4 py-2 rounded-xl text-xs font-bold min-h-[36px] whitespace-nowrap ${killSwitch?.active ? 'bg-rose-600 text-white' : 'bg-emerald-900/40 text-emerald-400'}`}>
            {killSwitch?.active ? '⏸ 중단 중' : '▶ 자동 중'}
          </button>
        </header>

        {/* Content area */}
        <main className="flex-1 overflow-y-auto bg-gradient-to-br from-[#06080f] via-[#0a0e1a] to-[#06080f]">
          {loading && !dash ? (
            <div className="flex items-center justify-center h-full">
              <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="p-4 sm:p-6 lg:p-8 max-w-[1200px] mx-auto">
              {tab === 'home' && <HomeView dash={dash} health={health} killSwitch={killSwitch} trades={trades} usDash={usDash} withdrawConfig={withdrawConfig} watchlist={watchlist} strategy={strategy} setStrategy={setStrategy} toast={toast} onRefresh={load} />}
              {tab === 'trades' && <TradesView trades={trades} watchlist={watchlist} />}
              {tab === 'watchlist' && <WatchlistView watchlist={watchlist} setWatchlist={setWatchlist} dash={dash} usDash={usDash} toast={toast} onRefresh={load} />}

              {tab === 'news' && <NewsView watchlist={watchlist} setWatchlist={setWatchlist} />}
              {tab === 'settings' && <SettingsView strategy={strategy} setStrategy={setStrategy} secrets={secrets} notebookRef={notebookRef} geminiRef={geminiRef} gptRef={gptRef} claudeRef={claudeRef} killSwitch={killSwitch} toggleKill={toggleKill} withdrawConfig={withdrawConfig} setWithdrawConfig={setWithdrawConfig} withdrawHistory={withdrawHistory} setWithdrawHistory={setWithdrawHistory} allocConfig={allocConfig} setAllocConfig={setAllocConfig} toast={toast} />}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// ── 자기학습 인사이트 패널 ──
function InsightsPanel({ insights: insightsProp, trades, onRefresh, toast }: { insights: any[]; trades?: any[]; onRefresh: () => void; toast?: (msg: string, type: string) => void }) {
  const [deleting, setDeleting] = React.useState<number | null>(null);
  const [applying, setApplying] = React.useState<number | null>(null);
  const [newInsight, setNewInsight] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const [showAdd, setShowAdd] = React.useState(false);
  const [deleteModal, setDeleteModal] = React.useState<{ id: number; insight: string; relatedTrades: any[] } | null>(null);
  const [liveInsights, setLiveInsights] = React.useState<any[] | null>(null);
  React.useEffect(() => {
    const load = () => api('/insights').then((d: any) => setLiveInsights(Array.isArray(d) ? d : [])).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);
  const insights = liveInsights ?? insightsProp;

  const [triggering, setTriggering] = React.useState(false);
  const triggerLearning = async () => {
    setTriggering(true);
    try {
      await api('/run-self-learning', { method: 'POST' });
      toast?.('자기학습 시작 — 잠시 후 인사이트가 업데이트됩니다', 'ok');
      setTimeout(() => api('/insights').then((d: any) => setLiveInsights(Array.isArray(d) ? d : [])).catch(() => {}), 8000);
    } catch { toast?.('자기학습 실행 실패', 'err'); }
    finally { setTriggering(false); }
  };

  const openDeleteModal = (id: number, insight: string) => {
    const words = insight.replace(/[^\w\s가-힣]/g, ' ').split(/\s+/).filter((w: string) => w.length >= 2).slice(0, 8);
    const relatedTrades = (trades ?? []).filter((t: any) => {
      if (t.status !== 'FILLED' || t.side !== 'SELL') return false;
      const avgBuy = Number(t.transaction_chains?.avg_buy_price) || 0;
      const filledPx = Number(t.filled_price) || 0;
      const pnl = avgBuy > 0 && filledPx > 0 ? (filledPx - avgBuy) * (Number(t.quantity) || 0) : 0;
      if (pnl >= 0) return false;
      const hay = ((t.ai_reasoning ?? '') + ' ' + (t.stock_name ?? '')).toLowerCase();
      return words.some((w: string) => hay.includes(w.toLowerCase()));
    }).slice(0, 4);
    setDeleteModal({ id, insight, relatedTrades });
  };

  const confirmDelete = async () => {
    if (!deleteModal) return;
    const id = deleteModal.id;
    setDeleteModal(null);
    setDeleting(id);
    try {
      await api(`/insights/${id}`, { method: 'DELETE', headers: {} });
      setLiveInsights((prev) => (prev ?? []).filter((i) => i.id !== id));
      onRefresh();
    } catch (err: any) {
      alert('삭제 실패: ' + err.message);
    } finally { setDeleting(null); }
  };

  const handleApply = async (id: number) => {
    setApplying(id);
    try {
      const data = await api(`/insights/${id}/apply`, { method: 'POST' });
      if (data.ok) { toast?.(data.message ?? '전략 파라미터 적용 완료', 'ok'); onRefresh(); }
      else toast?.(data.error ?? '적용 실패', 'err');
    } catch { toast?.('적용 요청 실패', 'err'); }
    finally { setApplying(null); }
  };

  const handleAdd = async () => {
    const text = newInsight.trim();
    if (!text) return;
    setAdding(true);
    try {
      await api('/insights', { method: 'POST', body: JSON.stringify({ category: 'MANUAL', insight: text, confidence: 0.9 }) });
      setNewInsight('');
      setShowAdd(false);
      onRefresh();
    } finally { setAdding(false); }
  };

  const categoryColor: Record<string, string> = {
    WIN_PATTERN: 'text-emerald-400 bg-emerald-900/30',
    LOSS_PATTERN: 'text-rose-400 bg-rose-900/30',
    TIMING: 'text-blue-400 bg-blue-900/30',
    SIZING: 'text-amber-400 bg-amber-900/30',
    MANUAL: 'text-purple-400 bg-purple-900/30',
  };
  const categoryLabel: Record<string, string> = {
    WIN_PATTERN: '승리패턴', LOSS_PATTERN: '손실패턴', TIMING: '타이밍',
    SIZING: '사이징', MANUAL: 'CEO가이드',
  };

  const harmful = insights.filter(i => i.category === 'LOSS_PATTERN');

  return (
    <>
      {/* 삭제 승인 모달 */}
      {deleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-[#0f1422] border border-rose-900/40 rounded-2xl p-5 max-w-sm w-full mx-4 shadow-2xl">
            <div className="flex items-start gap-3 mb-4">
              <span className="text-2xl shrink-0">⚠️</span>
              <div>
                <p className="text-sm font-bold text-rose-400 mb-1.5">인사이트 삭제 승인</p>
                <p className="text-[11px] text-slate-300 leading-relaxed bg-slate-800/40 rounded-lg px-3 py-2">"{deleteModal.insight}"</p>
              </div>
            </div>
            {deleteModal.relatedTrades.length > 0 ? (
              <div className="bg-rose-950/30 border border-rose-900/30 rounded-xl p-3 mb-4 space-y-1.5">
                <p className="text-[10px] text-rose-400 font-medium mb-2">이 가이드와 연관된 손실 매매:</p>
                {deleteModal.relatedTrades.map((t: any, i: number) => {
                  const avgBuy = Number(t.transaction_chains?.avg_buy_price) || 0;
                  const filledPx = Number(t.filled_price) || 0;
                  const qty = Number(t.quantity) || 0;
                  const pnl = avgBuy > 0 && filledPx > 0 ? (filledPx - avgBuy) * qty : 0;
                  return (
                    <div key={i} className="flex items-center justify-between text-[10px]">
                      <span className="text-slate-300 font-medium">{t.stock_name || t.stock_code}</span>
                      <span className="text-rose-400 font-bold">{fmtWon(pnl)}</span>
                    </div>
                  );
                })}
                <p className="text-[9px] text-rose-500/60 mt-1.5">이 인사이트 적용 후 손실이 발생한 매매입니다</p>
              </div>
            ) : (
              <p className="text-[11px] text-slate-500 mb-4">연관된 손실 매매 내역이 없습니다.</p>
            )}
            <div className="flex gap-2">
              <button onClick={() => setDeleteModal(null)}
                className="flex-1 py-2.5 bg-slate-700/50 hover:bg-slate-700 text-slate-300 text-xs rounded-xl transition-all">
                취소
              </button>
              <button onClick={confirmDelete}
                className="flex-1 py-2.5 bg-rose-700 hover:bg-rose-600 text-white text-xs font-bold rounded-xl transition-all">
                삭제 승인
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
          <span className="text-sm font-semibold text-slate-200">🧠 자기학습 인사이트</span>
          <span className="text-[10px] text-slate-600 ml-1">매일 18:30 자동 반영</span>
          <span className="ml-auto text-[10px] bg-slate-700/60 text-slate-400 px-2 py-0.5 rounded-full">{insights.length}개</span>
          <button onClick={triggerLearning} disabled={triggering}
            className="text-[10px] bg-blue-900/40 hover:bg-blue-900/60 text-blue-300 px-2.5 py-1 rounded-lg transition-all disabled:opacity-50">
            {triggering ? '분석중...' : '지금 분석'}
          </button>
          <button onClick={() => setShowAdd(v => !v)}
            className="text-[10px] bg-purple-900/40 hover:bg-purple-900/60 text-purple-300 px-2.5 py-1 rounded-lg transition-all">
            + 가이드 추가
          </button>
        </div>

        {showAdd && (
          <div className="px-4 py-3 border-b border-white/[0.04] bg-purple-900/10 space-y-2">
            <div className="flex gap-2">
              <input
                value={newInsight}
                onChange={e => setNewInsight(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
                placeholder="예: 공매도 과열 종목은 반드시 제외할 것"
                className="flex-1 bg-white/[0.06] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 outline-none focus:border-purple-500/50"
              />
              <button onClick={handleAdd} disabled={adding}
                className="px-3 py-1.5 bg-purple-700 hover:bg-purple-600 text-white text-xs rounded-lg disabled:opacity-50">
                {adding ? '저장중...' : '저장'}
              </button>
            </div>
            {/* 빠른 템플릿 */}
            <div className="flex flex-wrap gap-1.5">
              {[
                '거래량이 평균의 3배 이상 터질 때만 진입 — 작은 거래량 돌파는 페이크',
                '코스피 200일선 아래에서는 신규 매수 금지, 보유 종목 50% 이하로 유지',
                '개별 종목 최대 투자금은 전체 계좌의 20% 이하 유지',
                '매수 후 -7% 닿으면 이유 불문 손절 — 오를 거라는 기대 금지',
                '외국인/기관 순매도 전환 시 보유 중이면 다음날 개장에 50% 매도',
                '실적 발표 전날 신규 매수 금지 — 발표 후 반응 보고 진입',
                '상한가 다음날 추격 매수 금지 — 단타꾼 물량 출하 시점',
                '하락장(코스피 -1.5% 이상)에선 AI 점수 80점 이상만 매수 허용',
              ].map(t => (
                <button key={t} onClick={() => setNewInsight(t)}
                  className="text-[9px] bg-purple-900/30 hover:bg-purple-900/60 text-purple-300 px-2 py-1 rounded-md transition-all text-left leading-tight max-w-[180px] truncate">
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        {harmful.length > 0 && (
          <div className="px-4 py-2.5 bg-rose-900/10 border-b border-rose-900/20">
            <p className="text-[11px] text-rose-400 font-medium mb-2">
              ⚠️ 아래 인사이트는 수익에 악영향을 줄 수 있습니다 — 삭제를 검토하세요
            </p>
            {harmful.map(i => (
              <div key={i.id} className="flex items-start gap-2 py-1.5 border-b border-rose-900/10 last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-slate-300 leading-relaxed">{i.insight}</p>
                  <p className="text-[10px] text-slate-500 mt-0.5">
                    신뢰도 {Math.round(i.confidence * 100)}% · 샘플 {i.sample_count}건
                  </p>
                </div>
                <button
                  onClick={() => openDeleteModal(i.id, i.insight)}
                  disabled={deleting === i.id}
                  className="shrink-0 px-2.5 py-1 bg-rose-800/50 hover:bg-rose-700 text-rose-300 text-[10px] rounded-lg transition-all disabled:opacity-50">
                  {deleting === i.id ? '삭제중...' : '삭제'}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="divide-y divide-white/[0.03] max-h-80 overflow-y-auto">
          {insights.filter(i => i.category !== 'LOSS_PATTERN').length === 0 && !showAdd && (
            <div className="px-4 py-6 text-center">
              <p className="text-xs text-slate-500 mb-1">아직 학습된 패턴이 없습니다</p>
              <p className="text-[10px] text-slate-600">매일 18:30 자동 분석 또는 "지금 분석" 버튼으로 즉시 실행</p>
            </div>
          )}
          {insights.filter(i => i.category !== 'LOSS_PATTERN').map(i => (
            <div key={i.id} className="px-4 py-3 hover:bg-white/[0.02]">
              <div className="flex items-start gap-3">
                <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded mt-0.5 ${categoryColor[i.category] ?? 'text-slate-400 bg-slate-800'}`}>
                  {categoryLabel[i.category] ?? i.category}
                </span>
                <p className="flex-1 text-[11px] text-slate-300 leading-relaxed">{i.insight}</p>
                <div className="shrink-0 flex items-center gap-1.5">
                  {i.is_applied
                    ? <span className="text-[9px] bg-emerald-900/40 text-emerald-400 px-1.5 py-0.5 rounded-full">✓ 적용됨</span>
                    : i.param_change
                      ? <span className="text-[9px] bg-amber-900/40 text-amber-400 px-1.5 py-0.5 rounded-full">대기중</span>
                      : <span className="text-[9px] text-slate-600 px-1.5 py-0.5">AI 자동 반영</span>
                  }
                  <button onClick={() => openDeleteModal(i.id, i.insight)} disabled={deleting === i.id}
                    className="shrink-0 text-slate-700 hover:text-rose-400 text-[11px] transition-colors disabled:opacity-50">
                    ✕
                  </button>
                </div>
              </div>
              {i.recommendation && (
                <div className="mt-1.5 ml-[52px] flex items-start gap-1.5">
                  <span className="text-[9px] text-amber-400/80 shrink-0 mt-0.5">→ 권장:</span>
                  <p className="text-[10px] text-amber-300/70 leading-relaxed">{i.recommendation}</p>
                </div>
              )}
              {i.param_change && !i.is_applied && (
                <div className="mt-1 ml-[52px]">
                  <span className="text-[9px] text-violet-400/60">
                    파라미터 변경: {i.param_change.field} → {String(i.param_change.value)}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ── 성과 종합 분석 패널 ──
function PerformancePanel({ trades, strategy, setStrategy, toast }: { trades: any[]; strategy: any; setStrategy?: (s: any) => void; toast?: (msg: string, type: string) => void }) {
  const [quickPrompt, setQuickPrompt] = React.useState('');
  const [savingPrompt, setSavingPrompt] = React.useState(false);

  // 일별 실현 손익 계산 (SELL 체결 기준)
  const sellTrades = trades.filter((t: any) => t.status === 'FILLED' && t.side === 'SELL');
  const dailyMap = new Map<string, number>();
  for (const t of sellTrades) {
    const date = new Date(t.created_at).toISOString().slice(0, 10);
    // realized_pnl이 있으면 백엔드 FIFO 계산값 사용 (수수료 포함), 없으면 직접 계산
    if (t.realized_pnl != null) {
      dailyMap.set(date, (dailyMap.get(date) ?? 0) + Number(t.realized_pnl));
    } else {
      const avgBuy = Number(t.transaction_chains?.avg_buy_price) || 0;
      const filledPx = Number(t.filled_price) || 0;
      const qty = Number(t.filled_quantity ?? t.quantity) || 0;
      const BUY_FEE = 0.00015; const SELL_FEE = 0.00245;
      if (avgBuy > 0 && filledPx > 0 && qty > 0) {
        const gross = (filledPx - avgBuy) * qty;
        const fees = Math.round(avgBuy * qty * BUY_FEE) + Math.round(filledPx * qty * SELL_FEE);
        dailyMap.set(date, (dailyMap.get(date) ?? 0) + gross - fees);
      }
    }
  }

  const sortedDays = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let cumPnl = 0; let peak = 0; let maxDdPct = 0; let maxDdAmt = 0;
  const dailySeries = sortedDays.map(([date, pnl]) => {
    cumPnl += pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak > 0 ? ((peak - cumPnl) / peak) * 100 : 0;
    if (dd > maxDdPct) { maxDdPct = dd; maxDdAmt = peak - cumPnl; }
    return { date, pnl, cumPnl };
  });

  const allPnls = dailySeries.map(d => d.pnl);
  const avgPnl = allPnls.length > 0 ? allPnls.reduce((s, v) => s + v, 0) / allPnls.length : 0;
  // 승률/손익비는 매매(체결) 단위로 계산 — 일별 집계가 아닌 개별 SELL 기준
  const tradePnls = sellTrades
    .filter((t: any) => t.realized_pnl != null)
    .map((t: any) => Number(t.realized_pnl));
  const winPnls = tradePnls.filter((p: number) => p > 0);
  const lossPnls = tradePnls.filter((p: number) => p < 0);
  const winRate = tradePnls.length > 0 ? Math.round((winPnls.length / tradePnls.length) * 100) : 0;
  const avgWin = winPnls.length > 0 ? winPnls.reduce((s, v) => s + v, 0) / winPnls.length : 0;
  const avgLoss = lossPnls.length > 0 ? Math.abs(lossPnls.reduce((s, v) => s + v, 0) / lossPnls.length) : 0;
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 99 : 0);
  // 연속 손실/수익 스트릭 (최근)
  let streak = 0; let streakDir: 'win' | 'loss' | 'none' = 'none';
  for (let k = allPnls.length - 1; k >= 0; k--) {
    const p = allPnls[k];
    if (streak === 0) { streakDir = p > 0 ? 'win' : 'loss'; streak = 1; }
    else if ((streakDir === 'win' && p > 0) || (streakDir === 'loss' && p < 0)) streak++;
    else break;
  }

  const last14 = dailySeries.slice(-14);
  const last7 = dailySeries.slice(-7);
  const pos7 = last7.filter(d => d.pnl > 0).length;
  const neg7 = last7.filter(d => d.pnl < 0).length;
  const trendUp = pos7 > neg7; const trendDown = neg7 > pos7;
  const trendLabel = trendDown ? '하락세' : trendUp ? '상승세' : '횡보';
  const trendColor = trendDown ? 'text-rose-400' : trendUp ? 'text-emerald-400' : 'text-slate-400';
  const trendBg = trendDown ? 'bg-rose-900/20 border-rose-900/20' : trendUp ? 'bg-emerald-900/20 border-emerald-900/20' : 'bg-slate-700/20 border-slate-700/20';
  const maxBar = last14.length > 0 ? Math.max(...last14.map(d => Math.abs(d.pnl)), 1) : 1;

  const saveQuickPrompt = async () => {
    if (!quickPrompt.trim() || !setStrategy) return;
    setSavingPrompt(true);
    try {
      const body = {
        ...strategy,
        claude_prompt: (strategy?.claude_prompt ?? '') + '\n\n[CEO 추가 지시 ' + new Date().toLocaleDateString('ko') + ']\n' + quickPrompt.trim(),
      };
      const u = await api('/strategy', { method: 'PUT', body: JSON.stringify(body) });
      setStrategy(u);
      setQuickPrompt('');
      toast?.('전략 지시 추가됨', 'ok');
    } finally { setSavingPrompt(false); }
  };

  if (dailySeries.length === 0 && !strategy) return null;

  return (
    <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
        <span className="text-sm font-semibold text-slate-200">📊 성과 종합 분석</span>
        <span className={`ml-auto text-[10px] font-bold px-2.5 py-1 rounded-full border ${trendBg} ${trendColor}`}>
          {trendDown ? '↓' : trendUp ? '↑' : '→'} {trendLabel} (7일)
        </span>
      </div>
      <div className="p-4 space-y-4">
        {/* 4개 핵심 지표 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white/[0.03] rounded-xl p-3">
            <div className="text-[10px] text-slate-500 mb-1">누적 실현 손익</div>
            <div className={`text-base font-black ${cumPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {cumPnl >= 0 ? '+' : ''}{fmtWon(cumPnl)}
            </div>
            <div className="text-[9px] text-slate-600 mt-1">일평균 {avgPnl >= 0 ? '+' : ''}{fmtWon(avgPnl)}</div>
          </div>
          <div className="bg-white/[0.03] rounded-xl p-3">
            <div className="text-[10px] text-slate-500 mb-1">최대 낙폭 (MDD)</div>
            <div className={`text-base font-black ${maxDdPct > 15 ? 'text-rose-400' : maxDdPct > 7 ? 'text-amber-400' : 'text-slate-300'}`}>
              -{maxDdPct.toFixed(1)}%
            </div>
            <div className="text-[9px] text-slate-600 mt-1">{fmtWon(maxDdAmt)}</div>
          </div>
          <div className="bg-white/[0.03] rounded-xl p-3">
            <div className="text-[10px] text-slate-500 mb-1">승률</div>
            <div className={`text-base font-black ${winRate >= 60 ? 'text-emerald-400' : winRate >= 45 ? 'text-amber-400' : 'text-rose-400'}`}>
              {winRate}%
            </div>
            <div className="text-[9px] text-slate-600 mt-1">{winPnls.length}승 {lossPnls.length}패 ({tradePnls.length}매매)</div>
          </div>
          <div className="bg-white/[0.03] rounded-xl p-3">
            <div className="text-[10px] text-slate-500 mb-1">손익비</div>
            <div className={`text-base font-black ${profitFactor >= 1.5 ? 'text-emerald-400' : profitFactor >= 1.0 ? 'text-amber-400' : 'text-rose-400'}`}>
              {profitFactor === 99 ? '∞' : profitFactor.toFixed(2)}
            </div>
            <div className="text-[9px] mt-1">
              {streak > 1 && streakDir !== 'none'
                ? <span className={streakDir === 'win' ? 'text-emerald-500' : 'text-rose-500'}>{streakDir === 'win' ? `${streak}연승` : `${streak}연패 ⚠️`}</span>
                : <span className="text-slate-600">평균 +{fmtWon(avgWin)} / -{fmtWon(avgLoss)}</span>
              }
            </div>
          </div>
        </div>

        {/* 최근 14일 미니 바 차트 */}
        {last14.length > 0 && (
          <div>
            <div className="text-[10px] text-slate-500 mb-2">최근 {last14.length}일 일별 손익</div>
            <div className="flex items-end gap-0.5 h-10">
              {last14.map((d, i) => {
                const barH = Math.max(3, (Math.abs(d.pnl) / maxBar) * 36);
                return (
                  <div key={i} className="flex-1 flex flex-col items-center justify-end" title={`${d.date}: ${d.pnl >= 0 ? '+' : ''}${fmtWon(d.pnl)}`}>
                    <div className={`w-full rounded-sm ${d.pnl >= 0 ? 'bg-emerald-500/70' : 'bg-rose-500/70'}`} style={{ height: `${barH}px` }} />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[9px] text-slate-700 mt-1">
              <span>{last14[0]?.date?.slice(5)}</span>
              <span>오늘</span>
            </div>
          </div>
        )}

        {/* 빠른 전략 지시 입력창 */}
        {setStrategy && (
          <div className="border-t border-white/[0.04] pt-3">
            <div className="text-[10px] text-slate-500 mb-2">⚡ 빠른 전략 지시 <span className="text-slate-700">(Claude 프롬프트에 추가됨)</span></div>
            <div className="flex gap-2">
              <textarea
                value={quickPrompt}
                onChange={e => setQuickPrompt(e.target.value)}
                placeholder="예: 오늘부터 바이오 전면 제외, 반도체만 공략..."
                rows={2}
                className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2 text-[11px] text-slate-200 placeholder:text-slate-700 outline-none focus:border-blue-500/40 resize-none"
              />
              <button
                onClick={saveQuickPrompt}
                disabled={savingPrompt || !quickPrompt.trim()}
                className="px-4 bg-blue-700/60 hover:bg-blue-600/80 text-blue-300 text-xs rounded-xl transition-all disabled:opacity-40 shrink-0">
                {savingPrompt ? '...' : '저장'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// RISK GAUGE (3 arc gauges)
// ═══════════════════════════════════════

function ArcGauge({ pct, color, label, sub }: { pct: number; color: string; label: string; sub: string }) {
  const r = 28; const cx = 36; const cy = 36;
  const circ = Math.PI * r; // half-circle
  const clamped = Math.max(0, Math.min(100, pct));
  const stroke = (clamped / 100) * circ;
  const trackColor = 'rgba(255,255,255,0.05)';
  const colorMap: Record<string, string> = {
    emerald: '#10b981', blue: '#3b82f6', amber: '#f59e0b', rose: '#f43f5e',
  };
  const strokeColor = colorMap[color] ?? colorMap.blue;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="72" height="44" viewBox="0 0 72 44">
        {/* track */}
        <path d={`M 8 36 A ${r} ${r} 0 0 1 64 36`} fill="none" stroke={trackColor} strokeWidth="6" strokeLinecap="round" />
        {/* fill */}
        <path d={`M 8 36 A ${r} ${r} 0 0 1 64 36`} fill="none" stroke={strokeColor} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${stroke} ${circ}`} style={{ transition: 'stroke-dasharray 0.6s ease' }} />
        <text x="36" y="34" textAnchor="middle" fontSize="11" fontWeight="700" fill="white">{clamped}%</text>
      </svg>
      <div className="text-[10px] font-semibold text-slate-300 text-center leading-tight">{label}</div>
      <div className="text-[9px] text-slate-600 text-center">{sub}</div>
    </div>
  );
}

function RiskGaugePanel({ investedPct, dailyLossPct, concentrationPct }: { investedPct: number; dailyLossPct: number; concentrationPct: number }) {
  const investedColor = investedPct > 75 ? 'rose' : investedPct > 50 ? 'amber' : 'emerald';
  const lossColor = dailyLossPct > 70 ? 'rose' : dailyLossPct > 40 ? 'amber' : 'emerald';
  const concColor = concentrationPct > 50 ? 'rose' : concentrationPct > 30 ? 'amber' : 'blue';
  return (
    <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3">
      <div className="text-[11px] font-semibold text-slate-400 mb-2">리스크 게이지</div>
      <div className="flex items-end justify-around gap-2">
        <ArcGauge pct={Math.round(investedPct)} color={investedColor} label="투자 비중" sub="한도 80%" />
        <ArcGauge pct={Math.round(dailyLossPct)} color={lossColor} label="손실 소진" sub="일일 한도" />
        <ArcGauge pct={Math.round(concentrationPct)} color={concColor} label="종목 집중도" sub="단일 최대" />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// STRATEGY TIMELINE (7-day mode switch)
// ═══════════════════════════════════════

function StrategyTimelinePanel({ strategy }: { strategy: any }) {
  const [history, setHistory] = React.useState<any[]>([]);
  React.useEffect(() => {
    api('/strategy/history').then((r: any) => { if (Array.isArray(r)) setHistory(r.slice(0, 10)); }).catch(() => {});
  }, []);

  const modeColor: Record<string, string> = {
    SWING: 'bg-emerald-500/70 text-emerald-100',
    DEFENSE: 'bg-rose-500/70 text-rose-100',
    DIVIDEND: 'bg-amber-500/70 text-amber-100',
    SCALPING: 'bg-purple-500/70 text-purple-100',
  };
  const currentMode = strategy?.mode ?? 'SWING';
  const currentColor = modeColor[currentMode] ?? 'bg-slate-500/70 text-slate-100';

  return (
    <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-semibold text-slate-400">전략 모드 이력 (7일)</span>
        <span className={`ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full ${currentColor}`}>{currentMode} 진행 중</span>
      </div>
      {history.length === 0 ? (
        <div className="text-[10px] text-slate-600 py-1">전략 전환 없음 — 안정 운영 중</div>
      ) : (
        <div className="flex flex-wrap gap-1.5 mt-1">
          {history.slice().reverse().map((ev: any, i: number) => {
            const fromC = (modeColor[ev.from] ?? 'bg-slate-500/50 text-slate-300').split(' ');
            const toC = (modeColor[ev.to] ?? 'bg-slate-500/50 text-slate-300').split(' ');
            return (
              <div key={i} className="flex items-center gap-1 text-[9px] bg-white/[0.03] rounded-lg px-2 py-1">
                <span className={`px-1.5 py-0.5 rounded ${fromC[0]} ${fromC[1]}`}>{ev.from}</span>
                <span className="text-slate-600">→</span>
                <span className={`px-1.5 py-0.5 rounded ${toC[0]} ${toC[1]}`}>{ev.to}</span>
                <span className="text-slate-700 ml-1">{new Date(ev.ts).toLocaleDateString('ko', { month:'numeric', day:'numeric' })}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// OVERSEAS SCORE PANEL
// ═══════════════════════════════════════

function OverseasScorePanel({ usDash }: { usDash?: any }) {
  const usScored = (usDash?.watchlist ?? []).filter((s: any) => typeof s.score === 'number');
  const signalMap: Record<string, string> = { STRONG_BUY: '강력 추천', BUY: '매수', HOLD: '관망', SELL: '매도', STRONG_SELL: '강력 매도' };
  return (
    <Panel title="AI가 보는 해외 종목 점수" badge={usScored.length > 0 ? `${usScored.length}종목` : undefined} badgeColor="blue">
      {usScored.length > 0 ? (
        <div className="p-3.5 space-y-2">
          {[...usScored].sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0)).map((sc: any) => {
            const raw = Number(sc.score);
            const pct = Math.max(2, Math.min(100, (raw + 100) / 2));
            const barColor = pct >= 75 ? 'bg-emerald-500' : pct >= 60 ? 'bg-blue-500' : pct >= 45 ? 'bg-amber-500' : 'bg-slate-600';
            const textColor = pct >= 75 ? 'text-emerald-400' : pct >= 60 ? 'text-blue-400' : 'text-slate-500';
            const label = signalMap[sc.signal] ?? sc.signal ?? '';
            return (
              <div key={sc.code} className="flex items-center gap-3 px-2 py-2">
                <div className="w-24 shrink-0">
                  <div className="text-xs font-bold text-slate-300 truncate">{sc.name}</div>
                  <div className="text-[10px] text-slate-600">{sc.code} · RSI {sc.rsi != null ? Number(sc.rsi).toFixed(0) : '-'}</div>
                </div>
                <div className="flex-1">
                  <div className="h-2 bg-white/[0.04] rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <span className={`text-sm font-black w-10 text-right ${textColor}`}>{raw > 0 ? '+' : ''}{raw}</span>
                <span className={`text-[10px] font-medium w-16 text-right ${textColor}`}>{label}</span>
                <span className="text-[10px] text-slate-600 w-12 text-right">{(Number(sc.changePct) >= 0 ? '+' : '')}{Number(sc.changePct ?? 0).toFixed(2)}%</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="p-6 text-center space-y-3">
          <div className="text-2xl opacity-30">🌐</div>
          <p className="text-sm text-slate-500">해외 점수 계산 중...</p>
          <p className="text-[11px] text-slate-600">잠시 후 새로고침하면 기술적 분석 점수가 표시됩니다</p>
        </div>
      )}
    </Panel>
  );
}

// PNL 3-WAY BREAKDOWN
// ═══════════════════════════════════════

function PnlBreakdownPanel({ chains, trades }: { chains: any[]; trades: any[] }) {
  const filled = trades.filter((t: any) => t.status === 'FILLED' && t.side === 'SELL');

  // 시세차익 (SWING/DEFENSE/SCALPING 모드 매도 실현손익)
  const swingPnl = filled.filter((t: any) => ['SWING','DEFENSE','SCALPING'].includes(t.trading_mode ?? '')).reduce((sum: number, t: any) => {
    const pnl = typeof t.realized_pnl === 'number' ? Number(t.realized_pnl) : null;
    if (pnl === null) {
      const avgBuy = Number(t.transaction_chains?.avg_buy_price) || 0;
      const fp = Number(t.filled_price) || 0; const qty = Number(t.quantity) || 0;
      return avgBuy > 0 ? sum + (fp - avgBuy) * qty : sum;
    }
    return sum + pnl;
  }, 0);

  // 배당 적립 (DIVIDEND 모드 보유 종목 미실현 배당)
  const dividendAccrual = chains.filter((c: any) => c.strategy_mode === 'DIVIDEND').reduce((sum: number, c: any) => {
    const dvd = Number(c.dividendYield ?? 0);
    const holdDays = Number(c.holdingDays ?? 0);
    const invested = Number(c.invested ?? 0) || (Number(c.avg_buy_price) * Number(c.total_quantity));
    return sum + (invested * (dvd / 365 / 100) * holdDays);
  }, 0);

  // 파킹 ETF 수익 (stock_code === '333940')
  const parkingPnl = filled.filter((t: any) => t.stock_code === '333940').reduce((sum: number, t: any) => {
    const pnl = typeof t.realized_pnl === 'number' ? Number(t.realized_pnl) : 0;
    return sum + pnl;
  }, 0);

  if (swingPnl === 0 && dividendAccrual === 0 && parkingPnl === 0) return null;
  const total = swingPnl + dividendAccrual + parkingPnl;

  return (
    <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3">
      <div className="text-[11px] font-semibold text-slate-400 mb-2">수익 구조 분해</div>
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-white/[0.03] rounded-xl p-2.5 text-center">
          <div className="text-[9px] text-slate-500 mb-1">📈 시세차익</div>
          <div className={`text-sm font-black ${swingPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{swingPnl >= 0 ? '+' : ''}{fmtWon(swingPnl)}</div>
          <div className="text-[9px] text-slate-600 mt-0.5">SWING/DEFENSE</div>
        </div>
        <div className="bg-white/[0.03] rounded-xl p-2.5 text-center">
          <div className="text-[9px] text-slate-500 mb-1">🏦 배당적립</div>
          <div className={`text-sm font-black ${dividendAccrual >= 0 ? 'text-amber-400' : 'text-rose-400'}`}>+{fmtWon(dividendAccrual)}</div>
          <div className="text-[9px] text-slate-600 mt-0.5">DIVIDEND 모드</div>
        </div>
        <div className="bg-white/[0.03] rounded-xl p-2.5 text-center">
          <div className="text-[9px] text-slate-500 mb-1">🅿️ 파킹ETF</div>
          <div className={`text-sm font-black ${parkingPnl >= 0 ? 'text-blue-400' : 'text-rose-400'}`}>{parkingPnl >= 0 ? '+' : ''}{fmtWon(parkingPnl)}</div>
          <div className="text-[9px] text-slate-600 mt-0.5">333940 파킹</div>
        </div>
      </div>
      {total !== 0 && (
        <div className="mt-2 pt-2 border-t border-white/[0.04] flex justify-between text-[11px]">
          <span className="text-slate-500">합산 실현+적립</span>
          <span className={`font-bold ${total >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{total >= 0 ? '+' : ''}{fmtWon(total)}</span>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// AI DECISION TRANSPARENCY PANEL
// ═══════════════════════════════════════

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  const colorMap: Record<string, string> = {
    blue: 'bg-blue-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500', violet: 'bg-violet-500',
  };
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <div className="w-14 text-slate-500 shrink-0 text-right">{label}</div>
      <div className="flex-1 h-1.5 bg-white/[0.05] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${colorMap[color] ?? colorMap.blue}`} style={{ width: `${Math.max(0, Math.min(100, value))}%`, transition: 'width 0.5s ease' }} />
      </div>
      <div className="w-7 text-right text-slate-400 font-semibold">{Math.round(value)}</div>
    </div>
  );
}

// ── Vision Scalp: 제보 단타 카드 ──
function VisionScalpPanel({ toast }: { toast?: (msg: string, type?: string) => void }) {
  const [imgPreview, setImgPreview] = React.useState<string | null>(null);
  const [imgBase64, setImgBase64] = React.useState<string>('');
  const [mimeType, setMimeType] = React.useState<string>('image/png');
  const [signal, setSignal] = React.useState<any>(null);
  const [analyzing, setAnalyzing] = React.useState(false);
  const [executing, setExecuting] = React.useState(false);
  const [amountUsd, setAmountUsd] = React.useState(200);
  const [result, setResult] = React.useState<any>(null);

  const handleFile = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    setMimeType(file.type);
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      setImgPreview(dataUrl);
      // base64만 추출 (data:image/png;base64, 제거)
      setImgBase64(dataUrl.split(',')[1] ?? '');
      setSignal(null);
      setResult(null);
    };
    reader.readAsDataURL(file);
  };

  const analyze = async () => {
    if (!imgBase64) return;
    setAnalyzing(true);
    setSignal(null);
    try {
      const res = await api('/overseas/vision-scalp/analyze', {
        method: 'POST',
        body: JSON.stringify({ imageBase64: imgBase64, mimeType }),
      });
      setSignal(res);
      if (!res?.ticker) toast?.('미국 주식 신호를 찾지 못했습니다', 'error');
    } catch { toast?.('분석 실패', 'error'); }
    finally { setAnalyzing(false); }
  };

  const execute = async () => {
    if (!signal?.ticker) return;
    setExecuting(true);
    try {
      const res = await api('/overseas/vision-scalp/execute', {
        method: 'POST',
        body: JSON.stringify({
          ticker: signal.ticker,
          exchange: signal.exchange ?? 'NASDAQ',
          amountUsd,
          reasoning: signal.reasoning,
        }),
      });
      if (res?.ok) {
        setResult(res);
        toast?.(`${signal.ticker} 단타 매수 완료 — ${res.qty}주 @ $${res.price?.toFixed(2)}`, 'success');
        setSignal(null);
        setImgPreview(null);
        setImgBase64('');
      } else {
        toast?.(res?.error ?? '실행 실패', 'error');
      }
    } catch { toast?.('실행 오류', 'error'); }
    finally { setExecuting(false); }
  };

  const confidenceColor = (c: number) =>
    c >= 75 ? 'text-emerald-400' : c >= 50 ? 'text-yellow-400' : 'text-rose-400';

  return (
    <div className="border-b border-white/[0.04] px-3.5 py-3">
      <div className="text-[11px] font-semibold text-slate-400 mb-2.5 flex items-center gap-1.5">
        <span>📸</span> 제보 단타 <span className="text-slate-600 font-normal">(캡처 → AI 분석 → 미국주식 단타)</span>
      </div>
      <div className="flex flex-col sm:flex-row gap-2.5">
        {/* 업로드 영역 */}
        <label className="relative flex-shrink-0 cursor-pointer">
          <div
            className="w-24 h-20 rounded-xl border-2 border-dashed border-slate-700/60 hover:border-blue-500/50 bg-slate-800/40 flex items-center justify-center overflow-hidden transition-all"
            onDragOver={e => { e.preventDefault(); }}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          >
            {imgPreview
              ? <img src={imgPreview} alt="preview" className="w-full h-full object-cover rounded-xl" />
              : <span className="text-2xl opacity-30">+</span>}
          </div>
          <input type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
        </label>

        <div className="flex-1 space-y-2 min-w-0">
          {/* 분석 결과 */}
          {signal && signal.ticker ? (
            <div className="bg-slate-800/60 rounded-xl px-3 py-2 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-bold text-white">{signal.ticker}</span>
                <span className="text-[10px] text-slate-500">{signal.exchange}</span>
                <span className={`text-xs font-bold ${confidenceColor(signal.confidence)}`}>{signal.confidence}점</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${signal.riskLevel === 'LOW' ? 'bg-emerald-900/40 text-emerald-400' : signal.riskLevel === 'HIGH' ? 'bg-rose-900/40 text-rose-400' : 'bg-yellow-900/40 text-yellow-400'}`}>{signal.riskLevel}</span>
              </div>
              <p className="text-[10px] text-slate-400 leading-relaxed">{signal.reasoning}</p>
              <div className="text-[9px] text-slate-600">TP +2.5% · SL -1.5% 자동 설정</div>
            </div>
          ) : signal && !signal.ticker ? (
            <div className="bg-slate-800/60 rounded-xl px-3 py-2 text-[11px] text-slate-500">{signal.reasoning}</div>
          ) : null}

          {/* 실행 결과 */}
          {result && (
            <div className="bg-emerald-900/30 border border-emerald-800/40 rounded-xl px-3 py-2 text-[10px] text-emerald-400">
              ✓ {result.ticker} {result.qty}주 @ ${result.price?.toFixed(2)} · TP ${result.tpPrice} · SL ${result.slPrice}
            </div>
          )}

          <div className="flex items-center gap-2">
            {imgBase64 && !signal && (
              <button
                onClick={analyze}
                disabled={analyzing}
                className="px-3 py-1.5 rounded-lg bg-blue-600/80 hover:bg-blue-600 text-white text-xs font-medium disabled:opacity-50 transition-all"
              >
                {analyzing ? '분석 중…' : 'AI 분석'}
              </button>
            )}
            {signal?.ticker && (
              <>
                <input
                  type="number"
                  value={amountUsd}
                  onChange={e => setAmountUsd(Math.max(50, Math.min(1000, Number(e.target.value))))}
                  className="w-20 bg-slate-800/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-xs text-slate-300 text-center"
                  min={50} max={1000} step={50}
                />
                <span className="text-[10px] text-slate-600">USD</span>
                <button
                  onClick={execute}
                  disabled={executing}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600/80 hover:bg-emerald-600 text-white text-xs font-medium disabled:opacity-50 transition-all"
                >
                  {executing ? '실행 중…' : '단타 실행'}
                </button>
                <button onClick={() => { setSignal(null); setImgPreview(null); setImgBase64(''); }} className="text-[10px] text-slate-600 hover:text-slate-400">취소</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AiTransparencyPanel({ watchlist, tab, usDash }: { watchlist: any[]; tab?: 'KR' | 'US'; usDash?: any }) {
  const [details, setDetails] = React.useState<Map<string, any>>(new Map());
  const [selected, setSelected] = React.useState<string | null>(null);
  const [usSel, setUsSel] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (tab === 'US') return; // US 탭은 API 호출 불필요 (usDash에서 직접 읽음)
    const codes = watchlist.map((s: any) => s.stock_code).filter((c: string) => /^[0-9]{6}$/.test(c)).slice(0, 8);
    codes.forEach((code: string) => {
      api(`/stock/${code}/score-detail`).then((r: any) => {
        if (r && typeof r.composite === 'number') {
          setDetails((prev) => new Map(prev).set(code, r));
        }
      }).catch(() => {});
    });
    if (codes.length > 0 && !selected) setSelected(codes[0]);
  }, [watchlist, tab]);

  // US 탭: usDash?.watchlist에서 AI 점수 읽기
  if (tab === 'US') {
    const usStocks: any[] = (usDash?.watchlist ?? []).filter((s: any) => typeof s.score === 'number' || typeof s.ai_score === 'number').slice(0, 8);
    if (usStocks.length === 0) return null;
    const activeUsSel = usSel ?? usStocks[0]?.code ?? null;
    const selStock = usStocks.find((s: any) => s.code === activeUsSel);
    const score = selStock?.score ?? selStock?.ai_score ?? 0;
    const signal = selStock?.signal ?? '';
    return (
      <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3">
        <div className="text-[11px] font-semibold text-slate-400 mb-2">AI 판단 근거 투명성 🇺🇸</div>
        <div className="flex gap-1 flex-wrap mb-3">
          {usStocks.map((s: any) => {
            const sc = s.score ?? s.ai_score ?? 0;
            const active = activeUsSel === s.code;
            return (
              <button key={s.code} onClick={() => setUsSel(s.code)}
                className={`text-[9px] px-2 py-0.5 rounded-full font-semibold transition-colors ${active ? 'bg-blue-500/30 text-blue-300 border border-blue-500/40' : 'bg-white/[0.04] text-slate-500 hover:text-slate-300'}`}>
                {s.name ?? s.code} <span className={sc >= 60 ? 'text-emerald-400' : sc <= 40 ? 'text-rose-400' : 'text-amber-400'}>{Math.round(sc)}</span>
              </button>
            );
          })}
        </div>
        {selStock && (
          <div className="space-y-1.5">
            <ScoreBar label="AI점수" value={score} color="blue" />
            {selStock.confidence != null && <ScoreBar label="신뢰도" value={selStock.confidence} color="emerald" />}
            <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/[0.04]">
              <span className="text-[10px] text-slate-500">시그널</span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${signal === 'BUY' || signal === 'STRONG_BUY' ? 'bg-emerald-500/20 text-emerald-300' : signal === 'SELL' ? 'bg-rose-500/20 text-rose-300' : 'bg-white/[0.04] text-slate-400'}`}>{signal || 'HOLD'}</span>
              {selStock.price != null && <span className="text-[10px] text-slate-500 ml-auto">${selStock.price?.toFixed(2)}</span>}
            </div>
            {selStock.reason && (
              <div className="text-[10px] text-slate-500 leading-relaxed line-clamp-2">{selStock.reason}</div>
            )}
          </div>
        )}
      </div>
    );
  }

  const stocks = watchlist.filter((s: any) => details.has(s.stock_code)).slice(0, 8);
  if (stocks.length === 0) return null;

  const sel = selected ?? stocks[0]?.stock_code;
  const detail = details.get(sel ?? '');

  return (
    <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3">
      <div className="text-[11px] font-semibold text-slate-400 mb-2">AI 판단 근거 투명성</div>
      {/* 종목 탭 */}
      <div className="flex gap-1 flex-wrap mb-3">
        {stocks.map((s: any) => {
          const d = details.get(s.stock_code);
          const score = d?.composite ?? 0;
          const active = sel === s.stock_code;
          return (
            <button key={s.stock_code} onClick={() => setSelected(s.stock_code)}
              className={`text-[9px] px-2 py-0.5 rounded-full font-semibold transition-colors ${active ? 'bg-blue-500/30 text-blue-300 border border-blue-500/40' : 'bg-white/[0.04] text-slate-500 hover:text-slate-300'}`}>
              {s.stock_name ?? s.stock_code} <span className={score >= 60 ? 'text-emerald-400' : score <= 40 ? 'text-rose-400' : 'text-amber-400'}>{Math.round(score)}</span>
            </button>
          );
        })}
      </div>
      {/* 선택 종목 점수 분해 */}
      {detail && (
        <div className="space-y-1.5">
          <ScoreBar label="종합" value={detail.composite} color="blue" />
          <ScoreBar label="기본지표" value={detail.fundamental} color="emerald" />
          <ScoreBar label="기술지표" value={detail.technical} color="violet" />
          <ScoreBar label="시장심리" value={detail.sentiment} color="amber" />
          {detail.summary && (() => {
            let displayText = detail.summary;
            try {
              const parsed = typeof detail.summary === 'string' && detail.summary.trim().startsWith('{')
                ? JSON.parse(detail.summary) : null;
              if (parsed?.key_facts?.length > 0) {
                displayText = parsed.key_facts.slice(0, 3).join(' · ');
              } else if (parsed) {
                displayText = null;
              }
            } catch {}
            return displayText ? (
              <div className="mt-2 pt-2 border-t border-white/[0.04] text-[10px] text-slate-500 leading-relaxed line-clamp-2">
                {displayText}
              </div>
            ) : null;
          })()}
          {detail.updatedAt && (
            <div className="text-[9px] text-slate-700 text-right">
              {new Date(detail.updatedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 분석
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// 봇 수익률 vs KOSPI 비교 차트
// ═══════════════════════════════════════

function PerformanceVsKospiPanel() {
  const [data, setData] = React.useState<{ bot: any[]; kospi: any[] } | null>(null);
  React.useEffect(() => {
    api('/market/performance-vs-kospi', { timeout: 15000 }).then(setData).catch(() => {});
  }, []);

  if (!data || (data.bot.length === 0 && data.kospi.length === 0)) return null;

  const allVals = [...data.bot.map(p => p.value), ...data.kospi.map(p => p.value)];
  const minV = Math.min(...allVals, 0);
  const maxV = Math.max(...allVals, 0);
  const range = maxV - minV || 1;
  const H = 80; const W = 300;

  const toY = (v: number) => H - ((v - minV) / range) * H;
  const botPath = data.bot.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / Math.max(data.bot.length - 1, 1)) * W},${toY(p.value)}`).join(' ');
  const kospiPath = data.kospi.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / Math.max(data.kospi.length - 1, 1)) * W},${toY(p.value)}`).join(' ');
  const zeroY = toY(0);
  const botLast = data.bot[data.bot.length - 1]?.value ?? 0;
  const kospiLast = data.kospi[data.kospi.length - 1]?.value ?? 0;

  return (
    <Panel title="봇 수익률 vs KOSPI">
      <div className="px-4 pb-3">
        <div className="flex items-center gap-4 mb-2 text-[11px]">
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-emerald-400 inline-block rounded" /> 봇 <span className={pc(botLast)}>{botLast > 0 ? '+' : ''}{botLast.toFixed(2)}%</span></span>
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-blue-400 inline-block rounded" /> KOSPI <span className={pc(kospiLast)}>{kospiLast > 0 ? '+' : ''}{kospiLast.toFixed(2)}%</span></span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 80 }}>
          <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="#334155" strokeWidth="0.5" strokeDasharray="4 2" />
          {kospiPath && <path d={kospiPath} fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />}
          {botPath && <path d={botPath} fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
        <div className="flex justify-between text-[9px] text-slate-600 mt-1">
          <span>{data.bot[0]?.date ?? data.kospi[0]?.date ?? ''}</span>
          <span>오늘</span>
        </div>
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// 세금 추정 패널
// ═══════════════════════════════════════

function TaxEstimatePanel() {
  const [data, setData] = React.useState<any>(null);
  React.useEffect(() => {
    api('/market/tax-estimate').then(setData).catch(() => {});
  }, []);
  if (!data) return null;
  return (
    <Panel title={`${data.year}년 세금 추정`}>
      <div className="px-4 pb-3 grid grid-cols-2 gap-2">
        <div className="bg-slate-800/40 rounded-xl p-3">
          <p className="text-[10px] text-slate-500 mb-1">거래세 (0.23%)</p>
          <p className="text-sm font-bold text-amber-400">{Math.round(data.transactionTax).toLocaleString()}원</p>
        </div>
        <div className="bg-slate-800/40 rounded-xl p-3">
          <p className="text-[10px] text-slate-500 mb-1">순실현손익</p>
          <p className={`text-sm font-bold ${pc(data.netGain)}`}>{data.netGain > 0 ? '+' : ''}{Math.round(data.netGain).toLocaleString()}원</p>
        </div>
        <div className="bg-slate-800/40 rounded-xl p-3">
          <p className="text-[10px] text-slate-500 mb-1">총 매도금액</p>
          <p className="text-sm font-bold text-slate-200">{Math.round(data.totalSellAmount / 10000).toLocaleString()}만원</p>
        </div>
        <div className="bg-emerald-950/30 border border-emerald-900/30 rounded-xl p-3">
          <p className="text-[10px] text-slate-500 mb-1">양도세 (소액주주)</p>
          <p className="text-sm font-bold text-emerald-400">비과세 ✓</p>
        </div>
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// 52주 신고가 스캐너
// ═══════════════════════════════════════

function HighScannerPanel() {
  const [items, setItems] = React.useState<any[]>([]);
  React.useEffect(() => {
    api('/market/52w-highs', { timeout: 30000 }).then((d: any) => setItems(d.items ?? [])).catch(() => {});
  }, []);
  const nearHigh = items.filter(it => it.isNearHigh);
  if (nearHigh.length === 0) return null;
  return (
    <Panel title="52주 신고가 근접" badge={`${nearHigh.length}종목`}>
      <div className="px-4 pb-3 space-y-2">
        {nearHigh.map((it: any) => (
          <div key={it.stock_code} className="flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-slate-200">{it.stock_name}</span>
              <span className="ml-2 text-[10px] text-slate-500">{it.current.toLocaleString()}원</span>
            </div>
            <div className="text-right">
              <span className="text-[10px] text-amber-400 font-bold">신고가 {it.high52w.toLocaleString()}원</span>
              <span className="ml-2 text-[10px] text-emerald-400">{it.dropFromHigh.toFixed(1)}%</span>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// 공매도 비율 패널
// ═══════════════════════════════════════

const SHORT_RISK: Record<string, { color: string; label: string }> = {
  HIGH:   { color: 'text-rose-400',   label: '위험' },
  MEDIUM: { color: 'text-amber-400',  label: '주의' },
  LOW:    { color: 'text-emerald-400',label: '안전' },
};
function ShortSellingPanel() {
  const [items, setItems] = React.useState<any[]>([]);
  React.useEffect(() => {
    api('/market/short-selling', { timeout: 20000 }).then((d: any) => setItems(d.items ?? [])).catch(() => {});
  }, []);
  if (items.length === 0) return null;
  return (
    <Panel title="보유종목 공매도 현황">
      <div className="px-4 pb-3 divide-y divide-slate-800/30">
        {items.map((it: any) => {
          const risk = SHORT_RISK[it.riskLevel] ?? SHORT_RISK.LOW;
          return (
            <div key={it.stock_code} className="flex items-center justify-between py-2">
              <div>
                <span className="text-xs font-semibold text-slate-200">{it.stock_name}</span>
                {it.isIncreasing && <span className="ml-2 text-[9px] bg-rose-900/40 text-rose-400 px-1.5 py-0.5 rounded">증가↑</span>}
              </div>
              <div className="flex items-center gap-3 text-right">
                <span className="text-[11px] text-slate-400">{it.shortRatio.toFixed(1)}%</span>
                <span className={`text-[11px] font-bold ${risk.color}`}>{risk.label}</span>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// 업종 히트맵
// ═══════════════════════════════════════

function SectorHeatmapPanel() {
  const [items, setItems] = React.useState<any[]>([]);
  React.useEffect(() => {
    api('/market/sector-heatmap', { timeout: 10000 }).then((d: any) => setItems(d.items ?? [])).catch(() => {});
  }, []);
  if (items.length === 0) return null;
  const maxAbs = Math.max(...items.map((it: any) => Math.abs(it.pct)), 0.1);
  return (
    <Panel title="업종 현황">
      <div className="px-3 pb-3 flex flex-wrap gap-1.5">
        {items.map((it: any, i: number) => {
          const intensity = Math.min(1, Math.abs(it.pct) / maxAbs);
          const bg = it.pct > 0
            ? `rgba(52,211,153,${0.08 + intensity * 0.25})`
            : it.pct < 0
              ? `rgba(248,113,113,${0.08 + intensity * 0.25})`
              : 'rgba(100,116,139,0.1)';
          return (
            <div key={i} className="rounded-lg px-2 py-1.5 text-center min-w-[72px]" style={{ background: bg }}>
              <p className="text-[10px] text-slate-300 truncate">{it.name}</p>
              <p className={`text-[11px] font-bold ${it.pct > 0 ? 'text-emerald-400' : it.pct < 0 ? 'text-rose-400' : 'text-slate-400'}`}>
                {it.pct > 0 ? '+' : ''}{it.pct.toFixed(2)}%
              </p>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// 포트폴리오 상관관계 경고
// ═══════════════════════════════════════

function CorrelationWarningPanel() {
  const [warnings, setWarnings] = React.useState<any[]>([]);
  React.useEffect(() => {
    api('/market/correlation').then((d: any) => setWarnings(d.warnings ?? [])).catch(() => {});
  }, []);
  if (warnings.length === 0) return null;
  return (
    <Panel title="섹터 쏠림 경고" badge={`${warnings.length}건`}>
      <div className="px-4 pb-3 space-y-2">
        {warnings.map((w: any) => (
          <div key={w.sector} className="flex items-start gap-2 bg-amber-950/20 border border-amber-900/30 rounded-xl px-3 py-2">
            <span className="text-amber-400 text-sm">⚠</span>
            <div>
              <p className="text-xs font-bold text-amber-300">{w.sector} {w.count}종목 동시 보유</p>
              <p className="text-[10px] text-slate-500">{w.stocks.join(', ')}</p>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// 외국인/기관 순매매 패널
// ═══════════════════════════════════════

const TREND_META: Record<string, { label: string; color: string }> = {
  STRONG_BUY: { label: '강매수', color: 'text-emerald-400' },
  BUY:        { label: '매수',   color: 'text-emerald-300' },
  NEUTRAL:    { label: '중립',   color: 'text-slate-400' },
  SELL:       { label: '매도',   color: 'text-rose-300' },
  STRONG_SELL:{ label: '강매도', color: 'text-rose-400' },
};

function InvestorFlowPanel() {
  const [items, setItems] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    api('/market/investor-flow', { timeout: 30000 })
      .then((d: any) => setItems(d.items ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const top = items.filter((it) => it.trend === 'STRONG_BUY' || it.trend === 'BUY').slice(0, 5);
  const warn = items.filter((it) => it.trend === 'STRONG_SELL' || it.trend === 'SELL').slice(0, 3);

  return (
    <Panel title="외국인·기관 수급" badge={items.length > 0 ? `${items.length}종목` : undefined}>
      {loading ? (
        <div className="px-4 py-6 text-center text-xs text-slate-500 animate-pulse">수급 데이터 불러오는 중…</div>
      ) : items.length === 0 ? (
        <div className="px-4 py-4 text-center text-xs text-slate-500">감시종목이 없거나 장중에만 조회 가능</div>
      ) : (
        <div className="divide-y divide-slate-800/30">
          {top.length > 0 && (
            <div className="px-4 py-2">
              <p className="text-[10px] text-slate-500 mb-2 font-semibold tracking-wide uppercase">순매수 우위</p>
              <div className="space-y-2">
                {top.map((it) => {
                  const meta = TREND_META[it.trend] ?? TREND_META.NEUTRAL;
                  const streak = it.foreignStreak;
                  return (
                    <div key={it.stock_code} className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-semibold text-slate-200 truncate">{it.stock_name}</span>
                        {streak !== 0 && (
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${streak > 0 ? 'bg-emerald-900/40 text-emerald-400' : 'bg-rose-900/40 text-rose-400'}`}>
                            외국인 {streak > 0 ? '+' : ''}{streak}일
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 shrink-0 text-right">
                        <div className="text-[10px] text-slate-500">
                          <span>외 {it.foreignNet > 0 ? '+' : ''}{it.foreignNet.toLocaleString()}</span>
                          <span className="mx-1 text-slate-700">|</span>
                          <span>기 {it.institutionNet > 0 ? '+' : ''}{it.institutionNet.toLocaleString()}</span>
                        </div>
                        <span className={`text-[11px] font-bold ${meta.color}`}>{meta.label}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {warn.length > 0 && (
            <div className="px-4 py-2">
              <p className="text-[10px] text-rose-500 mb-2 font-semibold tracking-wide uppercase">순매도 주의</p>
              <div className="space-y-2">
                {warn.map((it) => {
                  const meta = TREND_META[it.trend] ?? TREND_META.NEUTRAL;
                  return (
                    <div key={it.stock_code} className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-400 truncate">{it.stock_name}</span>
                      <div className="flex items-center gap-3 shrink-0 text-right">
                        <div className="text-[10px] text-slate-500">
                          <span>외 {it.foreignNet > 0 ? '+' : ''}{it.foreignNet.toLocaleString()}</span>
                          <span className="mx-1 text-slate-700">|</span>
                          <span>기 {it.institutionNet > 0 ? '+' : ''}{it.institutionNet.toLocaleString()}</span>
                        </div>
                        <span className={`text-[11px] font-bold ${meta.color}`}>{meta.label}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

// ═══════════════════════════════════════
// 머니 통계 패널 (누적수익 + 월별 막대 + 목표 게이지)
// ═══════════════════════════════════════

function MoneyStatsPanel({ market, monthlyGoal }: { market: 'KR' | 'US'; monthlyGoal?: number }) {
  const [data, setData] = React.useState<{
    totalCumulative: number;
    thisMonthPnl: number;
    monthly: Array<{ month: string; pnl: number; trades: number }>;
    dinnerMoney?: { monthlyTotal: number; monthlyCap: number; todayReserved: boolean } | null;
  } | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    setLoading(true);
    api(`/profit-stats?market=${market}`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [market]);

  if (loading) return <div className="glass rounded-2xl border border-white/[0.04] px-4 py-4 text-center text-xs text-slate-600 animate-pulse">수익 통계 불러오는 중...</div>;
  if (!data) return null;

  const isKr = market === 'KR';
  const fmt2 = (n: number) => isKr
    ? (n >= 0 ? '+' : '') + Math.round(n).toLocaleString('ko-KR') + '원'
    : (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0);
  const fmtShort = (n: number) => {
    const abs = Math.abs(n);
    const sign = n >= 0 ? '+' : '-';
    if (isKr) {
      if (abs >= 10000000) return sign + Math.round(abs / 10000000) + '천만';
      if (abs >= 1000000) return sign + (abs / 1000000).toFixed(1) + '백만';
      if (abs >= 10000) return sign + Math.round(abs / 10000) + '만';
      return sign + Math.round(abs).toLocaleString('ko-KR');
    }
    return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0);
  };

  // 최근 6개월만
  const months = data.monthly.slice(-6);
  const maxAbs = Math.max(...months.map((m) => Math.abs(m.pnl)), 1);

  // 이번달 목표 달성률 (기본: 100만원 KR / $500 US)
  const goal = monthlyGoal ?? (isKr ? 1000000 : 500);
  const goalPct = Math.min(100, Math.max(0, (data.thisMonthPnl / goal) * 100));
  const goalReached = data.thisMonthPnl >= goal;

  // 원형 게이지 SVG
  const r = 28, cx = 36, cy = 36, circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - goalPct / 100);
  const gaugeColor = goalReached ? '#34d399' : goalPct > 60 ? '#60a5fa' : goalPct > 30 ? '#fbbf24' : '#94a3b8';

  return (
    <div className="glass rounded-2xl border border-white/[0.04] px-4 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-400">💰 수익 현황 {isKr ? '🇰🇷' : '🇺🇸'}</span>
      </div>

      {/* 누적 총수익 + 이번달 목표 게이지 */}
      <div className="flex items-center gap-4">
        {/* 누적 */}
        <div className="flex-1">
          <div className="text-[10px] text-slate-500 mb-0.5">봇 시작부터 누적</div>
          <div className={`text-2xl font-black tabular-nums ${data.totalCumulative >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {fmt2(data.totalCumulative)}
          </div>
          <div className="text-[10px] text-slate-500 mt-1">이번달 <span className={`font-bold ${data.thisMonthPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmt2(data.thisMonthPnl)}</span></div>
        </div>
        {/* 목표 게이지 */}
        <div className="flex flex-col items-center shrink-0">
          <svg width="72" height="72" viewBox="0 0 72 72">
            <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="7" />
            <circle cx={cx} cy={cy} r={r} fill="none" stroke={gaugeColor} strokeWidth="7"
              strokeDasharray={circumference} strokeDashoffset={dashOffset}
              strokeLinecap="round" transform={`rotate(-90 ${cx} ${cy})`}
              style={{ transition: 'stroke-dashoffset 0.8s ease' }} />
            <text x={cx} y={cy - 4} textAnchor="middle" fill={gaugeColor} fontSize="11" fontWeight="800">{Math.round(goalPct)}%</text>
            <text x={cx} y={cy + 8} textAnchor="middle" fill="#64748b" fontSize="7">이달목표</text>
          </svg>
          <div className="text-[9px] text-slate-600 mt-0.5">목표 {isKr ? (goal / 10000).toLocaleString('ko-KR') + '만원' : '$' + goal}</div>
        </div>
      </div>

      {/* 월별 막대 차트 */}
      {months.length > 0 && (
        <div>
          <div className="text-[10px] text-slate-500 mb-2">최근 {months.length}개월</div>
          <div className="flex items-end gap-1 h-16">
            {months.map((m) => {
              const pct = (Math.abs(m.pnl) / maxAbs) * 100;
              const isPos = m.pnl >= 0;
              const label = m.month.slice(5); // MM
              return (
                <div key={m.month} className="flex-1 flex flex-col items-center gap-0.5 group relative">
                  <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-slate-800 border border-white/10 rounded px-1.5 py-0.5 text-[9px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none">
                    {fmtShort(m.pnl)} ({m.trades}건)
                  </div>
                  <div className="w-full flex flex-col justify-end" style={{ height: '52px' }}>
                    <div
                      className={`w-full rounded-t-sm transition-all duration-500 ${isPos ? 'bg-emerald-500/70' : 'bg-rose-500/70'}`}
                      style={{ height: `${Math.max(pct, 4)}%` }}
                    />
                  </div>
                  <div className="text-[9px] text-slate-600">{label}월</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 저녁 용돈 적립 현황 (국내주식 KR만) */}
      {isKr && data.dinnerMoney && (
        <div className="border-t border-white/[0.04] pt-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] text-slate-400">🍚 저녁용돈 적립</span>
            <span className="text-[10px] text-slate-500">
              {data.dinnerMoney.monthlyTotal.toLocaleString('ko-KR')}원 / 30만원
              {data.dinnerMoney.todayReserved && <span className="ml-1 text-emerald-400">✓ 오늘 적립됨</span>}
            </span>
          </div>
          <div className="w-full h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${Math.min(100, (data.dinnerMoney.monthlyTotal / data.dinnerMoney.monthlyCap) * 100)}%`,
                background: data.dinnerMoney.monthlyTotal >= data.dinnerMoney.monthlyCap
                  ? '#34d399'
                  : 'linear-gradient(90deg, #f59e0b, #fbbf24)',
              }}
            />
          </div>
          <div className="text-[9px] text-slate-600 mt-1">수익 1만원↑ 되는 날 자동 적립 · 월 30만원 한도</div>
        </div>
      )}
    </div>
  );
}

// HOME VIEW
// ═══════════════════════════════════════

function HomeView({ dash, health, killSwitch, trades, usDash, withdrawConfig, watchlist, strategy, setStrategy, toast, onRefresh }: any) {
  const [showPortfolio, setShowPortfolio] = React.useState(false);
  const [holdingsTab, setHoldingsTab] = React.useState<'KR' | 'US'>('KR');
  const [userPickedTab, setUserPickedTab] = React.useState(false); // 사용자가 직접 탭 변경했는지
  const [usInsights, setUsInsights] = React.useState('');
  const [insightsDraft, setInsightsDraft] = React.useState('');
  const [insightsSaving, setInsightsSaving] = React.useState(false);
  const [tradingStatus, setTradingStatus] = React.useState<any>(null);
  const [aiStatus, setAiStatus] = React.useState<any>(null);
  const [runningTrackB, setRunningTrackB] = React.useState(false);
  const [runningTrackA, setRunningTrackA] = React.useState(false);
  const [privacyMode, setPrivacyMode] = React.useState(false);
  React.useEffect(() => {
    api('/overseas/insights').then((r: any) => {
      if (r?.insights != null) { setUsInsights(r.insights); setInsightsDraft(r.insights); }
    }).catch(() => {});
    api('/trading-status').then((r: any) => setTradingStatus(r)).catch(() => {});
    api('/ai-status').then((r: any) => setAiStatus(r)).catch(() => {});
  }, []);
  // 미국장 열리면 자동으로 US 탭으로 전환 (사용자가 직접 변경하지 않은 경우만)
  React.useEffect(() => {
    if (!userPickedTab) {
      setHoldingsTab(health?.usMarketOpen ? 'US' : 'KR');
    }
  }, [health?.usMarketOpen, userPickedTab]);
  const p = dash?.portfolio;
  const os = dash?.overseas; // 해외 보유 데이터
  const stockNameMap = new Map((watchlist ?? []).map((w: any) => [w.stock_code, w.stock_name]));
  const getStockName = (code: string): string => {
    return toDisplayName(stockNameMap.get(code), code);
  };
  const chains = dash?.chains || [];
  const usW = usDash?.watchlist || [];
  const usHoldings = usDash?.holdings || (dash?.overseas?.holdings ?? []); // 해외 보유종목 (usDash 미로드시 main dash 폴백)
  // 국내+해외 체결 모두 포함 (시간 역순) — PENDING 해외주문도 포함
  const filled = trades.filter((t: any) => t.status === 'FILLED' || (t.status === 'PENDING' && t.trigger_source === 'OVERSEAS'))
    .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const todayTrades = filled.filter((t: any) => new Date(t.created_at).toDateString() === new Date().toDateString());

  // API에서 내려오는 손익 분리 값 사용
  // unrealizedPnl: p.pnl로 폴백 금지 — pnl은 실현+미실현 합산이라 미실현 전용 카드에 사용하면 안 됨
  const unrealizedPnl = p?.unrealizedPnl ?? 0;             // 국내 미실현손익만
  const realizedPnl   = p?.realizedPnl ?? 0;               // 실현손익 (매도 완료분)
  const totalPnl      = p?.pnl ?? 0;                       // 국내 미실현+실현 합산
  const totalPnlPct   = p?.pnlPct ?? 0;
  const domesticInvested = p?.domesticInvested ?? 0;       // 국내 투자 원금
  const totalInvested    = p?.invested ?? domesticInvested; // 국내+해외 투자 원금
  const overseasInvestedUsd = os?.totalInvestedUsd ?? 0;
  const overseasInvestedKrw = os?.totalInvestedKrw ?? 0;
  const overseasCashUsd = os?.cashUsd ?? 0;
  const overseasCashKrw = os?.cashKrw ?? (overseasCashUsd * (os?.fxRate ?? 1380));
  const fxRate = os?.fxRate ?? 1380;
  const dailyLossLimit = dash?.riskLimits?.maxDailyDrawdownKrw ?? 200000;
  const totalValue = Number(p?.totalValue ?? 0);
  const domesticCash = Number(p?.cash ?? 0);
  const pctClamp = (v: number) => Math.max(0, Math.min(100, v));
  const investedPct = totalValue > 0 ? Math.round((totalInvested / totalValue) * 100) : 0;
  // 포트폴리오 비중 바 차트용 — totalValue는 이미 국내+해외 합산 grandTotalValue
  const investedPctExact = totalValue > 0 ? ((domesticInvested + overseasInvestedKrw) / totalValue) * 100 : 0;
  const cashPctExact = totalValue > 0 ? (domesticCash / totalValue) * 100 : 0;
  const overseasCashPctExact = totalValue > 0 ? (overseasCashKrw / totalValue) * 100 : 0;

  // 통합 미실현 손익 — 국내(미실현만) + 해외 미실현 합산
  const overseasPnlUsd = usHoldings.reduce((sum: number, h: any) => {
    const priceData = usW.find((s: any) => s.code === h.stock_code);
    const curPrice = priceData?.price ?? 0;
    if (curPrice <= 0 || h.avg_price <= 0) return sum;
    return sum + (curPrice - h.avg_price) * h.quantity;
  }, 0);
  const overseasPnlKrw = Math.round(overseasPnlUsd * fxRate);
  // 탭 기반 손익 표시 — 국내 탭이면 국내, 해외 탭이면 해외
  const showOnlyKr = holdingsTab === 'KR';
  const showOnlyUs = holdingsTab === 'US';
  const combinedPnl = showOnlyKr
    ? unrealizedPnl
    : (usHoldings.length > 0 ? overseasPnlKrw : 0);
  const combinedInvested = showOnlyKr
    ? (domesticInvested > 0 ? domesticInvested : 0)
    : (overseasInvestedKrw > 0 ? overseasInvestedKrw : 0);
  const combinedPnlPct = combinedInvested > 0 ? (combinedPnl / combinedInvested) * 100 : (domesticInvested > 0 ? totalPnlPct : 0);
  const hasOverseasHoldings = usHoldings.length > 0;

  // 탭별 금일 손익 = 오늘 매도한 종목 기준 실현손익만 표시 (미실현 제외)
  const todayStr = new Date().toDateString();
  // 해외(OVERSEAS) 제외: usTodaySells와 중복 집계 방지
  const krTodaySells = todayTrades.filter((t: any) => t.side === 'SELL' && t.trigger_source !== 'OVERSEAS');
  const krRealizedPnl = krTodaySells.reduce((sum: number, t: any) => {
    if (t.realized_pnl != null) return sum + Number(t.realized_pnl);
    const avgBuy = Number(t.transaction_chains?.avg_buy_price) || 0;
    const filledPx = Number(t.filled_price) || 0;
    const qty = Number(t.filled_quantity ?? t.quantity) || 0;
    if (avgBuy <= 0 || filledPx <= 0 || qty <= 0) return sum;
    const grossPnl = (filledPx - avgBuy) * qty;
    const buyFee = Math.round(avgBuy * qty * 0.00015);
    const sellFee = Math.round(filledPx * qty * 0.00245);
    return sum + grossPnl - buyFee - sellFee;
  }, 0);
  const krTabPnl = krRealizedPnl; // 매도 실현손익만
  const krTabHasData = krTodaySells.length > 0;
  const krSellsCostBasis = krTodaySells.reduce((sum: number, t: any) => {
    const avgBuy = Number(t.transaction_chains?.avg_buy_price) || 0;
    const qty = Number(t.filled_quantity ?? t.quantity) || 0;
    return avgBuy > 0 ? sum + avgBuy * qty : sum;
  }, 0);
  const krTabPct = krSellsCostBasis > 0 ? (krTabPnl / krSellsCostBasis) * 100 : null;

  const usTodaySells = trades.filter((t: any) =>
    t.status === 'FILLED' && t.side === 'SELL' && t.trigger_source === 'OVERSEAS' &&
    new Date(t.created_at).toDateString() === todayStr
  );
  const usTabPnlUsd = usTodaySells.reduce((sum: number, t: any) => {
    // overseas orders have chain_id=null so transaction_chains is always null.
    // avg_buy_price is encoded in ai_reasoning as "[avgBuy:123.4567] ..."
    const reasoningMatch = String(t.ai_reasoning ?? '').match(/\[avgBuy:([\d.]+)\]/);
    const avgBuy = reasoningMatch ? Number(reasoningMatch[1]) : (Number(t.transaction_chains?.avg_buy_price) || 0);
    const filledPx = Number(t.filled_price) || 0;
    const qty = Number(t.quantity) || 0;
    return avgBuy > 0 && filledPx > 0 ? sum + (filledPx - avgBuy) * qty : sum;
  }, 0);
  const usTabPnlKrw = Math.round(usTabPnlUsd * fxRate);

  // 로봇 일과 타임라인 계산
  const now = new Date();
  const marketStart = 9 * 60; // 09:00
  const marketEnd = 15 * 60 + 30; // 15:30
  const currentMin = now.getHours() * 60 + now.getMinutes();
  const marketProgress = health?.marketOpen ? Math.min(100, Math.max(0, ((currentMin - marketStart) / (marketEnd - marketStart)) * 100)) : 0;
  const usMarketProgress = (() => {
    const h = now.getHours(); const m = now.getMinutes();
    const cur = h * 60 + m;
    const adj = cur < 6 * 60 ? cur + 24 * 60 : cur;
    return Math.min(100, Math.max(0, ((adj - (23 * 60 + 30)) / (6 * 60 + 24 * 60 - (23 * 60 + 30))) * 100));
  })();
  const currentTimeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;

  const defensePark = dash?.defensePark;

  // ── 롤업 애니메이션 값 ──
  const animCombined = useCountUp(combinedPnl);
  const todayRealizedPnl = krTabPnl + usTabPnlKrw;
  const animToday = useCountUp(todayRealizedPnl);
  const animTotal = useCountUp(totalValue);

  return (
    <div className="space-y-4 sm:space-y-5">


      {/* ── 매매 상태 배너 ── */}
      {tradingStatus && tradingStatus.overallStatus !== 'ACTIVE' && (
        <div className={`rounded-2xl border px-4 py-3 ${
          tradingStatus.overallStatus === 'BLOCKED'
            ? 'border-rose-500/40 bg-rose-500/10'
            : 'border-amber-500/30 bg-amber-500/[0.07]'
        }`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-2">
            <span className="text-base shrink-0">{tradingStatus.overallStatus === 'BLOCKED' ? '🚫' : '👀'}</span>
            <span className={`text-sm font-bold whitespace-nowrap ${tradingStatus.overallStatus === 'BLOCKED' ? 'text-rose-300' : 'text-amber-300'}`}>
              {tradingStatus.overallStatus === 'BLOCKED' ? '매수 완전 차단 중' : '관망 중'}
            </span>
            <span className="text-[10px] text-slate-500 ml-auto whitespace-nowrap">{tradingStatus.mode} · {tradingStatus.buyThreshold}점</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {(tradingStatus.blocks ?? []).map((b: any, i: number) => (
              <div key={i} className={`flex items-center gap-1.5 text-[11px] rounded-lg px-2.5 py-1 ${
                b.severity === 'warn' ? 'bg-amber-500/15 text-amber-300' : 'bg-white/[0.04] text-slate-400'
              }`}>
                <span className="font-semibold">{b.reason}</span>
                <span className="text-[10px] opacity-70">— {b.detail}</span>
              </div>
            ))}
          </div>
          {tradingStatus.topScore > 0 && (
            <div className="mt-2 text-[10px] text-slate-500">
              감시종목 최고점수 <b className="text-slate-300">{tradingStatus.topScore}점</b> / 기준 <b className="text-slate-300">{tradingStatus.buyThreshold}점</b>
              {tradingStatus.candidateCount > 0 && <span className="ml-2 text-emerald-400">→ {tradingStatus.candidateCount}종목 후보 있음</span>}
            </div>
          )}
        </div>
      )}
      {tradingStatus && tradingStatus.overallStatus === 'ACTIVE' && (
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-2.5 flex flex-wrap items-center gap-x-2 gap-y-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <span className="text-xs font-semibold text-emerald-300 whitespace-nowrap">자동매매 정상 운영 중</span>
          {tradingStatus.candidateCount > 0 && (
            <span className="text-xs text-emerald-400/70">— {tradingStatus.candidateCount}종목 대기</span>
          )}
          <span className="text-[10px] text-slate-500 whitespace-nowrap">{tradingStatus.mode} · {tradingStatus.buyThreshold}점</span>
        </div>
      )}

      {/* ── 방어 파킹 배너 ── */}
      {defensePark?.isActive && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex items-start gap-3">
          <span className="text-xl shrink-0">🛡️</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-300">방어 파킹 중 — {defensePark.parkStockName} 보유</p>
            <p className="text-xs text-amber-400/80 mt-0.5 truncate">진입 사유: {defensePark.entryReason ?? '하락세 감지'}</p>
            <p className="text-xs text-amber-400/60 mt-0.5">시장 회복 감지 시 자동으로 정상 매매 복귀합니다.</p>
          </div>
          <button
            onClick={async () => {
              if (!confirm('파킹 강제 해제 + 보유 ETF 즉시 매도를 실행할까요?')) return;
              try {
                const r = await api('/release-defense-park', { method: 'POST' });
                alert(r?.message ?? '파킹 해제 완료');
                onRefresh();
              } catch (e: any) { alert('실패: ' + (e as any).message); }
            }}
            className="px-3 py-1.5 text-xs rounded-xl bg-amber-500/30 hover:bg-amber-500/50 text-amber-200 font-semibold transition-colors whitespace-nowrap shrink-0"
          >강제 해제</button>
        </div>
      )}

      {/* ── AI 엔진 상태 배너 (크레딧/쿼터/오류 시 표시) ── */}
      {aiStatus && (aiStatus.claude === 'no_credit' || aiStatus.claude === 'error' || aiStatus.gemini === 'quota' || aiStatus.gemini === 'error') && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.07] px-4 py-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm">⚠️</span>
            <span className="text-xs font-bold text-amber-300">AI 엔진 경고 — 안정 모드로 운영 중 (신규 매수 중단)</span>
            {aiStatus.claude === 'no_credit' && (
              <span className="text-[11px] bg-rose-500/20 text-rose-300 rounded px-2 py-0.5">Claude 크레딧 소진</span>
            )}
            {aiStatus.claude === 'error' && (
              <span className="text-[11px] bg-amber-500/20 text-amber-300 rounded px-2 py-0.5">Claude 오류</span>
            )}
            {aiStatus.gemini === 'quota' && (
              <span className="text-[11px] bg-amber-500/20 text-amber-300 rounded px-2 py-0.5">Gemini 무료 한도 초과 — 30분 후 자동 재시도</span>
            )}
            {aiStatus.gemini === 'error' && (
              <span className="text-[11px] bg-amber-500/20 text-amber-300 rounded px-2 py-0.5">Gemini 오류 — 30분 후 자동 재시도</span>
            )}
            <span className="ml-auto text-[10px] text-slate-500">
              {aiStatus.activeEngine === 'technical' ? '기술 지표 모드' : aiStatus.activeEngine === 'none' ? '매매 대기' : ''}
            </span>
          </div>
        </div>
      )}

      {/* ── 상태 한 줄 바 (손실 한도 + 장 진행도 통합) ── */}
      <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* 장 상태 표시 */}
        {health?.marketOpen ? (
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[11px] text-slate-400">한국장 {currentTimeStr}</span>
          </div>
        ) : health?.usMarketOpen ? (
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-[11px] text-blue-400">🇺🇸 미국장중 {currentTimeStr}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-2 h-2 rounded-full bg-slate-600" />
            <span className="text-[11px] text-slate-500">장 외 — 미국장 대기중</span>
          </div>
        )}
        {/* 장 진행 바 — 한국장중에만 표시, 미국장중엔 미국 시간 표시 */}
        <div className="flex-1 relative">
          {health?.marketOpen ? (
            <>
              <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full transition-all duration-1000" style={{ width: `${marketProgress}%` }} />
              </div>
              <div className="flex justify-between mt-0.5 text-[9px] text-slate-600">
                <span>09:00</span><span>15:30</span>
              </div>
            </>
          ) : health?.usMarketOpen ? (
            <>
              <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-blue-600 to-indigo-500 rounded-full transition-all duration-1000" style={{ width: `${usMarketProgress}%` }} />
              </div>
              <div className="flex justify-between mt-0.5 text-[9px] text-slate-600">
                <span>23:30</span><span>06:00</span>
              </div>
            </>
          ) : (
            <div className="text-[9px] text-slate-700 text-center">한국장 09:00 · 미국장 23:30</div>
          )}
        </div>
        {/* 손실 한도 */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-slate-500">손실 한도</span>
          <div className={`text-[11px] font-bold ${totalPnl < -(dailyLossLimit * 0.6) ? 'text-rose-400' : totalPnl < 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
            {totalPnl < 0
              ? `${Math.min(100, Math.round((Math.abs(totalPnl) / dailyLossLimit) * 100))}% (${fmtWon(Math.abs(totalPnl))}/${fmtWon(dailyLossLimit)} · 총자산 30%)`
              : `0% / ${fmtWon(dailyLossLimit)} (총자산 30%)`}
          </div>
        </div>
      </div>

      {/* ── 토스형 Hero 손익 카드 ── */}
      {(() => {
        const domesticTotal = domesticCash + domesticInvested;
        const domesticPct = domesticTotal > 0 ? Math.round((domesticInvested / domesticTotal) * 100) : 0;
        const mask = (v: string) => privacyMode ? '••••••' : v;
        return (
          <div className={`rounded-2xl border p-5 ${combinedPnl > 0 ? 'bg-gradient-to-br from-emerald-950/60 via-emerald-900/20 to-transparent border-emerald-500/20' : combinedPnl < 0 ? 'bg-gradient-to-br from-rose-950/60 via-rose-900/20 to-transparent border-rose-500/20' : 'glass border-white/[0.06]'}`}>
            {/* 상단 헤더 */}
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-semibold text-slate-400 tracking-wide">미실현 손익{showOnlyKr ? ' 🇰🇷 국내' : showOnlyUs ? ' 🇺🇸 해외' : hasOverseasHoldings ? ' (국내+해외)' : ''}</span>
              <button onClick={() => setPrivacyMode(v => !v)} className="text-slate-500 hover:text-slate-300 transition-colors p-1 -m-1 rounded-lg">
                {privacyMode ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                )}
              </button>
            </div>
            {/* 메인 수치 */}
            <div className="flex items-end gap-4 mb-5">
              <div className="flex-1">
                {showOnlyUs ? (
                  <>
                    <div className={`text-4xl sm:text-5xl font-black tracking-tight tabular-nums ${pc(overseasPnlUsd)}`}>
                      {privacyMode ? '••••••' : `${overseasPnlUsd > 0 ? '+' : ''}$${Math.round(overseasPnlUsd).toLocaleString('en-US')}`}
                    </div>
                    <div className={`text-sm font-bold mt-1 ${pc(overseasPnlUsd)}`}>
                      {overseasInvestedUsd > 0 ? `${((overseasPnlUsd / overseasInvestedUsd) * 100) > 0 ? '+' : ''}${((overseasPnlUsd / overseasInvestedUsd) * 100).toFixed(2)}%` : '0.00%'}
                    </div>
                  </>
                ) : (
                  <>
                    <div className={`text-4xl sm:text-5xl font-black tracking-tight tabular-nums ${pc(combinedPnl)}`}>
                      {privacyMode ? '••••••원' : `${combinedPnl > 0 ? '+' : ''}${Math.round(animCombined).toLocaleString('ko-KR')}원`}
                    </div>
                    <div className={`text-sm font-bold mt-1 ${pc(combinedPnl)}`}>
                      {combinedPnlPct !== 0 ? `${combinedPnlPct > 0 ? '+' : ''}${combinedPnlPct.toFixed(2)}%` : '0.00%'}
                    </div>
                  </>
                )}
              </div>
              {(krTabHasData || usTodaySells.length > 0) && (
                <div className="text-right shrink-0 border-l border-white/[0.06] pl-4">
                  <div className="text-[10px] text-slate-500 mb-0.5">오늘 실현</div>
                  <div className={`text-xl font-black tabular-nums ${pc(showOnlyUs ? usTabPnlUsd : todayRealizedPnl)}`}>
                    {privacyMode ? '••••' : showOnlyUs
                      ? `${usTabPnlUsd > 0 ? '+' : ''}$${Math.round(usTabPnlUsd).toLocaleString('en-US')}`
                      : `${todayRealizedPnl > 0 ? '+' : ''}${Math.round(animToday).toLocaleString('ko-KR')}원`}
                  </div>
                </div>
              )}
            </div>
            {/* 미니 스탯 3개 */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-white/[0.04] rounded-xl px-3 py-2">
                <div className="text-[9px] text-slate-500 mb-0.5">{showOnlyUs ? '해외현금' : '현금잔고'}</div>
                {showOnlyUs ? (
                  <div className="text-sm font-bold text-slate-200 tabular-nums truncate">{mask('$' + Math.round(overseasCashUsd).toLocaleString('en-US'))}</div>
                ) : (
                  <div className="text-sm font-bold text-slate-200 tabular-nums truncate">{mask(Math.round(domesticCash / 10000).toLocaleString('ko-KR') + '만원')}</div>
                )}
              </div>
              <div className="bg-white/[0.04] rounded-xl px-3 py-2">
                <div className="text-[9px] text-slate-500 mb-0.5">투자비중</div>
                {showOnlyUs ? (() => {
                  const usTotalUsd = overseasInvestedUsd + overseasCashUsd;
                  const usPct = usTotalUsd > 0 ? Math.round((overseasInvestedUsd / usTotalUsd) * 100) : 0;
                  return <div className={`text-sm font-bold tabular-nums ${usPct > 60 ? 'text-amber-400' : 'text-blue-400'}`}>{usPct}% <span className="text-[9px] text-slate-600">({usHoldings.length}종목)</span></div>;
                })() : (
                  <div className={`text-sm font-bold tabular-nums ${domesticPct > 60 ? 'text-amber-400' : 'text-blue-400'}`}>{domesticPct}% <span className="text-[9px] text-slate-600">({chains.length}종목)</span></div>
                )}
              </div>
              <div className="bg-white/[0.04] rounded-xl px-3 py-2">
                <div className="text-[9px] text-slate-500 mb-0.5">{showOnlyUs ? '오늘미국' : withdrawConfig?.totalReserved > 0 ? '인출예약' : '오늘매매'}</div>
                {showOnlyUs ? (
                  <div className={`text-sm font-bold tabular-nums ${usTodaySells.length > 0 ? pc(usTabPnlUsd) : 'text-slate-200'}`}>{usTodaySells.length > 0 ? `${usTabPnlUsd > 0 ? '+' : ''}$${usTabPnlUsd.toFixed(0)}` : `${usTodaySells.length}건`}</div>
                ) : withdrawConfig?.totalReserved > 0 ? (
                  <div className="text-sm font-bold text-amber-400 truncate">{mask(fmtWon(withdrawConfig.totalReserved))}</div>
                ) : (
                  <div className="text-sm font-bold text-slate-200">{todayTrades.length}<span className="text-[9px] text-slate-500 ml-0.5">건</span></div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── 머니 통계 (누적수익 + 월별 막대 + 목표 게이지) ── */}
      <MoneyStatsPanel market={holdingsTab} />

      {/* ── 리스크 게이지 + 전략 이력 ── */}
      {(() => {
        const dailyLossPct = totalPnl < 0 ? Math.min(100, Math.round((Math.abs(totalPnl) / dailyLossLimit) * 100)) : 0;
        const maxInvested = chains.reduce((mx: number, ch: any) => Math.max(mx, Number(ch.invested) || 0), 0);
        const concPct = totalInvested > 0 ? Math.round((maxInvested / totalInvested) * 100) : 0;
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <RiskGaugePanel investedPct={investedPct} dailyLossPct={dailyLossPct} concentrationPct={concPct} />
            <StrategyTimelinePanel strategy={strategy} />
          </div>
        );
      })()}

      {/* ── 보유종목 (국내/해외 탭) ── */}
      <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden">
        {/* 탭 헤더 */}
        <div className="flex items-center border-b border-white/[0.04]">
          <button onClick={() => { setHoldingsTab('KR'); setUserPickedTab(true); }}
            className={`flex-1 py-3 px-4 text-sm font-bold transition-all relative ${holdingsTab === 'KR' ? 'text-slate-100' : 'text-slate-500 hover:text-slate-400'}`}>
            {holdingsTab === 'KR' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />}
            <span className="flex items-center justify-center gap-1.5 flex-wrap">
              국내주식 {chains.length > 0 && <span className="text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full">{chains.length}</span>}
              {krTabHasData && <span className={`text-[10px] font-semibold ${krTabPnl > 0 ? 'text-emerald-400' : krTabPnl < 0 ? 'text-rose-400' : 'text-slate-500'}`}>{krTabPnl > 0 ? '+' : ''}{Math.round(krTabPnl).toLocaleString('ko-KR')}원{krTabPct != null ? ` (${krTabPct > 0 ? '+' : ''}${krTabPct.toFixed(2)}%)` : ''}</span>}
            </span>
          </button>
          <button onClick={() => { setHoldingsTab('US'); setUserPickedTab(true); }}
            className={`flex-1 py-3 px-4 text-sm font-bold transition-all relative ${holdingsTab === 'US' ? 'text-slate-100' : 'text-slate-500 hover:text-slate-400'}`}>
            {holdingsTab === 'US' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />}
            <span className="flex items-center justify-center gap-1.5 flex-wrap">
              해외주식 {usHoldings.length > 0 && <span className="text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full">{usHoldings.length}</span>}
              {usTodaySells.length > 0 && <span className={`text-[10px] font-semibold ${usTabPnlUsd > 0 ? 'text-emerald-400' : usTabPnlUsd < 0 ? 'text-rose-400' : 'text-slate-500'}`}>{usTabPnlUsd > 0 ? '+' : ''}${usTabPnlUsd.toFixed(2)} (₩{usTabPnlKrw > 0 ? '+' : ''}{usTabPnlKrw.toLocaleString('ko-KR')})</span>}
            </span>
          </button>
        </div>

        {/* 국내 탭 */}
        {holdingsTab === 'KR' && (
          chains.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-white/[0.03]">

              {chains.map((ch: any, i: number) => {
                const avgPrice = Number(ch.avg_buy_price) || 0;
                const qty = Number(ch.total_quantity) || 0;
                const invested = Number(ch.invested) || avgPrice * qty;
                const curAvg = Number(ch.current_averaging_count) || 0;
                const maxAvg = Number(ch.max_averaging_count) || 1;
                const STRATEGY_TP_SL: Record<string, [number, number]> = {
                  SWING: [3.5, -2.5], DEFENSE: [5.0, -2.0], SCALPING: [1.2, -0.6], DIVIDEND: [10, -5],
                };
                const [modeTp, modeSl] = STRATEGY_TP_SL[ch.strategy_mode as string] ?? [4.0, -2.5];
                const targetPct = Number(ch.target_profit_pct) || modeTp;
                const stopPct = Number(ch.stop_loss_pct) || modeSl;
                const pnl = ch.unrealizedPnl ?? 0;
                const pnlPct = ch.unrealizedPnlPct ?? 0;
                const resolvedName = toDisplayName(ch.stock_name, ch.stock_code);
                const displayName = isUnresolvedStockName(resolvedName, ch.stock_code)
                  ? getStockName(ch.stock_code)
                  : resolvedName;
                const isParking = ch.isParking === true;
                const weight = typeof ch.weight === 'number' ? ch.weight : null;

                /* ── 파킹 ETF 카드 ── */
                if (isParking) return (
                  <div key={`c${i}`} className="p-4 bg-sky-950/50 border-l-2 border-sky-500/60">
                    {/* 헤더: 종목명 + 배지 + 수익률 */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] bg-sky-500/25 text-sky-300 border border-sky-500/40 px-2 py-0.5 rounded-full font-bold shrink-0">💰 파킹중</span>
                        <span className="text-sm font-bold text-sky-100 truncate">{displayName}</span>
                      </div>
                      <div className="text-right shrink-0 ml-3">
                        <div className="text-base font-black text-sky-300">{pnlPct > 0 ? '+' : ''}{pnlPct.toFixed(2)}%</div>
                        <div className="text-[11px] text-sky-500">{pnl > 0 ? '+' : ''}{fmtWon(pnl)}</div>
                      </div>
                    </div>
                    {/* 3개 수치 */}
                    <div className="flex gap-4 mt-3">
                      <div>
                        <div className="text-[9px] text-slate-500">파킹금액</div>
                        <div className="text-[12px] font-bold text-sky-200">{fmtWon(invested)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] text-slate-500">평단 / 현재가</div>
                        <div className="text-[12px] font-bold text-slate-300">{fmtWon(avgPrice)} → {ch.currentPrice > 0 ? fmtWon(ch.currentPrice) : '-'}</div>
                      </div>
                      <div className="ml-auto text-right">
                        <div className="text-[9px] text-sky-600">자산비중</div>
                        <div className="text-[15px] font-black text-sky-400">{weight !== null ? `${weight}%` : '-'}</div>
                      </div>
                    </div>
                    {/* 매도 버튼 */}
                    <div className="flex justify-end mt-3">
                      <button onClick={async () => {
                        if (!confirm(`${displayName} ${qty}주 전량 매도하시겠습니까?\n(파킹 해제)`)) return;
                        try { const r = await api(`/sell/${ch.id}`, { method: 'POST', timeout: 40000 }); alert(r.message || '매도 완료'); onRefresh(); }
                        catch (err: any) { alert('매도 실패: ' + err.message); }
                      }} className="text-xs px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-rose-500/10 hover:text-rose-400 text-slate-500 transition-colors border border-white/[0.05]">
                        파킹 해제
                      </button>
                    </div>
                  </div>
                );

                /* ── 일반 종목 카드 ── */
                const range = targetPct - stopPct;
                const barPos = Math.max(0, Math.min(100, ((pnlPct - stopPct) / range) * 100));
                return (
                  <div key={`c${i}`} className="p-4 bg-[#0f1320] hover:bg-white/[0.01] transition-colors">
                    {/* 헤더: 종목명 + 수익률 */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-bold truncate">{displayName}</span>
                          <span className="text-[10px] bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded font-medium shrink-0">{ch.strategy_mode}</span>
                          {ch.status === 'PROFIT_TAKING' && <span className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 rounded font-bold shrink-0">2단계↑</span>}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">평단 {fmtWon(avgPrice)} · {fmt(qty)}주{weight !== null ? ` · 비중 ${weight}%` : ''}</div>
                      </div>
                      <div className="text-right shrink-0">
                        {ch.currentPrice > 0 ? (
                          <>
                            <div className={`text-lg font-black ${pc(pnl)}`}>{pnlPct > 0 ? '+' : ''}{pnlPct.toFixed(2)}%</div>
                            <div className={`text-[11px] ${pc(pnl)}`}>{pnl > 0 ? '+' : ''}{fmtWon(pnl)}</div>
                          </>
                        ) : <span className="text-xs text-slate-600">시세 로딩중</span>}
                      </div>
                    </div>
                    {/* P&L 진행 바 */}
                    {ch.currentPrice > 0 && avgPrice > 0 && (
                      <div className="mt-3">
                        <div className="relative h-1.5 bg-white/[0.05] rounded-full overflow-visible">
                          <div className={`absolute h-full rounded-full transition-all duration-700 ${pnlPct >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`} style={{ width: `${barPos}%` }} />
                          <div className="absolute h-3 w-0.5 bg-white/20 rounded-full top-1/2 -translate-y-1/2" style={{ left: `${((0 - stopPct) / range) * 100}%` }} />
                        </div>
                        <div className="flex justify-between mt-0.5">
                          <span className="text-[9px] text-rose-500">{stopPct}%</span>
                          <span className="text-[9px] text-emerald-500">+{targetPct}%</span>
                        </div>
                      </div>
                    )}
                    {/* 투자금 · 현재가 · 목표/손절 */}
                    <div className="grid grid-cols-3 gap-2 mt-2">
                      <div>
                        <div className="text-[9px] text-slate-500 mb-0.5">투자금</div>
                        <div className="text-[11px] font-bold truncate">{fmtWon(invested)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] text-slate-500 mb-0.5">현재가</div>
                        <div className="text-[11px] font-bold">{ch.currentPrice > 0 ? fmtWon(ch.currentPrice) : '-'}</div>
                      </div>
                      <div>
                        <div className="text-[9px] text-slate-500 mb-0.5">목표 / 손절</div>
                        <div className="text-[10px] font-bold"><span className="text-emerald-500">+{targetPct}%</span><span className="text-slate-600"> / </span><span className="text-rose-500">{stopPct}%</span></div>
                      </div>
                    </div>
                    {/* 액션 버튼 */}
                    <div className="flex items-center gap-1.5 mt-3">
                      <div className="flex gap-0.5">
                        {Array.from({ length: maxAvg }, (_, j) => (
                          <span key={j} className={`w-3.5 h-3.5 rounded-full text-[7px] font-bold flex items-center justify-center ${j < curAvg ? 'bg-blue-500 text-white' : 'bg-white/[0.06] text-slate-600'}`}>{j + 1}</span>
                        ))}
                      </div>
                      <div className="ml-auto flex items-center gap-1">
                        {ch.escape_target_price ? (
                          <button onClick={async () => {
                            try { await api(`/escape/${ch.id}`, { method: 'DELETE' }); onRefresh(); }
                            catch (err: any) { alert('취소 실패: ' + err.message); }
                          }} className="text-xs px-2.5 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 font-bold border border-amber-500/30 animate-pulse whitespace-nowrap">
                            탈출대기
                          </button>
                        ) : (
                          <button onClick={async () => {
                            if (!confirm(`${displayName}\n현재가 기준 +0.5% 돌파 시 자동 전량 매도합니다.`)) return;
                            try {
                              const r = await api(`/escape/${ch.id}`, { method: 'POST' });
                              alert(`탈출가 설정: ${fmtWon(r.escape_target_price)}`);
                              onRefresh();
                            } catch (err: any) { alert('탈출 설정 실패: ' + err.message); }
                          }} className="text-xs px-2.5 py-1.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 font-bold border border-amber-500/20 whitespace-nowrap">
                            탈출
                          </button>
                        )}
                        <button onClick={async () => {
                          if (!confirm(`${displayName} ${qty}주 전량 시장가 매도하시겠습니까?`)) return;
                          try { const r = await api(`/sell/${ch.id}`, { method: 'POST', timeout: 40000 }); alert(r.message || '매도 완료'); onRefresh(); }
                          catch (err: any) { alert('매도 실패: ' + err.message); }
                        }} className="text-xs px-2.5 py-1.5 rounded-xl bg-white/[0.04] hover:bg-rose-500/10 hover:text-rose-400 text-slate-500 font-medium border border-white/[0.04] whitespace-nowrap">
                          전량 매도
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-8 text-center space-y-3">
              <div className="text-2xl opacity-30">📦</div>
              <p className="text-sm text-slate-400">아직 투자 중인 종목이 없습니다</p>
              <p className="text-[11px] text-slate-600">장 중 10분 간격으로 자동 탐색 중</p>
            </div>
          )
        )}

        {/* 해외 탭 */}
        {holdingsTab === 'US' && (
          <div>
            {usHoldings.length > 0 && (
              <div className="divide-y divide-white/[0.03]">
                {usHoldings.map((h: any) => {
                  const priceData = usW.find((s: any) => s.code === h.stock_code);
                  const curPrice = (priceData?.price ?? 0) > 0 ? priceData!.price : (h.last_price ?? 0);
                  const isStale = (priceData?.price ?? 0) === 0 && curPrice > 0; // DB 저장 마지막 시세
                  const invested = h.avg_price * h.quantity;
                  const pnl = curPrice > 0 ? (curPrice - h.avg_price) * h.quantity : 0;
                  const pnlPct = curPrice > 0 && h.avg_price > 0 ? ((curPrice - h.avg_price) / h.avg_price) * 100 : 0;
                  const usDisplayName = toDisplayName(priceData?.name, h.stock_code);
                  return (
                    <div key={h.stock_code} className="px-4 py-3 flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold">{usDisplayName}</span>
                          <span className="text-[10px] text-slate-500">{h.quantity}주</span>
                        </div>
                        <div className="text-[11px] text-slate-500">평단 ${h.avg_price.toFixed(2)} · 투자 ${invested.toFixed(0)}</div>
                      </div>
                      <div className="text-right">
                        {curPrice > 0 ? (
                          <>
                            <div className={`text-base font-bold ${pc(pnl)}`}>{pnlPct > 0 ? '+' : ''}{pnlPct.toFixed(1)}%</div>
                            <div className={`text-[11px] ${pc(pnl)}`}>${pnl.toFixed(0)}</div>
                            {isStale && <div className="text-[10px] text-slate-600">장마감 시세</div>}
                          </>
                        ) : <span className="text-xs text-slate-600">시세 없음</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {/* 제보 단타 */}
            <VisionScalpPanel toast={toast} />
            {usW.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-3.5">
                {usW.map((s: any) => {
                  const held = usHoldings.find((h: any) => h.stock_code === s.code);
                  const usDisplayName = toDisplayName(s.name, s.code);
                  const hasPrice = s.price > 0;
                  return (
                    <div key={s.code} className={`rounded-xl border p-3 text-center transition-all hover:scale-[1.02] ${hasPrice ? pbg(s.changePct) : ''} ${held ? 'border-blue-500/40' : 'border-slate-700/30'}`}>
                      <div className="text-xs font-bold text-slate-300 truncate">{usDisplayName} {held ? '📌' : ''}</div>
                      <div className={`text-base font-bold mt-1 ${!hasPrice ? 'text-slate-600' : ''}`}>{hasPrice ? `$${s.price.toFixed(1)}` : '-'}</div>
                      <div className={`text-[11px] font-semibold mt-0.5 ${hasPrice ? pc(s.changePct) : 'text-slate-600'}`}>{hasPrice ? fmtPct(s.changePct) : '장마감'}</div>
                    </div>
                  );
                })}
              </div>
            )}
            {usW.length === 0 && usHoldings.length === 0 && (
              <div className="p-8 text-center space-y-2">
                <div className="text-2xl opacity-30">🌏</div>
                <p className="text-sm text-slate-400">장 마감 — 다음 세션 시작 시 시세 자동 업데이트</p>
                <p className="text-[11px] text-slate-600">🇯🇵 09:00~15:00 · 🇹🇼 10:00~14:30 · 🇺🇸 22:30~06:30 (서머타임)</p>
              </div>
            )}
            {/* 운영자 인사이트 입력 */}
            <div className="border-t border-white/[0.04] px-4 py-3">
              <div className="text-[11px] text-slate-500 mb-1.5 font-medium">💡 AI 인사이트 메모 <span className="text-slate-600">(다음 사이클에 AI에게 전달됩니다)</span></div>
              <textarea
                value={insightsDraft}
                onChange={e => setInsightsDraft(e.target.value)}
                placeholder="예: 미국 연준 금리 동결 예상, 반도체 섹터 주목 등 시장 상황을 자유롭게 입력하세요"
                rows={2}
                className="w-full bg-slate-800/60 border border-slate-700/50 rounded-xl px-3 py-2 text-xs text-slate-300 placeholder:text-slate-600 focus:border-blue-500/50 focus:outline-none resize-none"
              />
              <div className="flex items-center justify-between mt-1.5">
                {usInsights && insightsDraft === usInsights
                  ? <span className="text-[10px] text-emerald-500/70">✓ 저장됨</span>
                  : <span className="text-[10px] text-slate-600">{insightsDraft.length > 0 ? '미저장' : ''}</span>}
                <button
                  disabled={insightsSaving || insightsDraft === usInsights}
                  onClick={async () => {
                    setInsightsSaving(true);
                    try {
                      await api('/overseas/insights', { method: 'PUT', body: JSON.stringify({ insights: insightsDraft }) });
                      setUsInsights(insightsDraft);
                      toast?.('인사이트 저장됨', 'success');
                    } catch { toast?.('저장 실패', 'error'); }
                    setInsightsSaving(false);
                  }}
                  className="text-[11px] px-3 py-1 bg-blue-600/70 hover:bg-blue-500/70 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg transition-all"
                >
                  {insightsSaving ? '저장중...' : '저장'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── 포트폴리오 비중 (접기/펼치기) ── */}
      <div>
        {/* 포트폴리오 비중 */}
        <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden">
          <button onClick={() => setShowPortfolio(v => !v)} className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/[0.02] transition-colors">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-200">포트폴리오 비중</span>
              {totalInvested > 0 && <span className="text-[10px] bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded-md">투자 {((totalInvested / (p?.totalValue || 1)) * 100).toFixed(0)}%</span>}
            </div>
            <span className="text-[11px] text-slate-500">{showPortfolio ? '접기 ▲' : '자세히 ▼'}</span>
          </button>
          {showPortfolio && <div className="p-4 sm:p-5 space-y-4 border-t border-white/[0.04]">
            {/* 현금 vs 투자 비율 바 */}
            <div>
              {/* 색상 범례 */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] mb-2">
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-gradient-to-r from-blue-500 to-cyan-500 shrink-0" />투자 중 {investedPctExact.toFixed(0)}%</span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-slate-400/50 shrink-0" />국내 현금 {cashPctExact.toFixed(0)}%</span>
                {overseasCashKrw > 0 && <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-indigo-400/70 shrink-0" />해외 현금 {overseasCashPctExact.toFixed(0)}%</span>}
              </div>
              <div className="h-3 bg-white/[0.04] rounded-full overflow-hidden">
                <div className="h-full flex">
                  <div
                    className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 transition-all duration-500"
                    style={{ width: `${pctClamp(investedPctExact)}%` }}
                  />
                  <div
                    className="h-full bg-slate-400/50 transition-all duration-500"
                    style={{ width: `${pctClamp(cashPctExact)}%` }}
                  />
                  {overseasCashKrw > 0 && (
                    <div
                      className="h-full bg-indigo-400/70 transition-all duration-500"
                      style={{ width: `${pctClamp(overseasCashPctExact)}%` }}
                    />
                  )}
                </div>
              </div>
            </div>
            {/* 종목별 비중 — 국내 */}
            {chains.length > 0 && (
              <div className="space-y-2.5">
                {domesticInvested > 0 && usHoldings.length > 0 && (
                  <div className="text-[10px] text-slate-500 font-medium">국내 ({fmtWon(domesticInvested)})</div>
                )}
                {chains.map((ch: any, i: number) => {
                  const inv = Number(ch.invested) || 0;
                  const pct = totalInvested > 0 ? (inv / totalInvested) * 100 : 0;
                  return (
                    <div key={`kr-${i}`}>
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="font-medium text-slate-300">
                          {(() => {
                            const resolved = toDisplayName(ch.stock_name, ch.stock_code);
                            return isUnresolvedStockName(resolved, ch.stock_code) ? getStockName(ch.stock_code) : resolved;
                          })()}
                        </span>
                        <span className="text-slate-500">{fmtWon(inv)} ({pct.toFixed(0)}%)</span>
                      </div>
                      <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${ch.unrealizedPnl >= 0 ? 'bg-emerald-500/60' : 'bg-rose-500/60'}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {/* 해외 보유 */}
            {usHoldings.length > 0 && (
              <div className="mt-3 pt-3 border-t border-white/[0.04]">
                <div className="text-[10px] text-slate-500 font-medium mb-2">해외 ({fmtWon(overseasInvestedKrw)})</div>
                <div className="space-y-2">
                  {usHoldings.map((h: any, i: number) => {
                    const invUsd = h.avg_price * h.quantity;
                    const invKrw = invUsd * fxRate;
                    const pct = totalInvested > 0 ? (invKrw / totalInvested) * 100 : 0;
                    const priceData = usW.find((s: any) => s.code === h.stock_code);
                    const curPnl = priceData?.price ? (priceData.price - h.avg_price) * h.quantity : 0;
                    return (
                      <div key={`us-${i}`}>
                        <div className="flex justify-between text-[11px] mb-1">
                          <span className="font-medium text-blue-300">{toDisplayName(priceData?.name, h.stock_code)}</span>
                          <span className="text-slate-500">{fmtWon(invKrw)} ({pct.toFixed(0)}%)</span>
                        </div>
                        <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${curPnl >= 0 ? 'bg-blue-500/60' : 'bg-rose-500/60'}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>}
        </div>
      </div>

      {/* ── AI 스코어 + 최근 매매 2컬럼 ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 items-start gap-4 sm:gap-5">
        {/* AI 스코어 — KR/US 탭 연동 */}
        {holdingsTab === 'KR' ? (
          <Panel title="AI가 보는 종목 점수" badge={dash?.scores?.length > 0 ? `${dash.scores.length}종목` : undefined} badgeColor="blue">
            {dash?.scores?.length > 0 ? (
              <div className="p-3.5 space-y-2">
                {[...dash.scores].sort((a: any, b: any) => (b.composite_score ?? 0) - (a.composite_score ?? 0)).map((sc: any) => {
                  const score = Number(sc.composite_score);
                  const barColor = score >= 75 ? 'bg-emerald-500' : score >= 50 ? 'bg-blue-500' : score >= 25 ? 'bg-amber-500' : 'bg-slate-600';
                  const textColor = score >= 75 ? 'text-emerald-400' : score >= 50 ? 'text-blue-400' : 'text-slate-500';
                  const signalLabel = score >= 85 ? '강력 추천' : score >= 70 ? '매수 추천' : score >= 50 ? '관망' : score >= 30 ? '위험' : '매도 추천';
                  return (
                    <div key={sc.stock_code} className="flex items-center gap-3 px-2 py-2">
                      <span className="text-xs font-bold text-slate-300 w-24 shrink-0 truncate">{getStockName(sc.stock_code)}</span>
                      <div className="flex-1">
                        <div className="h-2 bg-white/[0.04] rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />
                        </div>
                      </div>
                      <span className={`text-sm font-black w-12 text-right ${textColor}`}>{score}</span>
                      <span className={`text-[10px] font-medium w-14 text-right ${textColor}`}>{signalLabel}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-6 text-center space-y-3">
                <div className="text-2xl opacity-30">🤖</div>
                <p className="text-sm text-slate-500">AI 스코어가 아직 없습니다</p>
                <p className="text-[11px] text-slate-600">매일 오전 7:30 / 오후 6시에 자동 실행됩니다.</p>
                <p className="text-[10px] text-blue-400/60">스코어 없는 동안 기술적 지표 기반으로 자동매매가 동작합니다</p>
              </div>
            )}
          </Panel>
        ) : <OverseasScorePanel usDash={usDash} />}

        {/* 최근 매매 — KR/US 탭 연동 */}
        {(() => {
          const isUsTab = holdingsTab === 'US';
          const tabFiltered = filled.filter((t: any) => {
            const isOv = t.trigger_source === 'OVERSEAS' || Number(t.filled_price) < 1000;
            return isUsTab ? isOv : !isOv;
          });
          const todayTabTrades = tabFiltered.filter((t: any) => new Date(t.created_at).toDateString() === new Date().toDateString());
          return (
        <Panel title={isUsTab ? '최근 매매 (미국)' : '최근 매매'} badge={`오늘 ${todayTabTrades.length}건`} badgeColor={todayTabTrades.length > 0 ? 'emerald' : undefined}>
          {tabFiltered.length === 0 ? <EmptyMsg>매매 기록 없음</EmptyMsg> : (
            <div className="divide-y divide-white/[0.03]">
              {tabFiltered.slice(0, 10).map((t: any, i: number) => {
                const isOverseasTrade = t.trigger_source === 'OVERSEAS' || Number(t.filled_price) < 1000;
                return (
                  <div key={i} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02]">
                    <SideBadge side={t.side} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-slate-200">
                          {(() => {
                            const resolved = toDisplayName(t.stock_name, t.stock_code);
                            return isUnresolvedStockName(resolved, t.stock_code) ? getStockName(t.stock_code) : resolved;
                          })()}
                        </span>
                        {isOverseasTrade && <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-md">🇺🇸</span>}
                        <span className="text-[10px] text-slate-600">{fmtTime(t.created_at)}</span>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5 truncate">{t.ai_reasoning || '-'}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-bold">{isOverseasTrade ? fmtUsd(Number(t.filled_price)) : fmtWon(Number(t.filled_price))}</div>
                      <div className="text-[10px] text-slate-500">{fmt(t.quantity)}주</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
          );
        })()}
      </div>


      {/* ── 수익 구조 분해 ── */}
      <PnlBreakdownPanel chains={chains} trades={trades} />

      {/* ── 봇 vs KOSPI 비교 ── */}
      {holdingsTab === 'KR' && <PerformanceVsKospiPanel />}

      {/* ── 외국인/기관 수급 ── */}
      {holdingsTab === 'KR' && <InvestorFlowPanel />}

      {/* ── 보유종목 공매도 ── */}
      {holdingsTab === 'KR' && <ShortSellingPanel />}

      {/* ── 섹터 쏠림 경고 ── */}
      {holdingsTab === 'KR' && <CorrelationWarningPanel />}

      {/* ── 52주 신고가 스캐너 ── */}
      {holdingsTab === 'KR' && <HighScannerPanel />}

      {/* ── 업종 히트맵 ── */}
      {holdingsTab === 'KR' && <SectorHeatmapPanel />}

      {/* ── 세금 추정 ── */}
      {holdingsTab === 'KR' && <TaxEstimatePanel />}

      {/* ── AI 판단 근거 투명성 ── */}
      <AiTransparencyPanel watchlist={watchlist} tab={holdingsTab} usDash={usDash} />

      {/* ── 성과 종합 분석 ── */}
      <PerformancePanel trades={trades} strategy={strategy} setStrategy={setStrategy} toast={toast} />

      {/* ── 자기학습 인사이트 ── */}
      <InsightsPanel insights={dash?.insights ?? []} trades={trades} onRefresh={onRefresh} toast={toast} />

      {/* ── 시스템 로그 ── */}
      {(health?.recentEvents?.length > 0) && (
        <Panel title="시스템 로그" badge={`${health.recentEvents.length}건`}>
          <div className="max-h-32 overflow-y-auto divide-y divide-slate-800/20">
            {health.recentEvents.map((ev: any, i: number) => (
              <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ev.status === 'success' ? 'bg-emerald-400' : ev.status === 'error' ? 'bg-rose-400' : 'bg-blue-400'}`} />
                <span className="text-slate-500 shrink-0 w-16">{fmtTime(ev.timestamp)}</span>
                <span className="text-slate-400 font-medium">[{ev.component}]</span>
                <span className="text-slate-300 truncate">{ev.message}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// TRADES VIEW
// ═══════════════════════════════════════

const PENDING_STOCK_NAME_REGEX = /^(?:종목(?:명)?확인중|확인중)$/;

// 특수문자(◆ 등) 포함 여부로 종목명 깨짐 감지
function isGarbledName(name: string): boolean {
  if (!name) return true;
  return /[^\w\s\uAC00-\uD7A3\u3131-\u318E\u1100-\u11FF().,·\-+%$]/.test(name);
}

function isPendingStockName(name: string): boolean {
  const compact = name.replace(/\s+/g, '');
  return PENDING_STOCK_NAME_REGEX.test(compact);
}

function isUnresolvedStockName(name: string, code?: string): boolean {
  if (!name) return true;
  if (isPendingStockName(name)) return true;
  return !!code && name === code;
}

function toDisplayName(name: unknown, code?: string): string {
  const n = String(name ?? '').trim();
  const known = getKnownStockName(code);
  if (!n || isPendingStockName(n)) return known ?? (code ? String(code) : '종목명 확인중');
  if (code && n === code) return known ?? String(code);
  if (/^[0-9]{6}$/.test(n)) return known ?? n;
  if (isGarbledName(n)) return known ?? (code ? String(code) : n);
  return n;
}

function simplifyReason(reason: string | null | undefined, side: string): string {
  if (!reason) return side === 'BUY' ? '매수' : '매도';
  if (reason.includes('15:20') || reason.includes('강제 청산')) return '마감 청산';
  if (reason.includes('손절') || reason.toLowerCase().includes('stop_loss')) return '손절 매도';
  if (reason.match(/익절\([+-]?[\d.]+%\)/)) return '익절 매도';
  if (reason.match(/손절\([+-]?[\d.]+%\)/)) return '손절 매도';
  if ((reason.includes('수익') || reason.includes('익절')) && reason.includes('매도')) return '익절 매도';
  if (reason.includes('목표가')) return '목표가 도달';
  if (reason.includes('AI 스코어') || reason.includes('기술적 매수')) return 'AI 매수 신호';
  if (reason.includes('물타기') || reason.includes('추가 매수') || reason.includes('AVERAGE')) return '추가 매수';
  if (reason.includes('분할 매도') || reason.includes('PROFIT_TAKING')) return '분할 익절';
  if (reason.includes('CEO') || reason.includes('수동')) return '수동 매도';
  if (reason.includes('🚀') || reason.includes('모멘텀')) return side === 'BUY' ? 'AI 매수 신호' : '모멘텀 매도';
  if (reason.includes('📉') || reason.includes('반등')) return side === 'BUY' ? '반등 매수' : '반등 매도';
  if (reason.includes('저점') || reason.includes('기술적')) return side === 'BUY' ? '기술적 매수' : '기술 매도';
  return reason.length > 15 ? reason.slice(0, 15) + '…' : reason;
}

function TradesView({ trades, watchlist }: { trades: any[]; watchlist: any[] }) {
  // 종목명 조회 맵 (API stock_name 우선, 없으면 watchlist, 없으면 코드)
  const nameMap = new Map(watchlist.map((w: any) => [w.stock_code, w.stock_name]));
  const getName = (t: any) => {
    const apiName = toDisplayName(t.stock_name, t.stock_code);
    if (!isUnresolvedStockName(apiName, t.stock_code)) return apiName;
    return toDisplayName(nameMap.get(t.stock_code), t.stock_code);
  };
  const [expanded, setExpanded] = useState<string | null>(null);
  const filled = trades.filter((t: any) => t.status === 'FILLED' || (t.status === 'PENDING' && t.trigger_source === 'OVERSEAS'));
  const isOverseas = (t: any) => t.trigger_source === 'OVERSEAS';
  const domestic = filled.filter((t: any) => !isOverseas(t));
  const buys = domestic.filter((t: any) => t.side === 'BUY');
  const sells = domestic.filter((t: any) => t.side === 'SELL');
  const todayCount = domestic.filter((t: any) => new Date(t.created_at).toDateString() === new Date().toDateString()).length;

  return (
    <div className="space-y-4">
      {/* 요약 통계 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">총 체결 (국내)</div>
          <div className="text-lg font-black mt-1">{domestic.length}건</div>
        </div>
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">오늘 (국내)</div>
          <div className="text-lg font-black mt-1 text-blue-400">{todayCount}건</div>
        </div>
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-emerald-400/60">매수</div>
          <div className="text-lg font-black mt-1 text-emerald-400">{buys.length}건</div>
        </div>
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-rose-400/60">매도</div>
          <div className="text-lg font-black mt-1 text-rose-400">{sells.length}건</div>
        </div>
      </div>

    <Panel title="매매내역" badge={`${trades.length}건`}>
      {trades.length === 0 ? (
        <div className="p-8 text-center space-y-2">
          <div className="text-2xl opacity-30">📋</div>
          <p className="text-sm text-slate-400">아직 매매 기록이 없습니다</p>
          <p className="text-[11px] text-slate-600">로봇이 매수/매도를 실행하면 여기에 기록됩니다.<br/>장 중(09:00~15:30) 10분 간격으로 자동 실행됩니다.</p>
        </div>
      ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead><tr className="text-slate-500 border-b border-slate-700/30">
            <th className="px-4 py-3 text-left font-medium">시간</th>
            <th className="px-4 py-3 text-left font-medium">종목</th>
            <th className="px-4 py-3 text-center font-medium">구분</th>
            <th className="px-4 py-3 text-right font-medium">수량</th>
            <th className="px-4 py-3 text-right font-medium">체결가</th>
            <th className="px-4 py-3 text-right font-medium">손익</th>
            <th className="px-4 py-3 text-center font-medium">상태</th>
            <th className="px-4 py-3 text-center font-medium">모드</th>
            <th className="px-4 py-3 text-left font-medium">내용</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-800/20">
            {trades.length === 0 ? (
              <tr><td colSpan={9} className="p-12 text-center text-slate-500">매매 기록 없음</td></tr>
            ) : trades.map((t: any, i: number) => {
              const chain = t.transaction_chains;
              const tradeKey = t.id || t.kis_order_no || `t${i}`;
              const isOpen = expanded === tradeKey;
              const isSell = t.side === 'SELL';
              const overseas = isOverseas(t);
              const avgBuy = Number(chain?.avg_buy_price) || 0;
              const filledPrice = Number(t.filled_price) || 0;
              const qty = Number(t.quantity) || 0;
              const apiPnl = typeof t.realized_pnl === 'number' ? Number(t.realized_pnl) : null;
              const apiPnlPct = typeof t.realized_pnl_pct === 'number' ? Number(t.realized_pnl_pct) : null;
              const apiPnlUsd = typeof t.realized_pnl_usd === 'number' ? Number(t.realized_pnl_usd) : null;
              // 국내 폴백: avg_buy_price vs filled_price
              const fallbackPnl = !overseas && isSell && avgBuy > 0 && filledPrice > 0 ? (filledPrice - avgBuy) * qty : null;
              const fallbackPnlPct = !overseas && isSell && avgBuy > 0 && filledPrice > 0 ? ((filledPrice - avgBuy) / avgBuy) * 100 : null;
              // 해외 폴백: avg_buy_price 기반 (국내와 동일 로직, 단위 USD)
              const overseasFallbackPnl = overseas && isSell && avgBuy > 0 && filledPrice > 0 ? (filledPrice - avgBuy) * qty : null;
              const overseasFallbackPnlPct = overseas && isSell && avgBuy > 0 && filledPrice > 0 ? ((filledPrice - avgBuy) / avgBuy) * 100 : null;
              // 해외: API 계산값 우선 → ai_reasoning 패턴 → avg_buy_price 폴백
              const overseasReasonPct = overseas && isSell && apiPnlPct === null
                ? (() => { const m = String(t.ai_reasoning || '').match(/[익손절]+\(([+-]?[\d.]+)%\)/); return m ? Number(m[1]) : null; })()
                : null;
              const overseasPnlUsdAmt = overseasReasonPct !== null && filledPrice > 0 && qty > 0
                ? filledPrice * qty * (overseasReasonPct / 100) : null;
              const tradePnl = overseas ? (apiPnlUsd ?? overseasPnlUsdAmt ?? overseasFallbackPnl) : (apiPnl ?? fallbackPnl);
              const tradePnlPct = apiPnlPct ?? (overseas ? (overseasReasonPct ?? overseasFallbackPnlPct) : fallbackPnlPct);
              return (
              <React.Fragment key={tradeKey}>
              <tr onClick={() => setExpanded(isOpen ? null : tradeKey)} className={`hover:bg-slate-800/20 transition-colors cursor-pointer${overseas ? ' opacity-60' : ''}`}>
                <td className="px-4 py-3 text-slate-500">{fmtTime(t.created_at)}</td>
                <td className="px-4 py-3 font-semibold">
                  {overseas && <span className="text-[10px] mr-1">🌏</span>}
                  {getName(t)}
                </td>
                <td className="px-4 py-3 text-center"><SideBadge side={t.side} /></td>
                <td className="px-4 py-3 text-right">{fmt(t.quantity)}</td>
                <td className="px-4 py-3 text-right font-medium">{overseas ? fmtUsd(filledPrice) : fmtWon(filledPrice)}</td>
                <td className="px-4 py-3 text-right">
                  {tradePnl !== null && tradePnlPct !== null ? (
                    <div className={tradePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      <div className="font-semibold text-[12px]">{tradePnlPct >= 0 ? '+' : ''}{tradePnlPct.toFixed(1)}%</div>
                      <div className="text-[11px] opacity-80">
                        {tradePnl >= 0 ? '+' : ''}{overseas ? `$${Math.abs(tradePnl).toFixed(2)}` : `${Math.round(tradePnl).toLocaleString()}원`}
                      </div>
                    </div>
                  ) : <span className="text-slate-600 text-[11px]">-</span>}
                </td>
                <td className="px-4 py-3 text-center"><StatusBadge status={t.status} /></td>
                <td className="px-4 py-3 text-center"><ModeBadge mode={t.trading_mode} /></td>
                <td className="px-4 py-3 text-slate-400 max-w-[200px]">
                  <div className="flex items-center gap-1">
                    <div className="truncate font-medium text-slate-300" title={t.ai_reasoning}>{simplifyReason(t.ai_reasoning, t.side)}</div>
                    <span className="text-[10px] text-slate-600 shrink-0">{isOpen ? '▲' : '▼'}</span>
                  </div>
                </td>
              </tr>
              {isOpen && (
                <tr className="bg-slate-900/40">
                  <td colSpan={9} className="px-5 py-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                      <div>
                        <p className="text-slate-500 font-medium mb-1.5">상세 내용</p>
                        <p className="text-slate-300 leading-relaxed whitespace-pre-wrap">{t.ai_reasoning || '기록 없음'}</p>
                      </div>
                      <div>
                        <p className="text-slate-500 font-medium mb-1.5">언제 팔 계획인지</p>
                        {chain?.strategy_mode ? (
                          <div className="space-y-1 text-slate-400">
                            <p>전략: <span className="text-slate-200 font-medium">{chain.strategy_mode}</span></p>
                            <p>평단가: <span className="text-slate-200">{Number(chain.avg_buy_price).toLocaleString()}원</span></p>
                            <p>상태: <span className="text-slate-200">{chain.status}</span></p>
                            {chain.strategy_mode === 'SWING' && (
                              <>
                                <p className="text-orange-400">수익 +3% 이상 & 고점 대비 -5% 이탈 → 전량 매도 (트레일링 스탑)</p>
                                <p className="text-rose-400">-5% 떨어지면 → 전부 팔아서 손실 차단</p>
                                <p className="text-blue-400">-3% 빠지면 → 더 싸게 추가 매수 (최대 3번)</p>
                              </>
                            )}
                            {chain.strategy_mode === 'DEFENSE' && (
                              <>
                                <p className="text-emerald-400">+5% 오르면 → 전부 팔아서 수익 확보</p>
                                <p className="text-rose-400">-3% 떨어지면 → 전부 팔아서 손실 차단</p>
                              </>
                            )}
                          </div>
                        ) : overseas ? (
                          <div className="space-y-1 text-slate-400">
                            <p>전략: <span className="text-slate-200 font-medium">미국주식 자동매매</span></p>
                            {(() => {
                              const isScalp = String(t.ai_reasoning || '').includes('scalp') || String(t.ai_reasoning || '').includes('SCALP');
                              const tpMatch = String(t.ai_reasoning || '').match(/tp[:\s]*\$?([\d.]+)/i);
                              const slMatch = String(t.ai_reasoning || '').match(/sl[:\s]*\$?([\d.]+)/i);
                              if (isScalp && tpMatch && slMatch) {
                                return (
                                  <>
                                    <p className="text-emerald-400">익절가 ${tpMatch[1]} 도달 → 전량 매도</p>
                                    <p className="text-rose-400">손절가 ${slMatch[1]} 이탈 → 전량 매도</p>
                                    <p className="text-amber-400">전략: 단타 (SCALP)</p>
                                  </>
                                );
                              }
                              return (
                                <>
                                  <p className="text-emerald-400">+10% 오르면 → 전량 매도 (익절)</p>
                                  <p className="text-rose-400">-2.5% 떨어지면 → 전량 매도 (손절)</p>
                                  <p className="text-orange-400">최고점 대비 -2.5% 빠지면 → 트레일링 스탑</p>
                                  <p className="text-sky-400">AI 매도 신호 (신뢰도 55%↑) → 전량 매도</p>
                                </>
                              );
                            })()}
                          </div>
                        ) : (
                          <p className="text-slate-500">체인 정보 없음</p>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </Panel>
    </div>
  );
}

// ═══════════════════════════════════════
// WATCHLIST VIEW
// ═══════════════════════════════════════

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
        <Panel title="로봇이 감시하는 종목들" badge={`${watchlist.length}종목`}>
          <div className="px-4 pt-3 pb-1 flex gap-2">
            <button
              onClick={async () => {
                toast?.('워치리스트 순환 시작...', 'info');
                const d = await api('/run-watchlist-rotation', { method: 'POST' }).catch(() => ({}));
                toast?.(d.message ?? '순환 완료', 'ok');
                setTimeout(onRefresh, 3000);
              }}
              className="text-xs bg-violet-900/40 hover:bg-violet-900/60 text-violet-300 px-3 py-1.5 rounded-xl transition-all whitespace-nowrap">
              🔄 순환 실행
            </button>
            <button
              onClick={async () => {
                toast?.('종목명 보정 중...', 'info');
                const d = await api('/fix-names', { method: 'POST' }).catch(() => ({}));
                toast?.(d.message ?? '보정 완료', 'ok');
              }}
              className="text-xs bg-slate-800/60 hover:bg-slate-800/80 text-slate-400 px-3 py-1.5 rounded-xl transition-all whitespace-nowrap">
              🏷️ 이름 보정
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 p-3">
            {[...watchlist].sort((a: any, b: any) => {
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

              let statusColor = 'text-slate-500';
              let statusLabel = '대기';
              let borderClass = 'border-white/[0.06]';
              if (chain) { statusColor = 'text-emerald-400'; statusLabel = '투자 중'; borderClass = 'border-emerald-500/30'; }
              else if (scoreVal >= 70) { statusColor = 'text-amber-400'; statusLabel = '매수 근접'; borderClass = 'border-amber-500/30'; }
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
                    <div className={`text-[10px] font-medium mt-1 ${sellPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      최근 매도 {sellPct >= 0 ? '+' : ''}{sellPct.toFixed(1)}%
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
            {watchlist.length === 0 && <div className="col-span-2"><EmptyMsg>종목을 추가하면 로봇이 24시간 감시합니다</EmptyMsg></div>}
          </div>
        </Panel>

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

          const displayList = usScores.length > 0 ? usScores : usW;
          return (
            <Panel title="🇺🇸 미국주식 감시" badge={scoresLoading ? '계산 중...' : `${displayList.length}종목`}>
              {scoresLoading && displayList.length === 0 && (
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
                  const signalColor = signal === 'STRONG_BUY' ? 'text-emerald-300' : signal === 'BUY' ? 'text-emerald-400' : signal === 'SELL' || signal === 'STRONG_SELL' ? 'text-rose-400' : 'text-slate-500';
                  const scoreBg = score !== null ? (score >= 40 ? 'bg-emerald-500/10 border-emerald-500/20' : score <= -20 ? 'bg-rose-500/10 border-rose-500/20' : 'bg-white/[0.03] border-slate-700/30') : `${pbg(s.changePct)} border-slate-700/30`;
                  return (
                    <div key={code} className={`rounded-lg border p-3 ${scoreBg}`}>
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <span className="font-bold text-sm truncate">{usDisplayName}</span>
                        <span className={`text-[10px] font-medium shrink-0 ${pc(s.changePct)}`}>{fmtPct(s.changePct)}</span>
                      </div>
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

// ═══════════════════════════════════════
// NEWS VIEW
// ═══════════════════════════════════════

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

// ═══════════════════════════════════════
// SETTINGS VIEW
// ═══════════════════════════════════════

// NotebookLM 소스 타입
interface NbSource { id: string; title: string; content: string; created_at?: string; harm_suspected?: boolean; }

function parseNbSources(raw: string | null | undefined): NbSource[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as NbSource[];
  } catch { /* not JSON — legacy plain text */ }
  // 레거시 텍스트 → 단일 소스로 변환
  if (/[^\w\s\uAC00-\uD7A3\u3131-\u318E\u1100-\u11FF().,·\-+%$\n:#\[\]@!?/"'=]/.test(raw)) return [];
  return [{ id: crypto.randomUUID(), title: '기존 소스', content: raw }];
}

function isGarbledPrompt(_val: string | null | undefined): boolean {
  return false; // 특수문자(→ 등) 포함 시 오탐 → 항상 raw 값 그대로 사용
}

function GoldenRatioPanel({ allocConfig, setAllocConfig, toast }: any) {
  const cfg = allocConfig ?? { kr_pct: 70, us_pct: 30, sector_semiconductor: 30, sector_bio: 20, sector_defense: 25, sector_finance: 20, sector_etc: 30, trailing_stop_pct: 5 };
  const [kr, setKr] = React.useState<number>(Number(cfg.kr_pct ?? 70));
  const [us, setUs] = React.useState<number>(Number(cfg.us_pct ?? 30));
  const [semi, setSemi] = React.useState<number>(Number(cfg.sector_semiconductor ?? 30));
  const [bio, setBio] = React.useState<number>(Number(cfg.sector_bio ?? 20));
  const [defense, setDefense] = React.useState<number>(Number(cfg.sector_defense ?? 25));
  const [finance, setFinance] = React.useState<number>(Number(cfg.sector_finance ?? 20));
  const [etc, setEtc] = React.useState<number>(Number(cfg.sector_etc ?? 30));
  const [trailStop, setTrailStop] = React.useState<number>(Number(cfg.trailing_stop_pct ?? 5));

  React.useEffect(() => {
    if (allocConfig) {
      setKr(Number(allocConfig.kr_pct ?? 70));
      setUs(Number(allocConfig.us_pct ?? 30));
      setSemi(Number(allocConfig.sector_semiconductor ?? 30));
      setBio(Number(allocConfig.sector_bio ?? 20));
      setDefense(Number(allocConfig.sector_defense ?? 25));
      setFinance(Number(allocConfig.sector_finance ?? 20));
      setEtc(Number(allocConfig.sector_etc ?? 30));
      setTrailStop(Number(allocConfig.trailing_stop_pct ?? 5));
    }
  }, [allocConfig]);

  const krUsValid = Math.abs(kr + us - 100) <= 1;

  const adjustKrUs = (side: 'kr' | 'us', val: number) => {
    const v = Math.max(0, Math.min(100, val));
    if (side === 'kr') { setKr(v); setUs(100 - v); }
    else { setUs(v); setKr(100 - v); }
  };

  const save = async () => {
    if (!krUsValid) { toast?.('국내+미국 합계가 100%여야 합니다', 'err'); return; }
    try {
      const updated = await api('/portfolio/allocation', { method: 'PUT', body: JSON.stringify({
        kr_pct: kr, us_pct: us,
        sector_semiconductor: semi, sector_bio: bio, sector_defense: defense, sector_finance: finance, sector_etc: etc,
        trailing_stop_pct: trailStop,
      })});
      setAllocConfig(updated);
      toast?.('투자비율 저장됨', 'ok');
    } catch { toast?.('저장 실패', 'err'); }
  };

  const SectorInput = ({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) => (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-slate-400">{label}</span>
      <div className="flex items-center gap-1.5">
        <input type="number" min={5} max={100} step={5} value={value}
          onChange={e => onChange(Math.max(5, Math.min(100, Number(e.target.value))))}
          className="w-16 bg-white/[0.05] ring-1 ring-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-white text-center focus:outline-none focus:ring-blue-500/50" />
        <span className="text-[11px] text-slate-500">%</span>
      </div>
    </div>
  );

  return (
    <Panel title="투자비율 설정">
      <div className="px-6 py-5 space-y-6">

        {/* 국내 vs 미국 */}
        <div className="space-y-3">
          <p className="text-xs font-semibold text-slate-300">국내 / 미국 비율</p>
          <div className="w-full h-3 rounded-full overflow-hidden flex">
            <div className="bg-blue-500 transition-all" style={{ width: `${kr}%` }} />
            <div className="bg-amber-500 transition-all" style={{ width: `${us}%` }} />
          </div>
          <div className="flex justify-between text-[10px] text-slate-400">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-500" />국내 <span className="font-bold text-white">{kr}%</span></span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500" />미국 <span className="font-bold text-white">{us}%</span></span>
          </div>
          <div className="space-y-2">
            {([['국내 주식', kr, (v: number) => adjustKrUs('kr', v), 'blue'], ['미국 주식', us, (v: number) => adjustKrUs('us', v), 'amber']] as [string, number, (v: number) => void, string][]).map(([label, val, setter, color]) => (
              <div key={label} className="space-y-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-400">{label}</span>
                  <span className="font-bold text-white">{val}%</span>
                </div>
                <input type="range" min={0} max={100} step={5} value={val}
                  onChange={e => setter(Number(e.target.value))}
                  className={`w-full h-1.5 rounded-full appearance-none cursor-pointer accent-${color}-500`} />
              </div>
            ))}
          </div>
          {!krUsValid && <p className="text-[11px] text-rose-400">합계 {kr + us}% — 100%가 되어야 합니다</p>}
        </div>

        <div className="border-t border-white/[0.06]" />

        {/* 섹터별 최대 한도 */}
        <div className="space-y-3">
          <div>
            <p className="text-xs font-semibold text-slate-300">섹터별 최대 투자 한도</p>
            <p className="text-[11px] text-slate-500 mt-0.5">포트폴리오 대비 각 섹터 최대 비중. AI가 한도 초과 종목 신규 매수를 막습니다.</p>
          </div>
          <div className="space-y-2.5">
            <SectorInput label="반도체 (SK하이닉스·삼성·한미반도체 등)" value={semi} onChange={setSemi} />
            <SectorInput label="바이오·제약" value={bio} onChange={setBio} />
            <SectorInput label="방산 (한화에어로·현대로템 등)" value={defense} onChange={setDefense} />
            <SectorInput label="금융·은행" value={finance} onChange={setFinance} />
            <SectorInput label="기타 단일 섹터" value={etc} onChange={setEtc} />
          </div>
        </div>

        <div className="border-t border-white/[0.06]" />

        {/* 트레일링 스탑 */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-300">트레일링 스탑 기준</p>
          <p className="text-[11px] text-slate-500">수익 +3% 이상일 때 활성화. 고점 대비 이 값 이상 하락하면 전량 매도합니다.</p>
          <div className="flex items-center gap-3">
            <input type="range" min={2} max={15} step={1} value={trailStop}
              onChange={e => setTrailStop(Number(e.target.value))}
              className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer accent-orange-500" />
            <span className="text-sm font-bold text-orange-400 w-12 text-right">-{trailStop}%</span>
          </div>
          <p className="text-[10px] text-slate-600">예: -{trailStop}% → 고점 100만원이면 {(100 * (1 - trailStop / 100)).toFixed(0)}만원 이탈 시 매도</p>
        </div>

        <button onClick={save} disabled={!krUsValid}
          className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-xl text-xs font-semibold transition-all">
          저장
        </button>
      </div>
    </Panel>
  );
}

function SettingsView({ strategy, setStrategy, secrets, notebookRef, geminiRef, gptRef, claudeRef, killSwitch, toggleKill, withdrawConfig, setWithdrawConfig, withdrawHistory, setWithdrawHistory, allocConfig, setAllocConfig, toast }: any) {
  const [activeStep, setActiveStep] = useState<number>(0);
  const [nbSources, setNbSources] = useState<NbSource[]>(() => parseNbSources(strategy?.notebooklm_prompt));
  const [nbAddTitle, setNbAddTitle] = useState('');
  const [nbAddContent, setNbAddContent] = useState('');
  const [nbAdding, setNbAdding] = useState(false);
  const [nbEditId, setNbEditId] = useState<string | null>(null);
  const [nbEditTitle, setNbEditTitle] = useState('');
  const [nbEditContent, setNbEditContent] = useState('');
  const [nbPendingDeleteId, setNbPendingDeleteId] = useState<string | null>(null);

  // 프롬프트 로컬 상태 — strategy 최초 로드 시 한 번만 초기화, 이후 30초 폴링에 영향 받지 않음
  const DEFAULT_STRATEGY_DOC = `# 매매 전략서

## 투자 철학
- 추세 추종 + 분할 매수(3회)로 리스크 분산
- 손절은 기계적으로, 익절은 단계적으로
- 모의투자 단계 — 적극적 자동매매로 전략 검증이 최우선

## 종목 선정 기준
- AI 점수 70점 이상 + 기술적 점수 상위 종목 우선
- 반도체·방산·에너지 테마 종목 적극 편입 (시장 주도 섹터)
- 바이오 종목은 이벤트(임상결과·FDA) 없으면 보수적 접근
- 14일 내 손절 이력 종목 재진입 금지

## 매매 규칙
- 1종목 최대 투자금: 총 자산의 25%
- 분할 매수: 1차 진입 후 -3% 물타기 최대 2회
- 부분 익절 후 트레일링 스톱 자동 적용
- 당일 신규 매수는 장 시작 30분 이후부터

## 시장 상황별 대응
### 상승장 (코스피 +1% 이상)
- 공격적 비중 확대, 우선 테마 종목 비중 20% 추가

### 횡보장
- 스윙 비중 유지, 손절 기준 엄격 적용

### 하락장 / 갭다운 3% 이상
- 신규 매수 금지, 기존 포지션 손절 기준 절반으로 타이트하게
- 현금 비중 50% 이상 유지`;

  const DEFAULT_RISK_PROMPT = `## 리스크 운영 지시사항

### 일별 손실 한도 초과 시
- 당일 추가 매수 완전 금지
- 기존 포지션 손절 기준 절반으로 타이트하게 운영
- 다음날 장 시작 전 Track A 재분석 후 전략 재평가

### 급락 감지 시 (갭다운 -3% 이상 또는 장중 -2% 급락)
- 개장 후 30분간 신규 매수 완전 금지
- 기존 포지션 평가손 -5% 이상이면 즉시 청산
- 반등 시작 확인 후에만 신규 진입 허용

### 외부 충격 (정치·경제 뉴스) 감지 시
- 미국 관세·금리 인상·전쟁·대규모 파산 키워드 → 포지션 50% 즉시 축소
- 대통령/연준 의장 발언 예정일 → 당일 신규 매수 금지
- 외환위기 징후 (원/달러 급등) → 해외주식 비중 확대, 국내 현금화

### 연속 손실 시 (3거래일 연속 마이너스)
- 매매 사이즈 절반으로 축소
- Track A 재실행 후 포트폴리오 전면 재검토
- 손절 패턴 있는 종목은 watchlist에서 즉시 제거

### 수익 실현 원칙
- 누적 수익 10% 달성 시 수익분 30% 인출 예약 자동 설정
- 인출 후 남은 원금으로 동일 전략 반복`;

  const [geminiPrompt, setGeminiPrompt] = useState<string>(() => strategy?.gemini_prompt ?? '');
  const [claudePrompt, setClaudePrompt] = useState<string>(() => strategy?.claude_prompt ?? '');
  const [strategyDoc, setStrategyDoc] = useState<string>(() => strategy?.strategy_document || DEFAULT_STRATEGY_DOC);
  const [riskPrompt, setRiskPrompt] = useState<string>(() => strategy?.risk_prompt || DEFAULT_RISK_PROMPT);
  const [strategyDocTab, setStrategyDocTab] = useState<'doc' | 'risk'>('doc');
  const promptsInitialized = React.useRef(false);
  React.useEffect(() => {
    if (!promptsInitialized.current && strategy) {
      setGeminiPrompt(strategy.gemini_prompt ?? '');
      setClaudePrompt(strategy.claude_prompt ?? '');
      setStrategyDoc(strategy.strategy_document || DEFAULT_STRATEGY_DOC);
      setRiskPrompt(strategy.risk_prompt || DEFAULT_RISK_PROMPT);
      promptsInitialized.current = true;
    }
  }, [strategy]);

  // strategy 바뀌면 소스 파싱
  React.useEffect(() => {
    setNbSources(parseNbSources(strategy?.notebooklm_prompt));
  }, [strategy?.notebooklm_prompt]);

  const setField = async (field: string, val: string | number) => {
    const body = {
      ...strategy,
      notebooklm_prompt: JSON.stringify(nbSources),
      gemini_prompt: geminiPrompt,
      claude_prompt: claudePrompt,
      [field]: val,
    };
    try { const u = await api('/strategy', { method: 'PUT', body: JSON.stringify(body) }); setStrategy(u); toast?.('설정 저장됨', 'ok'); } catch { toast?.('설정 저장 실패', 'err'); }
  };
  const saveStrategy = async () => {
    const body = {
      ...strategy,
      notebooklm_prompt: JSON.stringify(nbSources),
      gemini_prompt: geminiPrompt,
      claude_prompt: claudePrompt,
      strategy_document: strategyDoc,
      risk_prompt: riskPrompt,
    };
    try { const u = await api('/strategy', { method: 'PUT', body: JSON.stringify(body) }); setStrategy(u); toast?.('프롬프트 저장 완료', 'ok'); } catch (err: any) { toast?.(err.message, 'err'); }
  };
  const saveStrategyDoc = async () => {
    const body = {
      ...strategy,
      notebooklm_prompt: JSON.stringify(nbSources),
      gemini_prompt: geminiPrompt,
      claude_prompt: claudePrompt,
      strategy_document: strategyDoc,
      risk_prompt: riskPrompt,
    };
    try { const u = await api('/strategy', { method: 'PUT', body: JSON.stringify(body) }); setStrategy(u); toast?.('전략서 저장 완료', 'ok'); } catch (err: any) { toast?.(err.message, 'err'); }
  };
  const saveSecrets = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body: Record<string, string> = {};
    fd.forEach((v, k) => { if (typeof v === 'string' && v.trim()) body[k] = v.trim(); });
    if (!Object.keys(body).length) { toast?.('변경할 키를 입력하세요', 'info'); return; }
    try { await api('/secrets', { method: 'PUT', body: JSON.stringify(body) }); (e.target as HTMLFormElement).reset(); toast?.('API 키 저장 완료', 'ok'); } catch (err: any) { toast?.(err.message, 'err'); }
  };

  const steps = [
    { label: '참고 소스', sub: '소스 관리', color: 'amber', key: 'notebooklm_prompt',
      value: null, onChange: null,
      desc: 'AI 분석에 참고할 자료(뉴스 요약, 리서치 핵심 포인트)를 추가·삭제하세요. 여기서 등록한 소스가 매일 분석의 입력으로 사용됩니다.',
      placeholder: '' },
    { label: '분석 지시', sub: 'AI 분석 설정', color: 'blue', key: 'gemini_prompt',
      value: geminiPrompt, onChange: (v: string) => setGeminiPrompt(v),
      desc: 'AI가 종목을 분석할 때 따라야 할 규칙을 적어주세요. 예: "기관이 3일 이상 순매수한 종목만 보기", "소형주 제외" 등.',
      placeholder: `## CEO 추가 지시사항\n\n### 분석 우선순위\n1. 기관/외국인 수급 데이터를 최우선으로 분석하라. 3일 연속 순매수 종목만 주목.\n2. 최근 실적(영업이익) 증가 확인 필수. 적자전환 또는 실적 악화 종목은 즉시 제외.\n3. 52주 고점 대비 -10%~-25% 구간의 눌림목 종목을 우선 분석.\n\n### 제외 조건\n- 시가총액 5000억 미만 소형주\n- 테마주/급등주 (하루 +15% 이상)\n- 최근 30일 내 유상증자/CB 발행 종목` },
    { label: '매매 지시', sub: '매수·매도 규칙', color: 'emerald', key: 'claude_prompt',
      value: claudePrompt, onChange: (v: string) => setClaudePrompt(v),
      desc: 'AI가 실제로 사고팔 때 지켜야 할 규칙을 적어주세요. 예: "장 시작 30분은 매수 금지", "손절은 반드시 지켜라" 등.',
      placeholder: `## 매매 실행 추가 규칙\n\n### 매수 원칙\n- 장 시작 30분(09:00~09:30) 매수 금지\n- 14:30 이후 신규 매수 금지\n- 동일 종목 하루 1회만 매수\n\n### 매도 원칙\n- 손절은 반드시 지켜라. 감정적 판단 금지.\n- 2일 연속 하락 + 거래량 증가 시 즉시 매도\n- 익절 시 "조금 더" 판단 금지, 기계적 실행` },
  ];
  const colorMap: Record<string, { bg: string; border: string; text: string; dot: string; grad: string; activeBg: string }> = {
    amber:   { bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   text: 'text-amber-400',   dot: 'bg-amber-400',   grad: 'from-amber-500 to-orange-500', activeBg: 'bg-amber-950/20' },
    blue:    { bg: 'bg-blue-500/10',     border: 'border-blue-500/20',    text: 'text-blue-400',    dot: 'bg-blue-400',    grad: 'from-blue-500 to-cyan-500',    activeBg: 'bg-blue-950/20' },
    purple:  { bg: 'bg-purple-500/10',   border: 'border-purple-500/20',  text: 'text-purple-400',  dot: 'bg-purple-400',  grad: 'from-purple-500 to-pink-500',  activeBg: 'bg-purple-950/20' },
    emerald: { bg: 'bg-emerald-500/10',  border: 'border-emerald-500/20', text: 'text-emerald-400', dot: 'bg-emerald-400', grad: 'from-emerald-500 to-teal-500', activeBg: 'bg-emerald-950/20' },
  };

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* ── KIS 미설정 경고 ── */}
      {(!secrets?.kis_appkey?.exists || !secrets?.kis_appsecret?.exists) && (
        <div className="bg-amber-950/30 border border-amber-500/20 rounded-2xl p-4 flex items-start gap-3">
          <span className="text-amber-400 text-lg shrink-0">!</span>
          <div>
            <p className="text-sm font-bold text-amber-300">한국투자증권 API 키 미설정</p>
            <p className="text-[11px] text-slate-400 mt-1">실전 매매를 위해 아래 API 키 관리에서 KIS Key, Secret, 계좌번호를 입력하세요. 현재 모의투자 모드로 동작합니다.</p>
          </div>
        </div>
      )}

      {/* ── 상단: 킬스위치 + AI 실행 ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Panel title="긴급 제어">
          <div className="px-6 py-5 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">자동매매 제어</p>
              <p className={`text-[12px] mt-1 font-medium ${killSwitch?.active ? 'text-rose-400' : 'text-emerald-400'}`}>
                현재: {killSwitch?.active ? '매매 중단 (수동)' : '자동매매 실행 중'}
              </p>
              {killSwitch?.reason && <p className="text-[11px] text-slate-500 mt-1">{killSwitch.reason}</p>}
            </div>
            <button onClick={toggleKill} className={`px-5 py-2.5 rounded-xl text-xs font-semibold transition-all shrink-0 ${killSwitch?.active ? 'bg-emerald-700 hover:bg-emerald-600 text-white' : 'bg-rose-700 hover:bg-rose-600 text-white'}`}>
              {killSwitch?.active ? '▶ 자동매매 재개' : '⏸ 자동매매 중단'}
            </button>
          </div>
        </Panel>
        <Panel title="알림 설정">
          <div className="px-6 py-5 space-y-4">
            {/* 상태 표시 바 */}
            <div className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.04] border border-white/[0.07]">
              <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                pushStatus.permissionState === 'unsupported' ? 'bg-slate-600' :
                pushStatus.permissionState === 'denied' ? 'bg-red-500' :
                pushStatus.subscribed && pushStatus.ready ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)] animate-pulse' :
                'bg-amber-400'
              }`} />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-slate-200">
                  {pushStatus.permissionState === 'unsupported' ? '알림 미지원 브라우저' :
                   pushStatus.permissionState === 'denied' ? '알림 권한 차단됨' :
                   !pushStatus.ready ? '서버 알림 초기화 중...' :
                   pushStatus.subscribed ? '알림 활성 — 실시간 수신 중' :
                   '알림 미등록'}
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {pushStatus.permissionState === 'denied'
                    ? '브라우저 주소창 자물쇠 → 알림 → 허용으로 변경 후 새로고침'
                    : pushStatus.subscribed && pushStatus.ready
                    ? `등록 기기 ${pushStatus.deviceCount}대 · 매수/매도/긴급 알림 즉시 수신`
                    : !pushStatus.ready
                    ? 'VAPID 키 로드 중 — 잠시 후 버튼을 눌러주세요'
                    : '아래 버튼으로 이 기기에 알림을 등록하세요'}
                </p>
              </div>
              {pushStatus.subscribed && (
                <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full shrink-0 font-medium">ON</span>
              )}
            </div>

            {/* 에러 메시지 */}
            {pushStatus.error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                <p className="text-[11px] text-red-400 font-medium">❌ 등록 실패</p>
                <p className="text-[11px] text-slate-400 mt-1">{pushStatus.error}</p>
              </div>
            )}

            {/* 버튼 영역 */}
            <div className="flex gap-2">
              <button
                disabled={pushStatus.registering || pushStatus.permissionState === 'denied' || pushStatus.permissionState === 'unsupported'}
                onClick={async () => {
                  setPushStatus(prev => ({ ...prev, registering: true, error: null }));
                  try {
                    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
                      setPushStatus(prev => ({ ...prev, registering: false, error: '이 브라우저는 푸시 알림을 지원하지 않습니다. iOS는 사파리에서 홈 화면에 추가 후 사용하세요.' }));
                      return;
                    }
                    const permission = await Notification.requestPermission();
                    if (permission !== 'granted') {
                      setPushStatus(prev => ({ ...prev, registering: false, permissionState: 'denied', error: '알림 권한이 거부되었습니다. 브라우저 주소창 자물쇠 아이콘 → 알림 → 허용으로 변경해주세요.' }));
                      return;
                    }
                    // VAPID 키 최신 로드
                    const serverStatus = await api('/push/status');
                    if (!serverStatus.ready || !serverStatus.publicKey) {
                      setPushStatus(prev => ({ ...prev, registering: false, error: '서버 알림 키 초기화 중입니다. 10초 후 다시 시도해주세요.' }));
                      return;
                    }
                    const reg = await navigator.serviceWorker.ready;
                    const existing = await reg.pushManager.getSubscription();
                    if (existing) await existing.unsubscribe();
                    const sub = await reg.pushManager.subscribe({
                      userVisibleOnly: true,
                      applicationServerKey: serverStatus.publicKey,
                    });
                    await api('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
                    setPushStatus(prev => ({
                      ...prev,
                      registering: false,
                      subscribed: true,
                      ready: true,
                      permissionState: 'granted',
                      deviceCount: serverStatus.deviceCount + 1,
                      error: null,
                    }));
                    toast?.('이 기기에 알림 등록 완료 — 매수/매도 즉시 알림됩니다', 'ok');
                  } catch (err: any) {
                    setPushStatus(prev => ({ ...prev, registering: false, error: err.message || '알 수 없는 오류' }));
                  }
                }}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-xs font-semibold transition-all flex items-center justify-center gap-1.5"
              >
                {pushStatus.registering ? (
                  <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin inline-block" /> 등록 중...</>
                ) : pushStatus.subscribed ? '📱 이 기기 재등록' : '📱 이 기기에 등록'}
              </button>
              <button
                onClick={async () => {
                  try {
                    const res = await api('/push/test', { method: 'POST' });
                    if (res.ok) toast?.('테스트 알림 전송 완료', 'ok');
                    else toast?.('서버 알림 미준비 — 기기 등록 먼저', 'error');
                  } catch {
                    toast?.('테스트 실패 — 기기 등록 여부 확인', 'error');
                  }
                }}
                className="px-4 py-2.5 bg-white/[0.06] hover:bg-white/[0.1] rounded-xl text-xs text-slate-400 transition-all shrink-0"
              >테스트</button>
            </div>

            {/* 알림 종류 안내 */}
            <div className="grid grid-cols-2 gap-2">
              {[
                { icon: '🟢', label: '매수 체결', desc: '종목·수량·금액 즉시' },
                { icon: '🔻', label: '매도/손절', desc: '손익률·금액 포함' },
                { icon: '🎉', label: '목표 수익', desc: '+5% 이상 매도 시' },
                { icon: '⚠️', label: '긴급 알림', desc: '킬스위치·시장 이상' },
              ].map(({ icon, label, desc }) => (
                <div key={label} className="flex items-start gap-2 p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.05]">
                  <span className="text-base leading-none mt-0.5">{icon}</span>
                  <div>
                    <p className="text-[11px] font-medium text-slate-300">{label}</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">{desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* 기기 추가 안내 */}
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
              <p className="text-[11px] text-amber-400 font-medium mb-1">📱 폰·태블릿에서도 받으려면</p>
              <p className="text-[11px] text-slate-400">각 기기 브라우저에서 이 페이지를 열고 <b className="text-slate-300">"이 기기에 등록"</b>을 누르세요. 기기마다 따로 등록해야 합니다.</p>
              <p className="text-[11px] text-slate-500 mt-1">iPhone: 사파리 → 공유 → 홈 화면에 추가 → 홈 화면 앱에서 열기 → 등록</p>
            </div>
          </div>
        </Panel>
      </div>
      {/* ── 전략 설정 ── */}
      {strategy && (
        <Panel title="전략 설정" badge={strategy.mode === 'SWING' ? '스윙' : strategy.mode === 'DEFENSE' ? '방어' : '단타'} badgeColor={strategy.mode === 'SWING' ? 'blue' : strategy.mode === 'DEFENSE' ? 'rose' : 'amber'}>
          <div className="px-6 py-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Sel label="매매 방식" value={strategy.mode} opts={[['SWING','스윙 (중단기)'],['DEFENSE','방어 (하락장)'],['SCALPING','단타 (당일)']]} onChange={v => setField('mode', v)} />
              <Sel label="AI 매수 기준점수" value={strategy.buy_threshold} opts={[[50,'50점'],[55,'55점'],[58,'58점 (기본)'],[60,'60점'],[65,'65점'],[70,'70점'],[75,'75점'],[80,'80점']]} onChange={v => setField('buy_threshold', Number(v))} />
              <Sel label="손절 기준" value={strategy.stop_loss_pct} opts={[[-1.5,'-1.5% (타이트)'],[-2,'-2%'],[-2.5,'-2.5% (권장)'],[-3,'-3%'],[-4,'-4%'],[-5,'-5% (여유)']]} onChange={v => setField('stop_loss_pct', Number(v))} />
              <Sel label="익절 기준" value={strategy.take_profit_pct} opts={[[2,'+2%'],[2.5,'+2.5%'],[3,'+3%'],[3.5,'+3.5% (권장)'],[4,'+4%'],[5,'+5%'],[7,'+7%']]} onChange={v => setField('take_profit_pct', Number(v))} />
            </div>
          </div>
        </Panel>
      )}

      {/* ── 전략서 + 리스크 운영 프롬프트 ── */}
      {strategy && (
        <div className="glass rounded-2xl overflow-hidden shadow-xl shadow-black/40">
          <div className="px-6 py-4 border-b border-white/[0.05] flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-100">나의 매매 철학 & 위기 대응</h3>
              <p className="text-[11px] text-slate-500 mt-0.5">AI가 판단을 내릴 때 참고하는 나만의 투자 원칙을 적어두세요</p>
            </div>
            <button onClick={saveStrategyDoc} className="px-4 py-2.5 bg-violet-600 hover:bg-violet-500 rounded-xl text-xs font-semibold transition-all">저장</button>
          </div>
          {/* 탭 */}
          <div className="flex border-b border-white/[0.04]">
            {([['doc', '전략서', '매매 철학·원칙'], ['risk', '리스크 프롬프트', 'AI 리스크 판단 지시']] as const).map(([id, label, sub]) => (
              <button key={id} onClick={() => setStrategyDocTab(id)}
                className={`flex-1 py-3 px-4 text-left transition-all relative ${strategyDocTab === id ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]'}`}>
                {strategyDocTab === id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-violet-500 to-fuchsia-500" />}
                <div className="text-[11px] font-bold text-slate-200">{label}</div>
                <div className="text-[9px] text-slate-600 mt-0.5">{sub}</div>
              </button>
            ))}
          </div>
          {strategyDocTab === 'doc' && (
            <div className="p-4 sm:p-5 bg-violet-950/10">
              <p className="text-[11px] text-slate-400 mb-3">
                매매 철학, 종목 선정 기준, 시장 상황별 대응 원칙 등을 자유롭게 작성하세요.
                AI 분석 맥락에 주입됩니다.
              </p>
              <textarea
                value={strategyDoc}
                onChange={e => setStrategyDoc(e.target.value)}
                rows={16}
                placeholder={`# 매매 전략서\n\n## 투자 철학\n- 추세 추종 + 분할 매수로 리스크 분산\n- 손절은 기계적으로, 익절은 단계적으로\n\n## 종목 선정 기준\n- 기관/외국인 수급 3일 연속 순매수\n- 52주 고점 대비 -10~-25% 눌림목\n- 최근 분기 실적 개선 확인 필수\n\n## 시장 상황별 대응\n### 상승장\n- 공격적 비중 확대, 익절 기준 상향\n\n### 횡보장\n- 스윙 비중 유지, 손절 기준 엄격 적용\n\n### 하락장 / 급락 시\n- 신규 매수 최소화, 기존 포지션 축소\n- 현금 비중 50% 이상 유지\n- RSS/뉴스 이상 신호 감지 시 즉시 킬스위치`}
                className="w-full bg-white/[0.04] border-0 ring-1 ring-violet-500/20 rounded-xl px-4 py-3.5 text-[12px] leading-relaxed resize-y font-mono text-slate-200 placeholder:text-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500/40 transition-all"
              />
            </div>
          )}
          {strategyDocTab === 'risk' && (
            <div className="p-4 sm:p-5 bg-rose-950/10">
              <p className="text-[11px] text-slate-400 mb-3">
                리스크 상황별 AI 판단 지시사항입니다. 급락장·하락장 대응, 포지션 축소 기준, 대통령 발언 등 외부 충격 대응 원칙을 작성하세요.
              </p>
              <textarea
                value={riskPrompt}
                onChange={e => setRiskPrompt(e.target.value)}
                rows={16}
                placeholder={`## 리스크 운영 지시사항\n\n### 하락장 감지 시\n- 전 종목 신규 매수 금지\n- 기존 포지션 -3% 이상 손실이면 즉시 청산\n- 현금 비중 60% 이상 유지\n\n### 급락 (-3% 이상 갭다운) 시\n- 개장 30분간 매수 완전 금지\n- 손절 기준 절반으로 타이트하게 운영\n\n### 외부 충격 (정치·경제 뉴스) 감지 시\n- RSS 뉴스에 미국 관세·금리·전쟁 키워드 → 포지션 50% 이상 즉시 축소\n- 대통령/연준 발언 → 당일 신규 매수 금지\n\n### 연속 손실 시 (3회 이상)\n- 매매 사이즈 절반으로 줄이기\n- Track A 재분석 후 재진입 여부 결정`}
                className="w-full bg-white/[0.04] border-0 ring-1 ring-rose-500/20 rounded-xl px-4 py-3.5 text-[12px] leading-relaxed resize-y font-mono text-slate-200 placeholder:text-slate-700 focus:outline-none focus:ring-2 focus:ring-rose-500/40 transition-all"
              />
            </div>
          )}
        </div>
      )}

      {/* ── AI 파이프라인 프롬프트 (탭 UI) ── */}
      {strategy && (
        <div className="glass rounded-2xl overflow-hidden shadow-xl shadow-black/40">
          {/* 헤더 + 저장 버튼 */}
          <div className="px-6 py-4 border-b border-white/[0.05] flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-100">AI 매매 지시 설정</h3>
              <p className="text-[11px] text-slate-500 mt-0.5">AI가 분석하고 매매할 때 따르는 규칙을 탭별로 설정합니다</p>
            </div>
            <button onClick={saveStrategy} className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-xs font-semibold transition-all">저장</button>
          </div>

          {/* 스텝 네비게이션 (가로 탭) */}
          <div className="flex border-b border-white/[0.04]">
            {steps.map((s, i) => {
              const sc = colorMap[s.color];
              const active = i === activeStep;
              return (
                <button key={s.label} onClick={() => setActiveStep(i)}
                  className={`flex-1 py-3 px-2 text-center transition-all relative ${active ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]'}`}>
                  {active && <div className={`absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r ${sc.grad}`} />}
                  <div className="flex items-center justify-center gap-1.5">
                    <div className={`w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-black ${active ? `${sc.bg} ${sc.border} border ${sc.text}` : 'bg-slate-800 text-slate-500'}`}>{i + 1}</div>
                    <div className="text-left hidden sm:block">
                      <div className={`text-[11px] font-bold ${active ? sc.text : 'text-slate-400'}`}>{s.label}</div>
                      <div className="text-[9px] text-slate-600">{s.sub}</div>
                    </div>
                    <div className={`sm:hidden text-[11px] font-bold ${active ? sc.text : 'text-slate-400'}`}>{s.label}</div>
                  </div>
                  {i < steps.length - 1 && <span className="absolute right-0 top-1/2 -translate-y-1/2 text-slate-700 text-[10px]">&rarr;</span>}
                </button>
              );
            })}
          </div>

          {/* 모든 스텝 콘텐츠 (숨김 포함 — ref 유지를 위해 항상 렌더링) */}
          {steps.map((s, i) => {
            const sc = colorMap[s.color];
            const hidden = i !== activeStep;

            // ── Step 0: NotebookLM 소스 관리 ──
            if (i === 0) return (
              <div key={s.label} className={`p-4 sm:p-5 ${sc.activeBg} ${hidden ? 'hidden' : ''}`}>
                <p className="text-[11px] text-slate-400 mb-3">{s.desc}</p>

                {/* 소스 목록 */}
                <div className="space-y-2 mb-3">
                  {nbSources.length === 0 && (
                    <div className="text-[11px] text-slate-500 bg-slate-900/40 rounded-lg p-3 text-center">
                      소스가 없습니다. 아래에서 추가하세요.
                    </div>
                  )}
                  {nbSources.map((src) => {
                    const daysOld = src.created_at ? Math.floor((Date.now() - new Date(src.created_at).getTime()) / 86400000) : null;
                    const isHarmful = src.harm_suspected === true;
                    const isPendingDelete = nbPendingDeleteId === src.id;
                    return (
                    <div key={src.id} className={`bg-slate-900/60 border rounded-lg p-3 transition-all ${isHarmful ? 'border-rose-600/50 bg-rose-950/10' : 'border-amber-900/20'}`}>
                      {nbEditId === src.id ? (
                        <div className="space-y-2">
                          <input value={nbEditTitle} onChange={e => setNbEditTitle(e.target.value)}
                            className="w-full bg-white/[0.05] border-0 ring-1 ring-white/[0.1] rounded-xl px-3.5 py-2.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 transition-all" />
                          <textarea value={nbEditContent} onChange={e => setNbEditContent(e.target.value)} rows={6}
                            className="w-full bg-white/[0.05] border-0 ring-1 ring-white/[0.1] rounded-xl px-3.5 py-2.5 text-[11px] leading-relaxed resize-y font-mono text-slate-300 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 transition-all" />
                          <div className="flex gap-2">
                            <button onClick={() => {
                              setNbSources(prev => prev.map(x => x.id === src.id ? { ...x, title: nbEditTitle, content: nbEditContent } : x));
                              setNbEditId(null);
                            }} className="px-3 py-1 bg-amber-600 hover:bg-amber-500 rounded text-[11px] font-bold">저장</button>
                            <button onClick={() => setNbEditId(null)} className="px-3 py-1 bg-slate-700 rounded text-[11px] text-slate-400">취소</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-[11px] font-semibold text-amber-300 truncate">{src.title || '제목 없음'}</p>
                              {isHarmful && (
                                <span className="text-[9px] px-1.5 py-0.5 bg-rose-900/60 text-rose-300 rounded-full shrink-0 animate-pulse">⚠️ 수익 악영향 의심</span>
                              )}
                              {daysOld !== null && (
                                <span className="text-[9px] text-slate-600">{daysOld}일 전 등록</span>
                              )}
                            </div>
                            <p className="text-[10px] text-slate-400 mt-1 whitespace-pre-wrap line-clamp-3">{src.content}</p>
                          </div>
                          <div className="flex flex-col gap-1 shrink-0">
                            <button onClick={() => { setNbEditId(src.id); setNbEditTitle(src.title); setNbEditContent(src.content); setNbPendingDeleteId(null); }}
                              className="text-[10px] px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded">수정</button>
                            {/* 악영향 의심 토글 */}
                            <button onClick={() => setNbSources(prev => prev.map(x => x.id === src.id ? { ...x, harm_suspected: !x.harm_suspected } : x))}
                              className={`text-[9px] px-2 py-1 rounded transition-all ${isHarmful ? 'bg-rose-900/60 text-rose-300' : 'bg-slate-800 text-slate-500 hover:text-amber-400'}`}>
                              {isHarmful ? '⚠️ 플래그됨' : '⚠️ 악영향?'}
                            </button>
                            {/* 2단계 삭제 승인 */}
                            {isPendingDelete ? (
                              <button onClick={() => { setNbSources(prev => prev.filter(x => x.id !== src.id)); setNbPendingDeleteId(null); }}
                                className="text-[10px] px-2 py-1 bg-rose-600 text-white rounded font-bold animate-pulse">승인 삭제</button>
                            ) : (
                              <button onClick={() => setNbPendingDeleteId(src.id)}
                                className="text-[10px] px-2 py-1 bg-rose-900/40 text-rose-400 hover:bg-rose-800/40 rounded">삭제</button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>

                {/* 소스 추가 폼 */}
                {nbAdding ? (
                  <div className="bg-slate-900/60 border border-amber-700/30 rounded-lg p-3 space-y-2">
                    <input value={nbAddTitle} onChange={e => setNbAddTitle(e.target.value)}
                      placeholder="소스 제목 (예: 이번 주 시장 전망)"
                      className="w-full bg-white/[0.05] border-0 ring-1 ring-white/[0.1] rounded-xl px-3.5 py-2.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 transition-all" />
                    <textarea value={nbAddContent} onChange={e => setNbAddContent(e.target.value)}
                      placeholder="뉴스 요약, 리서치 핵심 포인트 등 AI 분석에 참고할 내용을 붙여넣으세요..."
                      rows={6}
                      className="w-full bg-white/[0.05] border-0 ring-1 ring-white/[0.1] rounded-xl px-3.5 py-2.5 text-[11px] leading-relaxed resize-y font-mono text-slate-300 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 transition-all" />
                    <div className="flex gap-2">
                      <button onClick={() => {
                        if (!nbAddContent.trim()) return;
                        setNbSources(prev => [...prev, { id: crypto.randomUUID(), title: nbAddTitle.trim() || `소스 ${prev.length + 1}`, content: nbAddContent.trim(), created_at: new Date().toISOString() }]);
                        setNbAddTitle(''); setNbAddContent(''); setNbAdding(false);
                      }} className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 rounded text-[11px] font-bold">추가</button>
                      <button onClick={() => { setNbAdding(false); setNbAddTitle(''); setNbAddContent(''); }}
                        className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-[11px] text-slate-400">취소</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setNbAdding(true)}
                    className="px-4 py-2 bg-amber-600/80 hover:bg-amber-600 rounded-lg text-[11px] font-bold">+ 소스 추가</button>
                )}
              </div>
            );

            // ── Steps 1–2: 텍스트에어리어 (controlled) ──
            return (
              <div key={s.label} className={`p-4 sm:p-5 ${sc.activeBg} ${hidden ? 'hidden' : ''}`}>
                <p className="text-[11px] text-slate-400 mb-3">{s.desc}</p>
                <textarea value={s.value ?? ''} onChange={e => s.onChange?.(e.target.value)} rows={10}
                  className="w-full bg-white/[0.04] border-0 ring-1 ring-white/[0.08] rounded-xl px-4 py-3.5 text-[11px] leading-relaxed resize-y font-mono text-slate-300 placeholder:text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition-all"
                  placeholder={s.placeholder} />
              </div>
            );
          })}
        </div>
      )}

      {/* ── 하단 2컬럼: API키 + 수익인출 ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-5">
        {/* API 키 */}
        <Panel title="API 키 관리">
          <form onSubmit={saveSecrets} autoComplete="off" className="px-6 py-5 space-y-3.5">
            {/* hidden dummy fields to absorb browser autofill */}
            <input type="text" name="fake_user" style={{ display: 'none' }} tabIndex={-1} />
            <input type="password" name="fake_pass" style={{ display: 'none' }} tabIndex={-1} />
            {[['gemini','Gemini AI'],['openai','OpenAI'],['anthropic','Anthropic AI'],['kis_appkey','KIS 앱키'],['kis_appsecret','KIS 시크릿'],['kis_account','KIS 계좌번호']].map(([k, l]) => (
              <div key={k} className="flex items-center gap-3">
                <span className="w-24 text-[12px] text-slate-400 shrink-0 font-medium">{l}</span>
                {secrets?.[k]?.exists && <span className="text-[9px] bg-emerald-900/40 text-emerald-400 px-2 py-0.5 rounded-full ring-1 ring-emerald-500/20 shrink-0">설정됨</span>}
                <input name={k} type="text" autoComplete="off" data-1p-ignore data-lpignore="true" placeholder={secrets?.[k]?.masked || '미설정'} className="flex-1 bg-white/[0.05] border-0 ring-1 ring-white/[0.08] rounded-xl px-3.5 py-2.5 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all [-webkit-text-security:disc]" />
              </div>
            ))}
            <button type="submit" className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-semibold transition-all mt-1">키 저장</button>
          </form>
        </Panel>

        {/* 수익 자동 인출 설정 */}
        <Panel title="수익 자동 인출">
          <div className="px-6 py-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <p className="text-[12px] text-slate-400">목표 수익률 달성 시 수익분 일부를 인출 예약금으로 잠금합니다</p>
              <button onClick={async () => {
                const next = !withdrawConfig?.is_active;
                try {
                  const updated = await api('/withdraw/config', { method: 'PUT', body: JSON.stringify({ ...withdrawConfig, is_active: next }) });
                  setWithdrawConfig({ ...updated, totalReserved: withdrawConfig?.totalReserved ?? 0 });
                } catch { toast?.('저장 실패', 'err'); }
              }} className={`px-5 py-2.5 rounded-xl text-xs font-semibold shrink-0 transition-all ${withdrawConfig?.is_active ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-white/[0.06] hover:bg-white/[0.1] text-slate-400'}`}>
                {withdrawConfig?.is_active ? 'ON' : 'OFF'}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <NumInput label="목표 수익률" value={withdrawConfig?.target_profit_pct ?? 10} suffix="%" min={1} max={100} step={0.5} onCommit={async v => {
                try { const u = await api('/withdraw/config', { method: 'PUT', body: JSON.stringify({ ...withdrawConfig, target_profit_pct: v }) }); setWithdrawConfig({ ...u, totalReserved: withdrawConfig?.totalReserved ?? 0 }); } catch { toast?.('저장 실패', 'err'); }
              }} />
              <NumInput label="인출 비율 (수익분 중)" value={withdrawConfig?.withdraw_ratio_pct ?? 50} suffix="%" min={1} max={100} step={1} onCommit={async v => {
                try { const u = await api('/withdraw/config', { method: 'PUT', body: JSON.stringify({ ...withdrawConfig, withdraw_ratio_pct: v }) }); setWithdrawConfig({ ...u, totalReserved: withdrawConfig?.totalReserved ?? 0 }); } catch { toast?.('저장 실패', 'err'); }
              }} />
            </div>

            {withdrawConfig?.totalReserved > 0 && (
              <div className="bg-amber-950/20 border border-amber-900/20 rounded-lg p-3">
                <p className="text-xs text-amber-400 font-medium">인출 예약금: {fmtWon(withdrawConfig.totalReserved)}</p>
                <p className="text-[10px] text-slate-500 mt-1">한국투자증권 앱에서 본인 계좌로 이체하세요</p>
              </div>
            )}

            {/* 인출 내역 */}
            {withdrawHistory?.length > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] text-slate-500 font-medium">인출 내역</p>
                <div className="max-h-40 overflow-y-auto divide-y divide-slate-800/20">
                  {withdrawHistory.map((w: any) => (
                    <div key={w.id} className="flex items-center gap-2 py-2 text-[11px]">
                      <span className={`w-1.5 h-1.5 rounded-full ${w.status === 'reserved' ? 'bg-amber-400' : w.status === 'withdrawn' ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                      <span className="font-medium">{fmtWon(w.amount)}</span>
                      <span className="text-slate-500">수익률 {Number(w.profit_pct_at_trigger).toFixed(1)}%</span>
                      <span className="text-slate-600 ml-auto">{fmtTime(w.created_at)}</span>
                      {w.status === 'reserved' && (
                        <button onClick={async () => {
                          await api(`/withdraw/${w.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'withdrawn' }) });
                          setWithdrawHistory(withdrawHistory.map((h: any) => h.id === w.id ? { ...h, status: 'withdrawn' } : h));
                          setWithdrawConfig({ ...withdrawConfig, totalReserved: (withdrawConfig?.totalReserved ?? 0) - w.amount });
                        }} className="text-[10px] text-emerald-400 hover:text-emerald-300">인출 완료</button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="text-[10px] text-slate-600 space-y-1">
              <p>* 인출 예약금은 자동매매에 사용되지 않습니다</p>
              <p>* 실제 출금: 한국투자증권 앱 → 출금 → 본인 은행계좌</p>
            </div>
          </div>
        </Panel>
      </div>

      {/* ── 황금비율 포트폴리오 배분 ── */}
      <GoldenRatioPanel allocConfig={allocConfig} setAllocConfig={setAllocConfig} toast={toast} />

      {/* ── 앱 보안 ── */}
      <Panel title="앱 보안">
        <div className="px-6 py-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="text-[12px] text-slate-500 shrink-0 font-medium">잠금 PIN 변경</p>
            <form onSubmit={async (e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const newPin = String(fd.get('pin') ?? '').trim();
              if (newPin.length < 4) { alert('PIN은 4자리 이상'); return; }
              const data = new TextEncoder().encode(newPin);
              const hash = await crypto.subtle.digest('SHA-256', data);
              const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
              localStorage.setItem('quantops_pin', hex);
              toast?.('PIN 변경 완료', 'ok');
              (e.target as HTMLFormElement).reset();
            }} className="flex gap-2.5 flex-1 max-w-sm">
              <input name="pin" type="password" inputMode="numeric" autoComplete="new-password" data-1p-ignore data-lpignore="true" maxLength={6} placeholder="새 PIN (4~6자리)" className="flex-1 bg-white/[0.05] border-0 ring-1 ring-white/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-center tracking-widest font-mono text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all" />
              <button type="submit" className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-semibold shrink-0 transition-all">변경</button>
            </form>
            <button type="button" onClick={() => {
              localStorage.removeItem('quantops_cred_id');
              localStorage.removeItem('quantops_auth_ts');
              toast?.('생체인증 초기화 완료', 'ok');
            }} className="text-[11px] text-slate-600 hover:text-slate-400 shrink-0 transition-colors">생체인증 초기화</button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

