'use client';

import React from 'react';
import { ProgressBar } from '@/components/ProgressBar';
import { BarSegment, BarOverlay } from '@/components/BarSegment';
import { BarLabel } from '@/components/BarLabel';
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
              <BarSegment startPct={0} widthPct={pct930} bgClass="bg-sky-900/40" />
              {/* 황금 오전 09:30~10:20 — 초록 */}
              <BarSegment startPct={pct930} widthPct={pct1020 - pct930} bgClass="bg-emerald-900/50" />
              {/* 마의 구간 10:20~13:00 — 빨강 */}
              <BarSegment startPct={pct1020} widthPct={pct1300 - pct1020} bgClass="bg-rose-900/40" />
              {/* 황금 오후 13:00~15:00 — 초록 */}
              <BarSegment startPct={pct1300} widthPct={pct1500 - pct1300} bgClass="bg-emerald-900/50" />
              {/* 마감 준비 15:00~15:20 — 주황 */}
              <BarSegment startPct={pct1500} widthPct={pct1520 - pct1500} bgClass="bg-amber-900/30" />
              {/* 진행 오버레이 */}
              <BarOverlay progressPct={marketProgress} />
            </div>
            {/* 구간 라벨 */}
            <div className="flex mt-0.5 text-[9px] relative h-3">
              <BarLabel position={{ side: 'left', pct: 0 }} className="text-sky-700">09:00</BarLabel>
              <BarLabel position={{ side: 'left', pct: pct930 }} centered className="text-emerald-700 font-semibold">
                09:30
              </BarLabel>
              <BarLabel position={{ side: 'left', pct: pct1020 }} centered className="text-rose-700 font-semibold">
                10:20
              </BarLabel>
              <BarLabel position={{ side: 'left', pct: pct1300 }} centered className="text-emerald-700 font-semibold">
                13:00
              </BarLabel>
              <BarLabel position={{ side: 'left', pct: pct1500 }} centered className="text-amber-700">
                15:00
              </BarLabel>
              <BarLabel position={{ side: 'right', pct: 0 }} className="text-slate-600">15:30</BarLabel>
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
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] text-slate-500">손실도</span>
        <div className={`text-[11px] font-bold tabular-nums ${lossColor}`}>
          {isUs
            ? (loss < 0 ? `${usedPct}%` : '0%')
            : (loss < 0 ? `${usedPct}%` : '0%')}
        </div>
        <div className={`text-[10px] tabular-nums ${lossColor} opacity-70 hidden sm:block`}>
          {isUs
            ? `($${Math.abs(Math.round(loss)).toLocaleString('en-US')}/$${limit.toLocaleString('en-US')})`
            : `(${fmtWon(Math.abs(loss < 0 ? loss : 0))}/${fmtWon(limit)})`}
        </div>
      </div>
    </div>
  );
}
