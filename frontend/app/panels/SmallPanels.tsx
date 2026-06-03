'use client';

import React from 'react';
import { api } from '../lib/utils';
import type { Strategy } from '../types';

// Re-export split modules for backward compatibility
export { ArcGauge, ScoreBar, RiskGaugePanel, CorrelationWarningPanel, ShortSellingPanel } from './RiskPanels';
export { SectorHeatmapPanel, HighScannerPanel, PerformanceVsKospiPanel, TaxEstimatePanel } from './MarketPanels';
export { PnlBreakdownPanel } from './PnlBreakdownPanel';

// ═══════════════════════════════════════
// STRATEGY TIMELINE PANEL
// ═══════════════════════════════════════

interface StrategyHistoryEntry {
  from: string;
  to: string;
  ts: string;
}

export function StrategyTimelinePanel({ strategy }: { strategy: Strategy | null }) {
  const [history, setHistory] = React.useState<StrategyHistoryEntry[]>([]);
  React.useEffect(() => {
    api('/strategy/history').then((r: unknown) => { if (Array.isArray(r)) setHistory(r.slice(0, 10)); }).catch(() => {});
  }, []);

  const modeColor: Record<string, string> = {
    SWING: 'bg-emerald-500/70 text-emerald-100',
    DEFENSE: 'bg-rose-500/70 text-rose-100',
    DIVIDEND: 'bg-amber-500/70 text-amber-100',
    SCALPING: 'bg-purple-500/70 text-purple-100',
    SNIPER: 'bg-orange-500/70 text-orange-100',
  };
  const currentMode = String(strategy?.mode ?? 'SWING');
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
          {history.slice().reverse().map((ev, i) => {
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
