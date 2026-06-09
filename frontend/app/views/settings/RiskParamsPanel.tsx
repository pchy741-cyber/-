'use client';

import React from 'react';
import { Panel } from '@/components/ui';
import { api } from '../../lib/utils';
import type { ToastFn } from '../../types';

interface RiskCfg {
  kr_pct: number;
  us_pct: number;
  position_cap_pct: number;
  max_invested_pct: number;
  cash_reserve_pct: number;
  max_positions: number;
  max_daily_trades: number;
  [key: string]: unknown;
}

const LIVE_DEF: RiskCfg  = { kr_pct: 30, us_pct: 70, position_cap_pct: 25, max_invested_pct: 88, cash_reserve_pct: 20, max_positions: 8,  max_daily_trades: 3  };
const PAPER_DEF: RiskCfg = { kr_pct: 70, us_pct: 30, position_cap_pct: 40, max_invested_pct: 97, cash_reserve_pct: 3,  max_positions: 20, max_daily_trades: 20 };

export function RiskParamsPanel({ toast }: { toast?: ToastFn }) {
  const [live, setLive]   = React.useState<RiskCfg>(LIVE_DEF);
  const [paper, setPaper] = React.useState<RiskCfg>(PAPER_DEF);
  const [saving, setSaving] = React.useState<'live' | 'paper' | null>(null);

  React.useEffect(() => {
    api('/portfolio/allocation/both').then((d: any) => {
      if (d?.live)  setLive(d.live);
      if (d?.paper) setPaper(d.paper);
    }).catch(() => {});
  }, []);

  const upd = (mode: 'live' | 'paper', field: string, val: number) => {
    if (mode === 'live')  setLive(prev => ({ ...prev, [field]: val }));
    else                  setPaper(prev => ({ ...prev, [field]: val }));
  };

  const save = async (mode: 'live' | 'paper') => {
    setSaving(mode);
    const cfg = mode === 'live' ? live : paper;
    try {
      const updated = await api('/portfolio/allocation', {
        method: 'PUT',
        body: JSON.stringify({ ...cfg, isPaper: mode === 'paper' }),
      });
      if (mode === 'live')  setLive(updated);
      else                  setPaper(updated);
      toast?.(`${mode === 'paper' ? '연습' : '실전'} 모드 저장됨`, 'ok');
    } catch { toast?.('저장 실패', 'err'); }
    setSaving(null);
  };

  return (
    <Panel title="포트폴리오 리스크 파라미터">
      <div className="px-5 py-4 space-y-3">
        <p className="text-[11px] text-slate-500">실전과 연습 모드의 리스크 한도를 독립적으로 설정합니다. 저장 즉시 AI 매매에 반영됩니다.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ModeCard mode="live"  cfg={live}  upd={upd} saving={saving} save={save} />
          <ModeCard mode="paper" cfg={paper} upd={upd} saving={saving} save={save} />
        </div>
      </div>
    </Panel>
  );
}

function ModeCard({ mode, cfg, upd, saving, save }: {
  mode: 'live' | 'paper';
  cfg: RiskCfg;
  upd: (mode: 'live' | 'paper', field: string, val: number) => void;
  saving: 'live' | 'paper' | null;
  save: (mode: 'live' | 'paper') => void;
}) {
  const isLive = mode === 'live';
  const accent = isLive ? 'text-rose-400' : 'text-yellow-400';
  const btnCls = isLive
    ? 'bg-rose-700/60 hover:bg-rose-600/60 disabled:opacity-40'
    : 'bg-yellow-700/60 hover:bg-yellow-600/60 disabled:opacity-40';

  return (
    <div className="space-y-2.5 bg-white/[0.02] rounded-xl p-4 border border-white/[0.06]">
      <p className={`text-xs font-bold ${accent}`}>{isLive ? '🔴 실전 모드' : '🟡 연습 모드'}</p>

      <NumRow label="종목당 최대 비중" value={cfg.position_cap_pct} suffix="%" min={5} max={60} step={5}
        onChange={v => upd(mode, 'position_cap_pct', v)} />
      <NumRow label="최대 투자 비중" value={cfg.max_invested_pct} suffix="%" min={50} max={100} step={1}
        onChange={v => upd(mode, 'max_invested_pct', v)} />
      <NumRow label="최소 현금 보유" value={cfg.cash_reserve_pct} suffix="%" min={0} max={50} step={1}
        onChange={v => upd(mode, 'cash_reserve_pct', v)} />
      <NumRow label="동시 보유 종목" value={cfg.max_positions} suffix="종목" min={1} max={30} step={1}
        onChange={v => upd(mode, 'max_positions', v)} />
      <NumRow label="일일 최대 매매" value={cfg.max_daily_trades} suffix="회" min={1} max={50} step={1}
        onChange={v => upd(mode, 'max_daily_trades', v)} />

      <button onClick={() => save(mode)} disabled={saving === mode}
        className={`w-full py-2 rounded-lg text-xs font-semibold transition-all mt-1 ${btnCls}`}>
        {saving === mode ? '저장 중...' : '저장'}
      </button>
    </div>
  );
}

function NumRow({ label, value, suffix, min, max, step, onChange }: {
  label: string; value: number; suffix: string;
  min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-slate-400 flex-1">{label}</span>
      <div className="flex items-center gap-1">
        <input type="number" min={min} max={max} step={step} value={value}
          onChange={e => onChange(Math.max(min, Math.min(max, Number(e.target.value))))}
          className="w-16 bg-white/[0.05] ring-1 ring-white/[0.08] rounded-lg px-2 py-1 text-xs text-white text-center focus:outline-none focus:ring-blue-500/50" />
        <span className="text-[10px] text-slate-500 w-8">{suffix}</span>
      </div>
    </div>
  );
}
