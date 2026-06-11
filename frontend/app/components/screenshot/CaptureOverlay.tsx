'use client';

import React from 'react';

export function CaptureOverlay({ step, total, progress }: { step: number; total: number; progress: string }) {
  return (
    <div data-html2canvas-ignore="true" className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center pointer-events-none">
      <div className="bg-[#0c1021] border border-white/10 rounded-2xl px-10 py-8 shadow-2xl text-center pointer-events-auto min-w-[280px]">
        <div className="relative w-20 h-20 mx-auto mb-5">
          <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="35" fill="none" stroke="#1e293b" strokeWidth="4" />
            <circle cx="40" cy="40" r="35" fill="none" stroke="url(#prog-grad)" strokeWidth="4"
              strokeLinecap="round" strokeDasharray={`${(step / total) * 220} 220`} className="transition-all duration-500" />
            <defs><linearGradient id="prog-grad" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#3b82f6" /><stop offset="100%" stopColor="#06b6d4" /></linearGradient></defs>
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xl font-black text-white">{step}/{total}</span>
          </div>
        </div>
        <p className="text-sm font-bold text-white mb-1">{progress}</p>
        <p className="text-xs text-slate-500">Copilot 분석 중...</p>
      </div>
    </div>
  );
}
