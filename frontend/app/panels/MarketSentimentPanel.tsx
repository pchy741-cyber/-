'use client';

import React, { useState, useEffect } from 'react';
import { api } from '../lib/utils';

interface SentimentData {
  fearGreedScore: number;
  fearGreedLabel: string;
  vix: number;
  greedyStreak: number;
  updatedAt: string;
}

function getScoreColor(score: number): string {
  if (score <= 25) return 'text-rose-400';
  if (score <= 45) return 'text-orange-400';
  if (score <= 55) return 'text-slate-300';
  if (score <= 75) return 'text-emerald-400';
  return 'text-emerald-300';
}

function getBarGradient(score: number): string {
  if (score <= 25) return 'from-rose-600 to-rose-500';
  if (score <= 45) return 'from-orange-600 to-orange-400';
  if (score <= 55) return 'from-slate-500 to-slate-400';
  if (score <= 75) return 'from-emerald-600 to-emerald-500';
  return 'from-emerald-500 to-lime-400';
}

function getVixLevel(vix: number): { label: string; color: string } {
  if (vix < 15) return { label: '안정', color: 'text-emerald-400' };
  if (vix < 20) return { label: '보통', color: 'text-slate-400' };
  if (vix < 25) return { label: '주의', color: 'text-amber-400' };
  if (vix < 35) return { label: '위험', color: 'text-rose-400' };
  return { label: '공황', color: 'text-rose-300 animate-pulse' };
}

function MarketSentimentPanel() {
  const [data, setData] = useState<SentimentData | null>(null);

  useEffect(() => {
    api('/market/sentiment')
      .then((r: SentimentData) => { if (r?.fearGreedScore != null) setData(r); })
      .catch(() => {});
    // 30분마다 갱신
    const id = setInterval(() => {
      api('/market/sentiment')
        .then((r: SentimentData) => { if (r?.fearGreedScore != null) setData(r); })
        .catch(() => {});
    }, 30 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  if (!data) return null;

  const { fearGreedScore, fearGreedLabel, vix, greedyStreak } = data;
  const vixInfo = getVixLevel(vix);
  const scoreColor = getScoreColor(fearGreedScore);
  const barGrad = getBarGradient(fearGreedScore);

  return (
    <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3">
      <div className="flex items-center gap-3">
        {/* Fear & Greed 게이지 */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="flex flex-col items-center shrink-0">
            <span className={`text-lg font-black tabular-nums ${scoreColor}`}>{fearGreedScore}</span>
            <span className="text-[9px] text-slate-500">F&G</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-0.5">
              <span className={`text-[10px] font-semibold ${scoreColor}`}>{fearGreedLabel}</span>
              {greedyStreak >= 3 && (
                <span className="text-[9px] bg-rose-500/20 text-rose-300 border border-rose-500/30 px-1.5 py-0.5 rounded-full font-bold animate-pulse">
                  과열 {greedyStreak}일
                </span>
              )}
            </div>
            {/* 게이지 바 */}
            <div className="relative h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className={`absolute inset-y-0 left-0 rounded-full bg-gradient-to-r ${barGrad} transition-all duration-700 w-[var(--w)]`}
                style={{ '--w': `${fearGreedScore}%` } as React.CSSProperties}
              />
            </div>
            <div className="flex justify-between mt-0.5 text-[8px] text-slate-600">
              <span>극공포</span>
              <span>극탐욕</span>
            </div>
          </div>
        </div>

        {/* VIX */}
        <div className="shrink-0 text-right border-l border-white/[0.06] pl-3">
          <div className="text-[9px] text-slate-500">VIX</div>
          <div className={`text-sm font-bold tabular-nums ${vixInfo.color}`}>{Number(vix ?? 0).toFixed(1)}</div>
          <div className={`text-[9px] font-medium ${vixInfo.color}`}>{vixInfo.label}</div>
        </div>
      </div>
    </div>
  );
}

export default React.memo(MarketSentimentPanel);
