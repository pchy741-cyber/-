'use client';

import React from 'react';

interface SuggestedAction {
  type: string;
  priority: 'high' | 'medium' | 'low';
  message: string;
  detail?: string;
}

interface MonthlyGoal {
  targetPct: number;
  targetAmount: number;
  currentPnl: number;
  progressPct: number;
  remaining: number;
}

interface FxImpact {
  fxRate: number;
  exposureUsd: number;
  exposureKrw: number;
  impactPer10Won: number;
  overseasPnlUsd: number;
  overseasPnlKrw: number;
}

const PRIORITY_STYLE = {
  high: { dot: 'bg-rose-400', border: 'border-l-rose-500/60', bg: 'bg-rose-500/[0.06]' },
  medium: { dot: 'bg-amber-400', border: 'border-l-amber-500/60', bg: 'bg-amber-500/[0.06]' },
  low: { dot: 'bg-blue-400', border: 'border-l-blue-500/60', bg: 'bg-blue-500/[0.04]' },
};

export default function SuggestedActionsPanel({
  suggestedActions,
  monthlyGoal,
  fxImpact,
}: {
  suggestedActions?: SuggestedAction[];
  monthlyGoal?: MonthlyGoal;
  fxImpact?: FxImpact | null;
}) {
  const actions = suggestedActions ?? [];
  const goal = monthlyGoal;

  // 아무 데이터도 없으면 → 감시중 idle 상태로 항상 표시 (패널이 사라지면 시스템 상태 파악 불가)
  if (actions.length === 0 && !goal && !fxImpact) {
    return (
      <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3 flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-emerald-500/70 animate-pulse shrink-0" />
        <span className="text-[11px] text-slate-500">자동매매 감시 중 — 매수 기회 대기 중</span>
      </div>
    );
  }

  return (
    <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden">
      {/* 월간 목표 + 환율 영향 */}
      {(goal || fxImpact) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-white/[0.02]">
          {goal && (
            <div className="px-4 py-3 bg-[var(--theme-bg)]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold text-slate-400">월간 목표</span>
                <span className={`text-[11px] font-bold ${goal.currentPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {goal.currentPnl >= 0 ? '+' : ''}{goal.currentPnl.toLocaleString('ko-KR')}원
                </span>
              </div>
              <div className="relative h-2 bg-white/[0.06] rounded-full overflow-hidden">
                <div
                  className={`absolute inset-y-0 left-0 rounded-full transition-all duration-700 ${
                    goal.progressPct >= 100 ? 'bg-emerald-500' : goal.progressPct >= 50 ? 'bg-blue-500' : 'bg-amber-500'
                  }`}
                  style={{ width: `${Math.min(100, Math.max(0, goal.progressPct))}%` }}
                />
              </div>
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-[10px] text-slate-600">
                  목표 +{goal.targetPct}% (₩{goal.targetAmount.toLocaleString('ko-KR')})
                </span>
                <span className={`text-[10px] font-semibold ${goal.progressPct >= 100 ? 'text-emerald-400' : 'text-slate-500'}`}>
                  {goal.progressPct >= 100 ? '달성!' : `잔여 ₩${goal.remaining.toLocaleString('ko-KR')}`}
                </span>
              </div>
            </div>
          )}

          {fxImpact && (
            <div className="px-4 py-3 bg-[var(--theme-bg)]">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-semibold text-slate-400">환율 영향</span>
                <span className="text-[11px] font-mono text-slate-300">₩{fxImpact.fxRate.toFixed(0)}/USD</span>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-1.5">
                <div>
                  <div className="text-[9px] text-slate-600 mb-0.5">해외 노출</div>
                  <div className="text-[11px] font-semibold text-slate-300">
                    ${fxImpact.exposureUsd.toLocaleString('en-US', { minimumFractionDigits: 0 })}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] text-slate-600 mb-0.5">₩10 변동 영향</div>
                  <div className="text-[11px] font-semibold text-amber-400">
                    ±₩{fxImpact.impactPer10Won.toLocaleString('ko-KR')}
                  </div>
                </div>
              </div>
              {fxImpact.overseasPnlUsd !== 0 && (
                <div className="mt-1.5 text-[10px]">
                  <span className="text-slate-600">해외 평가손익 </span>
                  <span className={fxImpact.overseasPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {fxImpact.overseasPnlUsd >= 0 ? '+' : ''}${fxImpact.overseasPnlUsd.toFixed(2)}
                    <span className="text-slate-600"> = </span>
                    ₩{fxImpact.overseasPnlKrw >= 0 ? '+' : ''}{fxImpact.overseasPnlKrw.toLocaleString('ko-KR')}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 추천 액션 */}
      {actions.length > 0 && (
        <div className={`${goal || fxImpact ? 'border-t border-white/[0.04]' : ''}`}>
          <div className="px-4 py-2.5 border-b border-white/[0.04] flex items-center gap-2">
            <span className="text-[11px] font-semibold text-slate-400">자동매매 현황</span>
            <span className="text-[10px] bg-white/[0.06] text-slate-500 px-1.5 py-0.5 rounded-full ml-auto">
              {actions.length}건
            </span>
          </div>
          <div className="divide-y divide-white/[0.03]">
            {actions.map((a, i) => {
              const s = PRIORITY_STYLE[a.priority];
              return (
                <div key={i} className={`px-4 py-2 flex items-start gap-2.5 border-l-2 ${s.border} ${s.bg}`}>
                  <span className={`w-1.5 h-1.5 rounded-full mt-1 shrink-0 ${s.dot}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-medium text-slate-200 leading-tight">{a.message}</div>
                    {a.detail && <div className="text-[10px] text-slate-500 mt-0.5 leading-snug">{a.detail}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
