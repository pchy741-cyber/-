'use client';

import React, { useState, useEffect, useRef } from 'react';

// ═══════════════════════════════════════
// API
// ═══════════════════════════════════════

const BACKEND_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_API_BASE_URL || (window.location.port === '3000' ? 'http://localhost:8080' : window.location.origin))
    : (process.env.NEXT_PUBLIC_API_BASE_URL || '');

async function api(path: string, opts?: RequestInit & { timeout?: number }) {
  const base = BACKEND_URL.endsWith('/') ? BACKEND_URL.slice(0, -1) : BACKEND_URL;
  const ms = opts?.timeout ?? (path.includes('backtest') ? 120000 : path.includes('overseas') ? 15000 : 12000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    const { timeout: _, ...fetchOpts } = opts ?? {};
    const res = await fetch(`${base}/api${path}`, { ...fetchOpts, signal: controller.signal, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...fetchOpts?.headers } });
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
const fmtWon = (n: number | null | undefined) => n == null ? '-' : n.toLocaleString('ko-KR') + '원';
const fmtUsd = (n: number | null | undefined) => n == null ? '-' : '$' + (n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtTime = (t: string | null | undefined) => { if (!t) return '-'; const d = new Date(t); return `${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`; };
const pc = (n: number | null | undefined) => n == null || n === 0 ? 'text-slate-400' : n > 0 ? 'text-emerald-400' : 'text-rose-400';
const pbg = (n: number | null | undefined) => n == null || n === 0 ? '' : n > 0 ? 'bg-emerald-950/30 border-emerald-900/30' : 'bg-rose-950/30 border-rose-900/30';

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

// ── 로딩 버튼 ──
function LoadBtn({ children, onClick, className = '', disabled = false }: { children: React.ReactNode; onClick: () => Promise<void>; className?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button disabled={busy || disabled} onClick={async () => { setBusy(true); try { await onClick(); } finally { setBusy(false); } }}
      className={`${className} ${busy ? 'opacity-60 cursor-wait' : ''}`}>
      {busy ? <span className="flex items-center gap-1.5"><span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />{children}</span> : children}
    </button>
  );
}

// ═══════════════════════════════════════
// Dashboard
// ═══════════════════════════════════════

type Tab = 'home' | 'trades' | 'watchlist' | 'backtest' | 'settings';

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
        api('/trades?limit=50'), api('/secrets'),
        api('/withdraw/config').catch(() => null),
        api('/withdraw/history').catch(() => []),
      ]);
      if (w.status === 'fulfilled') setWatchlist(Array.isArray(w.value) ? w.value : []);
      if (s.status === 'fulfilled') setStrategy(s.value);
      if (t.status === 'fulfilled') setTrades(Array.isArray(t.value) ? t.value : []);
      if (sec.status === 'fulfilled') setSecrets(sec.value);
      if (wc.status === 'fulfilled' && wc.value) setWithdrawConfig(wc.value);
      if (wh.status === 'fulfilled') setWithdrawHistory(Array.isArray(wh.value) ? wh.value : []);

      // 3단계: 미국주식 별도 로드 (느려도 다른 데이터에 영향 없음)
      api('/overseas/dashboard').then(us => { if (us) setUsDash(us); }).catch(() => {});
    } catch (err) { setLoading(false); console.error('[QUANTOPS] 데이터 로드 실패:', err); }
    finally { loadingRef.current = false; }
  };

  useEffect(() => { load(); const iv = setInterval(load, 60000); return () => clearInterval(iv); }, []); // 60초 간격 (KIS rate limit 보호)

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

    { id: 'backtest', label: '백테스트', icon: '🧪' },
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
            className={`w-full py-2.5 rounded-xl text-[11px] font-bold transition-all ${killSwitch?.active ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/30' : 'bg-white/[0.04] hover:bg-white/[0.06] text-slate-500'}`}>
            {killSwitch?.active ? '수동' : '자동'}
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
          <button onClick={toggleKill} className={`ml-auto px-3 py-1.5 rounded-lg text-[10px] font-bold ${killSwitch?.active ? 'bg-rose-600 text-white' : 'bg-slate-800 text-slate-500'}`}>
            {killSwitch?.active ? '수동' : '자동'}
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
              {tab === 'home' && <HomeView dash={dash} health={health} killSwitch={killSwitch} trades={trades} usDash={usDash} withdrawConfig={withdrawConfig} watchlist={watchlist} onRefresh={load} />}
              {tab === 'trades' && <TradesView trades={trades} watchlist={watchlist} />}
              {tab === 'watchlist' && <WatchlistView watchlist={watchlist} setWatchlist={setWatchlist} dash={dash} usDash={usDash} />}

              {tab === 'backtest' && <BacktestView watchlist={watchlist} />}
              {tab === 'settings' && <SettingsView strategy={strategy} setStrategy={setStrategy} secrets={secrets} notebookRef={notebookRef} geminiRef={geminiRef} gptRef={gptRef} claudeRef={claudeRef} killSwitch={killSwitch} toggleKill={toggleKill} withdrawConfig={withdrawConfig} setWithdrawConfig={setWithdrawConfig} withdrawHistory={withdrawHistory} setWithdrawHistory={setWithdrawHistory} toast={toast} />}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// HOME VIEW
// ═══════════════════════════════════════

function HomeView({ dash, health, killSwitch, trades, usDash, withdrawConfig, watchlist, onRefresh }: any) {
  const p = dash?.portfolio;
  const stockNameMap = new Map((watchlist ?? []).map((w: any) => [w.stock_code, w.stock_name]));
  const getStockName = (code: string): string => String(stockNameMap.get(code) ?? code);
  const chains = dash?.chains || [];
  const usW = usDash?.watchlist || [];
  const filled = trades.filter((t: any) => t.status === 'FILLED');
  const todayTrades = filled.filter((t: any) => new Date(t.created_at).toDateString() === new Date().toDateString());

  const totalPnl = p?.pnl ?? 0;
  const totalPnlPct = p?.pnlPct ?? 0;
  const totalInvested = p?.invested ?? 0;
  const dailyLossLimit = dash?.riskLimits?.maxDailyDrawdownKrw ?? 200000;
  const investedPct = p?.totalValue > 0 ? Math.round((totalInvested / p.totalValue) * 100) : 0;

  // 로봇 일과 타임라인 계산
  const now = new Date();
  const marketStart = 9 * 60; // 09:00
  const marketEnd = 15 * 60 + 30; // 15:30
  const currentMin = now.getHours() * 60 + now.getMinutes();
  const marketProgress = health?.marketOpen ? Math.min(100, Math.max(0, ((currentMin - marketStart) / (marketEnd - marketStart)) * 100)) : 0;
  const currentTimeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;

  return (
    <div className="space-y-5 sm:space-y-6">

      {/* ── 오늘 손실 한도 ── */}
      <Panel title="오늘 하루 손실 한도" badge={totalPnl < 0 ? '주의' : '안전'} badgeColor={totalPnl < -(dailyLossLimit * 0.6) ? 'red' : totalPnl < 0 ? 'amber' : 'green'}>
        <div className="px-5 py-3.5 flex items-center gap-4">
          <div className="flex-1">
            <div className="flex justify-between text-[11px] mb-1.5">
              <span className="text-slate-500">100%에 도달하면 오늘 하루 로봇이 매매를 멈춥니다</span>
              <span className={`font-bold ${totalPnl < -(dailyLossLimit * 0.6) ? 'text-rose-400' : 'text-slate-400'}`}>
                {totalPnl < 0 ? `손실 ${Math.abs(totalPnl).toLocaleString()}원` : '손실 없음'} / 한도 {dailyLossLimit.toLocaleString()}원
              </span>
            </div>
            <div className="h-2.5 bg-white/[0.04] rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all duration-500 ${totalPnl < -(dailyLossLimit * 0.6) ? 'bg-rose-500' : totalPnl < -(dailyLossLimit * 0.2) ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, Math.max(0, (Math.abs(Math.min(0, totalPnl)) / dailyLossLimit) * 100))}%` }} />
            </div>
          </div>
          <div className={`text-xl font-black shrink-0 ${totalPnl < -(dailyLossLimit * 0.6) ? 'text-rose-400' : 'text-emerald-400'}`}>
            {totalPnl < 0 ? `${Math.round((Math.abs(totalPnl) / dailyLossLimit) * 100)}%` : '0%'}
          </div>
        </div>
      </Panel>

      {/* ── 로봇 하루 일과 ── */}
      <Panel title={`오늘 로봇의 하루 일과 (지금 ${currentTimeStr})`} badge={health?.marketOpen ? '감시 및 분석 중' : '대기 중'} badgeColor={health?.marketOpen ? 'green' : undefined}>
        <div className="px-5 py-4">
          <div className="relative">
            <div className="h-2 bg-white/[0.04] rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full transition-all duration-1000" style={{ width: `${marketProgress}%` }} />
            </div>
            <div className="flex justify-between mt-2 text-[11px]">
              <span className="text-emerald-400 font-medium">09:00 장시작</span>
              {health?.marketOpen && (
                <span className="text-blue-400 font-medium" style={{ position: 'absolute', left: `${marketProgress}%`, transform: 'translateX(-50%)' }}>
                  지금 ({currentTimeStr})
                </span>
              )}
              <span className="text-slate-500">15:30 마감</span>
            </div>
          </div>
        </div>
      </Panel>

      {/* ── 메인 카드 ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-2xl p-4 sm:p-5 bg-gradient-to-br from-blue-600/10 via-cyan-600/5 to-transparent border border-blue-500/10">
          <div className="text-[10px] text-blue-300/60 mb-1 font-medium">총 자산</div>
          <div className="text-xl sm:text-2xl font-black tracking-tight text-white">{fmtWon(p?.totalValue)}</div>
          <div className="flex flex-wrap gap-x-2 mt-2 text-[10px]">
            <span className="text-slate-500">현금 <b className="text-slate-300">{fmtWon(p?.cash)}</b></span>
            <span className="text-slate-500">투자 <b className="text-blue-400">{fmtWon(totalInvested)}</b></span>
          </div>
        </div>

        <div className={`rounded-2xl p-4 sm:p-5 border ${totalPnl > 0 ? 'bg-emerald-500/5 border-emerald-500/15' : totalPnl < 0 ? 'bg-rose-500/5 border-rose-500/15' : 'glass border-white/[0.04]'}`}>
          <div className="text-[10px] text-slate-500 mb-1 font-medium">미실현 손익</div>
          <div className={`text-xl sm:text-2xl font-black ${pc(totalPnl)}`}>
            {totalPnl > 0 ? '+' : ''}{fmtWon(totalPnl)}
          </div>
          <div className={`text-[10px] font-bold mt-2 ${pc(totalPnlPct)}`}>
            {fmtPct(totalPnlPct)}
          </div>
        </div>

        <div className="rounded-2xl p-4 sm:p-5 glass border border-white/[0.04]">
          <div className="text-[10px] text-slate-500 mb-1 font-medium">투자금</div>
          <div className="text-xl sm:text-2xl font-black text-blue-400">{fmtWon(totalInvested)}</div>
          <div className="text-[10px] mt-2">
            <span className={`font-bold ${investedPct > 60 ? 'text-amber-400' : 'text-slate-400'}`}>비중 {investedPct}%</span>
            <span className="text-slate-600 ml-1">({chains.length}종목)</span>
          </div>
        </div>

        <div className="rounded-2xl p-4 sm:p-5 glass border border-white/[0.04]">
          <div className="text-[10px] text-slate-500 mb-1 font-medium">{withdrawConfig?.totalReserved > 0 ? '인출 예약' : '오늘 매매'}</div>
          {withdrawConfig?.totalReserved > 0 ? (
            <>
              <div className="text-xl sm:text-2xl font-black text-amber-400">{fmtWon(withdrawConfig.totalReserved)}</div>
              <div className="text-[10px] text-slate-600 mt-2">출금 대기</div>
            </>
          ) : (
            <>
              <div className="text-xl sm:text-2xl font-black">{todayTrades.length}<span className="text-base text-slate-500 ml-1">건</span></div>
              <div className="text-[10px] text-slate-600 mt-2">총 {filled.length}건 체결</div>
            </>
          )}
        </div>
      </div>

      {/* ── 국내 + 해외 2컬럼 ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-5">
        {/* 국내 보유 */}
        <Panel title="현재 투자 중인 내 돈" badge={`${(p?.positions?.length || 0) + chains.length}종목`} badgeColor="blue">
          {chains.length > 0 ? (
            <div className="divide-y divide-white/[0.03]">
              {chains.map((ch: any, i: number) => {
                const avgPrice = Number(ch.avg_buy_price) || 0;
                const qty = Number(ch.total_quantity) || 0;
                const invested = Number(ch.invested) || avgPrice * qty;
                const curAvg = Number(ch.current_averaging_count) || 0;
                const maxAvg = Number(ch.max_averaging_count) || 3;
                const targetPct = Number(ch.target_profit_pct) || 8;
                const stopPct = Number(ch.stop_loss_pct) || -5;
                const pnl = ch.unrealizedPnl ?? 0;
                const pnlPct = ch.unrealizedPnlPct ?? 0;

                return (
                  <div key={`c${i}`} className="p-4 sm:p-5 hover:bg-white/[0.01] transition-colors">
                    <div className="flex items-start justify-between gap-4">
                      {/* 종목 정보 */}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-base font-bold">{ch.stock_name || ch.stock_code}</span>
                          <span className="text-[10px] text-slate-500 ml-0.5">{ch.stock_code}</span>
                          <span className="text-[10px] bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded-md font-medium">{ch.strategy_mode}</span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-1">평단가 {fmtWon(avgPrice)}</div>
                      </div>

                      {/* 수익률 */}
                      <div className="text-right shrink-0">
                        {ch.currentPrice > 0 ? (
                          <>
                            <div className={`text-xl font-black ${pc(pnl)}`}>{pnlPct > 0 ? '+' : ''}{pnlPct.toFixed(2)}%</div>
                            <div className={`text-xs ${pc(pnl)}`}>{pnl > 0 ? '+' : ''}{fmtWon(pnl)}</div>
                          </>
                        ) : <span className="text-sm text-slate-600">시장 마감</span>}
                      </div>
                    </div>

                    {/* 분할 매수 + 투자금 + 현재가 */}
                    <div className="grid grid-cols-3 gap-3 mt-3">
                      <div>
                        <div className="text-[10px] text-slate-500 mb-1 font-medium">분할 매수</div>
                        <div className="flex gap-0.5">
                          {Array.from({ length: maxAvg }, (_, j) => (
                            <span key={j} className={`w-5 h-5 rounded-full text-[8px] font-bold flex items-center justify-center ${j <= curAvg ? 'bg-blue-500 text-white' : 'bg-white/[0.06] text-slate-600'}`}>
                              {j + 1}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-500 mb-1 font-medium">투자금</div>
                        <div className="text-[13px] font-bold">{fmtWon(invested)}</div>
                        <div className="text-[10px] text-slate-600">{fmt(qty)}주</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-500 mb-1 font-medium">현재가</div>
                        <div className="text-[13px] font-bold">{ch.currentPrice > 0 ? fmtWon(ch.currentPrice) : '-'}</div>
                      </div>
                    </div>

                    {/* 자동 청산 + 수동 매도 */}
                    <div className="flex flex-wrap items-center gap-1.5 mt-3">
                      <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-medium">
                        +{targetPct}% 익절
                      </span>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 font-medium">
                        {stopPct}% 손절
                      </span>
                      <button onClick={async () => {
                        if (!confirm(`${ch.stock_code} ${qty}주 전량 시장가 매도하시겠습니까?`)) return;
                        try {
                          const r = await api(`/sell/${ch.id}`, { method: 'POST' });
                          alert(r.message || '매도 완료');
                          onRefresh();
                        } catch (err: any) { alert('매도 실패: ' + err.message); }
                      }} className="text-[10px] ml-auto px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-rose-500/10 hover:text-rose-400 text-slate-500 transition-colors font-medium shrink-0 border border-white/[0.04]">
                        전량 매도
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-6 text-center space-y-2">
              <div className="text-2xl opacity-30">📦</div>
              <p className="text-sm text-slate-400">아직 투자 중인 종목이 없습니다</p>
              <p className="text-[11px] text-slate-600">로봇이 장 중 10분 간격으로 매수 기회를 탐색하고 있습니다.<br/>기술적 지표 조건이 맞으면 자동으로 매수합니다.</p>
            </div>
          )}
        </Panel>

        {/* 미국 시세 */}
        <Panel title="해외주식 시세" badge="🇺🇸 🇯🇵 🇹🇼 자동매매" badgeColor="blue">
          {usW.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-3.5">
              {usW.map((s: any) => (
                <div key={s.code} className={`rounded-xl border p-3 text-center transition-all hover:scale-[1.02] ${pbg(s.changePct)} border-slate-700/30`}>
                  <div className="text-xs font-bold text-slate-300">{s.code}</div>
                  <div className="text-base font-bold mt-1">{s.price > 0 ? `$${s.price.toFixed(1)}` : '-'}</div>
                  <div className={`text-[11px] font-semibold mt-0.5 ${pc(s.changePct)}`}>{s.changePct !== 0 ? fmtPct(s.changePct) : '-'}</div>
                  <div className="text-[10px] text-slate-600 mt-0.5">{s.name}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-6 text-center space-y-2">
              <div className="text-2xl opacity-30">🌏</div>
              <p className="text-sm text-slate-400">해외 장 시간에 시세가 갱신됩니다</p>
              <p className="text-[11px] text-slate-600">🇯🇵 09:00~15:00 · 🇹🇼 10:00~14:30 · 🇺🇸 23:30~06:30</p>
            </div>
          )}
        </Panel>
      </div>

      {/* ── 포트폴리오 비중 + 운영 요약 2컬럼 ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-5">
        {/* 포트폴리오 비중 */}
        <Panel title="포트폴리오 비중" badge={totalInvested > 0 ? `투자 ${((totalInvested / (p?.totalValue || 1)) * 100).toFixed(0)}%` : '대기'}>
          <div className="p-4 sm:p-5 space-y-4">
            {/* 현금 vs 투자 비율 바 */}
            <div>
              <div className="flex justify-between text-[11px] mb-2">
                <span className="text-slate-500">현금 {p?.cash > 0 ? ((p.cash / (p?.totalValue || 1)) * 100).toFixed(0) : 0}%</span>
                <span className="text-slate-500">투자 {totalInvested > 0 ? ((totalInvested / (p?.totalValue || 1)) * 100).toFixed(0) : 0}%</span>
              </div>
              <div className="h-2.5 bg-white/[0.04] rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full transition-all duration-500" style={{ width: `${totalInvested > 0 ? (totalInvested / (p?.totalValue || 1)) * 100 : 0}%` }} />
              </div>
            </div>
            {/* 종목별 비중 */}
            {chains.length > 0 && (
              <div className="space-y-2.5">
                {chains.map((ch: any, i: number) => {
                  const inv = Number(ch.invested) || 0;
                  const pct = totalInvested > 0 ? (inv / totalInvested) * 100 : 0;
                  return (
                    <div key={i}>
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="font-medium text-slate-300">{ch.stock_name || ch.stock_code}</span>
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
          </div>
        </Panel>

        {/* 투자 성적표 + 운영 현황 */}
        <Panel title="그동안의 투자 성적표">
          <div className="p-4 sm:p-5 space-y-4">
            {/* 핵심 성과 지표 */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
                <div className="text-[10px] text-slate-500 font-medium">원금 대비 수익</div>
                <div className={`text-lg font-black mt-1 ${pc(totalPnl)}`}>{fmtWon(totalPnl)}</div>
              </div>
              <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
                <div className="text-[10px] text-slate-500 font-medium">이기는 확률</div>
                <div className="text-lg font-black mt-1">{(() => {
                  const sells = filled.filter((t: any) => t.side === 'SELL' && t.filled_price && t.transaction_chains?.avg_buy_price);
                  if (sells.length === 0) return '-';
                  const wins = sells.filter((t: any) => Number(t.filled_price) > Number(t.transaction_chains?.avg_buy_price || 0));
                  return `${Math.round((wins.length / sells.length) * 100)}%`;
                })()}</div>
              </div>
              <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
                <div className="text-[10px] text-slate-500 font-medium">오늘 AI 매매</div>
                <div className="text-lg font-black mt-1">{todayTrades.length}건</div>
              </div>
              <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
                <div className="text-[10px] text-slate-500 font-medium">현재 보유 중</div>
                <div className="text-lg font-black mt-1">{chains.length}종목</div>
              </div>
            </div>

            {/* 현재 상태 */}
            <div className="grid grid-cols-3 gap-3 text-center text-[11px]">
              <div className="glass rounded-lg p-2.5 border border-white/[0.04]">
                <span className="text-slate-500">투자 전략</span>
                <div className="font-bold mt-0.5 text-blue-400">{dash?.strategy?.mode === 'SWING' ? '안정 스윙' : dash?.strategy?.mode === 'DEFENSE' ? '방어 모드' : '단타'}</div>
              </div>
              <div className="glass rounded-lg p-2.5 border border-white/[0.04]">
                <span className="text-slate-500">매매 모드</span>
                <div className={`font-bold mt-0.5 ${killSwitch?.active ? 'text-rose-400' : 'text-emerald-400'}`}>{killSwitch?.active ? '수동' : '자동'}</div>
              </div>
              <div className="glass rounded-lg p-2.5 border border-white/[0.04]">
                <span className="text-slate-500">운영 모드</span>
                <div className={`font-bold mt-0.5 ${dash?.tradingMode === 'paper' ? 'text-amber-400' : 'text-blue-400'}`}>{dash?.tradingMode === 'paper' ? '모의 투자' : '실전'}</div>
              </div>
            </div>
          </div>
        </Panel>
      </div>

      {/* ── AI 스코어 + 최근 매매 2컬럼 ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-5">
        {/* AI 스코어 */}
        <Panel title="AI가 보는 종목 점수" badge={dash?.scores?.length > 0 ? `${dash.scores.length}종목` : undefined} badgeColor="blue">
          {dash?.scores?.length > 0 ? (
            <div className="p-3.5 space-y-2">
              {dash.scores.map((sc: any) => {
                const score = Number(sc.composite_score);
                const barColor = score >= 75 ? 'bg-emerald-500' : score >= 50 ? 'bg-blue-500' : score >= 25 ? 'bg-amber-500' : 'bg-slate-600';
                const textColor = score >= 75 ? 'text-emerald-400' : score >= 50 ? 'text-blue-400' : 'text-slate-500';
                const signalLabel = score >= 85 ? '강력 추천' : score >= 70 ? '매수 추천' : score >= 50 ? '관망' : score >= 30 ? '위험' : '매도 추천';
                return (
                  <div key={sc.stock_code} className="flex items-center gap-3 px-2 py-2">
                    <span className="text-xs font-bold text-slate-300 w-24 shrink-0 truncate">{getStockName(sc.stock_code)}</span>
                    <div className="flex-1">
                      <div className="h-2 bg-white/[0.04] rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${Math.max(0, Math.min(100, (score + 100) / 2))}%` }} />
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
              <p className="text-[11px] text-slate-600">매일 오전 7:30 / 오후 6시에 자동 실행됩니다.<br/>설정 → AI 분석 수동 실행 버튼으로 즉시 생성할 수 있습니다.</p>
              <p className="text-[10px] text-blue-400/60">스코어 없는 동안 기술적 지표 기반으로 자동매매가 동작합니다</p>
            </div>
          )}
        </Panel>

        {/* 최근 매매 */}
        <Panel title="최근 매매" badge={`오늘 ${todayTrades.length}건`} badgeColor={todayTrades.length > 0 ? 'green' : undefined}>
          {filled.length === 0 ? <EmptyMsg>매매 기록 없음</EmptyMsg> : (
            <div className="divide-y divide-white/[0.03]">
              {filled.slice(0, 5).map((t: any, i: number) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02]">
                  <SideBadge side={t.side} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-slate-200">{getStockName(t.stock_code)}</span>
                      <span className="text-[10px] text-slate-600">{fmtTime(t.created_at)}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 truncate">{t.ai_reasoning || '-'}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-bold">{Number(t.filled_price) > 1000 ? fmtWon(Number(t.filled_price)) : fmtUsd(Number(t.filled_price))}</div>
                    <div className="text-[10px] text-slate-500">{fmt(t.quantity)}주</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>


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

function TradesView({ trades, watchlist }: { trades: any[]; watchlist: any[] }) {
  // 종목명 조회 맵
  const nameMap = new Map(watchlist.map((w: any) => [w.stock_code, w.stock_name]));
  const getName = (code: string) => nameMap.get(code) || code;
  const [expanded, setExpanded] = useState<string | null>(null);
  const filled = trades.filter((t: any) => t.status === 'FILLED');
  const buys = filled.filter((t: any) => t.side === 'BUY');
  const sells = filled.filter((t: any) => t.side === 'SELL');
  const todayCount = filled.filter((t: any) => new Date(t.created_at).toDateString() === new Date().toDateString()).length;

  return (
    <div className="space-y-4">
      {/* 요약 통계 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">총 체결</div>
          <div className="text-lg font-black mt-1">{filled.length}건</div>
        </div>
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">오늘</div>
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
            <th className="px-4 py-3 text-center font-medium">상태</th>
            <th className="px-4 py-3 text-center font-medium">모드</th>
            <th className="px-4 py-3 text-left font-medium">왜 샀는지</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-800/20">
            {trades.length === 0 ? (
              <tr><td colSpan={8} className="p-12 text-center text-slate-500">매매 기록 없음</td></tr>
            ) : trades.map((t: any, i: number) => {
              const chain = t.transaction_chains;
              const tradeKey = t.id || t.kis_order_no || `t${i}`;
              const isOpen = expanded === tradeKey;
              return (
              <React.Fragment key={tradeKey}>
              <tr onClick={() => setExpanded(isOpen ? null : tradeKey)} className="hover:bg-slate-800/20 transition-colors cursor-pointer">
                <td className="px-4 py-3 text-slate-500">{fmtTime(t.created_at)}</td>
                <td className="px-4 py-3 font-semibold">{getName(t.stock_code)} <span className="text-[10px] text-slate-500">{t.stock_code}</span></td>
                <td className="px-4 py-3 text-center"><SideBadge side={t.side} /></td>
                <td className="px-4 py-3 text-right">{fmt(t.quantity)}</td>
                <td className="px-4 py-3 text-right font-medium">{Number(t.filled_price) > 1000 ? fmtWon(Number(t.filled_price)) : fmtUsd(Number(t.filled_price))}</td>
                <td className="px-4 py-3 text-center"><StatusBadge status={t.status} /></td>
                <td className="px-4 py-3 text-center"><ModeBadge mode={t.trading_mode} /></td>
                <td className="px-4 py-3 text-slate-400 max-w-[280px]">
                  <div className="flex items-center gap-1">
                    <div className="truncate" title={t.ai_reasoning}>{t.ai_reasoning || '-'}</div>
                    <span className="text-[10px] text-slate-600 shrink-0">{isOpen ? '▲' : '▼'}</span>
                  </div>
                </td>
              </tr>
              {isOpen && (
                <tr className="bg-slate-900/40">
                  <td colSpan={8} className="px-5 py-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                      <div>
                        <p className="text-slate-500 font-medium mb-1.5">AI가 이 종목을 산 이유</p>
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
                                <p className="text-emerald-400">+8% 오르면 → 절반 팔아서 수익 확보</p>
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

function WatchlistView({ watchlist, setWatchlist, dash, usDash }: any) {
  const usW = usDash?.watchlist || [];
  const chains = dash?.chains || [];
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

    setSelectedStock(code);
    setAnalysisLoading(true);
    try {
      const data = await api(`/stock/${code}/analysis`);
      if (!controller.signal.aborted) setAnalysis(data);
    } catch { if (!controller.signal.aborted) setAnalysis(null); }
    finally { if (!controller.signal.aborted) setAnalysisLoading(false); }
  };

  const addStock = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const code = String(fd.get('code') ?? '').replace(/\D/g, '');
    if (code.length !== 6) { alert('6자리 종목코드'); return; }
    try {
      await api('/watchlist', { method: 'POST', body: JSON.stringify({ stock_code: code, stock_name: String(fd.get('name') ?? ''), market: fd.get('market') }) });
      (e.target as HTMLFormElement).reset();
      const w = await api('/watchlist'); setWatchlist(Array.isArray(w) ? w : []);
    } catch (err: any) { alert(err.message); }
  };
  const del = async (code: string) => {
    if (!confirm(`${code} 삭제?`)) return;
    await api(`/watchlist/${code}`, { method: 'DELETE' });
    setWatchlist((prev: any[]) => prev.filter(s => s.stock_code !== code));
  };

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
        <form onSubmit={addStock} className="flex flex-wrap gap-2 flex-1">
          <input name="code" placeholder="종목코드 (005930)" maxLength={6} required className="flex-1 min-w-[120px] bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm placeholder:text-slate-600 focus:border-blue-500 focus:outline-none" />
          <input name="name" placeholder="종목명(자동조회)" className="flex-1 min-w-[120px] bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm placeholder:text-slate-600 focus:border-blue-500 focus:outline-none" />
          <select name="market" defaultValue="KOSPI" className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm"><option>KOSPI</option><option>KOSDAQ</option></select>
          <button type="submit" className="px-5 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium">추가</button>
        </form>
        <button onClick={syncKIS} disabled={syncing} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded-lg text-sm font-medium whitespace-nowrap">
          {syncing ? '동기화 중...' : '한투 앱 동기화'}
        </button>
      </div>

      {/* 종목 상세 분석 패널 */}
      {selectedStock && (
        <Panel title={`${watchlist.find((s: any) => s.stock_code === selectedStock)?.stock_name || selectedStock} 종목 분석`} badge={selectedStock}>
          {analysisLoading ? (
            <div className="p-8 text-center"><div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto" /></div>
          ) : t ? (
            <div className="p-4 sm:p-5 space-y-5">
              {/* 차트 분석 지표 */}
              <div>
                <h4 className="text-xs font-semibold text-slate-400 mb-3">차트 건강 상태</h4>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
                  <Indicator label="과열/침체" value={t.rsi14?.toFixed(0)} sub={t.rsi14 > 70 ? '너무 올랐음' : t.rsi14 < 30 ? '많이 빠짐 (기회)' : '적정 수준'} color={t.rsi14 > 70 ? 'rose' : t.rsi14 < 30 ? 'emerald' : 'slate'} />
                  <Indicator label="추세 방향" value={t.macdHistogram > 0 ? '상승' : '하락'} sub={t.macdCrossover === 'golden' ? '상승 전환!' : t.macdCrossover === 'dead' ? '하락 전환' : '유지 중'} color={t.macdHistogram > 0 ? 'emerald' : 'rose'} />
                  <Indicator label="가격 위치" value={t.bollingerPosition != null ? t.bollingerPosition.toFixed(0) + '%' : '-'} sub={t.bollingerPosition > 80 ? '고가 영역' : t.bollingerPosition < 20 ? '저가 영역' : '중간'} color={t.bollingerPosition > 80 ? 'rose' : t.bollingerPosition < 20 ? 'emerald' : 'slate'} />
                  <Indicator label="추세 강도" value={t.adx14 != null ? t.adx14.toFixed(0) : '-'} sub={t.adx14 > 25 ? '뚜렷한 방향' : '방향 없음'} color={t.adx14 > 25 ? 'blue' : 'slate'} />
                  <Indicator label="AI 종합" value={t.score != null ? t.score.toFixed(0) + '점' : '-'} sub={t.score > 20 ? '매수 유리' : t.score < -20 ? '매수 위험' : '관망'} color={t.score > 20 ? 'emerald' : t.score < -20 ? 'rose' : 'slate'} />
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-3 text-center text-[11px]">
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">5일 평균가</span><b>{t.sma5?.toLocaleString()}</b></div>
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">20일 평균가</span><b>{t.sma20?.toLocaleString()}</b></div>
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">60일 평균가</span><b>{t.sma60?.toLocaleString()}</b></div>
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">거래량 변화</span><b className={t.volumeRatio > 2 ? 'text-amber-400' : ''}>{t.volumeRatio?.toFixed(1)}배</b></div>
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">매수/매도 힘</span><b>{t.stochasticK?.toFixed(0)}</b></div>
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">변동성</span><b>{t.atr14?.toFixed(0)}</b></div>
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
                      <div className="flex justify-between"><span className="text-slate-500">하락 베팅 비율</span><span className={sh.riskLevel === 'HIGH' ? 'text-rose-400 font-bold' : ''}>{sh.shortRatio?.toFixed(1)}%</span></div>
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
                      <div className="flex justify-between"><span className="text-slate-500">얼마나 오를 수 있나</span><span className={con.upsidePct > 0 ? 'text-emerald-400' : 'text-rose-400'}>{con.upsidePct > 0 ? '+' : ''}{con.upsidePct?.toFixed(1)}%</span></div>
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
          <div className="divide-y divide-white/[0.03]">
            {watchlist.map((s: any) => {
              const score = dash?.scores?.find((sc: any) => sc.stock_code === s.stock_code);
              const chain = chains.find((ch: any) => ch.stock_code === s.stock_code);
              const isSelected = selectedStock === s.stock_code;
              const scoreVal = score ? Number(score.composite_score) : -1;

              // 로봇 상태 결정
              let robotStatus = { label: '분석 대기', color: 'text-slate-500', bg: 'bg-white/[0.04]', border: '' };
              if (chain) {
                robotStatus = { label: '사서 굴리는 중', color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-l-2 border-emerald-500' };
              } else if (scoreVal >= 70) {
                robotStatus = { label: '매수 조건 근접!', color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-l-2 border-amber-500' };
              } else if (scoreVal >= 0) {
                robotStatus = { label: '감시 중', color: 'text-blue-400', bg: 'bg-blue-500/5', border: '' };
              } else {
                robotStatus = { label: '분석 대기', color: 'text-slate-500', bg: 'bg-white/[0.04]', border: '' };
              }

              return (
                <div key={s.stock_code} onClick={() => loadAnalysis(s.stock_code)} className={`flex items-center gap-3 px-4 py-3.5 hover:bg-white/[0.02] cursor-pointer group transition-colors ${isSelected ? 'bg-blue-950/20 border-l-2 border-blue-500' : robotStatus.border}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm">{s.stock_name?.trim() || s.stock_code}</span>
                      {s.stock_name?.trim() && s.stock_name.trim() !== s.stock_code && <span className="text-[10px] text-slate-600">{s.stock_code}</span>}
                    </div>
                    {chain ? (
                      <div className="text-[10px] text-slate-500 mt-0.5">평단 {Number(chain.avg_buy_price).toLocaleString()}원 · {chain.total_quantity}주</div>
                    ) : scoreVal >= 0 ? (
                      <div className="text-[10px] text-slate-500 mt-0.5">AI {scoreVal}점 {scoreVal >= 75 ? '— 매수 대기' : scoreVal >= 50 ? '— 관망' : '— 부족'}</div>
                    ) : (
                      <div className="text-[10px] text-slate-600 mt-0.5">기술적 지표로 감시 중</div>
                    )}
                  </div>
                  <span className={`text-[10px] px-2.5 py-1 rounded-md font-medium ${robotStatus.bg} ${robotStatus.color}`}>{robotStatus.label}</span>
                  <span className="text-[10px] text-slate-600">{isSelected ? '▲' : '▼'}</span>
                  <button onClick={(e) => { e.stopPropagation(); del(s.stock_code); }} className="opacity-0 group-hover:opacity-100 text-[11px] text-rose-400 hover:text-rose-300 transition-opacity">삭제</button>
                </div>
              );
            })}
            {watchlist.length === 0 && <EmptyMsg>종목을 추가하면 로봇이 24시간 감시합니다</EmptyMsg>}
          </div>
        </Panel>

        {/* 미국 */}
        <Panel title="🇺🇸 미국" badge={`${usW.length}종목`}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3">
            {usW.map((s: any) => (
              <div key={s.code} className={`rounded-lg border p-3 ${pbg(s.changePct)} border-slate-700/30`}>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-sm">{s.code}</span>
                  <span className={`text-[11px] font-medium ${pc(s.changePct)}`}>{fmtPct(s.changePct)}</span>
                </div>
                <div className="text-lg font-bold mt-1">{s.price > 0 ? `$${s.price.toFixed(2)}` : '-'}</div>
                <div className="text-[10px] text-slate-500">{s.name}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// BACKTEST VIEW
// ═══════════════════════════════════════

function BacktestView({ watchlist }: { watchlist: any[] }) {
  const [mode, setMode] = useState('SWING');
  const [capital, setCapital] = useState(1000000);
  const [days, setDays] = useState(120);
  const [running, setRunning] = useState(false);
  const [singleResult, setSingleResult] = useState<any>(null);
  const [batchResult, setBatchResult] = useState<any>(null);
  const [selectedStock, setSelectedStock] = useState('');

  const runSingle = async () => {
    if (!selectedStock) { alert('종목을 선택하세요'); return; }
    setRunning(true);
    setSingleResult(null);
    try {
      const r = await api('/backtest/single', { method: 'POST', body: JSON.stringify({ stockCode: selectedStock, mode, capital, days }) });
      setSingleResult(r);
    } catch (err: any) { alert(err.message); }
    finally { setRunning(false); }
  };

  const runAll = async () => {
    setRunning(true);
    setBatchResult(null);
    try {
      const r = await api('/backtest/all', { method: 'POST', body: JSON.stringify({ mode, capital, days }) });
      setBatchResult(r);
    } catch (err: any) { alert(err.message); }
    finally { setRunning(false); }
  };

  const pctColor = (v: number) => v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-slate-400';

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* 설정 */}
      <Panel title="백테스트 설정">
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="text-[11px] text-slate-500 block mb-1">전략</label>
              <select value={mode} onChange={e => setMode(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                <option value="SWING">스윙</option><option value="DEFENSE">방어</option><option value="SCALPING">단타</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] text-slate-500 block mb-1">시작 자본</label>
              <select value={capital} onChange={e => setCapital(Number(e.target.value))} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                <option value={500000}>50만원</option><option value={1000000}>100만원</option><option value={3000000}>300만원</option><option value={5000000}>500만원</option><option value={10000000}>1,000만원</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] text-slate-500 block mb-1">기간 (일)</label>
              <select value={days} onChange={e => setDays(Number(e.target.value))} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                <option value={60}>60일 (2개월)</option><option value={120}>120일 (4개월)</option><option value={180}>180일 (6개월)</option><option value={250}>250일 (1년)</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] text-slate-500 block mb-1">종목 (단일)</label>
              <select value={selectedStock} onChange={e => setSelectedStock(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                <option value="">선택</option>
                {watchlist.map((s: any) => <option key={s.stock_code} value={s.stock_code}>{s.stock_name} ({s.stock_code})</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-3">
            <button onClick={runSingle} disabled={running || !selectedStock} className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg text-sm font-medium">
              {running ? '분석 중...' : '단일 종목 테스트'}
            </button>
            <button onClick={runAll} disabled={running} className="px-5 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg text-sm font-medium">
              {running ? '분석 중...' : '전 종목 일괄 테스트'}
            </button>
          </div>
        </div>
      </Panel>

      {/* 단일 종목 결과 */}
      {singleResult && (
        <Panel title={`${singleResult.stockCode} 백테스트 결과`} badge={singleResult.period}>
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-slate-900/60 rounded-lg p-3 text-center">
                <div className="text-[10px] text-slate-500">총 수익률</div>
                <div className={`text-lg font-bold ${pctColor(singleResult.totalReturnPct)}`}>{singleResult.totalReturnPct > 0 ? '+' : ''}{singleResult.totalReturnPct.toFixed(1)}%</div>
              </div>
              <div className="bg-slate-900/60 rounded-lg p-3 text-center">
                <div className="text-[10px] text-slate-500">승률</div>
                <div className="text-lg font-bold">{(singleResult.winRate * 100).toFixed(0)}%</div>
                <div className="text-[10px] text-slate-600">{singleResult.wins}승 {singleResult.losses}패</div>
              </div>
              <div className="bg-slate-900/60 rounded-lg p-3 text-center">
                <div className="text-[10px] text-slate-500">최대 낙폭</div>
                <div className="text-lg font-bold text-rose-400">{singleResult.maxDrawdownPct.toFixed(1)}%</div>
              </div>
              <div className="bg-slate-900/60 rounded-lg p-3 text-center">
                <div className="text-[10px] text-slate-500">샤프 비율</div>
                <div className="text-lg font-bold">{singleResult.sharpeRatio.toFixed(2)}</div>
              </div>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center text-[11px]">
              <div><span className="text-slate-500">총 매매</span><br/><b>{singleResult.totalTrades}건</b></div>
              <div><span className="text-slate-500">평균 보유</span><br/><b>{singleResult.avgHoldingDays.toFixed(0)}일</b></div>
              <div><span className="text-slate-500">평균 수익</span><br/><b className="text-emerald-400">+{singleResult.avgWinPct.toFixed(1)}%</b></div>
              <div><span className="text-slate-500">평균 손실</span><br/><b className="text-rose-400">{singleResult.avgLossPct.toFixed(1)}%</b></div>
              <div><span className="text-slate-500">수익 팩터</span><br/><b>{singleResult.profitFactor.toFixed(2)}</b></div>
              <div><span className="text-slate-500">최종 자본</span><br/><b>{(singleResult.finalCapital / 10000).toFixed(0)}만원</b></div>
            </div>
            {/* 매매 내역 */}
            {singleResult.trades?.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-slate-500 border-b border-slate-700/30">
                    <th className="px-2 py-1.5 text-left">진입일</th><th className="px-2 py-1.5 text-left">청산일</th>
                    <th className="px-2 py-1.5 text-right">진입가</th><th className="px-2 py-1.5 text-right">청산가</th>
                    <th className="px-2 py-1.5 text-right">수익률</th><th className="px-2 py-1.5 text-right">보유일</th>
                  </tr></thead>
                  <tbody className="divide-y divide-slate-800/20">
                    {singleResult.trades.slice(0, 20).map((t: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-800/30">
                        <td className="px-2 py-1.5 text-slate-500">{t.entryDate}</td>
                        <td className="px-2 py-1.5 text-slate-500">{t.exitDate}</td>
                        <td className="px-2 py-1.5 text-right">{t.entryPrice?.toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-right">{t.exitPrice?.toLocaleString()}</td>
                        <td className={`px-2 py-1.5 text-right font-medium ${pctColor(t.pnlPct)}`}>{t.pnlPct > 0 ? '+' : ''}{t.pnlPct?.toFixed(1)}%</td>
                        <td className="px-2 py-1.5 text-right text-slate-500">{t.holdingDays}일</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Panel>
      )}

      {/* 일괄 결과 */}
      {batchResult && (
        <Panel title="전 종목 백테스트 결과" badge={`${batchResult.totalStocks}종목 · 평균 ${batchResult.avgReturn}%`}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-slate-500 border-b border-slate-700/30">
                <th className="px-3 py-2 text-left">종목</th>
                <th className="px-3 py-2 text-right">수익률</th>
                <th className="px-3 py-2 text-right">승률</th>
                <th className="px-3 py-2 text-right">샤프</th>
                <th className="px-3 py-2 text-right">최대 낙폭</th>
                <th className="px-3 py-2 text-right">매매 수</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-800/20">
                {batchResult.results.map((r: any) => (
                  <tr key={r.stockCode} className="hover:bg-slate-800/30">
                    <td className="px-3 py-2"><span className="font-medium">{r.stockName}</span> <span className="text-slate-600">{r.stockCode}</span></td>
                    <td className={`px-3 py-2 text-right font-bold ${pctColor(r.returnPct)}`}>{r.returnPct > 0 ? '+' : ''}{r.returnPct.toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right">{(r.winRate * 100).toFixed(0)}%</td>
                    <td className="px-3 py-2 text-right">{r.sharpe.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right text-rose-400">{r.maxDD.toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right text-slate-400">{r.trades}건</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {!singleResult && !batchResult && (
        <Panel title="사용 가이드">
          <div className="p-6 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
              <div className="bg-slate-900/40 rounded-xl p-4">
                <div className="text-lg mb-1">1</div>
                <p className="text-xs font-medium text-slate-300">전략/자본/기간 선택</p>
                <p className="text-[10px] text-slate-500 mt-1">위 설정에서 조건을 선택하세요</p>
              </div>
              <div className="bg-slate-900/40 rounded-xl p-4">
                <div className="text-lg mb-1">2</div>
                <p className="text-xs font-medium text-slate-300">테스트 실행</p>
                <p className="text-[10px] text-slate-500 mt-1">단일 종목 또는 전 종목 일괄</p>
              </div>
              <div className="bg-slate-900/40 rounded-xl p-4">
                <div className="text-lg mb-1">3</div>
                <p className="text-xs font-medium text-slate-300">결과 분석</p>
                <p className="text-[10px] text-slate-500 mt-1">수익률, 승률, 낙폭 등 확인</p>
              </div>
            </div>
            <p className="text-[11px] text-slate-600 text-center">과거 데이터로 전략의 실제 성과를 검증합니다. 실행에 1~3분 소요됩니다.</p>
          </div>
        </Panel>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// SETTINGS VIEW
// ═══════════════════════════════════════

function SettingsView({ strategy, setStrategy, secrets, notebookRef, geminiRef, gptRef, claudeRef, killSwitch, toggleKill, withdrawConfig, setWithdrawConfig, withdrawHistory, setWithdrawHistory, toast }: any) {
  const [activeStep, setActiveStep] = useState<number>(0);
  const setField = async (field: string, val: string | number) => {
    // ref에 있는 프롬프트도 함께 보내야 덮어쓰기 방지
    const body = {
      ...strategy,
      notebooklm_prompt: notebookRef.current?.value ?? strategy?.notebooklm_prompt ?? '',
      gemini_prompt: geminiRef.current?.value ?? strategy?.gemini_prompt ?? '',
      gpt_prompt: gptRef.current?.value ?? strategy?.gpt_prompt ?? '',
      claude_prompt: claudeRef.current?.value ?? strategy?.claude_prompt ?? '',
      [field]: val,
    };
    try { const u = await api('/strategy', { method: 'PUT', body: JSON.stringify(body) }); setStrategy(u); toast?.('설정 저장됨', 'ok'); } catch { toast?.('설정 저장 실패', 'err'); }
  };
  const saveStrategy = async () => {
    const body = {
      ...strategy,
      notebooklm_prompt: notebookRef.current?.value ?? '',
      gemini_prompt: geminiRef.current?.value ?? '',
      gpt_prompt: gptRef.current?.value ?? '',
      claude_prompt: claudeRef.current?.value ?? '',
    };
    try { const u = await api('/strategy', { method: 'PUT', body: JSON.stringify(body) }); setStrategy(u); toast?.('프롬프트 저장 완료', 'ok'); } catch (err: any) { toast?.(err.message, 'err'); }
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
    { label: 'NotebookLM', sub: '소스 수집', color: 'amber', ref: notebookRef, key: 'notebooklm_prompt',
      desc: 'NotebookLM에서 정리한 시장 분석·뉴스·리서치를 여기에 붙여넣으세요. 이 내용이 Gemini의 입력 소스가 됩니다.',
      placeholder: `## NotebookLM에서 복사한 내용 붙여넣기\n\n예시:\n- 이번 주 시장 전망 요약\n- 주목할 섹터/종목 리스트\n- 기관/외국인 수급 동향\n- 증권사 리서치 핵심 포인트\n- YouTube 투자 채널 요약` },
    { label: 'Gemini', sub: '분석 가공', color: 'blue', ref: geminiRef, key: 'gemini_prompt',
      desc: 'NotebookLM 소스 + 시장 데이터를 종합하여 팩트 기반 분석 리포트를 생성합니다.',
      placeholder: `## CEO 추가 지시사항\n\n### 분석 우선순위\n1. 기관/외국인 수급 데이터를 최우선으로 분석하라. 3일 연속 순매수 종목만 주목.\n2. 최근 실적(영업이익) 증가 확인 필수. 적자전환 또는 실적 악화 종목은 즉시 제외.\n3. 52주 고점 대비 -10%~-25% 구간의 눌림목 종목을 우선 분석.\n\n### 제외 조건\n- 시가총액 5000억 미만 소형주\n- 테마주/급등주 (하루 +15% 이상)\n- 최근 30일 내 유상증자/CB 발행 종목` },
    { label: 'GPT', sub: '스코어링', color: 'purple', ref: gptRef, key: 'gpt_prompt',
      desc: 'Gemini 분석 리포트를 바탕으로 종목별 0~100점 스코어를 산출합니다. 75점 이상 → 매수 후보.',
      placeholder: `## 스코어링 보정 지시\n\n### 가점 조건\n- 외국인+기관 동시 순매수 3일 이상: +10점\n- 실적 서프라이즈(컨센서스 대비 +10%): +8점\n- RSI 30 이하 과매도 구간: +5점\n\n### 감점 조건\n- 거래량 급감 (20일 평균 대비 50% 미만): -10점\n- 단기 급등 후 조정 없음 (5일 +10% 이상): -15점\n- 공매도 잔고 비율 5% 이상: -8점` },
    { label: 'Claude', sub: '매매 실행', color: 'emerald', ref: claudeRef, key: 'claude_prompt',
      desc: 'AI 스코어 + 실시간 시세를 종합하여 BUY/SELL/HOLD 최종 결정 + 수량 계산.',
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
          <div className="p-4 sm:p-5 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">매매 모드</p>
              <p className="text-[11px] text-slate-500 mt-0.5">자동 ↔ 수동 전환</p>
              {killSwitch?.reason && <p className="text-[11px] text-rose-400 mt-1">{killSwitch.reason}</p>}
            </div>
            <button onClick={toggleKill} className={`px-5 py-2.5 rounded-xl text-xs font-bold transition-all ${killSwitch?.active ? 'bg-rose-600 hover:bg-rose-500 shadow-lg shadow-rose-900/40' : 'bg-slate-700 hover:bg-slate-600 text-slate-400'}`}>
              {killSwitch?.active ? '수동 → 자동' : '자동 → 수동'}
            </button>
          </div>
        </Panel>
        <Panel title="알림 설정">
          <div className="p-4 sm:p-5 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">푸시 알림</p>
              <p className="text-[11px] text-slate-500 mt-0.5">매수/매도/긴급 알림을 받습니다</p>
            </div>
            <div className="flex gap-2">
              <button onClick={async () => {
                try {
                  const permission = await Notification.requestPermission();
                  if (permission !== 'granted') { alert('알림 권한이 거부되었습니다'); return; }
                  const reg = await navigator.serviceWorker.ready;
                  const { publicKey } = await api('/push/vapid-key');
                  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
                  await api('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
                  toast?.('알림 등록 완료', 'ok');
                } catch (err: any) { alert('알림 등록 실패: ' + err.message); }
              }} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-xl text-xs font-bold">알림 켜기</button>
              <button onClick={async () => {
                try { await api('/push/test', { method: 'POST' }); } catch { alert('테스트 실패'); }
              }} className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-xl text-xs text-slate-400">테스트</button>
            </div>
          </div>
        </Panel>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Panel title="AI 분석 수동 실행">
          <div className="p-4 sm:p-5 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Track A 즉시 실행</p>
              <p className="text-[11px] text-slate-500 mt-0.5">NotebookLM → Gemini → GPT → Claude</p>
            </div>
            <button onClick={async () => {
              if (!confirm('AI 분석을 수동 실행하시겠습니까?')) return;
              try { await api('/run-track-a', { method: 'POST', body: JSON.stringify({}) }); toast?.('AI 분석 시작 — 2~3분 후 갱신', 'ok'); } catch (err: any) { alert(err.message); }
            }} className="px-5 py-2.5 bg-purple-600 hover:bg-purple-500 rounded-xl text-xs font-bold">
              실행
            </button>
          </div>
        </Panel>
      </div>

      {/* ── 전략 설정 ── */}
      {strategy && (
        <Panel title="전략 설정" badge={strategy.mode === 'SWING' ? '안정 스윙' : strategy.mode === 'DEFENSE' ? '방어 모드' : '단타'} badgeColor={strategy.mode === 'SWING' ? 'blue' : strategy.mode === 'DEFENSE' ? 'red' : 'amber'}>
          <div className="p-4 sm:p-5 space-y-4">
            <div className="text-[11px] text-slate-500 bg-slate-900/40 rounded-lg p-3">
              {strategy.mode === 'SWING' ? '3분할 매수 → 물타기 → +8% 익절 / -5% 손절. 중장기 안정 수익 추구.' : strategy.mode === 'DEFENSE' ? '85점 이상만 소량 진입 → -3% 즉시 손절. 하락장 자본 보존 우선.' : '90점 이상 즉시 풀매수 → +3% 즉시 익절. 당일 15:20 강제 청산.'}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
              <Sel label="투자 방식" value={strategy.mode} opts={[['SWING','안정 투자'],['DEFENSE','방어 모드'],['SCALPING','빠른 매매']]} onChange={v => setField('mode', v)} />
              <Sel label="몇 점이면 살지" value={strategy.buy_threshold} opts={[[60,'60점 (적극)'],[70,'70점'],[75,'75점'],[80,'80점 (보통)'],[85,'85점'],[90,'90점 (신중)']]} onChange={v => setField('buy_threshold', Number(v))} />
              <Sel label="빠지면 언제 팔지" value={strategy.stop_loss_pct} opts={[[-2,'-2%'],[-3,'-3% (빡빡)'],[-5,'-5% (보통)'],[-7,'-7%'],[-10,'-10% (여유)']]} onChange={v => setField('stop_loss_pct', Number(v))} />
              <Sel label="오르면 언제 팔지" value={strategy.take_profit_pct} opts={[[3,'+3%'],[5,'+5%'],[8,'+8% (보통)'],[10,'+10%'],[15,'+15%'],[20,'+20%']]} onChange={v => setField('take_profit_pct', Number(v))} />
            </div>
          </div>
        </Panel>
      )}

      {/* ── AI 파이프라인 프롬프트 (탭 UI) ── */}
      {strategy && (
        <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden">
          {/* 헤더 + 저장 버튼 */}
          <div className="p-4 sm:p-5 border-b border-white/[0.04] flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-100">AI 파이프라인 프롬프트</h3>
              <p className="text-[10px] text-slate-500 mt-0.5">각 단계 탭을 눌러 프롬프트를 편집하세요</p>
            </div>
            <button onClick={saveStrategy} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-bold transition-all">저장</button>
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

          {/* 모든 스텝 textarea (숨김 포함 — ref 유지를 위해 항상 렌더링) */}
          {steps.map((s, i) => {
            const sc = colorMap[s.color];
            return (
              <div key={s.label} className={`p-4 sm:p-5 ${sc.activeBg} ${i === activeStep ? '' : 'hidden'}`}>
                <p className="text-[11px] text-slate-400 mb-3">{s.desc}</p>
                <textarea ref={s.ref} defaultValue={strategy?.[s.key] || ''} rows={10}
                  className="w-full bg-slate-900/60 border border-slate-700/50 rounded-lg p-3 text-[11px] leading-relaxed resize-y font-mono focus:outline-none text-slate-300"
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
          <form onSubmit={saveSecrets} autoComplete="off" className="p-4 sm:p-5 space-y-3">
            {/* hidden dummy fields to absorb browser autofill */}
            <input type="text" name="fake_user" style={{ display: 'none' }} tabIndex={-1} />
            <input type="password" name="fake_pass" style={{ display: 'none' }} tabIndex={-1} />
            {[['gemini','Gemini'],['openai','OpenAI'],['anthropic','Anthropic'],['kis_appkey','KIS Key'],['kis_appsecret','KIS Secret'],['kis_account','KIS 계좌']].map(([k, l]) => (
              <div key={k} className="flex items-center gap-3">
                <span className="w-20 text-xs text-slate-400 shrink-0">{l}</span>
                {secrets?.[k]?.exists && <span className="text-[9px] bg-emerald-900/50 text-emerald-300 px-2 py-0.5 rounded shrink-0">설정됨</span>}
                <input name={k} type="text" autoComplete="off" data-1p-ignore data-lpignore="true" placeholder={secrets?.[k]?.masked || '미설정'} className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono focus:border-blue-500 focus:outline-none [-webkit-text-security:disc]" />
              </div>
            ))}
            <button type="submit" className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium">키 저장</button>
          </form>
        </Panel>

        {/* 수익 자동 인출 설정 */}
        <Panel title="수익 자동 인출">
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">자동 수익 확보</p>
                <p className="text-[11px] text-slate-500 mt-0.5">목표 수익률 도달 시 수익분을 인출 예약금으로 잠금</p>
              </div>
              <button onClick={async () => {
                const next = !withdrawConfig?.is_active;
                try {
                  const updated = await api('/withdraw/config', { method: 'PUT', body: JSON.stringify({ ...withdrawConfig, is_active: next }) });
                  setWithdrawConfig({ ...updated, totalReserved: withdrawConfig?.totalReserved ?? 0 });
                } catch { toast?.('저장 실패', 'err'); }
              }} className={`px-4 py-2 rounded-lg text-xs font-bold ${withdrawConfig?.is_active ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-slate-700 hover:bg-slate-600 text-slate-400'}`}>
                {withdrawConfig?.is_active ? 'ON' : 'OFF'}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Sel label="목표 수익률" value={withdrawConfig?.target_profit_pct ?? 10} opts={[[5,'5%'],[8,'8%'],[10,'10%'],[15,'15%'],[20,'20%'],[30,'30%']]} onChange={async v => {
                try { const u = await api('/withdraw/config', { method: 'PUT', body: JSON.stringify({ ...withdrawConfig, target_profit_pct: Number(v) }) }); setWithdrawConfig({ ...u, totalReserved: withdrawConfig?.totalReserved ?? 0 }); } catch { toast?.('저장 실패', 'err'); }
              }} />
              <Sel label="인출 비율 (수익분 중)" value={withdrawConfig?.withdraw_ratio_pct ?? 50} opts={[[30,'30%'],[50,'50%'],[70,'70%'],[80,'80%'],[100,'100%']]} onChange={async v => {
                try { const u = await api('/withdraw/config', { method: 'PUT', body: JSON.stringify({ ...withdrawConfig, withdraw_ratio_pct: Number(v) }) }); setWithdrawConfig({ ...u, totalReserved: withdrawConfig?.totalReserved ?? 0 }); } catch { toast?.('저장 실패', 'err'); }
              }} />
              <Sel label="최소 인출 금액" value={withdrawConfig?.min_withdraw_amount ?? 100000} opts={[[50000,'5만원'],[100000,'10만원'],[200000,'20만원'],[500000,'50만원'],[1000000,'100만원']]} onChange={async v => {
                try { const u = await api('/withdraw/config', { method: 'PUT', body: JSON.stringify({ ...withdrawConfig, min_withdraw_amount: Number(v) }) }); setWithdrawConfig({ ...u, totalReserved: withdrawConfig?.totalReserved ?? 0 }); } catch { toast?.('저장 실패', 'err'); }
              }} />
              <Sel label="체크 주기" value={withdrawConfig?.check_frequency ?? 'daily'} opts={[['daily','매일 (장 마감)'],['weekly','매주 금요일']]} onChange={async v => {
                try { const u = await api('/withdraw/config', { method: 'PUT', body: JSON.stringify({ ...withdrawConfig, check_frequency: v }) }); setWithdrawConfig({ ...u, totalReserved: withdrawConfig?.totalReserved ?? 0 }); } catch { toast?.('저장 실패', 'err'); }
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

      {/* ── 앱 보안 ── */}
      <Panel title="앱 보안">
        <div className="p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="text-xs text-slate-500 shrink-0">잠금 PIN 변경</p>
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
            }} className="flex gap-2 flex-1 max-w-sm">
              <input name="pin" type="password" inputMode="numeric" autoComplete="new-password" data-1p-ignore data-lpignore="true" maxLength={6} placeholder="새 PIN (4~6자리)" className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-center tracking-widest font-mono focus:border-blue-500 focus:outline-none" />
              <button type="submit" className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium shrink-0">변경</button>
            </form>
            <button type="button" onClick={() => {
              localStorage.removeItem('quantops_cred_id');
              localStorage.removeItem('quantops_auth_ts');
              toast?.('생체인증 초기화 완료', 'ok');
            }} className="text-[11px] text-slate-600 hover:text-slate-400 shrink-0">생체인증 초기화</button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

// ═══════════════════════════════════════
// Shared Components
// ═══════════════════════════════════════

function Panel({ title, badge, badgeColor, children }: { title: string; badge?: string; badgeColor?: 'green' | 'red' | 'amber' | 'blue'; children: React.ReactNode }) {
  const bc = badgeColor === 'green' ? 'bg-emerald-500/15 text-emerald-400' : badgeColor === 'red' ? 'bg-rose-500/15 text-rose-400' : badgeColor === 'amber' ? 'bg-amber-500/15 text-amber-400' : badgeColor === 'blue' ? 'bg-blue-500/15 text-blue-400' : 'bg-white/[0.06] text-slate-400';
  return (
    <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/30 animate-in">
      <div className="px-5 py-3.5 border-b border-white/[0.04] flex items-center gap-2">
        <h3 className="text-[13px] font-bold text-slate-100 tracking-tight">{title}</h3>
        {badge && <span className={`text-[10px] px-2.5 py-1 rounded-full ml-auto font-medium ${bc}`}>{badge}</span>}
      </div>
      {children}
    </div>
  );
}

function Card({ label, value, color, bg, big }: { label: string; value: string; color?: string; bg?: string; big?: boolean }) {
  return (
    <div className={`rounded-2xl border border-white/[0.04] p-4 sm:p-5 shadow-xl shadow-black/20 transition-transform hover:scale-[1.01] ${bg || 'glass'}`}>
      <div className="text-[11px] text-slate-500 mb-2 font-medium uppercase tracking-wider">{label}</div>
      <div className={`${big ? 'text-xl sm:text-2xl' : 'text-base sm:text-lg'} font-bold tracking-tight ${color || 'text-slate-100'}`}>{value}</div>
    </div>
  );
}

function Indicator({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  const c = color === 'emerald' ? 'text-emerald-400' : color === 'rose' ? 'text-rose-400' : color === 'blue' ? 'text-blue-400' : color === 'amber' ? 'text-amber-400' : 'text-slate-300';
  const border = color === 'emerald' ? 'border-emerald-500/20' : color === 'rose' ? 'border-rose-500/20' : color === 'blue' ? 'border-blue-500/20' : 'border-white/[0.04]';
  const glow = color === 'emerald' ? 'glow-green' : color === 'rose' ? 'glow-red' : color === 'blue' ? 'glow-blue' : '';
  return (
    <div className={`rounded-xl p-3.5 text-center glass border ${border} ${glow}`}>
      <div className="text-[10px] text-slate-500 mb-1.5 font-medium uppercase tracking-wider">{label}</div>
      <div className={`text-xl font-black ${c}`}>{value ?? '-'}</div>
      <div className={`text-[10px] mt-1 font-medium ${c} opacity-80`}>{sub}</div>
    </div>
  );
}

function EmptyMsg({ children, icon }: { children: React.ReactNode; icon?: string }) {
  return (
    <div className="p-8 sm:p-10 text-center">
      {icon && <div className="text-2xl mb-2 opacity-40">{icon}</div>}
      <div className="text-slate-500 text-sm">{children}</div>
    </div>
  );
}

function SideBadge({ side }: { side: string }) {
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide ${side === 'BUY' ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20' : 'bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/20'}`}>{side === 'BUY' ? '매수' : '매도'}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const label = status === 'FILLED' ? '체결' : status === 'FAILED' ? '실패' : status === 'PENDING' ? '대기' : status === 'CANCELLED' ? '취소' : status;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-medium ${status === 'FILLED' ? 'bg-emerald-500/10 text-emerald-400' : status === 'FAILED' ? 'bg-rose-500/10 text-rose-400' : 'bg-white/[0.04] text-slate-500'}`}>{label}</span>;
}

function ModeBadge({ mode }: { mode: string }) {
  return <span className={`px-1.5 py-0.5 rounded text-[10px] ${mode === 'paper' ? 'bg-amber-900/40 text-amber-300' : 'bg-blue-900/40 text-blue-300'}`}>{mode === 'paper' ? '연습' : '실전'}</span>;
}

function Sel({ label, value, opts, onChange }: { label: string; value: any; opts: [any, string][]; onChange: (v: string) => void }) {
  // DB에서 "-5.00" (문자열) vs option "-5" (숫자) 매칭 → Number 변환 후 비교
  const numVal = Number(value);
  const matched = opts.find(([v]) => Number(v) === numVal)?.[0] ?? value;
  return (
    <div>
      <label className="text-[11px] text-slate-500 block mb-1">{label}</label>
      <select value={matched} onChange={e => onChange(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}
