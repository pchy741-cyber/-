'use client';

import React, { useState, useEffect } from 'react';
import { api } from '../lib/utils';
import type { AiCostSummary, AiCostHistory, AiCostDailyEntry } from '../types';

const PROVIDER_COLORS: Record<string, string> = {
  gemini: '#34d399',
  gpt: '#60a5fa',
  'claude-api': '#c084fc',
  'claude-cli': '#a78bfa',
  groq: '#fbbf24',
};

const PROVIDER_LABELS: Record<string, string> = {
  gemini: 'Gemini',
  gpt: 'GPT-4o-mini',
  'claude-api': 'Claude API',
  'claude-cli': 'Claude CLI',
  groq: 'Groq',
};

function fmtKrw(v: number): string {
  if (v >= 10000) return `${Math.round(v / 10000)}만`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}천`;
  return `${Math.round(v)}`;
}

function fmtUsd(v: number): string {
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function fmtTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

// ── KPI Card ──
function KpiCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4 space-y-1">
      <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">{label}</div>
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-600">{sub}</div>}
    </div>
  );
}

// ── SVG Line Chart (30일 일별 비용 추이) ──
function DailyCostChart({ daily, exchangeRate }: { daily: AiCostDailyEntry[]; exchangeRate: number }) {
  if (daily.length < 2) {
    return (
      <div className="h-48 flex items-center justify-center text-[11px] text-slate-600">
        데이터 부족 (최소 2일 필요)
      </div>
    );
  }

  const W = 700, H = 200, padL = 50, padR = 16, padT = 16, padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const values = daily.map(d => d.totalUsd * exchangeRate);
  const maxV = Math.max(...values, 1);

  const stepX = innerW / (daily.length - 1);

  const points = values.map((v, i) => ({
    x: padL + i * stepX,
    y: padT + innerH - (v / maxV) * innerH,
    v,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${padT + innerH} L ${points[0].x.toFixed(1)} ${padT + innerH} Z`;

  // Y-axis labels (4 ticks)
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({
    val: maxV * f,
    y: padT + innerH - f * innerH,
  }));

  // X-axis labels (show every ~7 days)
  const xStep = Math.max(1, Math.floor(daily.length / 5));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="xMidYMid meet">
      {/* grid lines */}
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={padL} y1={t.y} x2={W - padR} y2={t.y} stroke="rgba(255,255,255,0.04)" />
          <text x={padL - 6} y={t.y + 3} textAnchor="end" fill="#64748b" fontSize="9">
            {fmtKrw(t.val)}
          </text>
        </g>
      ))}
      {/* area fill */}
      <path d={areaPath} fill="rgba(96, 165, 250, 0.08)" />
      {/* line */}
      <path d={linePath} fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinejoin="round" />
      {/* dots */}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="2.5" fill="#60a5fa" />
      ))}
      {/* X labels */}
      {daily.map((d, i) => {
        if (i % xStep !== 0 && i !== daily.length - 1) return null;
        return (
          <text key={i} x={padL + i * stepX} y={H - 6} textAnchor="middle" fill="#64748b" fontSize="9">
            {d.day.slice(5)} {/* MM-DD */}
          </text>
        );
      })}
    </svg>
  );
}

// ── Provider Bar Chart (오늘 비율) ──
function ProviderBreakdown({ today }: { today: AiCostSummary['today'] }) {
  const entries = Object.entries(today).sort((a, b) => b[1].costUsd - a[1].costUsd);
  const totalUsd = entries.reduce((s, [, v]) => s + v.costUsd, 0) || 1;

  return (
    <div className="space-y-2">
      {entries.map(([provider, stats]) => {
        const pct = (stats.costUsd / totalUsd) * 100;
        const color = PROVIDER_COLORS[provider] ?? '#94a3b8';
        return (
          <div key={provider} className="space-y-1">
            <div className="flex justify-between text-[11px]">
              <span className="text-slate-400 font-medium">{PROVIDER_LABELS[provider] ?? provider}</span>
              <span className="text-slate-500">{fmtUsd(stats.costUsd)} ({pct.toFixed(0)}%)</span>
            </div>
            <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(pct, 1)}%`, backgroundColor: color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Detail Table ──
function DetailTable({ today, exchangeRate }: { today: AiCostSummary['today']; exchangeRate: number }) {
  const entries = Object.entries(today).sort((a, b) => b[1].costUsd - a[1].costUsd);

  if (entries.length === 0) {
    return <div className="text-[11px] text-slate-600 text-center py-6">오늘 AI 호출 기록 없음</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-left text-slate-500 border-b border-white/[0.06]">
            <th className="py-2 pr-3 font-medium">Provider</th>
            <th className="py-2 pr-3 font-medium text-right">Calls</th>
            <th className="py-2 pr-3 font-medium text-right">Input Tok</th>
            <th className="py-2 pr-3 font-medium text-right">Output Tok</th>
            <th className="py-2 pr-3 font-medium text-right">Cost (USD)</th>
            <th className="py-2 font-medium text-right">Cost (KRW)</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([provider, s]) => (
            <tr key={provider} className="border-b border-white/[0.03] text-slate-300">
              <td className="py-2 pr-3">
                <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: PROVIDER_COLORS[provider] ?? '#94a3b8' }} />
                {PROVIDER_LABELS[provider] ?? provider}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{s.calls.toLocaleString()}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{fmtTokens(s.inputTokens)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{fmtTokens(s.outputTokens)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-cyan-400">{fmtUsd(s.costUsd)}</td>
              <td className="py-2 text-right tabular-nums text-amber-400">{fmtKrw(s.costUsd * exchangeRate)}원</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Stacked Bar Chart per day (provider breakdown) ──
function DailyStackedChart({ daily, exchangeRate }: { daily: AiCostDailyEntry[]; exchangeRate: number }) {
  if (daily.length === 0) return null;

  // Collect all providers
  const allProviders = new Set<string>();
  for (const d of daily) for (const p of Object.keys(d.providers)) allProviders.add(p);
  const providers = [...allProviders];

  const maxKrw = Math.max(...daily.map(d => d.totalUsd * exchangeRate), 1);
  const barW = Math.max(4, Math.min(16, Math.floor(600 / daily.length) - 2));

  return (
    <div className="overflow-x-auto">
      <div className="flex items-end gap-0.5 h-32" style={{ minWidth: daily.length * (barW + 2) }}>
        {daily.map((d, i) => {
          const totalH = (d.totalUsd * exchangeRate / maxKrw) * 120;
          let offset = 0;
          return (
            <div key={i} className="flex flex-col-reverse" style={{ width: barW }} title={`${d.day}: ${fmtKrw(d.totalUsd * exchangeRate)}원`}>
              {providers.map(p => {
                const krw = (d.providers[p]?.costUsd ?? 0) * exchangeRate;
                const h = totalH > 0 ? (krw / (d.totalUsd * exchangeRate)) * totalH : 0;
                offset += h;
                return (
                  <div key={p} style={{ height: Math.max(h, 0), backgroundColor: PROVIDER_COLORS[p] ?? '#94a3b8', minHeight: h > 0 ? 1 : 0 }} />
                );
              })}
            </div>
          );
        })}
      </div>
      {/* Legend */}
      <div className="flex gap-3 mt-2 flex-wrap">
        {providers.map(p => (
          <div key={p} className="flex items-center gap-1 text-[9px] text-slate-500">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: PROVIDER_COLORS[p] ?? '#94a3b8' }} />
            {PROVIDER_LABELS[p] ?? p}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main View ──
export default function AiCostView() {
  const [summary, setSummary] = useState<AiCostSummary | null>(null);
  const [history, setHistory] = useState<AiCostHistory | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [s, h] = await Promise.all([
          api('/ai-cost/summary') as Promise<AiCostSummary>,
          api('/ai-cost/history?days=30') as Promise<AiCostHistory>,
        ]);
        if (cancelled) return;
        setSummary(s);
        setHistory(h);
      } catch {
        // silent — show empty state
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const interval = setInterval(load, 60_000); // 1분마다 갱신
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 gap-2">
        <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
        <span className="text-[11px] text-slate-500">AI 비용 데이터 로딩...</span>
      </div>
    );
  }

  const s = summary ?? {
    today: {}, todayTotalUsd: 0, todayTotalKrw: 0,
    todayTotalCalls: 0, todayTotalTokens: 0,
    monthTotalUsd: 0, monthTotalKrw: 0, exchangeRate: 1380,
  };
  const h = history ?? { daily: [], exchangeRate: 1380 };

  return (
    <div className="space-y-6">
      {/* Title */}
      <div>
        <h2 className="text-lg font-bold text-slate-200">AI 비용 대시보드</h2>
        <p className="text-[11px] text-slate-500 mt-0.5">모든 AI 모델의 토큰 사용량 및 비용 현황</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="오늘 비용" value={`${fmtKrw(s.todayTotalKrw)}원`} sub={fmtUsd(s.todayTotalUsd)} color="text-cyan-400" />
        <KpiCard label="이번달 누적" value={`${fmtKrw(s.monthTotalKrw)}원`} sub={fmtUsd(s.monthTotalUsd)} color="text-amber-400" />
        <KpiCard label="오늘 호출수" value={s.todayTotalCalls.toLocaleString()} sub="API calls" color="text-emerald-400" />
        <KpiCard label="오늘 토큰" value={fmtTokens(s.todayTotalTokens)} sub="input + output" color="text-violet-400" />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Daily Cost Trend */}
        <div className="lg:col-span-2 rounded-xl bg-white/[0.02] border border-white/[0.06] p-4">
          <h3 className="text-[12px] font-semibold text-slate-300 mb-3">30일 비용 추이 (KRW)</h3>
          <DailyCostChart daily={h.daily} exchangeRate={h.exchangeRate} />
        </div>

        {/* Provider Breakdown */}
        <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-4">
          <h3 className="text-[12px] font-semibold text-slate-300 mb-3">모델별 비용 비율</h3>
          <ProviderBreakdown today={s.today} />
        </div>
      </div>

      {/* Stacked Bar Chart */}
      {h.daily.length > 0 && (
        <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-4">
          <h3 className="text-[12px] font-semibold text-slate-300 mb-3">일별 모델별 비용 분포</h3>
          <DailyStackedChart daily={h.daily} exchangeRate={h.exchangeRate} />
        </div>
      )}

      {/* Detail Table */}
      <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-4">
        <h3 className="text-[12px] font-semibold text-slate-300 mb-3">오늘 상세</h3>
        <DetailTable today={s.today} exchangeRate={s.exchangeRate} />
      </div>

      {/* Footer */}
      <div className="text-[9px] text-slate-600 text-center pb-4">
        환율: $1 = {s.exchangeRate.toLocaleString()}원 (고정)
      </div>
    </div>
  );
}
