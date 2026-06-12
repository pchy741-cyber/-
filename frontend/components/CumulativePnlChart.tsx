'use client';

/**
 * 📈 일일 누적 손익 미니 차트
 *
 * CEO 지시 (2026-06-12): "일일 누적 손익 추세 차트"
 *  - PortfolioSection 상단에 14일 누적 PnL 라인 표시
 *  - 양수: emerald, 음수: rose
 *  - 데이터: /trades/daily-summary?days=14
 */

import { useEffect, useState } from 'react';
import { api } from '@/app/lib/utils';

interface DailyPnl {
  date: string;
  realizedPnl: number;
}

interface Props {
  viewMode: 'paper' | 'live';
  days?: number;
}

export function CumulativePnlChart({ viewMode, days = 14 }: Props) {
  const [series, setSeries] = useState<{ date: string; cumulative: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = (await api(`/trades/daily-summary?days=${days}&viewMode=${viewMode}`)) as {
          days: DailyPnl[];
        };
        if (cancelled) return;
        // 오래된 → 최신 순서로 정렬 후 누적
        const sorted = [...r.days].sort((a, b) => a.date.localeCompare(b.date));
        let cum = 0;
        const built = sorted.map((d) => {
          cum += d.realizedPnl;
          return { date: d.date, cumulative: cum };
        });
        setSeries(built);
      } catch {
        setSeries([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [viewMode, days]);

  if (loading) {
    return (
      <div className="h-16 flex items-center justify-center text-[10px] text-slate-600">
        손익 추세 로딩...
      </div>
    );
  }
  if (series.length < 2) {
    return (
      <div className="h-16 flex items-center justify-center text-[10px] text-slate-600">
        데이터 부족 (최소 2일 필요)
      </div>
    );
  }

  const width = 360;
  const height = 60;
  const padX = 8;
  const padY = 6;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const values = series.map((s) => s.cumulative);
  const minV = Math.min(0, ...values);
  const maxV = Math.max(0, ...values);
  const range = Math.max(1, maxV - minV);
  const stepX = innerW / (series.length - 1);
  const zeroY = padY + innerH - ((0 - minV) / range) * innerH;

  const points = series.map((s, i) => {
    const x = padX + i * stepX;
    const y = padY + innerH - ((s.cumulative - minV) / range) * innerH;
    return { x, y, v: s.cumulative };
  });
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaPath = `${path} L ${points[points.length - 1].x} ${zeroY} L ${points[0].x} ${zeroY} Z`;
  const last = points[points.length - 1];
  const lastVal = last.v;
  const isPositive = lastVal >= 0;
  const lineColor = isPositive ? '#34d399' : '#fb7185';
  const fillColor = isPositive ? 'rgba(52, 211, 153, 0.12)' : 'rgba(251, 113, 133, 0.12)';

  const fmtKrw = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 10000) return `${v >= 0 ? '+' : '-'}${Math.round(abs / 10000)}만`;
    return `${v >= 0 ? '+' : '-'}${Math.round(abs).toLocaleString('ko-KR')}`;
  };

  return (
    <div className="bg-white/[0.02] rounded-xl px-3 py-2 ring-1 ring-white/[0.04]">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-slate-500">📈 {days}일 누적 실현손익</span>
        <span className={`text-[11px] font-bold tabular-nums ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
          ₩{fmtKrw(lastVal)}
        </span>
      </div>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <line x1={padX} x2={width - padX} y1={zeroY} y2={zeroY} stroke="rgba(255,255,255,0.08)" strokeDasharray="2,2" />
        <path d={areaPath} fill={fillColor} />
        <path d={path} fill="none" stroke={lineColor} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={last.x} cy={last.y} r="2.5" fill={lineColor} />
      </svg>
    </div>
  );
}
