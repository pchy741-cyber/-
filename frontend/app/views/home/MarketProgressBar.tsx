'use client';

import React from 'react';
import { fmtWon } from '../../lib/utils';
import type { Health } from '../../types';

interface MarketProgressBarProps {
  health: Health | null;
  holdingsTab: 'KR' | 'US';
  currentTimeStr: string;
  marketProgress: number;
  usMarketProgress: number;
  unrealizedPnl: number;
  overseasPnlUsd: number;
  dailyLossLimit: number;
  overseasLimitUsd: number;
}

export default function MarketProgressBar({
  health, holdingsTab, currentTimeStr, marketProgress, usMarketProgress,
  unrealizedPnl, overseasPnlUsd, dailyLossLimit, overseasLimitUsd,
}: MarketProgressBarProps) {
  const isUs = holdingsTab === 'US';
  const loss = isUs ? overseasPnlUsd : unrealizedPnl;
  const limit = isUs ? overseasLimitUsd : dailyLossLimit;
  const usedPct = loss < 0 && limit > 0 ? Math.min(100, Math.round((Math.abs(loss) / limit) * 100)) : 0;
  const color = usedPct >= 60 ? 'text-rose-400' : usedPct > 0 ? 'text-amber-400' : 'text-emerald-400';

  return (
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
      {/* 장 진행 바 */}
      <div className="flex-1 relative">
        {health?.marketOpen ? (
          <>
            <div className="relative">
              <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full transition-all duration-1000" style={{ width: `${marketProgress}%` }} />
              </div>
              <div className="absolute top-0 w-px h-1.5 bg-emerald-400/60" style={{ left: '20.5%' }} />
              <div className="absolute top-0 w-px h-1.5 bg-emerald-400/60" style={{ left: '61.5%' }} />
            </div>
            <div className="flex justify-between mt-0.5 text-[9px] text-slate-600 relative">
              <span>09:00</span>
              <span className="absolute text-emerald-700" style={{ left: '20.5%', transform: 'translateX(-50%)' }}>10:20</span>
              <span className="absolute text-emerald-700" style={{ left: '61.5%', transform: 'translateX(-50%)' }}>13:00</span>
              <span>15:30</span>
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
        <span className="text-[10px] text-slate-500">손실한도(30%)</span>
        <div className={`text-[11px] font-bold ${color}`}>
          {isUs
            ? (loss < 0 ? `${usedPct}% ($${Math.abs(Math.round(loss)).toLocaleString('en-US')}/$${limit.toLocaleString('en-US')})` : `0% / $${limit.toLocaleString('en-US')}`)
            : (loss < 0 ? `${usedPct}% (${fmtWon(Math.abs(loss))}/${fmtWon(limit)})` : `0% / ${fmtWon(limit)}`)}
        </div>
      </div>
    </div>
  );
}
