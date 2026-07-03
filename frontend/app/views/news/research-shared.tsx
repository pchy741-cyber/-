'use client';

import React from 'react';
import type { DartFinancial } from './research-types';

// 숫자 포맷 (억 단위)
export function fmtBillion(v: number): string {
  const eok = v / 100_000_000;
  if (Math.abs(eok) >= 10000) return `${(eok / 10000).toFixed(1)}조`;
  if (Math.abs(eok) >= 1) return `${eok.toFixed(0)}억`;
  return `${(v / 10000).toFixed(0)}만`;
}

export function fScoreColor(f: number): string {
  if (f >= 7) return 'text-emerald-400';
  if (f >= 5) return 'text-amber-400';
  return 'text-rose-400';
}

export function fundColor(s: number): string {
  if (s >= 70) return 'text-emerald-400';
  if (s >= 50) return 'text-amber-400';
  return 'text-rose-400';
}

export function fundBg(s: number): string {
  if (s >= 70) return 'bg-emerald-500/15 border-emerald-500/30';
  if (s >= 50) return 'bg-amber-500/15 border-amber-500/30';
  return 'bg-rose-500/15 border-rose-500/30';
}

// 재무 지표 그리드 — DART/SEC 공통
export function FinancialGrid({ f, labelPrefix }: { f: DartFinancial; labelPrefix: 'kr' | 'us' }) {
  const isKr = labelPrefix === 'kr';
  const periodLabel = isKr
    ? `${f.year}년 ${f.quarter === 'annual' ? '연간' : f.quarter.toUpperCase()} 실적`
    : `FY${f.year} ${f.quarter === 'annual' ? 'Annual' : f.quarter} (10-K)`;

  const labels = isKr
    ? { revenue: '매출', opIncome: '영업이익', opMargin: '영업이익률', netIncome: '순이익', debtRatio: '부채비율', totalAssets: '총자산' }
    : { revenue: 'Revenue', opIncome: 'Op. Income', opMargin: 'Op. Margin', netIncome: 'Net Income', debtRatio: 'Debt Ratio', totalAssets: 'Total Assets' };

  const debtThresholds = isKr ? { good: 100, warn: 200 } : { good: 50, warn: 70 };

  return (
    <div className="mt-2">
      <div className="text-[9px] text-slate-600 mb-1.5">{periodLabel}</div>
      <div className="grid grid-cols-3 gap-1.5">
        <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
          <div className="text-[9px] text-slate-500">{labels.revenue}</div>
          <div className="text-[11px] font-bold text-slate-200">{fmtBillion(f.revenue)}</div>
          <div className={`text-[9px] font-bold ${f.revenueYoy >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {f.revenueYoy >= 0 ? '+' : ''}{f.revenueYoy.toFixed(1)}%
          </div>
        </div>
        <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
          <div className="text-[9px] text-slate-500">{labels.opIncome}</div>
          <div className="text-[11px] font-bold text-slate-200">{fmtBillion(f.operatingIncome)}</div>
          <div className={`text-[9px] font-bold ${f.operatingIncomeYoy >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {f.operatingIncomeYoy >= 0 ? '+' : ''}{f.operatingIncomeYoy.toFixed(1)}%
          </div>
        </div>
        <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
          <div className="text-[9px] text-slate-500">{labels.opMargin}</div>
          <div className={`text-[11px] font-bold ${f.operatingMargin >= 15 ? 'text-emerald-400' : f.operatingMargin >= 8 ? 'text-amber-400' : 'text-rose-400'}`}>
            {f.operatingMargin.toFixed(1)}%
          </div>
        </div>
        <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
          <div className="text-[9px] text-slate-500">{labels.netIncome}</div>
          <div className="text-[11px] font-bold text-slate-200">{fmtBillion(f.netIncome)}</div>
        </div>
        <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
          <div className="text-[9px] text-slate-500">{labels.debtRatio}</div>
          <div className={`text-[11px] font-bold ${f.debtRatio <= debtThresholds.good ? 'text-emerald-400' : f.debtRatio <= debtThresholds.warn ? 'text-amber-400' : 'text-rose-400'}`}>
            {f.debtRatio.toFixed(0)}%
          </div>
        </div>
        <div className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
          <div className="text-[9px] text-slate-500">{labels.totalAssets}</div>
          <div className="text-[11px] font-bold text-slate-200">{fmtBillion(f.totalAssets)}</div>
        </div>
      </div>
    </div>
  );
}

// 강점/리스크 공통
export function StrengthsRisks({ strengths, risks }: { strengths: string[]; risks: string[] }) {
  if (strengths.length === 0 && risks.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {strengths.length > 0 && (
        <div>
          <div className="text-[9px] text-emerald-500 font-bold mb-1">강점</div>
          {strengths.map((s, i) => (
            <div key={i} className="flex items-start gap-1 text-[10px] text-slate-300 leading-relaxed">
              <span className="text-emerald-500 shrink-0 mt-0.5">+</span><span>{s}</span>
            </div>
          ))}
        </div>
      )}
      {risks.length > 0 && (
        <div>
          <div className="text-[9px] text-rose-500 font-bold mb-1">리스크</div>
          {risks.map((s, i) => (
            <div key={i} className="flex items-start gap-1 text-[10px] text-slate-300 leading-relaxed">
              <span className="text-rose-500 shrink-0 mt-0.5">-</span><span>{s}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// AI 분석 블록 공통
export function AiAnalysisBlock({ analysis, color }: { analysis?: string; color: 'cyan' | 'blue' }) {
  if (!analysis) return null;
  return (
    <div className={`bg-${color}-950/20 border border-${color}-800/15 rounded-lg px-3 py-2`}>
      <div className={`text-[9px] text-${color}-500 font-bold mb-1`}>Gemini AI 분석</div>
      <p className="text-[10px] text-slate-300 leading-relaxed whitespace-pre-wrap">{analysis}</p>
    </div>
  );
}
