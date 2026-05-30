'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { api, pc } from '../lib/utils';

interface DividendViewProps {
  toast: (msg: string, type?: 'ok' | 'err' | 'info') => void;
  viewMode: 'paper' | 'live';
}

// 실제 ETF 배당 데이터 (2024~2025 기준)
const DIVIDEND_ETFS = [
  { code: 'JEPI', name: 'JP모건 커버드콜', yield: 7.5, freq: '월배당', price: 57 },
  { code: 'JEPQ', name: '나스닥 커버드콜', yield: 9.5, freq: '월배당', price: 55 },
  { code: 'SCHD', name: '배당성장 우량주', yield: 3.5, freq: '분기배당', price: 82 },
  { code: 'QYLD', name: 'QQQ 커버드콜', yield: 11.0, freq: '월배당', price: 17 },
  { code: 'O', name: '리얼티인컴 리츠', yield: 5.5, freq: '월배당', price: 58 },
  { code: 'XYLD', name: 'S&P500 커버드콜', yield: 10.5, freq: '월배당', price: 40 },
];

const FX_RATE = 1350; // 원/달러 근사값

export default function DividendView({ toast, viewMode }: DividendViewProps) {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<any>(null);
  const [holdings, setHoldings] = useState<any[]>([]);
  const [totalInvested, setTotalInvested] = useState(0);

  // 시뮬레이터
  const [simBudget, setSimBudget] = useState(5000000); // 500만원 기본

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

  // 시뮬레이션 계산
  const budgetUsd = simBudget / FX_RATE;
  const simResults = DIVIDEND_ETFS.map(etf => {
    const shares = Math.floor(budgetUsd / etf.price);
    const invested = shares * etf.price;
    const annualDiv = invested * etf.yield / 100;
    const monthlyDiv = annualDiv / 12;
    const afterTax = monthlyDiv * 0.846; // 15.4% 원천징수
    return { ...etf, shares, invested, annualDiv, monthlyDiv, afterTax };
  });

  // 균등 분산 투자 시
  const perEtfBudget = budgetUsd / DIVIDEND_ETFS.length;
  const blendedMonthly = DIVIDEND_ETFS.reduce((sum, etf) => {
    const shares = Math.floor(perEtfBudget / etf.price);
    return sum + (shares * etf.price * etf.yield / 100 / 12 * 0.846);
  }, 0);

  return (
    <div className="space-y-5">
      {/* 실제 수익 현황 (보유 있을 때) */}
      {(holdings.length > 0 || totalReceived > 0) && (
        <div className="bg-slate-800/40 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-200">내 배당 현황</h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium">
              자동 운영
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-900/40 rounded-xl p-4 text-center">
              <div className="text-[10px] text-slate-500 mb-1">총 투자</div>
              <div className="text-lg font-bold text-slate-100">
                ${totalInvested.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </div>
            </div>
            <div className="bg-slate-900/40 rounded-xl p-4 text-center">
              <div className="text-[10px] text-slate-500 mb-1">배당 수익</div>
              <div className={`text-lg font-bold ${pc(totalReceived)}`}>
                ${totalReceived.toFixed(2)}
              </div>
              <div className="text-[10px] text-slate-600">세금 ${totalTax.toFixed(2)}</div>
            </div>
          </div>
          {holdings.length > 0 && (
            <div className="divide-y divide-white/[0.03]">
              {holdings.map((h: any) => (
                <div key={h.stock_code} className="py-2.5 px-1 flex items-center justify-between">
                  <div>
                    <span className="text-sm font-bold text-slate-200">{h.stock_code}</span>
                    <span className="text-[10px] text-slate-500 ml-2">{h.quantity}주</span>
                  </div>
                  <div className={`text-sm font-bold ${pc(Number(h.total_dividends_received || 0))}`}>
                    ${Number(h.total_dividends_received || 0).toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ──── 시뮬레이터 ──── */}
      <div className="bg-slate-800/40 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-200">배당 시뮬레이터</h2>
          <span className="text-[10px] text-slate-500">세후 기준</span>
        </div>

        {/* 투자금 선택 */}
        <div className="flex gap-2 flex-wrap">
          {[1000000, 3000000, 5000000, 10000000].map(amt => (
            <button key={amt} onClick={() => setSimBudget(amt)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${simBudget === amt ? 'bg-blue-600/30 text-blue-300 border border-blue-500/30' : 'bg-slate-800/60 text-slate-500 border border-slate-700/30'}`}>
              {(amt / 10000).toLocaleString()}만원
            </button>
          ))}
        </div>

        {/* 균등 분산 요약 */}
        <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-xl p-4 text-center">
          <div className="text-[10px] text-emerald-400/70 mb-1">
            {(simBudget / 10000).toLocaleString()}만원 균등 분산 시
          </div>
          <div className="text-xl font-bold text-emerald-400">
            ~₩{Math.round(blendedMonthly * FX_RATE).toLocaleString()} / 월
          </div>
          <div className="text-[10px] text-slate-500 mt-1">
            ~${blendedMonthly.toFixed(2)}/월 · ~${(blendedMonthly * 12).toFixed(0)}/년
          </div>
        </div>

        {/* ETF별 상세 */}
        <div className="space-y-1.5">
          {simResults.map(r => (
            <div key={r.code} className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-slate-800/40 transition-colors">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-200">{r.code}</span>
                  <span className="text-[10px] text-slate-500 truncate">{r.name}</span>
                </div>
                <div className="text-[10px] text-slate-600">
                  ${r.price} × {r.shares}주 = ${r.invested.toFixed(0)} · {r.freq}
                </div>
              </div>
              <div className="text-right ml-3">
                <div className="text-xs font-bold text-emerald-400">
                  ₩{Math.round(r.afterTax * FX_RATE).toLocaleString()}/월
                </div>
                <div className="text-[10px] text-slate-500">{r.yield}%</div>
              </div>
            </div>
          ))}
        </div>

        <div className="text-[9px] text-slate-600 text-center space-y-0.5">
          <div>* 세후 = 배당소득세 15.4% 차감 · 환율 ₩{FX_RATE.toLocaleString()} 기준</div>
          <div>* 실제 배당금은 시장 상황에 따라 변동됩니다</div>
        </div>
      </div>
    </div>
  );
}
