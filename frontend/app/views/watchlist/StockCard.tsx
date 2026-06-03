import React from 'react';
import { toDisplayName } from '../../lib/helpers';
import type { WatchlistItem, StockScore, Chain } from '../../types';

interface StockCardProps {
  stock: WatchlistItem;
  score: StockScore | undefined;
  chain: Chain | undefined;
  sparkline?: number[];
  isSelected: boolean;
  fastAnalyzing?: boolean;
  onClick: () => void;
  onDelete: (code: string) => void;
}

function StockCard({ stock, score, chain, sparkline, isSelected, fastAnalyzing, onClick, onDelete }: StockCardProps) {
  const s = stock;
  const scoreVal = score ? Number(score.composite_score) : -1;
  const displayName = toDisplayName(s.stock_name, s.stock_code);
  const sellPct: number | undefined = s.last_sell_pct != null ? Number(s.last_sell_pct) : undefined;
  const lastSellPrice: number | undefined = s.last_sell_price != null ? Number(s.last_sell_price) : undefined;
  const curScorePrice = score?.currentPrice;
  const postSellPct: number | undefined = (lastSellPrice && curScorePrice && lastSellPrice > 0)
    ? ((curScorePrice - lastSellPrice) / lastSellPrice) * 100
    : undefined;

  let statusColor = 'text-slate-500';
  let statusLabel = '대기';
  let borderClass = 'border-white/[0.06]';
  if (chain) { statusColor = 'text-emerald-400'; statusLabel = '투자 중'; borderClass = 'border-emerald-500/30'; }
  else if (scoreVal >= 80) { statusColor = 'text-amber-400'; statusLabel = '매수 근접'; borderClass = 'border-amber-500/30'; }
  else if (scoreVal >= 0) { statusColor = 'text-blue-400'; statusLabel = '감시 중'; }

  return (
    <div onClick={onClick}
      className={`relative group rounded-xl border px-3 py-3 cursor-pointer hover:bg-white/[0.03] transition-colors ${isSelected ? 'bg-blue-950/20 border-blue-500/40' : borderClass}`}>
      <div className="flex items-start justify-between gap-1">
        <span className="font-bold text-[13px] truncate leading-tight">{displayName}</span>
        <span className={`text-[9px] font-semibold shrink-0 mt-0.5 ${statusColor}`}>{statusLabel}</span>
      </div>
      <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-2">
        <span>{chain ? `평단 ${Number(chain.avg_buy_price).toLocaleString()}원` : scoreVal >= 0 ? `AI ${scoreVal}점` : '점수 없음'}</span>
        {sparkline && sparkline.length >= 2 && (() => {
          const pts = sparkline;
          const min = Math.min(...pts); const max = Math.max(...pts);
          const range = max - min || 1;
          const w = 40; const h = 16;
          const xs = pts.map((_, i) => (i / (pts.length - 1)) * w);
          const ys = pts.map((v) => h - ((v - min) / range) * h);
          const d = xs.map((x, i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' ');
          const trend = pts[pts.length - 1] >= pts[0] ? '#10b981' : '#f43f5e';
          return (
            <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
              <path d={d} fill="none" stroke={trend} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          );
        })()}
      </div>
      {sellPct != null && (
        <div className="mt-1 flex flex-col gap-0.5">
          <div className={`text-[10px] font-medium ${sellPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            매도수익 {sellPct >= 0 ? '+' : ''}{sellPct.toFixed(1)}%
          </div>
          {postSellPct != null && (
            <div className={`text-[10px] ${postSellPct >= 0 ? 'text-amber-400' : 'text-sky-400'}`}>
              매도 후 {postSellPct >= 0 ? '↑+' : '↓'}{postSellPct.toFixed(1)}%
            </div>
          )}
        </div>
      )}
      {fastAnalyzing && (
        <div className="mt-1">
          <span className="text-[9px] px-1.5 py-0.5 rounded font-medium bg-violet-500/15 text-violet-400 animate-pulse">
            빠른 분석 중...
          </span>
        </div>
      )}
      {!fastAnalyzing && String(s.source ?? '') !== '' && String(s.source ?? '') !== 'MANUAL' && (
        <div className="mt-1">
          <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
            s.source === 'KIS_SYNC' ? 'bg-blue-500/15 text-blue-400' : 'bg-violet-500/15 text-violet-400'
          }`}>
            {s.source === 'KIS_SYNC' ? 'KIS관심그룹' : '자동편입'}
          </span>
        </div>
      )}
      <button onClick={(e) => { e.stopPropagation(); onDelete(s.stock_code); }}
        className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-[9px] text-rose-400 hover:text-rose-300 transition-opacity leading-none">✕</button>
    </div>
  );
}

export default StockCard;
