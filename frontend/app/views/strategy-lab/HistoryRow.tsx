import { pc, fmtWon, fmtTime } from '../../lib/utils';
import { STRATEGY_LABELS } from './constants';
import type { StrategyGraduation } from '../../types';

export function HistoryRow({ h }: { h: StrategyGraduation }) {
  const label = STRATEGY_LABELS[h.strategy_mode] || h.strategy_mode;
  const statusMap: Record<string, { color: string; text: string }> = {
    AUTO_APPLIED: { color: 'text-emerald-400', text: '자동 적용' },
    APPROVED: { color: 'text-blue-400', text: '승인' },
    REJECTED: { color: 'text-rose-400', text: '거부' },
    EXPIRED: { color: 'text-slate-500', text: '만료' },
    REVOKED: { color: 'text-orange-400', text: '강등' },
  };
  const st = statusMap[h.status] ?? { color: 'text-slate-500', text: h.status };

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.02] transition-colors">
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
        h.status === 'AUTO_APPLIED' || h.status === 'APPROVED' ? 'bg-emerald-500' :
        h.status === 'REJECTED' ? 'bg-rose-500' :
        h.status === 'REVOKED' ? 'bg-orange-500' : 'bg-slate-600'
      }`} />
      <div className="flex-1 min-w-0">
        <span className="text-[11px] text-slate-200 font-medium">{label}</span>
        <span className={`text-[10px] ml-2 ${st.color}`}>{st.text}</span>
      </div>
      <span className="text-[9px] text-slate-600">{fmtTime(h.decided_at ?? h.created_at)}</span>
      <span className={`text-[10px] font-bold ${pc(h.total_pnl_krw)}`}>{fmtWon(h.total_pnl_krw)}</span>
    </div>
  );
}
