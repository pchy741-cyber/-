'use client';

import React from 'react';
import { COLOR, type ColorKey } from './layout';

export function Badge({
  children, color = 'neutral', className = '',
}: {
  children: React.ReactNode;
  color?: ColorKey;
  className?: string;
}) {
  const c = COLOR[color];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${c.bg} ${c.text} ${className}`}>
      {children}
    </span>
  );
}

export function SideBadge({ side, isAverageDown, pnl }: { side: string; isAverageDown?: boolean; pnl?: number | null }) {
  let key: ColorKey;
  let label: string;
  if (isAverageDown) {
    key = 'blue'; label = '추가매수';
  } else if (side === 'BUY') {
    key = 'emerald'; label = '매수';
  } else if (pnl != null) {
    key = pnl >= 0 ? 'emerald' : 'rose';
    label = pnl >= 0 ? '익절' : '손절';
  } else {
    key = 'rose'; label = '매도';
  }
  const c = COLOR[key];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold tracking-wide ${c.bg} ${c.text} ring-1 ${c.ring}`}>
      {label}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = { FILLED: '체결', FAILED: '실패', PENDING: '대기', CANCELLED: '취소' };
  const label = map[status] ?? status;
  const cls =
    status === 'FILLED' ? 'bg-emerald-500/10 text-emerald-400' :
    status === 'FAILED' ? 'bg-rose-500/10 text-rose-400' :
    'bg-white/[0.04] text-slate-500';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

export function ModeBadge({ mode }: { mode: string }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs ${mode === 'paper' ? 'bg-amber-900/40 text-amber-300' : 'bg-blue-900/40 text-blue-300'}`}>
      {mode === 'paper' ? '연습' : '실전'}
    </span>
  );
}
