'use client';

import React, { useState } from 'react';
import { Panel, EmptyMsg } from '@/components/ui';
import { api, fmtPct, pc, pbg } from '../../lib/utils';
import { toDisplayName } from '../../lib/helpers';
import { US_SECTOR_MAP, US_SECTORS } from '../../panels/OverseasScorePanel';
import type { UsWatchlistItem } from '../../types';

export function USWatchlistPanel({ usW }: { usW: UsWatchlistItem[] }) {
  const [usScores, setUsScores] = useState<UsWatchlistItem[]>([]);
  const [scoresLoading, setScoresLoading] = useState(false);

  React.useEffect(() => {
    const hasScores = usW.some((s) => typeof s.score === 'number');
    if (hasScores) { setUsScores(usW); return; }
    setScoresLoading(true);
    api('/overseas/scores').then((data: UsWatchlistItem[]) => {
      if (Array.isArray(data) && data.length > 0) {
        const scoreMap = new Map(data.map((s) => [s.code, s]));
        const merged = (usW.length > 0 ? usW : data).map((s) => {
          const sc = scoreMap.get(s.code);
          return sc ? { ...s, score: sc.score, signal: sc.signal, rsi: sc.rsi } : s;
        });
        setUsScores(merged.length > 0 ? merged : data);
      } else if (usW.length > 0) {
        setUsScores(usW);
      }
    }).catch(() => { if (usW.length > 0) setUsScores(usW); })
    .finally(() => setScoresLoading(false));
  }, [usW]);

  const [usSector, setUsSector] = useState('전체');
  const allDisplayList = usScores.length > 0 ? usScores : usW;
  const displayList = usSector === '전체' ? allDisplayList : allDisplayList.filter((s) => US_SECTOR_MAP[s.code] === usSector);

  return (
    <Panel title="미국주식 감시" badge={scoresLoading ? '계산 중...' : `${displayList.length}/${allDisplayList.length}종목`}>
      <div className="px-3 pt-3 pb-1 flex gap-1 flex-wrap">
        {US_SECTORS.map(s => (
          <button key={s} onClick={() => setUsSector(s)}
            className={`text-[10px] px-2 py-1 rounded-lg transition-all ${usSector === s ? 'bg-blue-600 text-white' : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]'}`}>
            {s}
          </button>
        ))}
      </div>
      {scoresLoading && allDisplayList.length === 0 && (
        <div className="flex items-center gap-2 px-4 py-3 text-[11px] text-slate-500">
          <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          기술지표 자동 계산 중 (AI 없이 차트 분석)...
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3">
        {displayList.map((s) => {
          const code = s.code;
          const name = s.name ?? code;
          const usDisplayName = toDisplayName(name, code);
          const score = typeof s.score === 'number' ? s.score : null;
          const signal = s.signal ?? '';
          const rsi = typeof s.rsi === 'number' ? s.rsi : null;
          const sectorTag = US_SECTOR_MAP[code] ?? '';
          const signalColor = signal === 'STRONG_BUY' ? 'text-emerald-300' : signal === 'BUY' ? 'text-emerald-400' : signal === 'SELL' || signal === 'STRONG_SELL' ? 'text-rose-400' : 'text-slate-500';
          const scoreBg = score !== null ? (score >= 40 ? 'bg-emerald-500/10 border-emerald-500/20' : score <= -20 ? 'bg-rose-500/10 border-rose-500/20' : 'bg-white/[0.03] border-slate-700/30') : `${pbg(s.changePct)} border-slate-700/30`;
          return (
            <div key={code} className={`rounded-lg border p-3 ${scoreBg}`}>
              <div className="flex items-center justify-between gap-1 mb-0.5">
                <span className="font-bold text-sm truncate">{usDisplayName}</span>
                <span className={`text-[10px] font-medium shrink-0 ${pc(s.changePct)}`}>{fmtPct(s.changePct)}</span>
              </div>
              {sectorTag && <div className="text-[9px] text-slate-600 mb-1">{sectorTag}</div>}
              <div className="text-base font-bold">{(s.price ?? 0) > 0 ? `$${s.price!.toFixed(2)}` : '-'}</div>
              {score !== null && (
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${signalColor} bg-white/[0.04]`}>
                    {signal === 'STRONG_BUY' ? '강매수' : signal === 'BUY' ? '매수' : signal === 'HOLD' ? '관망' : signal === 'SELL' ? '매도' : signal === 'STRONG_SELL' ? '강매도' : signal}
                  </span>
                  <span className={`text-[9px] font-semibold ${score >= 40 ? 'text-emerald-400' : score <= -20 ? 'text-rose-400' : 'text-slate-400'}`}>{score >= 0 ? '+' : ''}{Math.round(score)}점</span>
                  {rsi !== null && <span className="text-[9px] text-slate-600">RSI {Math.round(rsi)}</span>}
                </div>
              )}
            </div>
          );
        })}
        {displayList.length === 0 && !scoresLoading && <div className="col-span-3"><EmptyMsg>데이터 없음</EmptyMsg></div>}
      </div>
    </Panel>
  );
}
