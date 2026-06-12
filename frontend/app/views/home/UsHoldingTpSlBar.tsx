'use client';

import React from 'react';
import { Button } from '@/components/ui';
import { BarOverlay } from '@/components/BarSegment';

// 절대위치 마커 (1px 또는 3px 폭) — TP/SL bar 안에서 위치 표시
function BarMarker({
  posPct,
  className,
  title,
}: {
  posPct: number;
  className: string;
  title?: string;
}) {
  return (
    <div
      className={`absolute top-0 h-full ${className}`}
      style={{ '--marker-pos': `${posPct}%`, left: 'var(--marker-pos)' } as React.CSSProperties}
      title={title}
    />
  );
}

interface TpSlBarProps {
  stockCode: string;
  pnlPct: number;
  effectiveTp: number | null;
  effectiveSl: number | null;
  avgPrice: number;
  editingTpSl: string | null;
  editTp: string;
  editSl: string;
  setEditingTpSl: (v: string | null) => void;
  setEditTp: (v: string) => void;
  setEditSl: (v: string) => void;
  saveTpSl: (code: string) => void;
  trailPct: number;
  trailActive: boolean;
  trailStopPct: number;
  maxPnlPct: number;
  partialStage: number;
  nextPartialTpPct: number | null;
}

export function UsHoldingTpSlBar({
  stockCode, pnlPct, effectiveTp, effectiveSl, avgPrice,
  editingTpSl, editTp, editSl, setEditingTpSl, setEditTp, setEditSl, saveTpSl,
  trailPct, trailActive, trailStopPct, maxPnlPct, partialStage, nextPartialTpPct,
}: TpSlBarProps) {
  if (effectiveTp == null || effectiveSl == null) return null;

  const range = effectiveTp - effectiveSl;
  const progress = range > 0 ? Math.max(0, Math.min(100, ((pnlPct - effectiveSl) / range) * 100)) : 50;
  const targetPrice = avgPrice * (1 + effectiveTp / 100);
  const stopPrice = avgPrice * (1 + effectiveSl / 100);

  return (
    <div className="space-y-1">
      {editingTpSl === stockCode ? (
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="text-rose-400 text-[9px]">SL</span>
          <input type="number" step="0.5" value={editSl} onChange={e => setEditSl(e.target.value)}
            className="w-14 px-1 py-0.5 bg-white/[0.05] ring-1 ring-rose-500/20 rounded-lg text-[10px] text-rose-400 text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-rose-500/40 transition-all" />
          <div className="flex-1" />
          <span className="text-emerald-400 text-[9px]">TP</span>
          <input type="number" step="0.5" value={editTp} onChange={e => setEditTp(e.target.value)}
            className="w-14 px-1 py-0.5 bg-white/[0.05] ring-1 ring-emerald-500/20 rounded-lg text-[10px] text-emerald-400 text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-all" />
          <Button variant="primary" size="sm" className="text-[9px] px-1.5 py-0.5 bg-blue-600/60" onClick={() => saveTpSl(stockCode)}>저장</Button>
          <Button variant="ghost" size="sm" className="text-[9px] px-1 py-0.5 text-slate-500" onClick={() => setEditingTpSl(null)}>취소</Button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="text-rose-400 font-medium tabular-nums text-right cursor-pointer hover:underline"
            onClick={() => { setEditingTpSl(stockCode); setEditSl(String(effectiveSl.toFixed(1))); setEditTp(String(effectiveTp.toFixed(1))); }}
            title="클릭하여 SL 조절">{effectiveSl.toFixed(1)}%<span className="text-slate-600 ml-0.5">${stopPrice.toFixed(0)}</span></span>
          <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden relative">
            <div className="absolute inset-0">
              <div className="h-full w-full bg-gradient-to-r from-rose-500/40 to-slate-600/20" />
            </div>
            <BarOverlay
              progressPct={progress}
              className={`rounded-full ${pnlPct >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`}
              transition="transition-all"
            />
            {nextPartialTpPct != null && nextPartialTpPct !== effectiveTp && range > 0 && (
              <BarMarker
                posPct={Math.max(0, Math.min(100, ((nextPartialTpPct - effectiveSl) / range) * 100))}
                className="w-px bg-cyan-400/50"
                title={`부분익절 +${nextPartialTpPct}%`}
              />
            )}
            {range > 0 && !trailActive && (
              <BarMarker
                posPct={Math.max(0, Math.min(100, ((trailPct - effectiveSl) / range) * 100))}
                className="w-px bg-yellow-500/40"
                title={`트레일 활성: +${trailPct}%`}
              />
            )}
            {trailActive && range > 0 && (
              <BarMarker
                posPct={Math.max(0, Math.min(100, ((trailStopPct - effectiveSl) / range) * 100))}
                className="w-[3px] bg-yellow-400/80 rounded-full"
                title={`트레일 스톱: ${trailStopPct >= 0 ? '+' : ''}${trailStopPct.toFixed(1)}%`}
              />
            )}
          </div>
          <span className="text-emerald-400 font-medium tabular-nums cursor-pointer hover:underline"
            onClick={() => { setEditingTpSl(stockCode); setEditSl(String(effectiveSl.toFixed(1))); setEditTp(String(effectiveTp.toFixed(1))); }}
            title="클릭하여 TP 조절">+{effectiveTp.toFixed(1)}%<span className="text-slate-600 ml-0.5">${targetPrice.toFixed(0)}</span></span>
        </div>
      )}
      {(trailActive || partialStage > 0 || nextPartialTpPct != null) && (
        <div className="text-[10px] text-slate-600 px-1 text-center">
          {trailActive
            ? <span className="text-yellow-500">트레일 활성 · 스톱 ${(avgPrice * (1 + trailStopPct / 100)).toFixed(2)} · 고점+{maxPnlPct.toFixed(1)}%</span>
            : partialStage > 0
              ? <span className="text-cyan-500">{partialStage}단계 부분익절 완료</span>
              : <span className="text-slate-500">1차 익절 +{nextPartialTpPct}% · 트레일 +{trailPct}%</span>
          }
        </div>
      )}
    </div>
  );
}
