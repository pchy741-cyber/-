import { pc, fmtPct } from '../../lib/utils';
import { STRATEGY_LABELS } from './constants';
import type { StrategyInsightRow } from '../../types';

export function InsightChip({ i }: { i: StrategyInsightRow }) {
  const wr = Number(i.win_rate);
  const pnl = Number(i.avg_pnl_pct);
  const label = STRATEGY_LABELS[i.strategy_mode] || i.strategy_mode;

  return (
    <div className={`inline-flex items-center gap-2 px-3 py-2 rounded-xl border transition-colors hover:bg-white/[0.03] ${
      i.is_actionable ? 'border-cyan-500/15 bg-cyan-500/[0.03]' : 'border-white/[0.04] bg-white/[0.01]'
    }`}>
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${wr > 0.6 ? 'bg-emerald-400' : wr > 0.5 ? 'bg-amber-400' : 'bg-rose-400'}`} />
      <span className="text-[10px] text-slate-200 max-w-[200px] truncate">{i.insight_text}</span>
      <span className={`text-[10px] font-bold ${pc(pnl)}`}>{fmtPct(pnl)}</span>
      <span className="text-[8px] text-slate-600">{label}</span>
      {i.is_actionable && <span className="text-[7px] bg-cyan-500/15 text-cyan-400 px-1 py-0.5 rounded font-bold">추천</span>}
    </div>
  );
}
