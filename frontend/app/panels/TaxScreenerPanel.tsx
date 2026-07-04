'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Panel, PresetGroup } from '@/components/ui/layout';
import { api, fmtManWon } from '../lib/utils';

interface TaxScreenerPanelProps {
  viewMode: 'paper' | 'live';
  toast: (msg: string, type?: 'ok' | 'err' | 'info') => void;
}

type SortKey = 'maxSafeInvestment' | 'surfaceYield' | 'effectiveTaxRate' | 'netDivAt1B';

const INSURANCE_OPTS = [
  { value: 'local' as const, label: '지역' },
  { value: 'employee' as const, label: '직장' },
];

export default function TaxScreenerPanel({ viewMode, toast }: TaxScreenerPanelProps) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [otherFin, setOtherFin] = useState(0);
  const [insurance, setInsurance] = useState<'local' | 'employee'>('local');
  const [sortKey, setSortKey] = useState<SortKey>('maxSafeInvestment');
  const [sortAsc, setSortAsc] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api(
        `/dividend/tax-screener?otherFinancial=${otherFin}&insurance=${insurance}&viewMode=${viewMode}`
      );
      setData(Array.isArray(res) ? res : []);
    } catch (e: any) {
      toast(e.message || '스크리너 로딩 실패', 'err');
    }
    setLoading(false);
  }, [otherFin, insurance, viewMode, toast]);

  useEffect(() => { load(); }, [load]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  };

  const sorted = [...data].sort((a, b) => {
    const diff = (a[sortKey] ?? 0) - (b[sortKey] ?? 0);
    return sortAsc ? diff : -diff;
  });

  const SortHeader = ({ k, label }: { k: SortKey; label: string }) => (
    <button onClick={() => handleSort(k)} className={`text-right text-[9px] font-medium transition-colors ${
      sortKey === k ? 'text-blue-400' : 'text-slate-600 hover:text-slate-400'
    }`}>
      {label}{sortKey === k ? (sortAsc ? ' ↑' : ' ↓') : ''}
    </button>
  );

  return (
    <Panel title="ETF 과세 효율 스크리너" badge="Tax" badgeColor="neutral">
      <div className="p-5 space-y-3">
        {/* 필터 */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-slate-500">기타 금융소득</span>
            <input type="number" value={otherFin} onChange={e => setOtherFin(Number(e.target.value) || 0)}
              className="w-24 bg-white/[0.04] ring-1 ring-white/[0.06] rounded-lg px-2 py-1 text-[10px] text-slate-300 focus:outline-none focus:ring-violet-500/40"
            />
          </div>
          <PresetGroup items={INSURANCE_OPTS} selected={insurance} onSelect={setInsurance} accent="violet" />
        </div>

        {loading ? (
          <div className="text-center text-slate-500 text-[11px] py-4">로딩 중...</div>
        ) : (
          <div className="overflow-x-auto">
            <div className="grid grid-cols-[1fr_50px_50px_70px_70px] gap-1 px-2 pb-1 border-b border-white/[0.04]">
              <span className="text-[9px] text-slate-600">ETF</span>
              <SortHeader k="surfaceYield" label="배당률" />
              <SortHeader k="effectiveTaxRate" label="실효세율" />
              <SortHeader k="maxSafeInvestment" label="안전한도" />
              <SortHeader k="netDivAt1B" label="10억 세후" />
            </div>

            {sorted.map((etf: any) => {
              const safeColor = etf.maxSafeInvestment >= 300_000_000 ? 'text-emerald-400'
                : etf.maxSafeInvestment >= 150_000_000 ? 'text-amber-400' : 'text-rose-400';
              return (
                <div key={etf.code} className="grid grid-cols-[1fr_50px_50px_70px_70px] gap-1 px-2 py-2 hover:bg-white/[0.02] rounded-lg items-center">
                  <div>
                    <span className="text-[11px] font-bold text-slate-200">{etf.code}</span>
                    <span className="text-[9px] text-slate-500 ml-1 hidden sm:inline">{etf.name}</span>
                  </div>
                  <span className="text-right text-[10px] text-slate-300 tabular-nums">{etf.surfaceYield}%</span>
                  <span className={`text-right text-[10px] font-bold tabular-nums ${
                    etf.effectiveTaxRate > 30 ? 'text-rose-400' : etf.effectiveTaxRate > 20 ? 'text-amber-400' : 'text-emerald-400'
                  }`}>{etf.effectiveTaxRate}%</span>
                  <span className={`text-right text-[10px] font-bold tabular-nums ${safeColor}`}>{fmtManWon(etf.maxSafeInvestment)}</span>
                  <span className="text-right text-[10px] text-emerald-400 font-bold tabular-nums">{fmtManWon(etf.netDivAt1B)}</span>
                </div>
              );
            })}
          </div>
        )}
        <p className="text-[9px] text-slate-600 text-center">안전한도 = 종합과세 미달 최대 투자액 (2천만원 기준)</p>
      </div>
    </Panel>
  );
}
