'use client';

import React from 'react';
import { Panel } from '@/components/ui';
import { api, pc } from '../lib/utils';

// ═══════════════════════════════════════
// ARC GAUGE
// ═══════════════════════════════════════

export function ArcGauge({ pct, color, label, sub }: { pct: number; color: string; label: string; sub: string }) {
  const r = 28; const cx = 36; const cy = 36;
  const circ = Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const stroke = (clamped / 100) * circ;
  const trackColor = 'rgba(255,255,255,0.05)';
  const colorMap: Record<string, string> = {
    emerald: '#10b981', blue: '#3b82f6', amber: '#f59e0b', rose: '#f43f5e',
  };
  const strokeColor = colorMap[color] ?? colorMap.blue;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="72" height="44" viewBox="0 0 72 44">
        <path d={`M 8 36 A ${r} ${r} 0 0 1 64 36`} fill="none" stroke={trackColor} strokeWidth="6" strokeLinecap="round" />
        <path d={`M 8 36 A ${r} ${r} 0 0 1 64 36`} fill="none" stroke={strokeColor} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${stroke} ${circ}`} style={{ transition: 'stroke-dasharray 0.6s ease' }} />
        <text x="36" y="34" textAnchor="middle" fontSize="11" fontWeight="700" fill="white">{clamped}%</text>
      </svg>
      <div className="text-[10px] font-semibold text-slate-300 text-center leading-tight">{label}</div>
      <div className="text-[9px] text-slate-600 text-center">{sub}</div>
    </div>
  );
}

// ═══════════════════════════════════════
// SCORE BAR
// ═══════════════════════════════════════

export function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  const colorMap: Record<string, string> = {
    blue: 'bg-blue-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500', violet: 'bg-violet-500',
  };
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <div className="w-14 text-slate-500 shrink-0 text-right">{label}</div>
      <div className="flex-1 h-1.5 bg-white/[0.05] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${colorMap[color] ?? colorMap.blue}`} style={{ width: `${Math.max(0, Math.min(100, value))}%`, transition: 'width 0.5s ease' }} />
      </div>
      <div className="w-7 text-right text-slate-400 font-semibold">{Math.round(value)}</div>
    </div>
  );
}

// ═══════════════════════════════════════
// RISK GAUGE PANEL
// ═══════════════════════════════════════

export function RiskGaugePanel({ investedPct, dailyLossPct, concentrationPct }: { investedPct: number; dailyLossPct: number; concentrationPct: number }) {
  const investedColor = investedPct > 75 ? 'rose' : investedPct > 50 ? 'amber' : 'emerald';
  const lossColor = dailyLossPct > 70 ? 'rose' : dailyLossPct > 40 ? 'amber' : 'emerald';
  const concColor = concentrationPct > 50 ? 'rose' : concentrationPct > 30 ? 'amber' : 'blue';
  return (
    <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3">
      <div className="text-[11px] font-semibold text-slate-400 mb-2">리스크 게이지</div>
      <div className="flex items-end justify-around gap-2">
        <ArcGauge pct={Math.round(investedPct)} color={investedColor} label="투자 비중" sub="한도 80%" />
        <ArcGauge pct={Math.round(dailyLossPct)} color={lossColor} label="손실 소진" sub="일일 한도" />
        <ArcGauge pct={Math.round(concentrationPct)} color={concColor} label="종목 집중도" sub="단일 최대" />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// 포트폴리오 상관관계 경고
// ═══════════════════════════════════════

export function CorrelationWarningPanel({ viewMode = 'live' }: { viewMode?: string }) {
  const [warnings, setWarnings] = React.useState<any[]>([]);
  React.useEffect(() => {
    api(`/market/correlation?viewMode=${viewMode}`).then((d: any) => setWarnings(d.warnings ?? [])).catch(() => {});
  }, [viewMode]);
  if (warnings.length === 0) return null;
  return (
    <Panel title="섹터 쏠림 경고" badge={`${warnings.length}건`}>
      <div className="px-4 pb-3 space-y-2">
        {warnings.map((w: any) => (
          <div key={w.sector} className="flex items-start gap-2 bg-amber-950/20 border border-amber-900/30 rounded-xl px-3 py-2">
            <span className="text-amber-400 text-sm">⚠</span>
            <div>
              <p className="text-xs font-bold text-amber-300">{w.sector} {w.count}종목 동시 보유</p>
              <p className="text-[10px] text-slate-500">{w.stocks.join(', ')}</p>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// 공매도 비율 패널
// ═══════════════════════════════════════

const SHORT_RISK: Record<string, { color: string; label: string }> = {
  HIGH:   { color: 'text-rose-400',   label: '위험' },
  MEDIUM: { color: 'text-amber-400',  label: '주의' },
  LOW:    { color: 'text-emerald-400',label: '안전' },
};

export function ShortSellingPanel() {
  const [items, setItems] = React.useState<any[]>([]);
  React.useEffect(() => {
    api('/market/short-selling', { timeout: 20000 }).then((d: any) => setItems(d.items ?? [])).catch(() => {});
  }, []);
  if (items.length === 0) return null;
  return (
    <Panel title="보유종목 공매도 현황">
      <div className="px-4 pb-3 divide-y divide-slate-800/30">
        {items.map((it: any) => {
          const risk = SHORT_RISK[it.riskLevel] ?? SHORT_RISK.LOW;
          return (
            <div key={it.stock_code} className="flex items-center justify-between py-2">
              <div>
                <span className="text-xs font-semibold text-slate-200">{it.stock_name}</span>
                {it.isIncreasing && <span className="ml-2 text-[9px] bg-rose-900/40 text-rose-400 px-1.5 py-0.5 rounded">증가↑</span>}
              </div>
              <div className="flex items-center gap-3 text-right">
                <span className="text-[11px] text-slate-400">{it.shortRatio.toFixed(1)}%</span>
                <span className={`text-[11px] font-bold ${risk.color}`}>{risk.label}</span>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
