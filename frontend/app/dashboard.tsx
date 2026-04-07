'use client';

import React, { useState, useEffect, useRef } from 'react';

// ═══════════════════════════════════════
// API
// ═══════════════════════════════════════

const BACKEND_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_API_BASE_URL || (window.location.port === '3000' ? 'http://localhost:8080' : window.location.origin))
    : (process.env.NEXT_PUBLIC_API_BASE_URL || '');

async function api(path: string, opts?: RequestInit) {
  const base = BACKEND_URL.endsWith('/') ? BACKEND_URL.slice(0, -1) : BACKEND_URL;
  const res = await fetch(`${base}/api${path}`, { ...opts, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...opts?.headers } });
  if (!res.ok) throw new Error(`API ${path} (${res.status})`);
  return res.json();
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

// ═══════════════════════════════════════
// Dashboard
// ═══════════════════════════════════════

type Tab = 'home' | 'trades' | 'watchlist' | 'sources' | 'backtest' | 'settings';

export default function Dashboard() {
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
  const [sources, setSources] = useState<any[]>([]);
  const [withdrawConfig, setWithdrawConfig] = useState<any>(null);
  const [withdrawHistory, setWithdrawHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const geminiRef = useRef<HTMLTextAreaElement>(null);
  const gptRef = useRef<HTMLTextAreaElement>(null);
  const claudeRef = useRef<HTMLTextAreaElement>(null);

  const load = async () => {
    try {
      setLoading(true);
      const [h, d, w, s, t, k, sec, us, src, wc, wh] = await Promise.allSettled([
        api('/health'), api('/dashboard'), api('/watchlist'), api('/strategy'),
        api('/trades?limit=50'), api('/kill-switch'), api('/secrets'),
        api('/overseas/dashboard').catch(() => null),
        api('/sources').catch(() => []),
        api('/withdraw/config').catch(() => null),
        api('/withdraw/history').catch(() => []),
      ]);
      if (h.status === 'fulfilled') setHealth(h.value);
      if (d.status === 'fulfilled') setDash(d.value);
      if (w.status === 'fulfilled') setWatchlist(Array.isArray(w.value) ? w.value : []);
      if (s.status === 'fulfilled') setStrategy(s.value);
      if (t.status === 'fulfilled') setTrades(Array.isArray(t.value) ? t.value : []);
      if (k.status === 'fulfilled') setKillSwitch(k.value);
      if (sec.status === 'fulfilled') setSecrets(sec.value);
      if (us.status === 'fulfilled' && us.value) setUsDash(us.value);
      if (src.status === 'fulfilled') setSources(Array.isArray(src.value) ? src.value : []);
      if (wc.status === 'fulfilled' && wc.value) setWithdrawConfig(wc.value);
      if (wh.status === 'fulfilled') setWithdrawHistory(Array.isArray(wh.value) ? wh.value : []);
      setLastUpdate(new Date());
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); const iv = setInterval(load, 30000); return () => clearInterval(iv); }, []);

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
    { id: 'sources', label: '참고소스', icon: '📎' },
    { id: 'backtest', label: '백테스트', icon: '🧪' },
    { id: 'settings', label: '설정', icon: '⚙️' },
  ];

  // ═══════════════════════════════════════
  // LAYOUT
  // ═══════════════════════════════════════

  return (
    <div className="flex h-screen bg-[#06080f] text-slate-100 overflow-hidden">
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
            { ok: health?.status === 'ok', label: health?.status === 'ok' ? '시스템 정상' : '시스템 오류' },
            { ok: health?.marketOpen, label: `KR ${health?.marketOpen ? '장중' : '장외'}` },
            { ok: health?.usMarketOpen, label: `US ${health?.usMarketOpen ? '장중' : '장외'}` },
            { ok: dash?.tradingMode !== 'paper', label: dash?.tradingMode === 'paper' ? '모의투자' : '실거래', amber: dash?.tradingMode === 'paper' },
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
            {killSwitch?.active ? '긴급정지 ON' : '긴급정지 OFF'}
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
            {killSwitch?.active ? '🛑 ON' : '⏸️'}
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
              {tab === 'home' && <HomeView dash={dash} health={health} killSwitch={killSwitch} trades={trades} usDash={usDash} sources={sources} withdrawConfig={withdrawConfig} />}
              {tab === 'trades' && <TradesView trades={trades} />}
              {tab === 'watchlist' && <WatchlistView watchlist={watchlist} setWatchlist={setWatchlist} dash={dash} usDash={usDash} />}
              {tab === 'sources' && <SourcesView sources={sources} setSources={setSources} />}
              {tab === 'backtest' && <BacktestView watchlist={watchlist} />}
              {tab === 'settings' && <SettingsView strategy={strategy} setStrategy={setStrategy} secrets={secrets} geminiRef={geminiRef} gptRef={gptRef} claudeRef={claudeRef} killSwitch={killSwitch} toggleKill={toggleKill} withdrawConfig={withdrawConfig} setWithdrawConfig={setWithdrawConfig} withdrawHistory={withdrawHistory} setWithdrawHistory={setWithdrawHistory} />}
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

function HomeView({ dash, health, killSwitch, trades, usDash, sources, withdrawConfig }: any) {
  const p = dash?.portfolio;
  const chains = dash?.chains || [];
  const usW = usDash?.watchlist || [];
  const filled = trades.filter((t: any) => t.status === 'FILLED');
  const todayTrades = filled.filter((t: any) => new Date(t.created_at).toDateString() === new Date().toDateString());

  const totalPnl = p?.pnl ?? 0;
  const totalPnlPct = p?.pnlPct ?? 0;
  const totalInvested = p?.invested ?? 0;

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* ── 다음 이벤트 배너 ── */}
      {health?.nextEvent && (
        <div className="px-4 py-2.5 bg-blue-950/30 border border-blue-900/20 rounded-xl text-xs text-blue-300 flex items-center gap-2">
          ⏰ <span>다음: <b>{health.nextEvent}</b></span>
        </div>
      )}

      {/* ── 자산 요약 ── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4">
        <div className="rounded-2xl p-5 sm:p-6 col-span-2 lg:col-span-1 bg-gradient-to-br from-blue-600/10 via-cyan-600/5 to-transparent border border-blue-500/10 shadow-xl shadow-blue-900/10">
          <div className="text-[10px] text-blue-300/60 mb-2 font-semibold uppercase tracking-widest">총 자산</div>
          <div className="text-2xl sm:text-3xl font-black tracking-tight text-white">{fmtWon(p?.totalValue)}</div>
        </div>
        <Card label="현금" value={fmtWon(p?.cash)} />
        <Card label="투자금" value={fmtWon(totalInvested)} />
        <div className={`rounded-2xl border p-4 sm:p-5 shadow-xl shadow-black/20 transition-transform hover:scale-[1.01] ${totalPnl > 0 ? 'bg-emerald-500/5 border-emerald-500/15 glow-green' : totalPnl < 0 ? 'bg-rose-500/5 border-rose-500/15 glow-red' : 'glass border-white/[0.04]'}`}>
          <div className="text-[10px] text-slate-500 mb-2 font-semibold uppercase tracking-widest">미실현 손익</div>
          <div className={`text-lg sm:text-xl font-black ${pc(totalPnl)}`}>{fmtWon(totalPnl)}</div>
          <div className={`text-sm font-bold mt-1 ${pc(totalPnlPct)}`}>{fmtPct(totalPnlPct)}</div>
        </div>
        <Card label="인출 예약" value={fmtWon(withdrawConfig?.totalReserved ?? 0)} color={withdrawConfig?.totalReserved > 0 ? 'text-amber-400' : undefined} bg={withdrawConfig?.totalReserved > 0 ? 'bg-amber-500/5 border-amber-500/15' : undefined} />
      </div>

      {/* ── 국내 + 해외 2컬럼 ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-5">
        {/* 국내 보유 */}
        <Panel title="국내 보유종목" badge={`${(p?.positions?.length || 0) + chains.length}종목`}>
          {(p?.positions?.length > 0 || chains.length > 0) ? (
            <table className="w-full text-[13px]">
              <thead><tr className="text-slate-500 border-b border-slate-700/30">
                <th className="px-4 py-2.5 text-left font-medium">종목</th>
                <th className="px-4 py-2.5 text-right font-medium">수량</th>
                <th className="px-4 py-2.5 text-right font-medium">평단가</th>
                <th className="px-4 py-2.5 text-right font-medium">현재가</th>
                <th className="px-4 py-2.5 text-right font-medium">수익률</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-800/30">
                {(p?.positions || []).map((pos: any, i: number) => (
                  <tr key={i} className="hover:bg-slate-800/20">
                    <td className="px-4 py-3"><div className="font-semibold">{pos.stockName || pos.stockCode}</div><div className="text-[10px] text-slate-600">{pos.stockCode}</div></td>
                    <td className="px-4 py-3 text-right text-slate-400">{fmt(pos.quantity)}주</td>
                    <td className="px-4 py-3 text-right text-slate-500">{fmtWon(pos.avgBuyPrice)}</td>
                    <td className="px-4 py-3 text-right">{fmtWon(pos.currentPrice)}</td>
                    <td className={`px-4 py-3 text-right font-bold ${pc(pos.profitLoss)}`}>
                      <div>{fmtPct(pos.profitLossPct)}</div>
                      <div className="text-[10px] font-normal">{fmtWon(pos.profitLoss)}</div>
                    </td>
                  </tr>
                ))}
                {chains.map((ch: any, i: number) => {
                  const avgPrice = Number(ch.avg_buy_price) || 0;
                  return (
                  <tr key={`c${i}`} className="hover:bg-slate-800/20">
                    <td className="px-4 py-3">
                      <div className="font-semibold">{ch.stock_code}</div>
                      <div className="text-[10px] text-slate-600">{ch.strategy_mode} · {ch.status}</div>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-400">{fmt(ch.total_quantity)}주</td>
                    <td className="px-4 py-3 text-right text-slate-500">{fmtWon(avgPrice)}</td>
                    <td className="px-4 py-3 text-right">
                      {ch.currentPrice > 0 ? fmtWon(ch.currentPrice) : <span className="text-slate-600">-</span>}
                    </td>
                    <td className={`px-4 py-3 text-right font-bold ${pc(ch.unrealizedPnl)}`}>
                      {ch.currentPrice > 0 ? (
                        <>
                          <div>{fmtPct(ch.unrealizedPnlPct)}</div>
                          <div className="text-[10px] font-normal">{fmtWon(ch.unrealizedPnl)}</div>
                        </>
                      ) : <span className="text-slate-600 font-normal text-xs">장 외</span>}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <EmptyMsg>보유 종목 없음</EmptyMsg>}
        </Panel>

        {/* 미국 시세 */}
        <Panel title="미국주식" badge="자동매매 23:30~06:00">
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
          ) : <EmptyMsg>미국 장 시간에 갱신됩니다</EmptyMsg>}
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
                        <span className="font-medium text-slate-300">{ch.stock_code}</span>
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

        {/* 운영 요약 */}
        <Panel title="운영 현황">
          <div className="p-4 sm:p-5 grid grid-cols-2 gap-3">
            <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
              <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">전략 모드</div>
              <div className="text-base font-bold mt-1 text-blue-400">{dash?.strategy?.mode || 'SWING'}</div>
            </div>
            <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
              <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">오늘 매매</div>
              <div className="text-base font-bold mt-1">{todayTrades.length}건</div>
            </div>
            <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
              <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">열린 포지션</div>
              <div className="text-base font-bold mt-1">{chains.length}개</div>
            </div>
            <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
              <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">총 매매</div>
              <div className="text-base font-bold mt-1">{filled.length}건</div>
            </div>
            <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
              <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">킬스위치</div>
              <div className={`text-base font-bold mt-1 ${killSwitch?.active ? 'text-rose-400' : 'text-emerald-400'}`}>{killSwitch?.active ? 'ON' : '정상'}</div>
            </div>
            <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
              <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">매매 모드</div>
              <div className={`text-base font-bold mt-1 ${dash?.tradingMode === 'paper' ? 'text-amber-400' : 'text-blue-400'}`}>{dash?.tradingMode === 'paper' ? '모의' : '실전'}</div>
            </div>
          </div>
        </Panel>
      </div>

      {/* ── AI 스코어 + 최근 매매 2컬럼 ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-5">
        {/* AI 스코어 */}
        <Panel title="AI 종목 스코어" badge={dash?.scores?.length > 0 ? `${dash.scores.length}종목` : undefined}>
          {dash?.scores?.length > 0 ? (
            <div className="p-3.5 space-y-2">
              {dash.scores.map((sc: any) => {
                const score = Number(sc.composite_score);
                const barColor = score >= 75 ? 'bg-emerald-500' : score >= 50 ? 'bg-blue-500' : score >= 25 ? 'bg-amber-500' : 'bg-slate-600';
                const textColor = score >= 75 ? 'text-emerald-400' : score >= 50 ? 'text-blue-400' : 'text-slate-500';
                const signalLabel = sc.signal === 'STRONG_BUY' ? '강력매수' : sc.signal === 'BUY' ? '매수' : sc.signal === 'HOLD' ? '보류' : sc.signal === 'SELL' ? '매도' : sc.signal;
                return (
                  <div key={sc.stock_code} className="flex items-center gap-3 px-2 py-2">
                    <span className="text-xs font-bold text-slate-300 w-16 shrink-0">{sc.stock_code}</span>
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
          ) : <EmptyMsg>AI 분석 대기 중 (07:30 / 18:00 자동 실행)</EmptyMsg>}
        </Panel>

        {/* 최근 매매 */}
        <Panel title="최근 매매" badge={`오늘 ${todayTrades.length}건`}>
          {filled.length === 0 ? <EmptyMsg>매매 기록 없음</EmptyMsg> : (
            <div className="divide-y divide-white/[0.03]">
              {filled.slice(0, 5).map((t: any, i: number) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02]">
                  <SideBadge side={t.side} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-slate-200">{t.stock_code}</span>
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

      {/* ── 참고 소스 ── */}
      {sources?.length > 0 && (
        <Panel title="참고 소스" badge={`${sources.length}건`}>
          <div className="divide-y divide-white/[0.03]">
            {sources.slice(0, 4).map((s: any) => (
              <a key={s.id} href={s.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02] group">
                <span className="text-base shrink-0">{sourceIcon(s.source_type)}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-slate-300 group-hover:text-blue-400 transition-colors truncate">{s.title}</div>
                  {s.memo && <div className="text-[11px] text-slate-600 truncate mt-0.5">{s.memo}</div>}
                </div>
                <span className="text-[10px] text-slate-600 shrink-0">{fmtTime(s.added_at)}</span>
                {s.is_pinned && <span className="text-[9px] bg-amber-500/10 text-amber-400 px-1.5 py-0.5 rounded font-medium shrink-0">PIN</span>}
              </a>
            ))}
          </div>
        </Panel>
      )}

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

function TradesView({ trades }: { trades: any[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <Panel title="매매내역" badge={`${trades.length}건`}>
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
            <th className="px-4 py-3 text-left font-medium">AI 판단</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-800/20">
            {trades.length === 0 ? (
              <tr><td colSpan={8} className="p-12 text-center text-slate-500">매매 기록 없음</td></tr>
            ) : trades.map((t: any, i: number) => {
              const chain = t.transaction_chains;
              const isOpen = expanded === i;
              return (
              <React.Fragment key={i}>
              <tr onClick={() => setExpanded(isOpen ? null : i)} className="hover:bg-slate-800/20 transition-colors cursor-pointer">
                <td className="px-4 py-3 text-slate-500">{fmtTime(t.created_at)}</td>
                <td className="px-4 py-3 font-semibold">{t.stock_code}</td>
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
                        <p className="text-slate-500 font-medium mb-1.5">AI 판단 근거</p>
                        <p className="text-slate-300 leading-relaxed whitespace-pre-wrap">{t.ai_reasoning || '근거 없음'}</p>
                      </div>
                      <div>
                        <p className="text-slate-500 font-medium mb-1.5">매도 계획</p>
                        {chain?.strategy_mode ? (
                          <div className="space-y-1 text-slate-400">
                            <p>전략: <span className="text-slate-200 font-medium">{chain.strategy_mode}</span></p>
                            <p>평단가: <span className="text-slate-200">{Number(chain.avg_buy_price).toLocaleString()}원</span></p>
                            <p>상태: <span className="text-slate-200">{chain.status}</span></p>
                            {chain.strategy_mode === 'SWING' && (
                              <>
                                <p className="text-emerald-400">익절: 평단가 +8% → 50% 매도</p>
                                <p className="text-rose-400">손절: 평단가 -5% → 전량 매도</p>
                                <p className="text-blue-400">물타기: -3% 시 추가 매수 (최대 3회)</p>
                              </>
                            )}
                            {chain.strategy_mode === 'DEFENSE' && (
                              <>
                                <p className="text-emerald-400">익절: 평단가 +5% → 전량 매도</p>
                                <p className="text-rose-400">손절: 평단가 -3% → 전량 매도</p>
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
    </Panel>
  );
}

// ═══════════════════════════════════════
// WATCHLIST VIEW
// ═══════════════════════════════════════

function WatchlistView({ watchlist, setWatchlist, dash, usDash }: any) {
  const usW = usDash?.watchlist || [];
  const [selectedStock, setSelectedStock] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<any>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);

  const loadAnalysis = async (code: string) => {
    if (selectedStock === code) { setSelectedStock(null); return; }
    setSelectedStock(code);
    setAnalysisLoading(true);
    try {
      const data = await api(`/stock/${code}/analysis`);
      setAnalysis(data);
    } catch { setAnalysis(null); }
    finally { setAnalysisLoading(false); }
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

  const t = analysis?.technicals;
  const f = analysis?.flow;
  const sh = analysis?.shorts;
  const con = analysis?.consensus;

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* 추가 폼 */}
      <form onSubmit={addStock} className="flex flex-wrap gap-2">
        <input name="code" placeholder="종목코드 (005930)" maxLength={6} required className="flex-1 min-w-[120px] bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm placeholder:text-slate-600 focus:border-blue-500 focus:outline-none" />
        <input name="name" placeholder="종목명(자동조회)" className="flex-1 min-w-[120px] bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm placeholder:text-slate-600 focus:border-blue-500 focus:outline-none" />
        <select name="market" defaultValue="KOSPI" className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm"><option>KOSPI</option><option>KOSDAQ</option></select>
        <button type="submit" className="px-5 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium">추가</button>
      </form>

      {/* 종목 상세 분석 패널 */}
      {selectedStock && (
        <Panel title={`${watchlist.find((s: any) => s.stock_code === selectedStock)?.stock_name || selectedStock} 종목 분석`} badge={selectedStock}>
          {analysisLoading ? (
            <div className="p-8 text-center"><div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto" /></div>
          ) : t ? (
            <div className="p-4 sm:p-5 space-y-5">
              {/* 기술적 지표 */}
              <div>
                <h4 className="text-xs font-semibold text-slate-400 mb-3">기술적 지표</h4>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
                  <Indicator label="RSI (14)" value={t.rsi14?.toFixed(0)} sub={t.rsi14 > 70 ? '과매수' : t.rsi14 < 30 ? '과매도' : '중립'} color={t.rsi14 > 70 ? 'rose' : t.rsi14 < 30 ? 'emerald' : 'slate'} />
                  <Indicator label="MACD" value={t.macdHistogram?.toFixed(0)} sub={t.macdCrossover === 'golden' ? '골든크로스' : t.macdCrossover === 'dead' ? '데드크로스' : '유지'} color={t.macdHistogram > 0 ? 'emerald' : 'rose'} />
                  <Indicator label="볼린저" value={t.bollingerPosition?.toFixed(0) + '%'} sub={t.bollingerPosition > 80 ? '상단 돌파' : t.bollingerPosition < 20 ? '하단 근접' : '밴드 내'} color={t.bollingerPosition > 80 ? 'rose' : t.bollingerPosition < 20 ? 'emerald' : 'slate'} />
                  <Indicator label="ADX (추세)" value={t.adx14?.toFixed(0)} sub={t.adx14 > 25 ? '강한 추세' : '횡보'} color={t.adx14 > 25 ? 'blue' : 'slate'} />
                  <Indicator label="종합 점수" value={t.score?.toFixed(0)} sub={t.overallSignal} color={t.score > 20 ? 'emerald' : t.score < -20 ? 'rose' : 'slate'} />
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-3 text-center text-[11px]">
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">SMA 5</span><b>{t.sma5?.toLocaleString()}</b></div>
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">SMA 20</span><b>{t.sma20?.toLocaleString()}</b></div>
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">SMA 60</span><b>{t.sma60?.toLocaleString()}</b></div>
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">거래량 비</span><b className={t.volumeRatio > 2 ? 'text-amber-400' : ''}>{t.volumeRatio?.toFixed(1)}x</b></div>
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">스토캐스틱</span><b>{t.stochasticK?.toFixed(0)}</b></div>
                  <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">ATR</span><b>{t.atr14?.toFixed(0)}</b></div>
                </div>
                {t.goldenCross && <p className="text-[11px] text-emerald-400 mt-2">골든크로스 발생 (SMA5 &gt; SMA20)</p>}
                {t.deathCross && <p className="text-[11px] text-rose-400 mt-2">데드크로스 발생 (SMA5 &lt; SMA20)</p>}
              </div>

              {/* 수급 + 공매도 + 목표가 */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* 수급 */}
                <div className="bg-slate-900/40 rounded-xl p-4">
                  <h4 className="text-xs font-semibold text-slate-400 mb-2">외국인/기관 수급</h4>
                  {f ? (
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between"><span className="text-slate-500">외국인</span><span className={f.foreignNet > 0 ? 'text-emerald-400' : 'text-rose-400'}>{f.foreignNet > 0 ? '+' : ''}{f.foreignNet?.toLocaleString()}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">기관</span><span className={f.institutionNet > 0 ? 'text-emerald-400' : 'text-rose-400'}>{f.institutionNet > 0 ? '+' : ''}{f.institutionNet?.toLocaleString()}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">연속매수</span><span className="font-bold">{f.foreignStreak ?? 0}일</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">추세</span><span className={f.trend === 'STRONG_BUY' || f.trend === 'BUY' ? 'text-emerald-400' : f.trend === 'SELL' || f.trend === 'STRONG_SELL' ? 'text-rose-400' : 'text-slate-400'}>{f.trend}</span></div>
                    </div>
                  ) : <p className="text-[11px] text-slate-600">장 외 시간</p>}
                </div>

                {/* 공매도 */}
                <div className="bg-slate-900/40 rounded-xl p-4">
                  <h4 className="text-xs font-semibold text-slate-400 mb-2">공매도</h4>
                  {sh ? (
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between"><span className="text-slate-500">공매도 비율</span><span className={sh.riskLevel === 'HIGH' ? 'text-rose-400 font-bold' : ''}>{sh.shortRatio?.toFixed(1)}%</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">추세</span><span>{sh.isIncreasing ? '증가 중' : '감소 중'}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">위험도</span><span className={sh.riskLevel === 'HIGH' ? 'text-rose-400' : sh.riskLevel === 'MEDIUM' ? 'text-amber-400' : 'text-emerald-400'}>{sh.riskLevel}</span></div>
                    </div>
                  ) : <p className="text-[11px] text-slate-600">장 외 시간</p>}
                </div>

                {/* 증권사 목표가 */}
                <div className="bg-slate-900/40 rounded-xl p-4">
                  <h4 className="text-xs font-semibold text-slate-400 mb-2">증권사 컨센서스</h4>
                  {con ? (
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between"><span className="text-slate-500">목표가</span><span className="font-bold">{con.targetPrice?.toLocaleString()}원</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">상승 여력</span><span className={con.upsidePct > 0 ? 'text-emerald-400' : 'text-rose-400'}>{con.upsidePct > 0 ? '+' : ''}{con.upsidePct?.toFixed(1)}%</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">의견</span><span>{con.buyCount}매수 {con.holdCount}보유 {con.sellCount}매도</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">컨센서스</span><span className={con.consensusRating === 'STRONG_BUY' || con.consensusRating === 'BUY' ? 'text-emerald-400' : 'text-slate-400'}>{con.consensusRating}</span></div>
                    </div>
                  ) : <p className="text-[11px] text-slate-600">데이터 없음</p>}
                </div>
              </div>
            </div>
          ) : <EmptyMsg>장 외 시간이거나 데이터가 부족합니다</EmptyMsg>}
        </Panel>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-5">
        {/* 국내 */}
        <Panel title="🇰🇷 국내" badge={`${watchlist.length}종목`}>
          <div className="divide-y divide-slate-800/20">
            {watchlist.map((s: any) => {
              const score = dash?.scores?.find((sc: any) => sc.stock_code === s.stock_code);
              const isSelected = selectedStock === s.stock_code;
              return (
                <div key={s.stock_code} onClick={() => loadAnalysis(s.stock_code)} className={`flex items-center px-4 py-3 hover:bg-slate-800/30 cursor-pointer group transition-colors ${isSelected ? 'bg-blue-950/20 border-l-2 border-blue-500' : ''}`}>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-sm">{s.stock_name}</span>
                    <span className="text-[11px] text-slate-500 ml-2">{s.stock_code} · {s.market}</span>
                  </div>
                  {score && <span className={`text-[11px] font-bold mr-3 ${Number(score.composite_score) >= 60 ? 'text-emerald-400' : 'text-slate-500'}`}>{score.composite_score}점</span>}
                  <span className="text-[10px] text-slate-600 mr-2">{isSelected ? '▲' : '분석 ▼'}</span>
                  <button onClick={(e) => { e.stopPropagation(); del(s.stock_code); }} className="opacity-0 group-hover:opacity-100 text-[11px] text-rose-400 hover:text-rose-300 transition-opacity">삭제</button>
                </div>
              );
            })}
            {watchlist.length === 0 && <EmptyMsg>종목을 추가하세요</EmptyMsg>}
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

      {!singleResult && !batchResult && <EmptyMsg>백테스트를 실행하면 과거 데이터로 전략 성과를 검증합니다</EmptyMsg>}
    </div>
  );
}

// ═══════════════════════════════════════
// SOURCES VIEW
// ═══════════════════════════════════════

function sourceIcon(type: string) {
  switch (type) {
    case 'youtube': return '🎬';
    case 'news': return '📰';
    case 'research': return '📊';
    default: return '📎';
  }
}

function SourcesView({ sources, setSources }: { sources: any[]; setSources: (s: any[]) => void }) {
  const addSource = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const title = String(fd.get('title') ?? '').trim();
    const url = String(fd.get('url') ?? '').trim();
    const sourceType = String(fd.get('source_type') ?? 'article');
    const memo = String(fd.get('memo') ?? '').trim();
    if (!title || !url) { alert('제목과 URL을 입력하세요'); return; }
    try {
      const added = await api('/sources', { method: 'POST', body: JSON.stringify({ title, url, source_type: sourceType, memo }) });
      setSources([added, ...sources]);
      (e.target as HTMLFormElement).reset();
    } catch (err: any) { alert(err.message); }
  };

  const togglePin = async (id: string) => {
    await api(`/sources/${id}/pin`, { method: 'PATCH' });
    setSources(sources.map(s => s.id === id ? { ...s, is_pinned: !s.is_pinned } : s));
  };

  const del = async (id: string) => {
    if (!confirm('삭제하시겠습니까?')) return;
    await api(`/sources/${id}`, { method: 'DELETE' });
    setSources(sources.filter(s => s.id !== id));
  };

  // YouTube URL에서 video ID 추출
  const getYoutubeId = (url: string) => {
    const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
    return m?.[1] ?? null;
  };

  const pinned = sources.filter(s => s.is_pinned);
  const others = sources.filter(s => !s.is_pinned);

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* 추가 폼 */}
      <Panel title="소스 추가">
        <form onSubmit={addSource} className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input name="title" placeholder="제목 (예: 이번주 시장 전망)" required className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm placeholder:text-slate-600 focus:border-blue-500 focus:outline-none" />
            <input name="url" placeholder="URL (YouTube, 뉴스, 리서치)" required className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm placeholder:text-slate-600 focus:border-blue-500 focus:outline-none" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr_auto] gap-3 items-end">
            <select name="source_type" defaultValue="youtube" className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm">
              <option value="youtube">YouTube</option>
              <option value="news">뉴스</option>
              <option value="research">리서치</option>
              <option value="article">기사/블로그</option>
            </select>
            <input name="memo" placeholder="메모 (선택)" className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm placeholder:text-slate-600 focus:border-blue-500 focus:outline-none" />
            <button type="submit" className="px-5 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium whitespace-nowrap">추가</button>
          </div>
        </form>
      </Panel>

      {/* 핀 고정 소스 */}
      {pinned.length > 0 && (
        <Panel title="고정 소스" badge={`${pinned.length}건`}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3">
            {pinned.map((s: any) => {
              const ytId = s.source_type === 'youtube' ? getYoutubeId(s.url) : null;
              return (
                <div key={s.id} className="bg-slate-900/60 rounded-lg border border-slate-700/30 overflow-hidden group">
                  {ytId && (
                    <div className="aspect-video bg-black">
                      <iframe src={`https://www.youtube.com/embed/${ytId}`} className="w-full h-full" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope" allowFullScreen />
                    </div>
                  )}
                  <div className="p-3">
                    <div className="flex items-start gap-2">
                      <span className="text-sm shrink-0">{sourceIcon(s.source_type)}</span>
                      <div className="flex-1 min-w-0">
                        <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-blue-400 hover:text-blue-300 block truncate">{s.title}</a>
                        {s.memo && <p className="text-[10px] text-slate-500 mt-0.5">{s.memo}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-[10px] text-slate-600">{fmtTime(s.added_at)}</span>
                      <div className="ml-auto flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => togglePin(s.id)} className="text-[10px] text-amber-400 hover:text-amber-300">고정 해제</button>
                        <button onClick={() => del(s.id)} className="text-[10px] text-rose-400 hover:text-rose-300">삭제</button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {/* 전체 소스 목록 */}
      <Panel title="전체 소스" badge={`${others.length}건`}>
        {others.length === 0 ? <EmptyMsg>소스를 추가하세요 — YouTube, 뉴스, 리서치 등</EmptyMsg> : (
          <div className="divide-y divide-slate-800/20">
            {others.map((s: any) => (
              <div key={s.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-slate-800/30 group">
                <span className="text-sm shrink-0">{sourceIcon(s.source_type)}</span>
                <div className="flex-1 min-w-0">
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-blue-400 hover:text-blue-300 truncate block">{s.title}</a>
                  {s.memo && <p className="text-[10px] text-slate-500 truncate">{s.memo}</p>}
                </div>
                <span className="text-[10px] text-slate-600 shrink-0">{fmtTime(s.added_at)}</span>
                <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button onClick={() => togglePin(s.id)} className="text-[10px] text-amber-400 hover:text-amber-300">PIN</button>
                  <button onClick={() => del(s.id)} className="text-[10px] text-rose-400 hover:text-rose-300">삭제</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

// ═══════════════════════════════════════
// SETTINGS VIEW
// ═══════════════════════════════════════

function SettingsView({ strategy, setStrategy, secrets, geminiRef, gptRef, claudeRef, killSwitch, toggleKill, withdrawConfig, setWithdrawConfig, withdrawHistory, setWithdrawHistory }: any) {
  const [promptTab, setPromptTab] = useState<'gemini' | 'gpt' | 'claude'>('gemini');
  const setField = async (field: string, val: string | number) => {
    try { const u = await api('/strategy', { method: 'PUT', body: JSON.stringify({ ...strategy, [field]: val }) }); setStrategy(u); } catch {}
  };
  const saveStrategy = async () => {
    const body = { ...strategy, gemini_prompt: geminiRef.current?.value ?? '', gpt_prompt: gptRef.current?.value ?? '', claude_prompt: claudeRef.current?.value ?? '' };
    try { await api('/strategy', { method: 'PUT', body: JSON.stringify(body) }); alert('저장 완료'); } catch (err: any) { alert(err.message); }
  };
  const saveSecrets = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body: Record<string, string> = {};
    fd.forEach((v, k) => { if (typeof v === 'string' && v.trim()) body[k] = v.trim(); });
    if (!Object.keys(body).length) { alert('변경할 키 입력'); return; }
    try { await api('/secrets', { method: 'PUT', body: JSON.stringify(body) }); (e.target as HTMLFormElement).reset(); alert('저장 완료'); } catch (err: any) { alert(err.message); }
  };

  const promptTabs = [
    { id: 'gemini' as const, label: 'Gemini (서론 · 분석)', ref: geminiRef, key: 'gemini_prompt', desc: '시장 데이터를 팩트 기반으로 정제합니다' },
    { id: 'gpt' as const, label: 'GPT (본론 · 스코어링)', ref: gptRef, key: 'gpt_prompt', desc: 'Gemini 결과를 기반으로 점수를 매깁니다' },
    { id: 'claude' as const, label: 'Claude (결론 · 매매)', ref: claudeRef, key: 'claude_prompt', desc: '최종 매수/매도/보류를 결정합니다' },
  ];
  const activePrompt = promptTabs.find(t => t.id === promptTab)!;

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* ── 상단: 킬스위치 + AI 실행 ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Panel title="긴급 제어">
          <div className="p-4 sm:p-5 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">긴급정지</p>
              <p className="text-[11px] text-slate-500 mt-0.5">모든 자동매매 즉시 중지</p>
              {killSwitch?.reason && <p className="text-[11px] text-rose-400 mt-1">{killSwitch.reason}</p>}
            </div>
            <button onClick={toggleKill} className={`px-5 py-2.5 rounded-xl text-xs font-bold transition-all ${killSwitch?.active ? 'bg-rose-600 hover:bg-rose-500 shadow-lg shadow-rose-900/40' : 'bg-slate-700 hover:bg-slate-600 text-slate-400'}`}>
              {killSwitch?.active ? '🛑 ON → 해제' : '⏸️ OFF → 발동'}
            </button>
          </div>
        </Panel>
        <Panel title="AI 분석 수동 실행">
          <div className="p-4 sm:p-5 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Track A 즉시 실행</p>
              <p className="text-[11px] text-slate-500 mt-0.5">Gemini → GPT → Claude 파이프라인</p>
            </div>
            <button onClick={async () => {
              if (!confirm('AI 분석을 수동 실행하시겠습니까?')) return;
              try { await api('/run-track-a', { method: 'POST', body: JSON.stringify({}) }); alert('실행 시작 — 2~3분 후 갱신'); } catch (err: any) { alert(err.message); }
            }} className="px-5 py-2.5 bg-purple-600 hover:bg-purple-500 rounded-xl text-xs font-bold">
              실행
            </button>
          </div>
        </Panel>
      </div>

      {/* ── 전략 설정 (풀와이드) ── */}
      {strategy && (
        <Panel title="전략 설정">
          <div className="p-4 sm:p-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
              <Sel label="전략 모드" value={strategy.mode} opts={[['SWING','스윙'],['DEFENSE','방어'],['SCALPING','단타']]} onChange={v => setField('mode', v)} />
              <Sel label="매수 기준" value={strategy.buy_threshold} opts={[[60,'60점'],[70,'70점'],[75,'75점'],[80,'80점'],[85,'85점'],[90,'90점']]} onChange={v => setField('buy_threshold', Number(v))} />
              <Sel label="손절" value={strategy.stop_loss_pct} opts={[[-2,'-2%'],[-3,'-3%'],[-5,'-5%'],[-7,'-7%'],[-10,'-10%']]} onChange={v => setField('stop_loss_pct', Number(v))} />
              <Sel label="익절" value={strategy.take_profit_pct} opts={[[3,'+3%'],[5,'+5%'],[8,'+8%'],[10,'+10%'],[15,'+15%'],[20,'+20%']]} onChange={v => setField('take_profit_pct', Number(v))} />
            </div>
          </div>
        </Panel>
      )}

      {/* ── AI 프롬프트 (탭 전환, 풀와이드) ── */}
      {strategy && (
        <Panel title="AI 프롬프트 관리">
          <div className="p-4 sm:p-5 space-y-4">
            {/* 탭 */}
            <div className="flex gap-1 bg-slate-900/60 rounded-xl p-1">
              {promptTabs.map(t => (
                <button key={t.id} onClick={() => setPromptTab(t.id)}
                  className={`flex-1 py-2.5 rounded-lg text-xs font-medium transition-all ${promptTab === t.id ? 'bg-blue-600/20 text-blue-400 shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}>
                  {t.label}
                </button>
              ))}
            </div>
            {/* 설명 */}
            <p className="text-[11px] text-slate-500">{activePrompt.desc}</p>
            {/* 에디터 */}
            <textarea
              ref={activePrompt.ref}
              defaultValue={strategy?.[activePrompt.key] || ''}
              rows={10}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl p-4 text-sm leading-relaxed resize-y font-mono focus:border-blue-500 focus:outline-none"
              placeholder={`${activePrompt.label} 프롬프트를 입력하세요...`}
            />
            <button onClick={saveStrategy} className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium">전략 + 프롬프트 저장</button>
          </div>
        </Panel>
      )}

      {/* ── 하단 2컬럼: API키 + 수익인출 ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-5">
        {/* API 키 */}
        <Panel title="API 키 관리">
          <form onSubmit={saveSecrets} className="p-4 sm:p-5 space-y-3">
            {[['gemini','Gemini'],['openai','OpenAI'],['anthropic','Anthropic'],['kis_appkey','KIS Key'],['kis_appsecret','KIS Secret'],['kis_account','KIS 계좌']].map(([k, l]) => (
              <div key={k} className="flex items-center gap-3">
                <span className="w-20 text-xs text-slate-400 shrink-0">{l}</span>
                {secrets?.[k]?.exists && <span className="text-[9px] bg-emerald-900/50 text-emerald-300 px-2 py-0.5 rounded shrink-0">설정됨</span>}
                <input name={k} type="password" placeholder={secrets?.[k]?.masked || '미설정'} className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono focus:border-blue-500 focus:outline-none" />
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
                } catch {}
              }} className={`px-4 py-2 rounded-lg text-xs font-bold ${withdrawConfig?.is_active ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-slate-700 hover:bg-slate-600 text-slate-400'}`}>
                {withdrawConfig?.is_active ? 'ON' : 'OFF'}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Sel label="목표 수익률" value={withdrawConfig?.target_profit_pct ?? 10} opts={[[5,'5%'],[8,'8%'],[10,'10%'],[15,'15%'],[20,'20%'],[30,'30%']]} onChange={async v => {
                try { const u = await api('/withdraw/config', { method: 'PUT', body: JSON.stringify({ ...withdrawConfig, target_profit_pct: Number(v) }) }); setWithdrawConfig({ ...u, totalReserved: withdrawConfig?.totalReserved ?? 0 }); } catch {}
              }} />
              <Sel label="인출 비율 (수익분 중)" value={withdrawConfig?.withdraw_ratio_pct ?? 50} opts={[[30,'30%'],[50,'50%'],[70,'70%'],[80,'80%'],[100,'100%']]} onChange={async v => {
                try { const u = await api('/withdraw/config', { method: 'PUT', body: JSON.stringify({ ...withdrawConfig, withdraw_ratio_pct: Number(v) }) }); setWithdrawConfig({ ...u, totalReserved: withdrawConfig?.totalReserved ?? 0 }); } catch {}
              }} />
              <Sel label="최소 인출 금액" value={withdrawConfig?.min_withdraw_amount ?? 100000} opts={[[50000,'5만원'],[100000,'10만원'],[200000,'20만원'],[500000,'50만원'],[1000000,'100만원']]} onChange={async v => {
                try { const u = await api('/withdraw/config', { method: 'PUT', body: JSON.stringify({ ...withdrawConfig, min_withdraw_amount: Number(v) }) }); setWithdrawConfig({ ...u, totalReserved: withdrawConfig?.totalReserved ?? 0 }); } catch {}
              }} />
              <Sel label="체크 주기" value={withdrawConfig?.check_frequency ?? 'daily'} opts={[['daily','매일 (장 마감)'],['weekly','매주 금요일']]} onChange={async v => {
                try { const u = await api('/withdraw/config', { method: 'PUT', body: JSON.stringify({ ...withdrawConfig, check_frequency: v }) }); setWithdrawConfig({ ...u, totalReserved: withdrawConfig?.totalReserved ?? 0 }); } catch {}
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
            <form onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const newPin = String(fd.get('pin') ?? '').trim();
              if (newPin.length < 4) { alert('PIN은 4자리 이상'); return; }
              localStorage.setItem('quantops_pin', newPin);
              alert('PIN 변경 완료');
              (e.target as HTMLFormElement).reset();
            }} className="flex gap-2 flex-1 max-w-sm">
              <input name="pin" type="password" inputMode="numeric" maxLength={6} placeholder="새 PIN (4~6자리)" className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-center tracking-widest font-mono focus:border-blue-500 focus:outline-none" />
              <button type="submit" className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium shrink-0">변경</button>
            </form>
            <button type="button" onClick={() => {
              localStorage.removeItem('quantops_cred_id');
              localStorage.removeItem('quantops_auth_ts');
              alert('생체인증이 초기화되었습니다.');
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

function Panel({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/30 animate-in">
      <div className="px-5 py-3.5 border-b border-white/[0.04] flex items-center gap-2">
        <h3 className="text-[13px] font-bold text-slate-100 tracking-tight">{title}</h3>
        {badge && <span className="text-[10px] bg-white/[0.06] text-slate-400 px-2.5 py-1 rounded-full ml-auto font-medium">{badge}</span>}
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

function EmptyMsg({ children }: { children: React.ReactNode }) {
  return <div className="p-10 text-center text-slate-600 text-sm">{children}</div>;
}

function SideBadge({ side }: { side: string }) {
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide ${side === 'BUY' ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20' : 'bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/20'}`}>{side === 'BUY' ? '매수' : '매도'}</span>;
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-medium ${status === 'FILLED' ? 'bg-emerald-500/10 text-emerald-400' : status === 'FAILED' ? 'bg-rose-500/10 text-rose-400' : 'bg-white/[0.04] text-slate-500'}`}>{status}</span>;
}

function ModeBadge({ mode }: { mode: string }) {
  return <span className={`px-1.5 py-0.5 rounded text-[10px] ${mode === 'paper' ? 'bg-amber-900/40 text-amber-300' : 'bg-blue-900/40 text-blue-300'}`}>{mode === 'paper' ? '모의' : '실'}</span>;
}

function Sel({ label, value, opts, onChange }: { label: string; value: any; opts: [any, string][]; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-[11px] text-slate-500 block mb-1">{label}</label>
      <select defaultValue={value} onChange={e => onChange(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}
