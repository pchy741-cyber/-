import React from 'react';
import { STRATEGY_LABELS, GRAD_STEPS } from './constants';
import type { StrategyLabOverview } from '../../types';

export function PipelineRow({ s }: { s: StrategyLabOverview }) {
  const label = STRATEGY_LABELS[s.mode] || s.mode;
  const gradStatus = s.graduation?.status;

  let step = 0;
  if (gradStatus === 'PENDING') step = 1;
  else if (gradStatus === 'AUTO_APPLIED' || gradStatus === 'APPROVED') step = 2;

  return (
    <div className="flex items-center gap-3">
      <span className="text-[11px] font-bold text-slate-300 w-16 shrink-0 truncate">{label}</span>
      <div className="flex-1 flex items-center gap-1">
        {GRAD_STEPS.map((gs, i) => (
          <React.Fragment key={gs.key}>
            <div className={`h-1.5 flex-1 rounded-full transition-all duration-500 ${
              i <= step
                ? i === 2 ? 'bg-emerald-500' : 'bg-cyan-500'
                : 'bg-white/[0.04]'
            }`} />
            {i < GRAD_STEPS.length - 1 && (
              <div className={`w-1 h-1 rounded-full shrink-0 ${i < step ? 'bg-cyan-500' : 'bg-white/[0.06]'}`} />
            )}
          </React.Fragment>
        ))}
      </div>
      <span className={`text-[9px] font-bold w-14 text-right ${
        step === 2 ? 'text-emerald-400' : step === 1 ? 'text-amber-400' : 'text-slate-600'
      }`}>
        {GRAD_STEPS[step].label}
      </span>
    </div>
  );
}
