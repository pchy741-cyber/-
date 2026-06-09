import React, { useMemo } from 'react';
import { ProgressBar } from '@/components/ProgressBar';
import { pc, fmtWon, fmtPct } from '../../lib/utils';
import { CRITERIA, STRATEGY_LABELS, STRATEGY_ICONS } from './constants';
import type { StrategyLabOverview } from '../../types';

export function StrategyCard({ s, expanded, onToggle }: { s: StrategyLabOverview; expanded: boolean; onToggle: () => void }) {
  const p = s.paper!;
  const c = CRITERIA[s.mode] ?? CRITERIA.DEFAULT;
  const isProfitable = p.totalPnlKrw >= 0;
  const label = STRATEGY_LABELS[s.mode] || s.mode;
  const icon = STRATEGY_ICONS[s.mode] || '📊';

  const gradStatus = s.graduation?.status;
  const isLive = gradStatus === 'AUTO_APPLIED' || gradStatus === 'APPROVED';
  const isPending = gradStatus === 'PENDING';

  const perfBars = useMemo(() => {
    const count = Math.min(p.totalTrades, 10);
    const wins = Math.round(count * p.winRate);
    const bars: boolean[] = [];
    for (let i = 0; i < count; i++) bars.push(i < wins);
    for (let i = bars.length - 1; i > 0; i--) {
      const j = (p.totalTrades * 7 + i * 13) % (i + 1);
      [bars[i], bars[j]] = [bars[j], bars[i]];
    }
    return bars;
  }, [p.totalTrades, p.winRate]);

  const gradProgress = Math.min(100, (
    Math.min(1, p.totalTrades / c.trades) * 0.25 +
    Math.min(1, p.winRate / c.wr) * 0.25 +
    Math.min(1, p.profitFactor / c.pf) * 0.25 +
    (p.maxDrawdownPct >= c.mdd ? 1 : (Math.abs(c.mdd) > 0 ? Math.max(0, 1 - Math.abs(p.maxDrawdownPct - c.mdd) / Math.abs(c.mdd)) : 1)) * 0.25
  ) * 100);

  return (
    <div
      className={`relative rounded-2xl border transition-all duration-300 cursor-pointer group ${
        isProfitable
          ? 'border-emerald-500/10 hover:border-emerald-500/20'
          : 'border-rose-500/10 hover:border-rose-500/20'
      } ${expanded ? 'ring-1 ring-white/[0.08]' : ''}`}
      onClick={onToggle}
    >
      <div className={`absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 ${
        isProfitable ? 'shadow-[inset_0_0_30px_rgba(16,185,129,0.04)]' : 'shadow-[inset_0_0_30px_rgba(244,63,94,0.04)]'
      }`} />

      <div className="relative p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-base">{icon}</span>
            <div>
              <span className="font-bold text-sm text-slate-100">{label}</span>
              <span className="text-[9px] text-slate-600 ml-1.5">{s.mode}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${
              isLive ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50' :
              isPending ? 'bg-amber-400 animate-pulse' :
              isProfitable ? 'bg-emerald-500/50' : 'bg-rose-500/50'
            }`} />
            {isLive && <span className="text-[8px] font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">LIVE</span>}
            {isPending && <span className="text-[8px] font-bold text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">대기</span>}
          </div>
        </div>

        <div className="flex items-end justify-between">
          <div>
            <div className={`text-lg font-black tracking-tight ${pc(p.totalPnlKrw)}`}>
              {fmtWon(p.totalPnlKrw)}
            </div>
            <div className={`text-[10px] font-bold ${pc(p.totalPnlPct)}`}>
              {fmtPct(p.totalPnlPct)}
            </div>
          </div>
          <div className="flex items-end gap-[2px] h-6">
            {perfBars.map((win, i) => (
              <div
                key={i}
                className={`w-[3px] rounded-sm ${win ? 'bg-emerald-500/60' : 'bg-rose-500/60'}`}
                style={{ height: `${30 + ((i * 17 + p.totalTrades) % 70)}%` }}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 text-[10px]">
          <span className="text-slate-500">{p.totalTrades}건</span>
          <span className={`font-bold ${p.winRate >= 0.55 ? 'text-emerald-400' : p.winRate >= 0.45 ? 'text-amber-400' : 'text-rose-400'}`}>
            WR {(p.winRate * 100).toFixed(0)}%
          </span>
          <span className="text-slate-500">PF {p.profitFactor.toFixed(1)}</span>
          <span className="text-slate-500 ml-auto">{p.avgHoldingDays.toFixed(0)}일</span>
        </div>

        <div className="space-y-1">
          <ProgressBar
            value={gradProgress}
            colorClass={gradProgress >= 100 ? 'bg-emerald-500' : gradProgress >= 70 ? 'bg-cyan-500' : 'bg-slate-500'}
            height="h-1"
          />
          <div className="text-[9px] text-slate-600 text-right">{gradProgress.toFixed(0)}% 졸업</div>
        </div>

        {expanded && (
          <div className="pt-2 border-t border-white/[0.04] space-y-2">
            <div className="grid grid-cols-2 gap-2 text-[10px]">
              <MetricRow label="거래수" value={`${p.totalTrades}`} target={`/${c.trades}`} met={p.totalTrades >= c.trades} />
              <MetricRow label="승률" value={`${(p.winRate * 100).toFixed(0)}%`} target={`/${(c.wr * 100).toFixed(0)}%`} met={p.winRate >= c.wr} />
              <MetricRow label="PF" value={p.profitFactor.toFixed(2)} target={`/${c.pf}`} met={p.profitFactor >= c.pf} />
              <MetricRow label="MDD" value={`${p.maxDrawdownPct.toFixed(1)}%`} target={`/${c.mdd}%`} met={p.maxDrawdownPct >= c.mdd} />
            </div>
            {s.live && s.live.totalTrades > 0 && (
              <div className="text-[10px] text-slate-500 pt-1 border-t border-white/[0.04]">
                Live: {s.live.totalTrades}건 WR {(s.live.winRate * 100).toFixed(0)}% <span className={pc(s.live.totalPnlKrw)}>{fmtWon(s.live.totalPnlKrw)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MetricRow({ label, value, target, met }: { label: string; value: string; target: string; met: boolean }) {
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded-lg bg-white/[0.02]">
      <span className="text-slate-500">{label}</span>
      <div className="flex items-center gap-1">
        <span className={met ? 'text-emerald-400 font-bold' : 'text-slate-300'}>{value}</span>
        <span className="text-slate-600">{target}</span>
        {met && <span className="text-emerald-400 text-[8px]">✓</span>}
      </div>
    </div>
  );
}
