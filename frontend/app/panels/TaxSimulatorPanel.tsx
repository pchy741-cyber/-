'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/utils';

interface TaxSimulatorPanelProps {
  viewMode: 'paper' | 'live';
  toast: (msg: string, type?: 'ok' | 'err' | 'info') => void;
}

const INV_PRESETS = [
  { krw: 100_000_000, label: '1억' },
  { krw: 300_000_000, label: '3억' },
  { krw: 500_000_000, label: '5억' },
  { krw: 1_000_000_000, label: '10억' },
];

const EARNED_PRESETS = [
  { krw: 0, label: '없음' },
  { krw: 30_000_000, label: '3천만' },
  { krw: 50_000_000, label: '5천만' },
  { krw: 70_000_000, label: '7천만' },
];

const OTHER_FIN_PRESETS = [
  { krw: 0, label: '없음' },
  { krw: 10_000_000, label: '1천만' },
  { krw: 20_000_000, label: '2천만' },
];

const fmtKrw = (n: number) => '₩' + Math.round(n).toLocaleString('ko-KR');
const fmtManWon = (n: number) => {
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + '억';
  if (n >= 10_000) return Math.round(n / 10_000).toLocaleString() + '만';
  return Math.round(n).toLocaleString();
};

export default function TaxSimulatorPanel({ viewMode, toast }: TaxSimulatorPanelProps) {
  const [investment, setInvestment] = useState(1_000_000_000);
  const [customInv, setCustomInv] = useState('');
  const [earned, setEarned] = useState(0);
  const [otherFin, setOtherFin] = useState(0);
  const [insurance, setInsurance] = useState<'local' | 'employee'>('local');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api(
        `/dividend/tax-simulator?investment=${investment}&earned=${earned}&otherFinancial=${otherFin}&insurance=${insurance}&viewMode=${viewMode}`
      );
      setData(res);
    } catch (e: any) {
      toast(e.message || '세금 계산 실패', 'err');
    }
    setLoading(false);
  }, [investment, earned, otherFin, insurance, viewMode, toast]);

  useEffect(() => { load(); }, [load]);

  const t20 = data?.threshold20M;
  const gaugePct = t20 ? Math.min(100, (t20.currentFinancialIncome / 20_000_000) * 100) : 0;

  return (
    <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/40">
      <div className="px-5 py-3.5 border-b border-white/[0.04] flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-200">배당 세후 실수령 계산기</h2>
        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-blue-500/15 text-blue-400">종합과세</span>
      </div>
      <div className="p-5 space-y-4">
        {/* 투자금 프리셋 */}
        <div>
          <div className="text-[10px] text-slate-500 mb-1.5">투자금</div>
          <div className="grid grid-cols-4 gap-1.5">
            {INV_PRESETS.map(p => (
              <button key={p.krw} onClick={() => { setInvestment(p.krw); setCustomInv(''); }}
                className={`py-2 text-[11px] font-bold rounded-lg transition-all ring-1 ${
                  investment === p.krw && !customInv
                    ? 'bg-blue-500/15 text-blue-400 ring-blue-500/30'
                    : 'bg-white/[0.04] text-slate-400 ring-white/[0.06] hover:ring-white/[0.12]'
                }`}>{p.label}</button>
            ))}
          </div>
          <input
            type="number" placeholder="직접 입력 (원)" value={customInv}
            onChange={e => { setCustomInv(e.target.value); if (e.target.value) setInvestment(Number(e.target.value)); }}
            className="mt-1.5 w-full bg-white/[0.04] ring-1 ring-white/[0.06] rounded-lg px-3 py-2 text-[11px] text-slate-300 placeholder:text-slate-600 focus:outline-none focus:ring-blue-500/40"
          />
        </div>

        {/* 근로소득 */}
        <div>
          <div className="text-[10px] text-slate-500 mb-1.5">근로소득 (연)</div>
          <div className="flex gap-1.5">
            {EARNED_PRESETS.map(p => (
              <button key={p.krw} onClick={() => setEarned(p.krw)}
                className={`flex-1 py-1.5 text-[10px] font-bold rounded-lg transition-all ring-1 ${
                  earned === p.krw ? 'bg-blue-500/15 text-blue-400 ring-blue-500/30' : 'bg-white/[0.04] text-slate-400 ring-white/[0.06]'
                }`}>{p.label}</button>
            ))}
          </div>
        </div>

        {/* 기타 금융소득 */}
        <div>
          <div className="text-[10px] text-slate-500 mb-1.5">기타 금융소득</div>
          <div className="flex gap-1.5">
            {OTHER_FIN_PRESETS.map(p => (
              <button key={p.krw} onClick={() => setOtherFin(p.krw)}
                className={`flex-1 py-1.5 text-[10px] font-bold rounded-lg transition-all ring-1 ${
                  otherFin === p.krw ? 'bg-blue-500/15 text-blue-400 ring-blue-500/30' : 'bg-white/[0.04] text-slate-400 ring-white/[0.06]'
                }`}>{p.label}</button>
            ))}
          </div>
        </div>

        {/* 건보 토글 */}
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-slate-500">건강보험</span>
          <div className="flex gap-1">
            {(['local', 'employee'] as const).map(type => (
              <button key={type} onClick={() => setInsurance(type)}
                className={`px-3 py-1 text-[10px] font-bold rounded-lg ring-1 transition-all ${
                  insurance === type ? 'bg-blue-500/15 text-blue-400 ring-blue-500/30' : 'bg-white/[0.04] text-slate-400 ring-white/[0.06]'
                }`}>{type === 'local' ? '지역' : '직장'}</button>
            ))}
          </div>
        </div>

        {/* 결과 */}
        {loading ? (
          <div className="text-center text-slate-500 text-[11px] py-4">계산 중...</div>
        ) : data ? (
          <div className="space-y-3">
            {/* 대형 숫자: 세후 월 실수령 */}
            <div className="bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl p-4 text-center">
              <div className="text-[10px] text-slate-500 mb-1">세후 월 실수령</div>
              <div className="text-2xl font-black text-emerald-400 tabular-nums">
                {fmtKrw(data.netMonthlyDiv)}
              </div>
              <div className="text-[10px] text-slate-500 mt-1">
                연 {fmtKrw(data.netAnnualDiv)} (총배당 {fmtKrw(data.grossAnnualDiv)})
              </div>
            </div>

            {/* 실효세율 바 */}
            <div>
              <div className="flex justify-between text-[10px] mb-1">
                <span className="text-slate-500">실효세율</span>
                <span className={`font-bold ${data.effectiveTaxRate > 30 ? 'text-rose-400' : data.effectiveTaxRate > 20 ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {data.effectiveTaxRate}%
                </span>
              </div>
              <div className="w-full h-2 bg-white/[0.06] rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    data.effectiveTaxRate > 30 ? 'bg-rose-500' : data.effectiveTaxRate > 20 ? 'bg-amber-500' : 'bg-emerald-500'
                  }`}
                  style={{ width: `${Math.min(100, data.effectiveTaxRate * 2)}%` }}
                />
              </div>
              <div className="flex justify-between text-[9px] text-slate-600 mt-0.5">
                <span>원천징수 {fmtKrw(data.withholdingTax)}</span>
                {data.comprehensiveTax > 0 && <span className="text-rose-400">+종합과세 {fmtKrw(data.comprehensiveTax)}</span>}
                {data.healthInsuranceDelta > 0 && <span className="text-amber-400">+건보 {fmtKrw(data.healthInsuranceDelta)}</span>}
              </div>
            </div>

            {/* 2천만원 임계점 게이지 */}
            {t20 && (
              <div className="bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl p-3">
                <div className="flex justify-between text-[10px] mb-1.5">
                  <span className="text-slate-400">금융소득 2천만원 기준</span>
                  {t20.isOver ? (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-500/15 text-rose-400">초과</span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/15 text-emerald-400">안전</span>
                  )}
                </div>
                <div className="w-full h-2.5 bg-white/[0.06] rounded-full overflow-hidden relative">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${t20.isOver ? 'bg-rose-500' : 'bg-emerald-500'}`}
                    style={{ width: `${Math.min(100, gaugePct)}%` }}
                  />
                  {/* 2천만 마커 */}
                  <div className="absolute top-0 bottom-0 w-px bg-white/30" style={{ left: '100%' }} />
                </div>
                <div className="flex justify-between text-[9px] text-slate-600 mt-1">
                  <span>현재 {fmtManWon(t20.currentFinancialIncome)}원</span>
                  {!t20.isOver && <span>여유 {fmtManWon(t20.headroom)}원</span>}
                </div>
                <div className="text-[9px] text-slate-500 mt-1">
                  종합과세 안전 투자한도: <span className="text-blue-400 font-bold">{fmtManWon(t20.maxSafeInvestment)}원</span>
                </div>
              </div>
            )}

            {/* 투자금별 비교 테이블 */}
            {data.breakdown && (
              <div>
                <div className="text-[10px] text-slate-500 mb-1.5">투자금별 비교</div>
                <div className="space-y-0.5">
                  <div className="grid grid-cols-4 text-[9px] text-slate-600 px-2 pb-1">
                    <span>투자금</span><span className="text-right">총배당</span><span className="text-right">세후</span><span className="text-right">세율</span>
                  </div>
                  {data.breakdown.map((b: any) => (
                    <div key={b.investmentKrw} className={`grid grid-cols-4 text-[10px] px-2 py-1.5 rounded-lg ${
                      b.investmentKrw === investment ? 'bg-blue-500/10 ring-1 ring-blue-500/20' : 'hover:bg-white/[0.02]'
                    }`}>
                      <span className="text-slate-300 font-medium">{fmtManWon(b.investmentKrw)}</span>
                      <span className="text-right text-slate-400 tabular-nums">{fmtManWon(b.grossDiv)}</span>
                      <span className="text-right text-emerald-400 font-bold tabular-nums">{fmtManWon(b.netDiv)}</span>
                      <span className={`text-right font-bold tabular-nums ${b.effectiveRate > 30 ? 'text-rose-400' : b.effectiveRate > 20 ? 'text-amber-400' : 'text-emerald-400'}`}>
                        {b.effectiveRate}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
