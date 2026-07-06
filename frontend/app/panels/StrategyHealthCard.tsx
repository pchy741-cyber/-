'use client';

import React from 'react';
import { api } from '../lib/utils';

interface StrategyHealth {
  period: { startDate: string; endDate: string; tradingDays: number; totalTrades: number };
  returns: { cumulativePct: number; cagr: number; monthlyAvgPct: number; dailyAvgPct: number; bestTradePct: number; worstTradePct: number; totalPnlKrw: number };
  risk: { maxDrawdownPct: number; maxDrawdownTrades: number; currentDrawdownPct: number; volatilityTrade: number; volatilityAnnual: number };
  efficiency: { sharpeRatio: number; sortinoRatio: number; calmarRatio: number; profitFactor: number; payoffRatio: number; psr: number; minTRL: number; psrSignificant: boolean };
  consistency: { winRate: number; profitDaysRate: number; maxConsecutiveWins: number; maxConsecutiveLosses: number; recoveryFactor: number };
  benchmark: { alpha: number; beta: number; informationRatio: number; trackingError: number; benchmarkCagr: number; available: boolean };
  goal: { monthlyTargetPct: number; currentMonthPct: number; onTrack: boolean; onTrackLongTerm: 'ON_TRACK' | 'NEUTRAL' | 'OFF_TRACK'; projectedMonthlyPct: number; daysRemaining: number; requiredSharpe: number; goalRealistic: boolean };
  grade: string;
  mode: string;
  market: 'KR' | 'US' | 'ALL';
}

const GRADE_COLORS: Record<string, string> = {
  'A+': 'text-emerald-300 bg-emerald-500/20 border-emerald-500/30',
  'A': 'text-emerald-400 bg-emerald-500/15 border-emerald-500/25',
  'B+': 'text-blue-300 bg-blue-500/20 border-blue-500/30',
  'B+*': 'text-blue-300 bg-blue-500/20 border-blue-500/30',
  'B': 'text-blue-400 bg-blue-500/15 border-blue-500/25',
  'B*': 'text-blue-400 bg-blue-500/15 border-blue-500/25',
  'C': 'text-amber-400 bg-amber-500/15 border-amber-500/25',
  'D': 'text-rose-400 bg-rose-500/15 border-rose-500/25',
};

const LONG_TERM_TRACK = {
  ON_TRACK: { label: '궤도 상회', color: 'text-emerald-400' },
  NEUTRAL: { label: '궤도 범위', color: 'text-blue-400' },
  OFF_TRACK: { label: '궤도 하회', color: 'text-amber-400' },
} as const;

const MARKET_TABS = [
  { key: 'ALL' as const, label: '전체' },
  { key: 'KR' as const, label: '국내' },
  { key: 'US' as const, label: '해외' },
];

function n(v: unknown): number { return typeof v === 'number' && isFinite(v) ? v : 0; }
function pctColor(v: number) { return n(v) > 0 ? 'text-emerald-400' : n(v) < 0 ? 'text-rose-400' : 'text-slate-400'; }
function fmtPct(v: number) { const x = n(v); return (x > 0 ? '+' : '') + x.toFixed(2) + '%'; }

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
  const [market, setMarket] = React.useState<'ALL' | 'KR' | 'US'>('ALL');

  React.useEffect(() => {
    setLoading(true);
    api(`/strategy-health?days=${days}&viewMode=${viewMode}&market=${market}`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [viewMode, days, market]);

  if (loading) return (
    <div className="glass rounded-2xl border border-white/[0.04] p-4 space-y-3 animate-pulse">
      <div className="h-3 w-32 bg-white/[0.06] rounded" />
      <div className="grid grid-cols-2 gap-3">
        {[1,2,3,4].map(i => <div key={i} className="h-16 bg-white/[0.04] rounded-xl" />)}
      </div>
    </div>
  );

  if (!data || !data.period || !data.returns) return null;

  const ret = data.returns ?? {} as any;
  const risk = data.risk ?? {} as any;
  const eff = data.efficiency ?? {} as any;
  const con = data.consistency ?? {} as any;
  const goal = data.goal ?? {} as any;
  const bm = data.benchmark ?? {} as any;
  const gradeStyle = GRADE_COLORS[data.grade] || GRADE_COLORS['C'];
  const ltTrack = LONG_TERM_TRACK[goal.onTrackLongTerm] ?? LONG_TERM_TRACK.NEUTRAL;
  const gradeHasStar = data.grade.endsWith('*');

  return (
    <div className="glass rounded-2xl border border-white/[0.04] p-4 space-y-4">
      {/* Header: Grade + Period + Filters */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={`text-lg font-black px-2.5 py-1 rounded-lg border ${gradeStyle}`} title={gradeHasStar ? 'PSR 유의성 미달' : undefined}>{data.grade}</div>
          <div>
            <div className="text-sm font-bold text-slate-200">전략 건강도</div>
            <div className="text-[10px] text-slate-500">
              {data.period.startDate} ~ {data.period.endDate} · {data.period.totalTrades}건 · {data.period.tradingDays}일
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-1 items-end">
          {/* Market tabs */}
          <div className="flex gap-0.5">
            {MARKET_TABS.map(t => (
              <button key={t.key} onClick={() => setMarket(t.key)}
                className={`text-[10px] px-2 py-0.5 rounded-md font-semibold transition ${market === t.key ? 'bg-white/[0.12] text-slate-200' : 'text-slate-500 hover:text-slate-300'}`}>
                {t.label}
              </button>
            ))}
          </div>
          {/* Period selector */}
          <div className="flex gap-0.5">
            {[30, 90, 180, 365].map(d => (
              <button key={d} onClick={() => setDays(d)}
                className={`text-[10px] px-2 py-0.5 rounded-md font-semibold transition ${days === d ? 'bg-white/[0.1] text-slate-200' : 'text-slate-500 hover:text-slate-300'}`}>
                {d}D
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Goal progress bar */}
      <div className="bg-white/[0.03] rounded-xl p-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] text-slate-400">이번 달 목표</span>
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-semibold ${ltTrack.color}`}>{ltTrack.label}</span>
            <span className={`text-[11px] font-bold ${goal.onTrack ? 'text-emerald-400' : 'text-amber-400'}`}>
              {goal.onTrack ? '달성 예상' : '미달 예상'} · D-{goal.daysRemaining}
            </span>
          </div>
        </div>
        <div className="relative h-2 bg-white/[0.06] rounded-full overflow-hidden">
          <div className={`absolute inset-y-0 left-0 rounded-full transition-all ${goal.onTrack ? 'bg-emerald-500' : 'bg-amber-500'}`}
            style={{ width: `${Math.min(100, Math.max(0, goal.monthlyTargetPct > 0 ? (goal.currentMonthPct / goal.monthlyTargetPct) * 100 : 0))}%` }} />
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-[10px] text-slate-500">현재 {n(goal.currentMonthPct).toFixed(1)}%</span>
          <span className="text-[10px] text-slate-500">목표 {n(goal.monthlyTargetPct)}% (예상 {n(goal.projectedMonthlyPct).toFixed(1)}%)</span>
        </div>
        {!goal.goalRealistic && (
          <div className="text-[10px] text-rose-400 mt-1">필요 Sharpe {n(goal.requiredSharpe).toFixed(1)} — 비현실적</div>
        )}
      </div>

      {/* Key metrics 4-grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="bg-white/[0.03] rounded-xl p-2.5 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5">누적 수익률</div>
          <div className={`text-base font-bold tabular-nums ${pctColor(ret.cumulativePct)}`}>{fmtPct(ret.cumulativePct)}</div>
          <div className="text-[10px] text-slate-500">CAGR {fmtPct(ret.cagr)}</div>
        </div>
        <div className="bg-white/[0.03] rounded-xl p-2.5 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5">Sharpe</div>
          <div className={`text-base font-bold tabular-nums ${n(eff.sharpeRatio) >= 1.5 ? 'text-emerald-400' : n(eff.sharpeRatio) >= 1 ? 'text-blue-400' : n(eff.sharpeRatio) >= 0 ? 'text-amber-400' : 'text-rose-400'}`}>
            {n(eff.sharpeRatio).toFixed(2)}
          </div>
          <div className={`text-[10px] ${eff?.psrSignificant ? 'text-emerald-500' : 'text-slate-500'}`}>
            PSR {(n(eff.psr) * 100).toFixed(0)}%{eff?.psrSignificant ? ' (유의)' : ''}
          </div>
        </div>
        <div className="bg-white/[0.03] rounded-xl p-2.5 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5">MDD</div>
          <div className={`text-base font-bold tabular-nums ${n(risk.maxDrawdownPct) < 5 ? 'text-emerald-400' : n(risk.maxDrawdownPct) < 10 ? 'text-amber-400' : 'text-rose-400'}`}>
            -{n(risk.maxDrawdownPct).toFixed(1)}%
          </div>
          <div className="text-[10px] text-slate-500">{risk.maxDrawdownTrades}거래 지속</div>
        </div>
        <div className="bg-white/[0.03] rounded-xl p-2.5 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5">승률</div>
          <div className={`text-base font-bold tabular-nums ${n(con.winRate) >= 55 ? 'text-emerald-400' : n(con.winRate) >= 45 ? 'text-amber-400' : 'text-rose-400'}`}>
            {n(con.winRate).toFixed(1)}%
          </div>
          <div className="text-[10px] text-slate-500">PF {n(eff.profitFactor).toFixed(2)}</div>
        </div>
      </div>

      {/* Detailed sections */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Section title="수익 분석">
          <MetricRow label="CAGR" value={<span className={pctColor(ret.cagr)}>{fmtPct(ret.cagr)}</span>} sub="연환산" />
          <MetricRow label="월 평균" value={<span className={pctColor(ret.monthlyAvgPct)}>{fmtPct(ret.monthlyAvgPct)}</span>} />
          <MetricRow label="일 평균" value={<span className={pctColor(ret.dailyAvgPct)}>{fmtPct(ret.dailyAvgPct)}</span>} />
          <MetricRow label="최고/최저 거래" value={<><span className="text-emerald-400">{fmtPct(ret.bestTradePct)}</span><span className="text-slate-600 mx-1">/</span><span className="text-rose-400">{fmtPct(ret.worstTradePct)}</span></>} />
          <MetricRow label="총 손익" value={`₩${n(ret.totalPnlKrw).toLocaleString('ko-KR')}`} />
        </Section>

        <Section title="효율성">
          <MetricRow label="Sortino" value={n(eff.sortinoRatio).toFixed(2)} sub="하방 위험 대비" />
          <MetricRow label="Calmar" value={n(eff.calmarRatio).toFixed(2)} sub="MDD 대비 수익" />
          <MetricRow label="Payoff Ratio" value={n(eff.payoffRatio).toFixed(2)} sub="평균 이익/손실" />
          <MetricRow label="Recovery Factor" value={n(con.recoveryFactor).toFixed(2)} sub="MDD 회복력" />
          <MetricRow label="MinTRL" value={n(eff.minTRL) >= 9999 ? 'N/A' : `${n(eff.minTRL)}일`} sub={`현재 ${n(data.period.tradingDays)}일`} />
        </Section>

        <Section title="리스크">
          <MetricRow label="현재 낙폭" value={<span className={pctColor(-n(risk.currentDrawdownPct))}>{n(risk.currentDrawdownPct) > 0 ? `-${n(risk.currentDrawdownPct).toFixed(1)}%` : '0%'}</span>} />
          <MetricRow label="거래 변동성" value={`${n(risk.volatilityTrade).toFixed(2)}%`} sub="거래별" />
          <MetricRow label="연 변동성" value={`${n(risk.volatilityAnnual).toFixed(1)}%`} />
        </Section>

        <Section title="일관성">
          <MetricRow label="수익일 비율" value={`${n(con.profitDaysRate).toFixed(1)}%`} />
          <MetricRow label="최대 연승" value={`${con.maxConsecutiveWins}연승`} />
          <MetricRow label="최대 연패" value={<span className="text-rose-400">{con.maxConsecutiveLosses}연패</span>} />
        </Section>

        {bm?.available && (
          <Section title="벤치마크 (SPY)">
            <MetricRow label="Alpha" value={<span className={pctColor(bm.alpha)}>{fmtPct(bm.alpha)}</span>} sub="CAPM 초과수익" />
            <MetricRow label="Beta" value={n(bm.beta).toFixed(2)} sub={n(bm.beta) > 1 ? '고변동' : '저변동'} />
            <MetricRow label="Info Ratio" value={n(bm.informationRatio).toFixed(2)} sub={`TE ${n(bm.trackingError).toFixed(1)}%`} />
            <MetricRow label="SPY CAGR" value={<span className={pctColor(bm.benchmarkCagr)}>{fmtPct(bm.benchmarkCagr)}</span>} />
          </Section>
        )}
      </div>

      {/* Mode badge */}
      <div className="text-center">
        <span className={`text-[10px] px-2 py-0.5 rounded-full ${data.mode === 'paper' ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
          {data.mode === 'paper' ? 'Paper' : 'Live'} · {data.market === 'KR' ? '국내' : data.market === 'US' ? '해외' : '전체'}
        </span>
      </div>
    </div>
  );
});
