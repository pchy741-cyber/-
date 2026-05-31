'use client';

import React from 'react';

export function ViewModeToggle({
  viewMode, onChange, size = 'md',
}: {
  viewMode: 'live' | 'paper';
  onChange: (m: 'live' | 'paper') => void;
  size?: 'sm' | 'md';
}) {
  const isSm = size === 'sm';
  return (
    <div className={`flex items-center gap-1 bg-[#0a0e1a] rounded-${isSm ? 'lg' : 'xl'} p-${isSm ? '0.5' : '1'} border border-white/[0.06]`}>
      <button
        onClick={() => onChange('live')}
        className={`${isSm ? 'px-3 py-1 text-[10px]' : 'px-6 py-1.5 text-xs'} rounded-${isSm ? 'md' : 'lg'} font-bold tracking-wide transition-all duration-200 ${
          viewMode === 'live'
            ? 'bg-emerald-500/20 text-emerald-300 shadow-sm ring-1 ring-emerald-500/20'
            : 'text-slate-600 hover:text-slate-400 hover:bg-white/[0.03]'
        }`}
      >
        {isSm ? '실전' : '실전 보기'}
      </button>
      <button
        onClick={() => onChange('paper')}
        className={`${isSm ? 'px-3 py-1 text-[10px]' : 'px-6 py-1.5 text-xs'} rounded-${isSm ? 'md' : 'lg'} font-bold tracking-wide transition-all duration-200 ${
          viewMode === 'paper'
            ? 'bg-amber-500/20 text-amber-300 shadow-sm ring-1 ring-amber-500/20'
            : 'text-slate-600 hover:text-slate-400 hover:bg-white/[0.03]'
        }`}
      >
        {isSm ? '연습' : '연습 보기'}
      </button>
    </div>
  );
}
