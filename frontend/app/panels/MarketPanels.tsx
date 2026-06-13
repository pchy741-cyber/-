'use client';

import React from 'react';
import { Panel } from '@/components/ui';
import { api, pc, fmtWon } from '../lib/utils';

interface SectorHeatmapItem {
  name: string;
  pct: number;
}

interface HighScannerItem {
  stock_code: string;
  stock_name: string;
  current: number;
  high52w: number;
  dropFromHigh: number;
  isNearHigh: boolean;
}

interface PerformancePoint {
  date?: string;
  value: number;
}

interface TaxEstimateData {
  year: number;
  transactionTax: number;
  netGain: number;
  totalSellAmount: number;
}

// ═══════════════════════════════════════
// 업종 히트맵
// ═══════════════════════════════════════

export function SectorHeatmapPanel() {
  const [items, setItems] = React.useState<SectorHeatmapItem[]>([]);
  React.useEffect(() => {
    api('/market/sector-heatmap', { timeout: 10000 }).then((d: Record<string, unknown>) => setItems((d.items as SectorHeatmapItem[]) ?? [])).catch(() => {});
  }, []);
  if (items.length === 0) return null;
  const maxAbs = Math.max(...items.map((it) => Math.abs(it.pct)), 0.1);
  return (
    <Panel title="업종 현황">
      <div className="px-3 pb-3 flex flex-wrap gap-1.5">
        {items.map((it, i) => {
          const intensity = Math.min(1, Math.abs(it.pct) / maxAbs);
          const bg = it.pct > 0
            ? `rgba(52,211,153,${0.08 + intensity * 0.25})`
            : it.pct < 0
              ? `rgba(248,113,113,${0.08 + intensity * 0.25})`
              : 'rgba(100,116,139,0.1)';
          return (
            <div key={i} className="rounded-lg px-2 py-1.5 text-center min-w-[72px]" style={{ background: bg }}>
              <p className="text-[10px] text-slate-300 truncate">{it.name}</p>
              <p className={`text-[11px] font-bold ${it.pct > 0 ? 'text-emerald-400' : it.pct < 0 ? 'text-rose-400' : 'text-slate-400'}`}>
                {it.pct > 0 ? '+' : ''}{it.pct.toFixed(2)}%
              </p>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// 52주 신고가 스캐너
// ═══════════════════════════════════════

export function HighScannerPanel() {
  const [items, setItems] = React.useState<HighScannerItem[]>([]);
  React.useEffect(() => {
    api('/market/52w-highs', { timeout: 30000 }).then((d: Record<string, unknown>) => setItems((d.items as HighScannerItem[]) ?? [])).catch(() => {});
  }, []);
  const nearHigh = items.filter(it => it.isNearHigh);
  if (nearHigh.length === 0) return null;
  return (
    <Panel title="52주 신고가 근접" badge={`${nearHigh.length}종목`}>
      <div className="px-4 pb-3 space-y-2">
        {nearHigh.map((it) => (
          <div key={it.stock_code} className="flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-slate-200">{it.stock_name}</span>
              <span className="ml-2 text-[10px] text-slate-500">{it.current.toLocaleString()}원</span>
            </div>
            <div className="text-right">
              <span className="text-[10px] text-amber-400 font-bold">신고가 {it.high52w.toLocaleString()}원</span>
              <span className="ml-2 text-[10px] text-emerald-400">{it.dropFromHigh.toFixed(1)}%</span>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// 봇 수익률 vs KOSPI 비교 차트
// ═══════════════════════════════════════

export function PerformanceVsKospiPanel({ viewMode = 'live' }: { viewMode?: string }) {
  const [data, setData] = React.useState<{ bot: PerformancePoint[]; kospi: PerformancePoint[] } | null>(null);
  React.useEffect(() => {
    api(`/market/performance-vs-kospi?viewMode=${viewMode}`, { timeout: 15000 }).then(setData).catch(() => {});
  }, [viewMode]);

  if (!data || (data.bot.length === 0 && data.kospi.length === 0)) return null;

  const allVals = [...data.bot.map(p => p.value), ...data.kospi.map(p => p.value)];
  const minV = Math.min(...allVals, 0);
  const maxV = Math.max(...allVals, 0);
  const range = maxV - minV || 1;
  const H = 80; const W = 300;

  const toY = (v: number) => H - ((v - minV) / range) * H;
  const botPath = data.bot.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / Math.max(data.bot.length - 1, 1)) * W},${toY(p.value)}`).join(' ');
  const kospiPath = data.kospi.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / Math.max(data.kospi.length - 1, 1)) * W},${toY(p.value)}`).join(' ');
  const zeroY = toY(0);
  const botLast = data.bot[data.bot.length - 1]?.value ?? 0;
  const kospiLast = data.kospi[data.kospi.length - 1]?.value ?? 0;

  return (
    <Panel title="봇 수익률 vs KOSPI">
      <div className="px-4 pb-3">
        <div className="flex items-center gap-4 mb-2 text-[11px]">
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-emerald-400 inline-block rounded" /> 봇 <span className={pc(botLast)}>{botLast > 0 ? '+' : ''}{botLast.toFixed(2)}%</span></span>
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-blue-400 inline-block rounded" /> KOSPI <span className={pc(kospiLast)}>{kospiLast > 0 ? '+' : ''}{kospiLast.toFixed(2)}%</span></span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20">
          <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="#334155" strokeWidth="0.5" strokeDasharray="4 2" />
          {kospiPath && <path d={kospiPath} fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />}
          {botPath && <path d={botPath} fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
        <div className="flex justify-between text-[9px] text-slate-600 mt-1">
          <span>{data.bot[0]?.date ?? data.kospi[0]?.date ?? ''}</span>
          <span>오늘</span>
        </div>
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// TAX ESTIMATE PANEL
// ═══════════════════════════════════════

export function TaxEstimatePanel({ viewMode = 'live' }: { viewMode?: string }) {
  const [data, setData] = React.useState<TaxEstimateData | null>(null);
  React.useEffect(() => {
    api(`/market/tax-estimate?viewMode=${viewMode}`).then(setData).catch(() => {});
  }, [viewMode]);
  if (!data) return null;
  return (
    <Panel title={`${data.year}년 세금 추정`}>
      <div className="px-4 pb-3 grid grid-cols-2 gap-2">
        <div className="bg-slate-800/40 rounded-xl p-3">
          <p className="text-[10px] text-slate-500 mb-1">거래세 (0.18%)</p>
          <p className="text-sm font-bold text-amber-400">{Math.round(data.transactionTax).toLocaleString()}원</p>
        </div>
        <div className="bg-slate-800/40 rounded-xl p-3">
          <p className="text-[10px] text-slate-500 mb-1">순실현손익</p>
          <p className={`text-sm font-bold ${pc(data.netGain)}`}>{data.netGain > 0 ? '+' : ''}{Math.round(data.netGain).toLocaleString()}원</p>
        </div>
        <div className="bg-slate-800/40 rounded-xl p-3">
          <p className="text-[10px] text-slate-500 mb-1">총 매도금액</p>
          <p className="text-sm font-bold text-slate-200">{Math.round(data.totalSellAmount / 10000).toLocaleString()}만원</p>
        </div>
        <div className="bg-emerald-950/30 border border-emerald-900/30 rounded-xl p-3">
          <p className="text-[10px] text-slate-500 mb-1">양도세 (소액주주)</p>
          <p className="text-sm font-bold text-emerald-400">비과세 ✓</p>
        </div>
      </div>
    </Panel>
  );
}
