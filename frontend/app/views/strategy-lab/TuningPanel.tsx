'use client';

import React from 'react';
import { fmtTime } from '../../lib/utils';
import { STRATEGY_LABELS, STRATEGY_ICONS } from './constants';
import type { TuningStatus, OptimizerResult } from '../../types';

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}시간 전`;
  const days = Math.floor(hrs / 24);
  return `${days}일 전`;
}

export function TuningPanel({ tuning }: { tuning: TuningStatus }) {
  const { optimizers, configs, insightStats, appliedInsights } = tuning;

  const totalApplied = optimizers.filter(o => o.applied).length;
  const totalImproved = optimizers.filter(o => o.improved).length;
  const insightsApplied = Number(insightStats.approved ?? 0);
  const insightsPending = Number(insightStats.pending_actionable ?? 0);
  const hasActivity = optimizers.length > 0 || insightsApplied > 0;

  if (!hasActivity) return null;

  // 최근 실행 시간
  const latestRun = optimizers.length > 0
    ? optimizers.reduce((a, b) => new Date(a.runAt || a.updatedAt) > new Date(b.runAt || b.updatedAt) ? a : b)
    : null;

  return (
    <div className="rounded-2xl border border-cyan-500/10 bg-gradient-to-br from-cyan-950/20 via-slate-900/40 to-slate-950/20 overflow-hidden">
      {/* 헤더 — 튜닝 활동 요약 */}
      <div className="px-4 py-3 border-b border-white/[0.04] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="relative w-6 h-6 flex items-center justify-center">
            <div className="absolute inset-0 rounded-lg bg-cyan-500/15 animate-pulse" />
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="relative text-cyan-400">
              <path d="M12 20V10M6 20V4M18 20V16" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div>
            <span className="text-xs font-bold text-cyan-300">AI 자동 튜닝</span>
            {latestRun && (
              <span className="text-[9px] text-slate-600 ml-2">{timeAgo(latestRun.runAt || latestRun.updatedAt)}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {totalApplied > 0 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-bold">
              {totalApplied}건 적용
            </span>
          )}
          {insightsPending > 0 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-bold">
              {insightsPending}건 대기
            </span>
          )}
        </div>
      </div>

      {/* KPI 카드 — 최소 정보 */}
      <div className="grid grid-cols-3 gap-px bg-white/[0.02]">
        <KpiCell label="최적화 실행" value={`${optimizers.length}전략`} sub={`${totalImproved}개선 / ${totalApplied}적용`} />
        <KpiCell label="인사이트" value={`${insightsApplied}건 적용`} sub={`${insightStats.total ?? 0}건 분석`} />
        <KpiCell
          label="Sharpe 변화"
          value={optimizers.length > 0
            ? (() => {
                const avgImprovement = optimizers
                  .filter(o => o.currentSharpe && o.bestSharpe)
                  .map(o => ((o.bestSharpe - o.currentSharpe) / Math.max(Math.abs(o.currentSharpe), 0.01)) * 100);
                const avg = avgImprovement.length > 0
                  ? avgImprovement.reduce((a, b) => a + b, 0) / avgImprovement.length
                  : 0;
                return avg >= 0 ? `+${avg.toFixed(0)}%` : `${avg.toFixed(0)}%`;
              })()
            : '-'
          }
          sub="평균 개선율"
        />
      </div>

      {/* 전략별 옵티마이저 결과 */}
      {optimizers.length > 0 && (
        <div className="px-3 py-2 space-y-1.5">
          {optimizers.map(opt => (
            <OptimizerRow key={opt.mode} opt={opt} configs={configs} />
          ))}
        </div>
      )}

      {/* 최근 적용된 인사이트 */}
      {appliedInsights.length > 0 && (
        <div className="px-3 pb-3 pt-1">
          <div className="text-[9px] text-slate-500 mb-1.5 font-medium">최근 적용된 튜닝</div>
          <div className="space-y-1">
            {appliedInsights.slice(0, 5).map(ins => {
              const action = ins.suggested_action
                ? (typeof ins.suggested_action === 'string' ? JSON.parse(ins.suggested_action) : ins.suggested_action)
                : null;
              return (
                <div key={ins.id} className="flex items-center gap-2 text-[10px] px-2 py-1.5 rounded-lg bg-white/[0.02]">
                  <span className="w-1 h-1 rounded-full bg-emerald-400 shrink-0" />
                  <span className="text-slate-400 shrink-0">{STRATEGY_LABELS[ins.strategy_mode] || ins.strategy_mode}</span>
                  <span className="text-slate-300 truncate flex-1">{ins.condition_label}</span>
                  {action && (
                    <span className="text-cyan-400/70 shrink-0">{action.type}</span>
                  )}
                  <span className="text-slate-600 shrink-0">{timeAgo(ins.applied_at)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCell({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="px-3 py-2.5 text-center">
      <div className="text-[9px] text-slate-500 mb-0.5">{label}</div>
      <div className="text-sm font-black text-slate-200 tabular-nums">{value}</div>
      <div className="text-[9px] text-slate-600">{sub}</div>
    </div>
  );
}

function OptimizerRow({ opt, configs }: { opt: OptimizerResult; configs: TuningStatus['configs'] }) {
  const label = STRATEGY_LABELS[opt.mode] || opt.mode;
  const icon = STRATEGY_ICONS[opt.mode] || '📊';
  const config = configs.find(c => c.mode === opt.mode && c.isPaper);

  const sharpeChange = opt.currentSharpe
    ? ((opt.bestSharpe - opt.currentSharpe) / Math.max(Math.abs(opt.currentSharpe), 0.01)) * 100
    : 0;
  const isImproved = opt.improved;
  const isApplied = opt.applied;

  return (
    <div className={`flex items-center gap-2 px-2.5 py-2 rounded-xl transition-colors ${
      isApplied ? 'bg-emerald-500/[0.06] ring-1 ring-emerald-500/10' :
      isImproved ? 'bg-cyan-500/[0.04]' :
      'bg-white/[0.02]'
    }`}>
      {/* 전략 아이콘 + 이름 */}
      <span className="text-sm shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-bold text-slate-200 truncate">{label}</span>
          {isApplied && (
            <span className="text-[8px] px-1 py-px rounded bg-emerald-500/20 text-emerald-400 font-bold shrink-0">적용</span>
          )}
          {isImproved && !isApplied && (
            <span className="text-[8px] px-1 py-px rounded bg-cyan-500/20 text-cyan-400 font-bold shrink-0">개선</span>
          )}
          {!isImproved && (
            <span className="text-[8px] px-1 py-px rounded bg-slate-600/30 text-slate-500 font-bold shrink-0">유지</span>
          )}
        </div>
        {/* TP/SL 변경 표시 */}
        <div className="flex items-center gap-2 mt-0.5 text-[9px]">
          <span className="text-slate-500">
            TP <span className="text-slate-400 tabular-nums">{opt.currentTp}%</span>
            {isApplied && opt.bestTp !== opt.currentTp && (
              <span className="text-emerald-400"> → {opt.bestTp.toFixed(1)}%</span>
            )}
          </span>
          <span className="text-slate-500">
            SL <span className="text-slate-400 tabular-nums">{opt.currentSl}%</span>
            {isApplied && opt.bestSl !== opt.currentSl && (
              <span className="text-emerald-400"> → {opt.bestSl.toFixed(1)}%</span>
            )}
          </span>
          {opt.paperTrades != null && (
            <span className="text-slate-600">{opt.paperTrades}건</span>
          )}
        </div>
      </div>
      {/* Sharpe 변화 */}
      <div className="text-right shrink-0">
        <div className={`text-[11px] font-bold tabular-nums ${
          sharpeChange > 5 ? 'text-emerald-400' : sharpeChange > 0 ? 'text-cyan-400' : 'text-slate-500'
        }`}>
          {sharpeChange >= 0 ? '+' : ''}{sharpeChange.toFixed(0)}%
        </div>
        <div className="text-[8px] text-slate-600">Sharpe</div>
      </div>
    </div>
  );
}
