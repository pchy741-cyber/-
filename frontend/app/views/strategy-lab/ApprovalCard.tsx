import { pc, fmtWon, fmtTime } from '../../lib/utils';
import { STRATEGY_LABELS } from './constants';
import type { StrategyGraduation } from '../../types';

export function ApprovalCard({ g, onApprove, onReject }: { g: StrategyGraduation; onApprove: (id: number) => void; onReject: (id: number) => void }) {
  const riskColor = { LOW: 'text-emerald-400 bg-emerald-500/10', MEDIUM: 'text-amber-400 bg-amber-500/10', HIGH: 'text-rose-400 bg-rose-500/10' }[g.risk_level];
  const label = STRATEGY_LABELS[g.strategy_mode] || g.strategy_mode;

  return (
    <div className="rounded-xl border border-amber-500/10 p-3.5 space-y-3 bg-white/[0.01]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-bold text-sm text-slate-100">{label}</span>
          <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded ${riskColor}`}>{g.risk_level}</span>
        </div>
        <span className="text-[9px] text-slate-600">{fmtTime(g.created_at)}</span>
      </div>
      <div className="grid grid-cols-4 gap-1 text-center text-[10px]">
        <div><div className="text-slate-600">거래</div><div className="font-bold text-slate-200">{g.trades}</div></div>
        <div><div className="text-slate-600">승률</div><div className="font-bold text-slate-200">{(Number(g.win_rate) * 100).toFixed(0)}%</div></div>
        <div><div className="text-slate-600">PF</div><div className="font-bold text-slate-200">{Number(g.profit_factor).toFixed(2)}</div></div>
        <div><div className="text-slate-600">MDD</div><div className="font-bold text-slate-200">{Number(g.mdd).toFixed(1)}%</div></div>
      </div>
      <div className={`text-center text-sm font-black ${pc(g.total_pnl_krw)}`}>{fmtWon(g.total_pnl_krw)}</div>
      <div className="flex gap-2">
        <button onClick={(e) => { e.stopPropagation(); onApprove(g.id); }}
          className="flex-1 py-2 rounded-xl text-xs font-bold bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors">
          승인
        </button>
        <button onClick={(e) => { e.stopPropagation(); onReject(g.id); }}
          className="flex-1 py-2 rounded-xl text-xs font-bold bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 transition-colors">
          거부
        </button>
      </div>
    </div>
  );
}
