'use client';

import React from 'react';
import { Button } from '@/components/ui';
import { ViewModeToggle } from '@/components/ViewModeToggle';
import { MarketTicker } from '@/components/MarketTicker';

export function DashboardHeader({ viewMode, switchView, dash, killSwitch, toggleKill, marketTab, setMobileMenu, isPaper, isUS, theme }: {
  viewMode: 'live' | 'paper'; switchView: (m: 'live' | 'paper') => void;
  dash: any; killSwitch: any; toggleKill: (scope?: 'KR' | 'OVERSEAS') => Promise<void>;
  marketTab: 'KR' | 'US'; setMobileMenu: (v: boolean) => void;
  isPaper: boolean; isUS: boolean; theme: any;
}) {
  const isKillActive = killSwitch?.kr?.active || killSwitch?.overseas?.active;

  return (
    <>
      {/* Mobile header */}
      <header className="lg:hidden flex items-center gap-3 px-4 py-3 border-b transition-colors duration-500 bg-[var(--theme-side)] border-[var(--theme-border)]">
        <button onClick={() => setMobileMenu(true)} className="text-slate-400">
          <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
        </button>
        <span className="font-bold text-sm bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">AI Bot</span>
        <div className="mx-auto">
          <ViewModeToggle viewMode={viewMode} onChange={switchView} size="sm" />
        </div>
        <Button
          variant={isKillActive ? 'danger' : 'success'}
          size="sm"
          className="min-h-[36px] px-4 py-2"
          onClick={() => toggleKill()}
        >
          {isKillActive ? '⏸ 중단 중' : '▶ 자동 중'}
        </Button>
      </header>

      {/* Desktop header */}
      <header className="hidden lg:flex items-center justify-center h-12 border-b shrink-0 relative transition-colors duration-500 bg-[var(--theme-side-60)] border-[var(--theme-border)]">
        <div className="absolute left-4 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[10px] text-slate-500 font-medium">
            거래: {dash?.tradingMode === 'paper' ? '연습 중' : '실전 중'}
          </span>
        </div>
        <ViewModeToggle viewMode={viewMode} onChange={switchView} />
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

      {/* 시장 정보 헤더 — 데스크탑+모바일 */}
      <div className="px-3 py-1.5 border-b border-[var(--theme-border)] bg-[var(--theme-side-60)]">
        <MarketTicker />
      </div>
    </>
  );
}
