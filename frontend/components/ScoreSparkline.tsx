'use client';

import { useEffect, useState } from 'react';
import { api } from '../app/lib/utils';

/**
 * AI 점수 시계열 미니 그래프 (Sparkline)
 * - 최근 24h 점수 변화
 * - 변화량 색상 (상승 = emerald, 하락 = rose)
 * - 마지막 점은 강조
 */

interface ScorePoint {
  score: number;
  at: string;
  delta: number | null;
}

interface Props {
  stockCode: string;
  hours?: number;
  width?: number;
  height?: number;
  apiBase?: string; // 하위 호환용 (미사용)
}

export function ScoreSparkline({
  stockCode,
  hours = 24,
  width = 120,
  height = 36,
}: Props) {
  const [points, setPoints] = useState<ScorePoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastDelta, setLastDelta] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        const data = await api(`/ai-loop/scores/history?stock_code=${stockCode}&hours=${hours}`);
        if (cancelled) return;
        const pts = (data.points ?? []) as ScorePoint[];
        setPoints(pts);
        setLastDelta(pts.length > 0 ? pts[pts.length - 1].delta : null);
      } catch {
        if (!cancelled) setPoints([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    // 30초마다 갱신
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [stockCode, hours]);

  if (points.length < 2) {
    return (
      <div className="flex items-center justify-center text-[9px] text-slate-600 w-[var(--w)] h-[var(--h)]" style={{ '--w': `${width}px`, '--h': `${height}px` } as React.CSSProperties}>
        {loading ? '...' : '데이터 없음'}
      </div>
    );
  }

  const scores = points.map((p) => p.score);
  const minS = Math.min(...scores);
  const maxS = Math.max(...scores);
  const range = Math.max(1, maxS - minS);
  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const stepX = innerW / Math.max(1, points.length - 1);

  const path = points
    .map((p, i) => {
      const x = pad + i * stepX;
      const y = pad + innerH - ((p.score - minS) / range) * innerH;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const last = points[points.length - 1];
  const lastX = pad + (points.length - 1) * stepX;
  const lastY = pad + innerH - ((last.score - minS) / range) * innerH;

  const lineColor = lastDelta != null && lastDelta < 0 ? '#fb7185' : '#34d399';
  // 부스트 뱃지: +5점 spike 이상 = ⚡, -5점 drop 이상 = 🔻
  const showBoost = lastDelta != null && Math.abs(lastDelta) >= 5;
  const boostBadge = showBoost
    ? lastDelta! >= 5
      ? '⚡'
      : '🔻'
    : '';

  return (
    <div className="inline-flex items-center gap-1">
      <svg width={width} height={height} className="overflow-visible">
        <path d={path} fill="none" stroke={lineColor} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={lastX} cy={lastY} r="2.5" fill={lineColor} />
      </svg>
      <div className="flex flex-col text-[9px] leading-tight">
        <span className={`tabular-nums font-bold ${lastDelta != null && lastDelta < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
          {last.score.toFixed(0)}
        </span>
        {lastDelta != null && (
          <span
            className={`tabular-nums ${showBoost ? 'font-black animate-pulse' : ''} ${lastDelta < 0 ? 'text-rose-400' : 'text-emerald-400'}`}
          >
            {boostBadge}
            {lastDelta >= 0 ? '+' : ''}
            {lastDelta.toFixed(1)}
          </span>
        )}
      </div>
    </div>
  );
}
