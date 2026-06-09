'use client';

import React from 'react';
import { ProgressBar } from '@/components/ProgressBar';
import { fmtWon } from '../../lib/utils';
import type { Health } from '../../types';

interface MarketProgressBarProps {
  health: Health | null;
  holdingsTab: 'KR' | 'US';
  currentTimeStr: string;
  marketProgress: number;
  usMarketProgress: number;
  unrealizedPnl: number;
  overseasPnlUsd: number;
  dailyLossLimit: number;
  overseasLimitUsd: number;
}

// KST 기준 장중 구간 계산 (09:00~15:30 = 390분)
function getKrMarketPhase(timeStr: string): { label: string; color: string; dot: string } {
  const [hStr, mStr] = timeStr.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const cur = h * 60 + m;
  if (cur < 9 * 60) return { label: '장 전', color: 'text-slate-500', dot: 'bg-slate-600' };
  if (cur < 9 * 60 + 30) return { label: '개장 자동구간 — 대기', color: 'text-sky-400', dot: 'bg-sky-400 animate-pulse' };
  if (cur < 10 * 60 + 20) return { label: '★★ 황금 오전 — 매수 가능', color: 'text-emerald-400', dot: 'bg-emerald-400 animate-pulse' };
  if (cur < 13 * 60) return { label: '☠️ 마의구간 — 신규 매수 금지', color: 'text-rose-400', dot: 'bg-rose-500' };
  if (cur < 15 * 60) return { label: '★ 황금 오후 — 눌림 진입', color: 'text-emerald-400', dot: 'bg-emerald-400 animate-pulse' };
  if (cur < 15 * 60 + 20) return { label: '마감 준비 — 신규 매수 금지', color: 'text-amber-400', dot: 'bg-amber-400' };
  return { label: '장 마감', color: 'text-slate-500', dot: 'bg-slate-600' };
}

// 09:00~15:30 사이 분 위치를 퍼센트로 변환
function toBarPct(h: number, m: number) {
  return Math.round(((h * 60 + m - 9 * 60) / 390) * 1000) / 10;
}

export default function MarketProgressBar({
  health, holdingsTab, currentTimeStr, marketProgress, usMarketProgress,
  unrealizedPnl, overseasPnlUsd, dailyLossLimit, overseasLimitUsd,
}: MarketProgressBarProps) {
  const isUs = holdingsTab === 'US';
  const loss = isUs ? overseasPnlUsd : unrealizedPnl;
  const limit = isUs ? overseasLimitUsd : dailyLossLimit;
  const usedPct = loss < 0 && limit > 0 ? Math.min(100, Math.round((Math.abs(loss) / limit) * 100)) : 0;
  const lossColor = usedPct >= 60 ? 'text-rose-400' : usedPct > 0 ? 'text-amber-400' : 'text-emerald-400';
  const phase = health?.marketOpen ? getKrMarketPhase(currentTimeStr) : null;

  // 구간별 배경색 영역 (09:00=0%, 09:30=7.7%, 10:20=20.5%, 13:00=61.5%, 15:00=92.3%, 15:30=100%)
  const pct930  = toBarPct(9, 30);   // 7.7
  const pct1020 = toBarPct(10, 20);  // 20.5
  const pct1300 = toBarPct(13, 0);   // 61.5
  const pct1500 = toBarPct(15, 0);   // 92.3
  const pct1520 = toBarPct(15, 20);  // 97.4

  return (
    <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      {/* 장 상태 표시 */}
      <div className="flex items-center gap-2 shrink-0">
        {health?.marketOpen ? (
          <>
            <span className={`w-2 h-2 rounded-full shrink-0 ${phase?.dot ?? 'bg-emerald-400 animate-pulse'}`} />
            <div className="flex flex-col">
              <span className="text-[11px] text-slate-400 leading-tight">한국장 {currentTimeStr}</span>
              {phase && <span className={`text-[10px] font-semibold leading-tight ${phase.color}`}>{phase.label}</span>}
            </div>
          </>
        ) : health?.usMarketOpen ? (
          <>
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse shrink-0" />
            <span className="text-[11px] text-blue-400">🇺🇸 미국장중 {currentTimeStr}</span>
          </>
        ) : (
          <>
            <span className="w-2 h-2 rounded-full bg-slate-600 shrink-0" />
            <span className="text-[11px] text-slate-500">장 외 — 미국장 대기중</span>
          </>
        )}
      </div>

      {/* 장 진행 바 */}
      <div className="flex-1 relative min-w-0">
        {health?.marketOpen ? (
          <>
            {/* 구간별 배경 영역 */}
            <div className="relative h-2.5 rounded-full overflow-hidden bg-white/[0.03]">
              {/* 개장 자동구간 09:00~09:30 — 회색 */}
              <div className="absolute top-0 h-full bg-sky-900/40" style={{ left: '0%', width: `${pct930}%` }} />
              {/* 황금 오전 09:30~10:20 — 초록 */}
              <div className="absolute top-0 h-full bg-emerald-900/50" style={{ left: `${pct930}%`, width: `${pct1020 - pct930}%` }} />
              {/* 마의 구간 10:20~13:00 — 빨강 */}
              <div className="absolute top-0 h-full bg-rose-900/40" style={{ left: `${pct1020}%`, width: `${pct1300 - pct1020}%` }} />
              {/* 황금 오후 13:00~15:00 — 초록 */}
              <div className="absolute top-0 h-full bg-emerald-900/50" style={{ left: `${pct1300}%`, width: `${pct1500 - pct1300}%` }} />
              {/* 마감 준비 15:00~15:20 — 주황 */}
              <div className="absolute top-0 h-full bg-amber-900/30" style={{ left: `${pct1500}%`, width: `${pct1520 - pct1500}%` }} />
              {/* 진행 오버레이 */}
              <div className="absolute top-0 left-0 h-full bg-white/20 rounded-full transition-all duration-1000" style={{ width: `${marketProgress}%` }} />
            </div>
            {/* 구간 라벨 */}
            <div className="flex mt-0.5 text-[9px] relative" style={{ height: '12px' }}>
              <span className="absolute text-sky-700" style={{ left: '0%' }}>09:00</span>
              <span className="absolute text-emerald-700 font-semibold" style={{ left: `${pct930}%`, transform: 'translateX(-50%)' }}>09:30</span>
              <span className="absolute text-rose-700 font-semibold" style={{ left: `${pct1020}%`, transform: 'translateX(-50%)' }}>10:20</span>
              <span className="absolute text-emerald-700 font-semibold" style={{ left: `${pct1300}%`, transform: 'translateX(-50%)' }}>13:00</span>
              <span className="absolute text-amber-700" style={{ left: `${pct1500}%`, transform: 'translateX(-50%)' }}>15:00</span>
              <span className="absolute text-slate-600" style={{ right: '0%' }}>15:30</span>
            </div>
          </>
        ) : health?.usMarketOpen ? (
          <>
            <ProgressBar value={usMarketProgress} colorClass="bg-gradient-to-r from-blue-600 to-indigo-500" transition="transition-all duration-1000" />
            <div className="flex justify-between mt-0.5 text-[9px] text-slate-600">
              <span>23:30</span><span>06:00</span>
            </div>
          </>
        ) : (
          <div className="text-[9px] text-slate-700 text-center">한국장 09:00 · 미국장 23:30</div>
        )}
      </div>

      {/* 손실 한도 */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[10px] text-slate-500">손실한도</span>
        <div className={`text-[11px] font-bold ${lossColor}`}>
          {isUs
            ? (loss < 0 ? `${usedPct}% ($${Math.abs(Math.round(loss)).toLocaleString('en-US')}/$${limit.toLocaleString('en-US')})` : `0% / $${limit.toLocaleString('en-US')}`)
            : (loss < 0 ? `${usedPct}% (${fmtWon(Math.abs(loss))}/${fmtWon(limit)})` : `0% / ${fmtWon(limit)}`)}
        </div>
      </div>
    </div>
  );
}
