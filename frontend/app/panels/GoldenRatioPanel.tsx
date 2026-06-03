'use client';

import React from 'react';
import { Panel } from '@/components/ui';
import { api } from '../lib/utils';
import type { AllocConfig, ToastFn } from '../types';

interface GoldenRatioPanelProps {
  allocConfig: AllocConfig | null;
  setAllocConfig: (config: AllocConfig) => void;
  toast?: ToastFn;
}

export default function GoldenRatioPanel({ allocConfig, setAllocConfig, toast }: GoldenRatioPanelProps) {
  const cfg = allocConfig ?? { kr_pct: 70, us_pct: 30, sector_semiconductor: 30, sector_bio: 20, sector_defense: 25, sector_finance: 20, sector_etc: 30, trailing_stop_pct: 5 };
  const [kr, setKr] = React.useState<number>(Number(cfg.kr_pct ?? 70));
  const [us, setUs] = React.useState<number>(Number(cfg.us_pct ?? 30));
  const [semi, setSemi] = React.useState<number>(Number(cfg.sector_semiconductor ?? 30));
  const [bio, setBio] = React.useState<number>(Number(cfg.sector_bio ?? 20));
  const [defense, setDefense] = React.useState<number>(Number(cfg.sector_defense ?? 25));
  const [finance, setFinance] = React.useState<number>(Number(cfg.sector_finance ?? 20));
  const [etc, setEtc] = React.useState<number>(Number(cfg.sector_etc ?? 30));
  const [trailStop, setTrailStop] = React.useState<number>(Number(cfg.trailing_stop_pct ?? 5));

  React.useEffect(() => {
    if (allocConfig) {
      setKr(Number(allocConfig.kr_pct ?? 70));
      setUs(Number(allocConfig.us_pct ?? 30));
      setSemi(Number(allocConfig.sector_semiconductor ?? 30));
      setBio(Number(allocConfig.sector_bio ?? 20));
      setDefense(Number(allocConfig.sector_defense ?? 25));
      setFinance(Number(allocConfig.sector_finance ?? 20));
      setEtc(Number(allocConfig.sector_etc ?? 30));
      setTrailStop(Number(allocConfig.trailing_stop_pct ?? 5));
    }
  }, [allocConfig]);

  const krUsValid = Math.abs(kr + us - 100) <= 1;

  const adjustKrUs = (side: 'kr' | 'us', val: number) => {
    const v = Math.max(0, Math.min(100, val));
    if (side === 'kr') { setKr(v); setUs(100 - v); }
    else { setUs(v); setKr(100 - v); }
  };

  const save = async () => {
    if (!krUsValid) { toast?.('국내+미국 합계가 100%여야 합니다', 'err'); return; }
    try {
      const updated: AllocConfig = await api('/portfolio/allocation', { method: 'PUT', body: JSON.stringify({
        kr_pct: kr, us_pct: us,
        sector_semiconductor: semi, sector_bio: bio, sector_defense: defense, sector_finance: finance, sector_etc: etc,
        trailing_stop_pct: trailStop,
      })});
      setAllocConfig(updated);
      toast?.('투자비율 저장됨', 'ok');
    } catch { toast?.('저장 실패', 'err'); }
  };

  const SectorInput = ({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) => (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-slate-400">{label}</span>
      <div className="flex items-center gap-1.5">
        <input type="number" min={5} max={100} step={5} value={value}
          onChange={e => onChange(Math.max(5, Math.min(100, Number(e.target.value))))}
          className="w-16 bg-white/[0.05] ring-1 ring-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-white text-center focus:outline-none focus:ring-blue-500/50" />
        <span className="text-[11px] text-slate-500">%</span>
      </div>
    </div>
  );

  return (
    <Panel title="투자비율 설정">
      <div className="px-6 py-5 space-y-6">

        {/* 국내 vs 미국 */}
        <div className="space-y-3">
          <p className="text-xs font-semibold text-slate-300">국내 / 미국 비율</p>
          <div className="w-full h-3 rounded-full overflow-hidden flex">
            <div className="bg-blue-500 transition-all" style={{ width: `${kr}%` }} />
            <div className="bg-amber-500 transition-all" style={{ width: `${us}%` }} />
          </div>
          <div className="flex justify-between text-[10px] text-slate-400">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-500" />국내 <span className="font-bold text-white">{kr}%</span></span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500" />미국 <span className="font-bold text-white">{us}%</span></span>
          </div>
          <div className="space-y-2">
            {([['국내 주식', kr, (v: number) => adjustKrUs('kr', v), 'blue'], ['미국 주식', us, (v: number) => adjustKrUs('us', v), 'amber']] as [string, number, (v: number) => void, string][]).map(([label, val, setter, color]) => (
              <div key={label} className="space-y-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-400">{label}</span>
                  <span className="font-bold text-white">{val}%</span>
                </div>
                <input type="range" min={0} max={100} step={5} value={val}
                  onChange={e => setter(Number(e.target.value))}
                  className={`w-full h-1.5 rounded-full appearance-none cursor-pointer accent-${color}-500`} />
              </div>
            ))}
          </div>
          {!krUsValid && <p className="text-[11px] text-rose-400">합계 {kr + us}% — 100%가 되어야 합니다</p>}
        </div>

        <div className="border-t border-white/[0.06]" />

        {/* 섹터별 최대 한도 */}
        <div className="space-y-3">
          <div>
            <p className="text-xs font-semibold text-slate-300">섹터별 최대 투자 한도</p>
            <p className="text-[11px] text-slate-500 mt-0.5">포트폴리오 대비 각 섹터 최대 비중. AI가 한도 초과 종목 신규 매수를 막습니다.</p>
          </div>
          <div className="space-y-2.5">
            <SectorInput label="반도체 (SK하이닉스·삼성·한미반도체 등)" value={semi} onChange={setSemi} />
            <SectorInput label="바이오·제약" value={bio} onChange={setBio} />
            <SectorInput label="방산 (한화에어로·현대로템 등)" value={defense} onChange={setDefense} />
            <SectorInput label="금융·은행" value={finance} onChange={setFinance} />
            <SectorInput label="기타 단일 섹터" value={etc} onChange={setEtc} />
          </div>
        </div>

        <div className="border-t border-white/[0.06]" />

        {/* 자동 수익 보호 (트레일링 스탑) */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-300">수익 보호 — 고점에서 얼마나 빠지면 팔까?</p>
          <p className="text-[11px] text-slate-500">수익이 +3% 이상 났을 때만 작동합니다. 최고점에서 이 % 이상 내려오면 자동으로 전량 매도해 수익을 지킵니다.</p>
          <div className="flex items-center gap-3">
            <input type="range" min={2} max={15} step={1} value={trailStop}
              onChange={e => setTrailStop(Number(e.target.value))}
              className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer accent-orange-500" />
            <span className="text-sm font-bold text-orange-400 w-12 text-right">-{trailStop}%</span>
          </div>
          <p className="text-[10px] text-slate-600">예: 100만원까지 올랐다가 {trailStop}% 빠진 {(100 * (1 - trailStop / 100)).toFixed(0)}만원이 되면 {'→'} 자동 매도</p>
        </div>

        <button onClick={save} disabled={!krUsValid}
          className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-xl text-xs font-semibold transition-all">
          저장
        </button>
      </div>
    </Panel>
  );
}
