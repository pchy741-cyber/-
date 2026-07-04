'use client';

import React from 'react';
import { api } from '../lib/utils';

interface StrategyHealth {
  period: { startDate: string; endDate: string; tradingDays: number };
  returns: { cumulativePct: number; monthlyAvgPct: number; dailyAvgPct: number; bestDayPct: number; worstDayPct: number; totalPnlKrw: number; initialCapital: number };
  risk: { maxDrawdownPct: number; maxDrawdownDays: number; currentDrawdownPct: number; volatilityDaily: number; volatilityAnnual: number };
  efficiency: { sharpeRatio: number; sortinoRatio: number; calmarRatio: number; profitFactor: number; payoffRatio: number };
  consistency: { winRate: number; profitDaysRate: number; maxConsecutiveWins: number; maxConsecutiveLosses: number; recoveryFactor: number };
  goal: { monthlyTargetPct: number; currentMonthPct: number; onTrack: boolean; projectedMonthlyPct: number; daysRemaining: number };
  grade: string;
  mode: string;
}

const GRADE_COLORS: Record<string, string> = {
  'A+': 'text-emerald-300 bg-emerald-500/20 border-emerald-500/30',
  'A': 'text-emerald-400 bg-emerald-500/15 border-emerald-500/25',
  'B+': 'text-blue-300 bg-blue-500/20 border-blue-500/30',
  'B': 'text-blue-400 bg-blue-500/15 border-blue-500/25',
  'C': 'text-amber-400 bg-amber-500/15 border-amber-500/25',
  'D': 'text-rose-400 bg-rose-500/15 border-rose-500/25',
};

function pctColor(v: number) { return v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-slate-400'; }
function fmtPct(v: number) { return (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }

function MetricRow({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[11px] text-slate-400">{label}</span>
      <div className="text-right">
        <span className="text-[13px] font-semibold text-slate-200 tabular-nums">{value}</span>
        {sub && <span className="block text-[10px] text-slate-500">{sub}</span>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">{title}</div>
      <div className="divide-y divide-white/[0.04]">{children}</div>
    </div>
  );
}

export default React.memo(function StrategyHealthCard({ viewMode = 'live' }: { viewMode?: 'live' | 'paper' }) {
  const [data, setData] = React.useState<StrategyHealth | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [days, setDays] = React.useState(90);

  React.useEffect(() => {
    setLoading(true);
    api(`/strategy-health?days=${days}&viewMode=${viewMode}`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [viewMode, days]);

  if (loading) return (
    <div className="glass rounded-2xl border border-white/[0.04] p-4 space-y-3 animate-pulse">
      <div className="h-3 w-32 bg-white/[0.06] rounded" />
      <div className="grid grid-cols-2 gap-3">
        {[1,2,3,4].map(i => <div key={i} className="h-16 bg-white/[0.04] rounded-xl" />)}
      </div>
      <div className="space-y-2">
        {[1,2,3].map(i => <div key={i} className="h-3 bg-white/[0.03] rounded" />)}
      </div>
    </div>
  );

  if (!data) return null;

  const { returns: ret, risk, efficiency: eff, consistency: con, goal } = data;
  const gradeStyle = GRADE_COLORS[data.grade] || GRADE_COLORS['C'];

  return (
    <div className="glass rounded-2xl border border-white/[0.04] p-4 space-y-4">
      {/* Header: Grade + Period */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={`text-lg font-black px-2.5 py-1 rounded-lg border ${gradeStyle}`}>{data.grade}</div>
          <div>
            <div className="text-sm font-bold text-slate-200">전략 건강도</div>
            <div className="text-[10px] text-slate-500">{data.period.startDate} ~ {data.period.endDate} · {data.period.tradingDays}일</div>
          </div>
        </div>
        {/* Period selector */}
        <div className="flex gap-1">
          {[30, 90, 180, 365].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`text-[10px] px-2 py-1 rounded-md font-semibold transition ${days === d ? 'bg-white/[0.1] text-slate-200' : 'text-slate-500 hover:text-slate-300'}`}>
              {d}D
            </button>
          ))}
        </div>
      </div>

      {/* Goal progress bar */}
      <div className="bg-white/[0.03] rounded-xl p-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] text-slate-400">이번 달 목표</span>
          <span className={`text-[11px] font-bold ${goal.onTrack ? 'text-emerald-400' : 'text-amber-400'}`}>
            {goal.onTrack ? '목표 달성 예상' : '목표 미달 예상'} · D-{goal.daysRemaining}
          </span>
        </div>
        <div className="relative h-2 bg-white/[0.06] rounded-full overflow-hidden">
          <div className={`absolute inset-y-0 left-0 rounded-full transition-all ${goal.onTrack ? 'bg-emerald-500' : 'bg-amber-500'}`}
            style={{ width: `${Math.min(100, Math.max(0, (goal.currentMonthPct / goal.monthlyTargetPct) * 100))}%` }} />
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-[10px] text-slate-500">현재 {goal.currentMonthPct.toFixed(1)}%</span>
          <span className="text-[10px] text-slate-500">목표 {goal.monthlyTargetPct}% (예상 {goal.projectedMonthlyPct.toFixed(1)}%)</span>
        </div>
      </div>

      {/* Key metrics 4-grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="bg-white/[0.03] rounded-xl p-2.5 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5">누적 수익률</div>
          <div className={`text-base font-bold tabular-nums ${pctColor(ret.cumulativePct)}`}>{fmtPct(ret.cumulativePct)}</div>
          <div className="text-[10px] text-slate-500">₩{ret.totalPnlKrw.toLocaleString('ko-KR')}</div>
        </div>
        <div className="bg-white/[0.03] rounded-xl p-2.5 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5">Sharpe</div>
          <div className={`text-base font-bold tabular-nums ${eff.sharpeRatio >= 1.5 ? 'text-emerald-400' : eff.sharpeRatio >= 1 ? 'text-blue-400' : eff.sharpeRatio >= 0 ? 'text-amber-400' : 'text-rose-400'}`}>
            {eff.sharpeRatio.toFixed(2)}
          </div>
          <div className="text-[10px] text-slate-500">연 {risk.volatilityAnnual.toFixed(1)}% vol</div>
        </div>
        <div className="bg-white/[0.03] rounded-xl p-2.5 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5">MDD</div>
          <div className={`text-base font-bold tabular-nums ${risk.maxDrawdownPct < 5 ? 'text-emerald-400' : risk.maxDrawdownPct < 10 ? 'text-amber-400' : 'text-rose-400'}`}>
            -{risk.maxDrawdownPct.toFixed(1)}%
          </div>
          <div className="text-[10px] text-slate-500">{risk.maxDrawdownDays}일 지속</div>
        </div>
        <div className="bg-white/[0.03] rounded-xl p-2.5 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5">승률</div>
          <div className={`text-base font-bold tabular-nums ${con.winRate >= 55 ? 'text-emerald-400' : con.winRate >= 45 ? 'text-amber-400' : 'text-rose-400'}`}>
            {con.winRate.toFixed(1)}%
          </div>
          <div className="text-[10px] text-slate-500">PF {eff.profitFactor.toFixed(2)}</div>
        </div>
      </div>

      {/* Detailed sections */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Section title="수익 분석">
          <MetricRow label="월 평균" value={<span className={pctColor(ret.monthlyAvgPct)}>{fmtPct(ret.monthlyAvgPct)}</span>} />
          <MetricRow label="일 평균" value={<span className={pctColor(ret.dailyAvgPct)}>{fmtPct(ret.dailyAvgPct)}</span>} />
          <MetricRow label="최고/최저일" value={<><span className="text-emerald-400">{fmtPct(ret.bestDayPct)}</span><span className="text-slate-600 mx-1">/</span><span className="text-rose-400">{fmtPct(ret.worstDayPct)}</span></>} />
          <MetricRow label="시드" value={`₩${ret.initialCapital.toLocaleString('ko-KR')}`} />
        </Section>

        <Section title="효율성">
          <MetricRow label="Sortino" value={eff.sortinoRatio.toFixed(2)} sub="하방 위험 대비" />
          <MetricRow label="Calmar" value={eff.calmarRatio.toFixed(2)} sub="MDD 대비 수익" />
          <MetricRow label="Payoff Ratio" value={eff.payoffRatio.toFixed(2)} sub="평균 이익/손실" />
          <MetricRow label="Recovery Factor" value={con.recoveryFactor.toFixed(2)} sub="MDD 회복력" />
        </Section>

        <Section title="리스크">
          <MetricRow label="현재 낙폭" value={<span className={pctColor(-risk.currentDrawdownPct)}>{risk.currentDrawdownPct > 0 ? `-${risk.currentDrawdownPct.toFixed(1)}%` : '0%'}</span>} />
          <MetricRow label="일 변동성" value={`${risk.volatilityDaily.toFixed(2)}%`} />
          <MetricRow label="연 변동성" value={`${risk.volatilityAnnual.toFixed(1)}%`} />
        </Section>

        <Section title="일관성">
          <MetricRow label="수익일 비율" value={`${con.profitDaysRate.toFixed(1)}%`} />
          <MetricRow label="최대 연승" value={`${con.maxConsecutiveWins}연승`} />
          <MetricRow label="최대 연패" value={<span className="text-rose-400">{con.maxConsecutiveLosses}연패</span>} />
        </Section>
      </div>

      {/* Mode badge */}
      <div className="text-center">
        <span className={`text-[10px] px-2 py-0.5 rounded-full ${data.mode === 'paper' ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
          {data.mode === 'paper' ? 'Paper Mode' : 'Live Mode'}
        </span>
      </div>
    </div>
  );
});
