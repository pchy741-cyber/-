'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/utils';

interface ProjectionPanelProps {
  viewMode: 'paper' | 'live';
  toast: (msg: string, type?: 'ok' | 'err' | 'info') => void;
}

const YEAR_PRESETS = [5, 10, 20, 30];
const MONTHLY_PRESETS = [
  { krw: 0, label: '없음' },
  { krw: 500_000, label: '50만' },
  { krw: 1_000_000, label: '100만' },
  { krw: 2_000_000, label: '200만' },
];

const fmtKrw = (n: number) => '₩' + Math.round(n).toLocaleString('ko-KR');
const fmtManWon = (n: number) => {
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + '억';
  if (n >= 10_000_000) return (n / 10_000_000).toFixed(0) + '천만';
  if (n >= 10_000) return Math.round(n / 10_000).toLocaleString() + '만';
  return Math.round(n).toLocaleString();
};

export default function ProjectionPanel({ viewMode, toast }: ProjectionPanelProps) {
  const [years, setYears] = useState(10);
  const [monthly, setMonthly] = useState(1_000_000);
  const [growth, setGrowth] = useState(5);
  const [reinvest, setReinvest] = useState(true);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showTable, setShowTable] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api(
        `/dividend/projection?years=${years}&monthly=${monthly}&growth=${growth}&reinvest=${reinvest}&viewMode=${viewMode}`
      );
      setData(res);
    } catch (e: any) {
      toast(e.message || '프로젝션 실패', 'err');
    }
    setLoading(false);
  }, [years, monthly, growth, reinvest, viewMode, toast]);

  useEffect(() => { load(); }, [load]);

  const yearData = data?.years || [];
  const summary = data?.summary;

  // SVG 영역 차트 계산
  const chartW = 320;
  const chartH = 140;
  const padL = 0;
  const padB = 20;
  const drawW = chartW - padL;
  const drawH = chartH - padB;

  const maxVal = Math.max(...yearData.map((y: any) => y.portfolioValue), 1);
  const points = yearData.map((y: any, i: number) => ({
    x: padL + (i / Math.max(yearData.length - 1, 1)) * drawW,
    yNominal: drawH - (y.portfolioValue / maxVal) * drawH,
    yReal: drawH - (y.realValue / maxVal) * drawH,
    yContrib: drawH - (y.cumulativeContributions / maxVal) * drawH,
  }));

  const nominalPath = points.map((p: any, i: number) => `${i === 0 ? 'M' : 'L'}${p.x},${p.yNominal}`).join(' ');
  const nominalArea = nominalPath + ` L${points[points.length - 1]?.x ?? drawW},${drawH} L${padL},${drawH} Z`;
  const realPath = points.map((p: any, i: number) => `${i === 0 ? 'M' : 'L'}${p.x},${p.yReal}`).join(' ');
  const contribPath = points.map((p: any, i: number) => `${i === 0 ? 'M' : 'L'}${p.x},${p.yContrib}`).join(' ');

  return (
    <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/40">
      <div className="px-5 py-3.5 border-b border-white/[0.04] flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-200">장기 배당 프로젝션</h2>
        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-cyan-500/15 text-cyan-400">복리</span>
      </div>
      <div className="p-5 space-y-4">
        {/* 투자 기간 */}
        <div>
          <div className="text-[10px] text-slate-500 mb-1.5">투자 기간</div>
          <div className="flex gap-1.5">
            {YEAR_PRESETS.map(y => (
              <button key={y} onClick={() => setYears(y)}
                className={`flex-1 py-1.5 text-[10px] font-bold rounded-lg ring-1 transition-all ${
                  years === y ? 'bg-cyan-500/15 text-cyan-400 ring-cyan-500/30' : 'bg-white/[0.04] text-slate-400 ring-white/[0.06]'
                }`}>{y}년</button>
            ))}
          </div>
        </div>

        {/* 월 적립금 */}
        <div>
          <div className="text-[10px] text-slate-500 mb-1.5">월 적립금</div>
          <div className="grid grid-cols-4 gap-1.5">
            {MONTHLY_PRESETS.map(p => (
              <button key={p.krw} onClick={() => setMonthly(p.krw)}
                className={`py-1.5 text-[10px] font-bold rounded-lg ring-1 transition-all ${
                  monthly === p.krw ? 'bg-cyan-500/15 text-cyan-400 ring-cyan-500/30' : 'bg-white/[0.04] text-slate-400 ring-white/[0.06]'
                }`}>{p.label}</button>
            ))}
          </div>
        </div>

        {/* 성장률 슬라이더 */}
        <div>
          <div className="flex justify-between text-[10px] mb-1">
            <span className="text-slate-500">예상 성장률</span>
            <span className="text-cyan-400 font-bold">{growth}%</span>
          </div>
          <input type="range" min="0" max="15" step="1" value={growth}
            onChange={e => setGrowth(Number(e.target.value))}
            className="w-full h-1.5 bg-white/[0.06] rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400"
          />
        </div>

        {/* 배당 재투자 토글 */}
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-slate-500">배당 재투자</span>
          <button onClick={() => setReinvest(!reinvest)}
            className={`px-3 py-1 text-[10px] font-bold rounded-lg ring-1 transition-all ${
              reinvest ? 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/30' : 'bg-white/[0.04] text-slate-400 ring-white/[0.06]'
            }`}>{reinvest ? 'ON' : 'OFF'}</button>
        </div>

        {loading ? (
          <div className="text-center text-slate-500 text-[11px] py-4">계산 중...</div>
        ) : data ? (
          <div className="space-y-3">
            {/* SVG 영역 차트 */}
            {yearData.length > 1 && (
              <div className="bg-white/[0.02] rounded-xl p-3 overflow-hidden">
                <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full" preserveAspectRatio="xMidYMid meet">
                  {/* 명목 가치 영역 */}
                  <path d={nominalArea} fill="rgba(59,130,246,0.12)" />
                  <path d={nominalPath} fill="none" stroke="rgba(59,130,246,0.7)" strokeWidth="2" />
                  {/* 실질 가치 라인 */}
                  <path d={realPath} fill="none" stroke="rgba(148,163,184,0.4)" strokeWidth="1.5" strokeDasharray="4,3" />
                  {/* 투입금 라인 */}
                  <path d={contribPath} fill="none" stroke="rgba(251,191,36,0.3)" strokeWidth="1" strokeDasharray="2,2" />
                  {/* X축 라벨 */}
                  {yearData.filter((_: any, i: number) => i === 0 || i === yearData.length - 1 || (yearData.length > 5 && i === Math.floor(yearData.length / 2))).map((y: any, _: number) => {
                    const idx = yearData.indexOf(y);
                    const px = padL + (idx / Math.max(yearData.length - 1, 1)) * drawW;
                    return (
                      <text key={y.year} x={px} y={chartH - 4} textAnchor="middle" fill="#64748b" fontSize="8">{y.year}년</text>
                    );
                  })}
                </svg>
                <div className="flex gap-3 mt-1.5 justify-center">
                  <span className="text-[8px] text-blue-400 flex items-center gap-1"><span className="w-3 h-0.5 bg-blue-500 rounded inline-block" /> 명목</span>
                  <span className="text-[8px] text-slate-400 flex items-center gap-1"><span className="w-3 h-0.5 bg-slate-500 rounded inline-block border-dashed" /> 실질</span>
                  <span className="text-[8px] text-amber-400 flex items-center gap-1"><span className="w-3 h-0.5 bg-amber-500 rounded inline-block" /> 투입</span>
                </div>
              </div>
            )}

            {/* 요약 카드 4개 */}
            {summary && (
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl p-3 text-center">
                  <div className="text-[9px] text-slate-500 mb-0.5">최종 가치</div>
                  <div className="text-sm font-black text-blue-400 tabular-nums">{fmtManWon(summary.finalValue)}원</div>
                  <div className="text-[9px] text-slate-600">실질 {fmtManWon(summary.finalRealValue)}원</div>
                </div>
                <div className="bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl p-3 text-center">
                  <div className="text-[9px] text-slate-500 mb-0.5">총 배당 수령</div>
                  <div className="text-sm font-black text-emerald-400 tabular-nums">{fmtManWon(summary.totalDividends)}원</div>
                </div>
                <div className="bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl p-3 text-center">
                  <div className="text-[9px] text-slate-500 mb-0.5">월 배당 수입</div>
                  <div className="text-sm font-black text-cyan-400 tabular-nums">{fmtKrw(summary.monthlyIncomeAtEnd)}</div>
                  <div className="text-[9px] text-slate-600">{years}년 후 기준</div>
                </div>
                <div className="bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl p-3 text-center">
                  <div className="text-[9px] text-slate-500 mb-0.5">CAGR</div>
                  <div className={`text-sm font-black tabular-nums ${summary.cagr >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {summary.cagr}%
                  </div>
                  <div className="text-[9px] text-slate-600">연평균 성장률</div>
                </div>
              </div>
            )}

            {/* 연도별 테이블 (접기/펼치기) */}
            <div>
              <button onClick={() => setShowTable(!showTable)}
                className="w-full text-[10px] text-slate-500 hover:text-slate-300 py-1.5 transition-colors">
                {showTable ? '연도별 상세 접기 ▲' : '연도별 상세 펼치기 ▼'}
              </button>
              {showTable && yearData.length > 0 && (
                <div className="space-y-0.5 mt-1">
                  <div className="grid grid-cols-5 text-[9px] text-slate-600 px-2 pb-1">
                    <span>년차</span><span className="text-right">포트폴리오</span><span className="text-right">세후배당</span><span className="text-right">투입금</span><span className="text-right">수익</span>
                  </div>
                  {yearData.map((y: any) => (
                    <div key={y.year} className="grid grid-cols-5 text-[10px] px-2 py-1 hover:bg-white/[0.02] rounded">
                      <span className="text-slate-400">{y.year}년</span>
                      <span className="text-right text-blue-400 tabular-nums">{fmtManWon(y.portfolioValue)}</span>
                      <span className="text-right text-emerald-400 tabular-nums">{fmtManWon(y.annualDividendAfterTax)}</span>
                      <span className="text-right text-slate-500 tabular-nums">{fmtManWon(y.cumulativeContributions)}</span>
                      <span className={`text-right font-bold tabular-nums ${y.totalReturn >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {y.totalReturn >= 0 ? '+' : ''}{fmtManWon(y.totalReturn)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
