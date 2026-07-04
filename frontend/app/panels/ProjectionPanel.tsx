'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Panel, StatCard, PresetGroup } from '@/components/ui/layout';
import { api, fmtManWon, fmtKrwFull } from '../lib/utils';

interface ProjectionPanelProps {
  viewMode: 'paper' | 'live';
  toast: (msg: string, type?: 'ok' | 'err' | 'info') => void;
}

const YEAR_PRESETS = [
  { value: 5, label: '5년' },
  { value: 10, label: '10년' },
  { value: 20, label: '20년' },
  { value: 30, label: '30년' },
];

const MONTHLY_PRESETS = [
  { value: 0, label: '없음' },
  { value: 500_000, label: '50만' },
  { value: 1_000_000, label: '100만' },
  { value: 2_000_000, label: '200만' },
];

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

  // SVG 영역 차트
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
    <Panel title="장기 배당 프로젝션" badge="복리" badgeColor="neutral">
      <div className="p-5 space-y-4">
        <PresetGroup label="투자 기간" items={YEAR_PRESETS} selected={years} onSelect={setYears} accent="cyan" />
        <PresetGroup label="월 적립금" items={MONTHLY_PRESETS} selected={monthly} onSelect={setMonthly} accent="cyan" cols={4} />

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
                  <path d={nominalArea} fill="rgba(59,130,246,0.12)" />
                  <path d={nominalPath} fill="none" stroke="rgba(59,130,246,0.7)" strokeWidth="2" />
                  <path d={realPath} fill="none" stroke="rgba(148,163,184,0.4)" strokeWidth="1.5" strokeDasharray="4,3" />
                  <path d={contribPath} fill="none" stroke="rgba(251,191,36,0.3)" strokeWidth="1" strokeDasharray="2,2" />
                  {yearData.filter((_: any, i: number) => i === 0 || i === yearData.length - 1 || (yearData.length > 5 && i === Math.floor(yearData.length / 2))).map((y: any) => {
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
                <StatCard label="최종 가치" value={`${fmtManWon(summary.finalValue)}원`} sub={`실질 ${fmtManWon(summary.finalRealValue)}원`} color="text-blue-400" />
                <StatCard label="총 배당 수령" value={`${fmtManWon(summary.totalDividends)}원`} color="text-emerald-400" />
                <StatCard label="월 배당 수입" value={fmtKrwFull(summary.monthlyIncomeAtEnd)} sub={`${years}년 후 기준`} color="text-cyan-400" />
                <StatCard label="CAGR" value={`${summary.cagr}%`} sub="연평균 성장률" color={summary.cagr >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
              </div>
            )}

            {/* 연도별 테이블 */}
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
    </Panel>
  );
}
