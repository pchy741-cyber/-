'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { api, pc } from '../lib/utils';

interface DividendViewProps {
  toast: (msg: string, type?: 'ok' | 'err' | 'info') => void;
  viewMode: 'paper' | 'live';
}

// 실제 ETF 데이터 (2024~2025 실적 기반)
// totalReturn = 배당수익률 + 시세상승률
const DIVIDEND_ETFS = [
  { code: 'JEPQ', name: '나스닥 커버드콜', yield: 9.5, growth: 8, price: 55, freq: '월', risk: '중' },
  { code: 'JEPI', name: 'S&P 커버드콜', yield: 7.5, growth: 5, price: 57, freq: '월', risk: '중' },
  { code: 'SCHD', name: '배당성장 우량주', yield: 3.5, growth: 12, price: 82, freq: '분기', risk: '낮음' },
  { code: 'QYLD', name: 'QQQ 커버드콜', yield: 11.0, growth: 0, price: 17, freq: '월', risk: '중' },
  { code: 'XYLD', name: 'S&P 커버드콜', yield: 10.5, growth: 1, price: 40, freq: '월', risk: '중' },
  { code: 'O', name: '리얼티인컴 리츠', yield: 5.5, growth: 3, price: 58, freq: '월', risk: '낮음' },
];

const FX_RATE = 1350;
const TAX_RATE = 0.154; // 배당소득세

export default function DividendView({ toast, viewMode }: DividendViewProps) {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<any>(null);
  const [holdings, setHoldings] = useState<any[]>([]);
  const [totalInvested, setTotalInvested] = useState(0);
  const [simBudget, setSimBudget] = useState(5000000);
  const [simYears, setSimYears] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [hist, hold] = await Promise.all([
        api('/dividend/history?limit=100'),
        api(`/dividend/holdings?viewMode=${viewMode}`),
      ]);
      setStats(hist.stats || null);
      const h = hold.holdings || [];
      setHoldings(h);
      setTotalInvested(h.reduce((s: number, x: any) => s + Number(x.avg_price || 0) * Number(x.quantity || 0), 0));
    } catch (e: any) { toast(e.message || '로딩 실패', 'err'); }
    setLoading(false);
  }, [viewMode, toast]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="p-8 text-center text-slate-500">로딩 중...</div>;

  const totalReceived = Number(stats?.total_received_usd || 0);
  const totalTax = Number(stats?.total_tax_usd || 0);

  // 시뮬레이션
  const budgetUsd = simBudget / FX_RATE;

  // ETF별 계산 (복리)
  const simResults = DIVIDEND_ETFS.map(etf => {
    const shares = Math.floor(budgetUsd / etf.price);
    const invested = shares * etf.price;
    const totalReturnPct = etf.yield + etf.growth;

    // 복리 계산 (배당 재투자 DRIP)
    let principal = invested;
    let totalDividends = 0;
    for (let y = 0; y < simYears; y++) {
      const yearDiv = principal * etf.yield / 100 * (1 - TAX_RATE);
      totalDividends += yearDiv;
      const yearGrowth = principal * etf.growth / 100;
      principal += yearDiv + yearGrowth; // DRIP + 시세상승
    }
    const totalProfit = principal - invested;
    const monthlyDiv = invested * etf.yield / 100 * (1 - TAX_RATE) / 12;
    const effectiveReturn = ((principal / invested) - 1) * 100;

    return { ...etf, shares, invested, totalReturnPct, totalProfit, monthlyDiv, effectiveReturn, finalValue: principal };
  }).sort((a, b) => b.effectiveReturn - a.effectiveReturn);

  // 균등 분산 (최적 포트폴리오)
  const perEtfBudget = budgetUsd / DIVIDEND_ETFS.length;
  let blendedFinal = 0;
  let blendedMonthlyDiv = 0;
  DIVIDEND_ETFS.forEach(etf => {
    const shares = Math.floor(perEtfBudget / etf.price);
    const invested = shares * etf.price;
    let principal = invested;
    for (let y = 0; y < simYears; y++) {
      const yearDiv = principal * etf.yield / 100 * (1 - TAX_RATE);
      principal += yearDiv + principal * etf.growth / 100;
    }
    blendedFinal += principal;
    blendedMonthlyDiv += invested * etf.yield / 100 * (1 - TAX_RATE) / 12;
  });
  const blendedInvested = DIVIDEND_ETFS.reduce((s, etf) => {
    return s + Math.floor(perEtfBudget / etf.price) * etf.price;
  }, 0);
  const blendedReturn = blendedInvested > 0 ? ((blendedFinal / blendedInvested) - 1) * 100 : 0;
  const blendedProfit = blendedFinal - blendedInvested;

  return (
    <div className="space-y-5">
      {/* 실제 수익 현황 */}
      {(holdings.length > 0 || totalReceived > 0) && (
        <div className="bg-slate-800/40 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-200">내 배당 현황</h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium">자동</span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-900/40 rounded-xl p-4 text-center">
              <div className="text-[10px] text-slate-500 mb-1">투자</div>
              <div className="text-lg font-bold text-slate-100">${totalInvested.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
            </div>
            <div className="bg-slate-900/40 rounded-xl p-4 text-center">
              <div className="text-[10px] text-slate-500 mb-1">배당 수익</div>
              <div className={`text-lg font-bold ${pc(totalReceived)}`}>${totalReceived.toFixed(2)}</div>
              <div className="text-[10px] text-slate-600">세금 ${totalTax.toFixed(2)}</div>
            </div>
          </div>
          {holdings.length > 0 && (
            <div className="divide-y divide-white/[0.03]">
              {holdings.map((h: any) => (
                <div key={h.stock_code} className="py-2 px-1 flex items-center justify-between">
                  <span className="text-sm font-bold text-slate-200">{h.stock_code} <span className="text-[10px] text-slate-500 font-normal">{h.quantity}주</span></span>
                  <span className={`text-sm font-bold ${pc(Number(h.total_dividends_received || 0))}`}>${Number(h.total_dividends_received || 0).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ──── 시뮬레이터 (총수익률) ──── */}
      <div className="bg-slate-800/40 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-200">수익 시뮬레이터</h2>
          <span className="text-[10px] text-slate-500">배당 + 시세 + 복리</span>
        </div>

        {/* 투자금 */}
        <div className="flex gap-2 flex-wrap">
          {[1000000, 3000000, 5000000, 10000000].map(amt => (
            <button key={amt} onClick={() => setSimBudget(amt)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${simBudget === amt ? 'bg-blue-600/30 text-blue-300 border border-blue-500/30' : 'bg-slate-800/60 text-slate-500 border border-slate-700/30'}`}>
              {(amt / 10000).toLocaleString()}만원
            </button>
          ))}
        </div>

        {/* 기간 */}
        <div className="flex gap-2">
          {[1, 3, 5].map(y => (
            <button key={y} onClick={() => setSimYears(y)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${simYears === y ? 'bg-violet-600/30 text-violet-300 border border-violet-500/30' : 'bg-slate-800/60 text-slate-500 border border-slate-700/30'}`}>
              {y}년
            </button>
          ))}
        </div>

        {/* 균등 분산 요약 */}
        <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-xl p-4">
          <div className="text-[10px] text-emerald-400/70 mb-1 text-center">
            {(simBudget / 10000).toLocaleString()}만원 · {simYears}년 · 6종목 분산 · 배당 재투자
          </div>
          <div className="grid grid-cols-3 gap-3 text-center mt-2">
            <div>
              <div className="text-[9px] text-slate-500">월 배당</div>
              <div className="text-sm font-bold text-emerald-400">₩{Math.round(blendedMonthlyDiv * FX_RATE).toLocaleString()}</div>
            </div>
            <div>
              <div className="text-[9px] text-slate-500">{simYears}년 수익</div>
              <div className="text-base font-bold text-emerald-400">₩{Math.round(blendedProfit * FX_RATE).toLocaleString()}</div>
            </div>
            <div>
              <div className="text-[9px] text-slate-500">총수익률</div>
              <div className="text-sm font-bold text-emerald-400">+{blendedReturn.toFixed(1)}%</div>
            </div>
          </div>
        </div>

        {/* ETF별 상세 */}
        <div className="space-y-1">
          {simResults.map(r => (
            <div key={r.code} className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-slate-800/40 transition-colors">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-200">{r.code}</span>
                  <span className="text-[10px] text-slate-500 truncate">{r.name}</span>
                  <span className={`text-[9px] px-1 py-0.5 rounded ${r.risk === '낮음' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}`}>{r.risk}</span>
                </div>
                <div className="text-[10px] text-slate-600">
                  배당 {r.yield}% + 시세 {r.growth}% = <span className="text-slate-400 font-medium">{r.totalReturnPct}%</span>
                  {' · '}{r.freq} · {r.shares}주
                </div>
              </div>
              <div className="text-right ml-3">
                <div className="text-xs font-bold text-emerald-400">
                  +₩{Math.round(r.totalProfit * FX_RATE).toLocaleString()}
                </div>
                <div className="text-[10px] text-slate-500">
                  {simYears}년 · {r.effectiveReturn.toFixed(0)}%
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="text-[9px] text-slate-600 text-center space-y-0.5">
          <div>* 배당소득세 15.4% 차감 · 환율 ₩{FX_RATE.toLocaleString()} · 배당 재투자(DRIP) 복리 적용</div>
          <div>* 과거 실적 기반 추정이며 미래 수익을 보장하지 않습니다</div>
        </div>
      </div>
    </div>
  );
}
