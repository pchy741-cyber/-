'use client';

import React from 'react';
import { Button } from '@/components/ui';

type Tab = 'home' | 'trades' | 'journal' | 'watchlist' | 'news' | 'settings' | 'dividend' | 'futures';

export function DashboardSidebar({ tab, setTab, mobileMenu, setMobileMenu, health, dash, viewMode, switchView, killSwitch, toggleKill, lastUpdate, load, featureFlags, isPaper, isUS, theme, loopStatus }: {
  tab: Tab; setTab: (t: Tab) => void;
  mobileMenu: boolean; setMobileMenu: (v: boolean) => void;
  health: any; dash: any;
  viewMode: 'live' | 'paper'; switchView: (m: 'live' | 'paper') => void;
  killSwitch: any; toggleKill: (scope?: 'KR' | 'OVERSEAS') => Promise<void>;
  lastUpdate: Date; load: (force?: boolean) => void;
  featureFlags: Record<string, boolean>;
  isPaper: boolean; isUS: boolean; theme: any;
  loopStatus?: any;
}) {
  const isKillActive = killSwitch?.kr?.active || killSwitch?.overseas?.active;

  const navItems: { id: Tab; label: string; icon: string }[] = [
    { id: 'home', label: '대시보드', icon: '📊' },
    { id: 'trades', label: '매매내역', icon: '📋' },
    { id: 'journal', label: '매매일지', icon: '📓' },
    { id: 'watchlist', label: '감시목록', icon: '👁' },
    { id: 'news', label: '뉴스', icon: '📰' },
    { id: 'dividend' as Tab, label: '배당', icon: '💰' },
    { id: 'futures' as Tab, label: '선물', icon: '📈' },
    { id: 'settings', label: '설정', icon: '⚙️' },
  ];

  return (
    <>
      {mobileMenu && <div className="fixed inset-0 bg-black/60 z-40 lg:hidden" onClick={() => setMobileMenu(false)} />}
      <aside className={`fixed lg:static inset-y-0 left-0 z-50 w-[220px] backdrop-blur-xl flex flex-col shrink-0 transform transition-all duration-500 bg-[var(--theme-side-95)] border-r border-[var(--theme-border)] ${mobileMenu ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="px-5 py-5 border-b border-white/[0.04]">
          <h1 className="text-lg font-black tracking-tight bg-gradient-to-r from-blue-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent">AI Bot</h1>
          <p className="text-[10px] text-slate-600 mt-0.5 font-medium">Auto Bot v0.2</p>
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

        {/* AI Loop 상태 패널 */}
        {loopStatus?.active && (
          <div className="mx-3 mt-3 rounded-xl bg-gradient-to-br from-emerald-500/10 via-cyan-500/5 to-transparent border border-emerald-500/20 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span className="text-[11px] font-bold text-emerald-400">AI Loop 연결됨</span>
            </div>
            <div className="space-y-1.5 text-[10px] text-slate-400">
              <div className="flex justify-between">
                <span>실행</span>
                <span className="text-slate-300 font-medium">{loopStatus.totalRuns}회</span>
              </div>
              {loopStatus.brief && (
                <div className="flex justify-between">
                  <span>전략</span>
                  <span className="text-cyan-400 font-medium">{loopStatus.brief.regime}/{loopStatus.brief.risk}</span>
                </div>
              )}
              {loopStatus.autoPilot?.overridesSet > 0 && (
                <div className="flex justify-between">
                  <span>AP 조절</span>
                  <span className="text-amber-400 font-medium">{loopStatus.autoPilot.overridesSet}건</span>
                </div>
              )}
              {loopStatus.autoPilot?.decisions?.length > 0 && (
                <div className="mt-1.5 pt-1.5 border-t border-white/5 space-y-0.5">
                  {loopStatus.autoPilot.decisions.slice(0, 3).map((d: string, i: number) => (
                    <div key={i} className="text-[9px] text-slate-500 truncate" title={d}>
                      {d}
                    </div>
                  ))}
                </div>
              )}
              {loopStatus.lastRunResult === 'error' && (
                <div className="text-red-400 font-medium">오류 {loopStatus.consecutiveErrors}회</div>
              )}
            </div>
          </div>
        )}

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
          <Button
            variant={isKillActive ? 'danger' : 'success'}
            size="md"
            className={`w-full py-3 ${isKillActive ? 'shadow-lg shadow-rose-600/30' : ''}`}
            onClick={() => toggleKill()}
          >
            {isKillActive ? '⏸ 매매 중단 중' : '▶ 자동매매 중'}
          </Button>
          {isKillActive && (
            <div className="flex gap-1">
              {killSwitch?.kr?.active && (
                <Button variant="amber" size="sm" className="flex-1 py-1.5 text-[10px]" onClick={() => toggleKill('KR')}>
                  국내 해제
                </Button>
              )}
              {killSwitch?.overseas?.active && (
                <Button variant="violet" size="sm" className="flex-1 py-1.5 text-[10px]" onClick={() => toggleKill('OVERSEAS')}>
                  해외 해제
                </Button>
              )}
            </div>
          )}
          <Button variant="ghost" size="sm" className="w-full py-2 text-[10px] text-slate-600 hover:text-slate-400" onClick={() => load(true)}>
            새로고침 · {lastUpdate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
          </Button>
        </div>
      </aside>
    </>
  );
}
