'use client';

import React from 'react';
import { api } from '../lib/utils';

export default function MoneyStatsPanel({ market, monthlyGoal, viewMode = 'live', totalValue }: { market: 'KR' | 'US'; monthlyGoal?: number; viewMode?: 'live' | 'paper'; totalValue?: number }) {
  const [data, setData] = React.useState<{
    totalCumulative: number;
    thisMonthPnl: number;
    monthly: Array<{ month: string; pnl: number; trades: number }>;
    dinnerMoney?: { monthlyTotal: number; monthlyCap: number; todayReserved: boolean } | null;
    operatingDays?: number;
    dailyAvgPnl?: number;
  } | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    setLoading(true);
    api(`/profit-stats?market=${market}&viewMode=${viewMode}`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [market, viewMode]);

  if (loading) return (
    <div className="glass rounded-2xl border border-white/[0.04] px-4 py-4 space-y-3 animate-pulse">
      <div className="h-3 w-24 bg-white/[0.06] rounded" />
      <div className="flex items-center gap-4">
        <div className="flex-1 space-y-2">
          <div className="h-2.5 w-32 bg-white/[0.04] rounded" />
          <div className="h-7 w-40 bg-white/[0.06] rounded" />
          <div className="h-2.5 w-28 bg-white/[0.04] rounded" />
        </div>
        <div className="w-[72px] h-[72px] rounded-full bg-white/[0.04]" />
      </div>
      <div className="flex gap-1 h-16">
        {[1,2,3,4,5,6].map(i => <div key={i} className="flex-1 bg-white/[0.03] rounded-t-sm h-[var(--h)]" style={{ '--h': `${20 + i * 8}%` } as React.CSSProperties} />)}
      </div>
    </div>
  );
  if (!data) return null;

  const isKr = market === 'KR';
  const fmt2 = (n: number) => isKr
    ? (n >= 0 ? '+' : '') + Math.round(n).toLocaleString('ko-KR') + '원'
    : (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0);
  const fmtShort = (n: number) => {
    const abs = Math.abs(n);
    const sign = n >= 0 ? '+' : '-';
    if (isKr) {
      if (abs >= 10000000) return sign + Math.round(abs / 10000000) + '천만';
      if (abs >= 1000000) return sign + (abs / 1000000).toFixed(1) + '백만';
      if (abs >= 10000) return sign + Math.round(abs / 10000) + '만';
      return sign + Math.round(abs).toLocaleString('ko-KR');
    }
    return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0);
  };

  const months = data.monthly.slice(-6);
  const maxAbs = Math.max(...months.map((m) => Math.abs(m.pnl)), 1);
  const goal = monthlyGoal ?? (isKr ? 1000000 : 500);
  const goalPct = Math.min(100, Math.max(0, (data.thisMonthPnl / goal) * 100));
  const goalReached = data.thisMonthPnl >= goal;
  const r = 28, cx = 36, cy = 36, circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - goalPct / 100);
  const gaugeColor = goalReached ? '#34d399' : goalPct > 60 ? '#60a5fa' : goalPct > 30 ? '#fbbf24' : '#94a3b8';

  return (
    <div className="glass rounded-2xl border border-white/[0.04] px-4 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-400">수익 현황 {isKr ? 'KR' : 'US'}</span>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex-1">
          <div className="text-[10px] text-slate-500 mb-0.5">봇 시작부터 누적 {data.operatingDays ? <span className="text-slate-600">({data.operatingDays}일)</span> : ''}</div>
          <div className={`text-2xl font-black tabular-nums ${data.totalCumulative >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {fmt2(data.totalCumulative)}
          </div>
          <div className="text-[10px] text-slate-500 mt-1">이번달 <span className={`font-bold ${data.thisMonthPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmt2(data.thisMonthPnl)}</span></div>
          {data.dailyAvgPnl !== undefined && (
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-[10px] text-slate-500">일평균</span>
              <span className={`text-[11px] font-bold tabular-nums ${data.dailyAvgPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {fmt2(data.dailyAvgPnl)}
              </span>
              {totalValue && totalValue > 0 && (
                <span className={`text-[10px] font-semibold ${data.dailyAvgPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                  ({data.dailyAvgPnl >= 0 ? '+' : ''}{((data.dailyAvgPnl / totalValue) * 100).toFixed(3)}%/일)
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col items-center shrink-0">
          <svg width="72" height="72" viewBox="0 0 72 72">
            <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="7" />
            <circle cx={cx} cy={cy} r={r} fill="none" stroke={gaugeColor} strokeWidth="7"
              strokeDasharray={circumference} strokeDashoffset={dashOffset}
              strokeLinecap="round" transform={`rotate(-90 ${cx} ${cy})`}
              className="[transition:stroke-dashoffset_0.8s_ease]" />
            <text x={cx} y={cy - 4} textAnchor="middle" fill={gaugeColor} fontSize="11" fontWeight="800">{Math.round(goalPct)}%</text>
            <text x={cx} y={cy + 8} textAnchor="middle" fill="#64748b" fontSize="7">이달목표</text>
          </svg>
          <div className="text-[9px] text-slate-600 mt-0.5">목표 {isKr ? (goal / 10000).toLocaleString('ko-KR') + '만원' : '$' + goal}</div>
        </div>
      </div>

      {months.length > 0 && (
        <div>
          <div className="text-[10px] text-slate-500 mb-2">최근 {months.length}개월</div>
          <div className="flex items-end gap-1 h-16">
            {months.map((m) => {
              const pct = (Math.abs(m.pnl) / maxAbs) * 100;
              const isPos = m.pnl >= 0;
              const label = m.month.slice(5);
              return (
                <div key={m.month} className="flex-1 flex flex-col items-center gap-0.5 group relative">
                  <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-slate-800 border border-white/10 rounded px-1.5 py-0.5 text-[9px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none">
                    {fmtShort(m.pnl)} ({m.trades}건)
                  </div>
                  <div className="w-full flex flex-col justify-end h-[52px]">
                    <div
                      className={`w-full rounded-t-sm transition-all duration-500 h-[var(--h)] ${isPos ? 'bg-emerald-500/70' : 'bg-rose-500/70'}`}
                      style={{ '--h': `${Math.max(pct, 4)}%` } as React.CSSProperties}
                    />
                  </div>
                  <div className="text-[9px] text-slate-600">{label}월</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {isKr && data.dinnerMoney && (
        <div className="border-t border-white/[0.04] pt-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] text-slate-400">저녁용돈 적립</span>
            <span className="text-[10px] text-slate-500">
              {data.dinnerMoney.monthlyTotal.toLocaleString('ko-KR')}원 / {(data.dinnerMoney.monthlyCap / 10000).toFixed(0)}만원
              {data.dinnerMoney.todayReserved && <span className="ml-1 text-emerald-400">오늘 적립됨</span>}
            </span>
          </div>
          <div className="w-full h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 w-[var(--w)] ${
                data.dinnerMoney.monthlyTotal >= data.dinnerMoney.monthlyCap
                  ? 'bg-emerald-400'
                  : 'bg-gradient-to-r from-amber-500 to-amber-400'
              }`}
              style={{ '--w': `${Math.min(100, (data.dinnerMoney.monthlyTotal / data.dinnerMoney.monthlyCap) * 100)}%` } as React.CSSProperties}
            />
          </div>
          <div className="text-[9px] text-slate-600 mt-1">수익 1만원 이상 되는 날 자동 적립 · 월 {(data.dinnerMoney.monthlyCap / 10000).toFixed(0)}만원 한도</div>
        </div>
      )}
    </div>
  );
}
