'use client';

import React from 'react';
import { fmtWon, pc } from '../../lib/utils';
import type { Trade, WithdrawConfig } from '../../types';

interface HeroPnlCardProps {
  holdingsTab: 'KR' | 'US';
  combinedPnl: number;
  animCombined: number;
  combinedPnlPct: number;
  overseasPnlUsd: number;
  overseasInvestedUsd: number;
  showOnlyKr: boolean;
  showOnlyUs: boolean;
  hasOverseasHoldings: boolean;
  privacyMode: boolean;
  setPrivacyMode: (fn: (v: boolean) => boolean) => void;
  krTabHasData: boolean;
  usTodaySells: Trade[];
  krTabPnl: number;
  krTabPct: number | null;
  usTabPnlUsd: number;
  todayRealizedPnl: number;
  animToday: number;
  domesticCash: number;
  domesticOrderable: number;
  overseasCashUsd: number;
  domesticInvested: number;
  domesticEval: number;
  overseasMarketKrw: number;
  chainsLength: number;
  usHoldingsLength: number;
  withdrawConfig: WithdrawConfig | null;
  todayTradesLength: number;
  totalValue: number;
  totalInvested: number;
  fxRate: number;
  cashSource?: string;
}

export default function HeroPnlCard({
  holdingsTab, combinedPnl, animCombined, combinedPnlPct,
  overseasPnlUsd, overseasInvestedUsd, showOnlyKr, showOnlyUs,
  hasOverseasHoldings, privacyMode, setPrivacyMode,
  krTabHasData, usTodaySells, krTabPnl, krTabPct, usTabPnlUsd,
  todayRealizedPnl, animToday, domesticCash, domesticOrderable, overseasCashUsd,
  domesticInvested, domesticEval, overseasMarketKrw, chainsLength, usHoldingsLength, withdrawConfig, todayTradesLength,
  totalValue, totalInvested, fxRate, cashSource,
}: HeroPnlCardProps) {
  const totalHoldings = chainsLength + usHoldingsLength;
  // 국내/해외 시가평가 기준 비중 (totalValue = 현금 + 국내시가 + 해외시가)
  const krPct = totalValue > 0 ? Math.round((domesticEval / totalValue) * 100) : 0;
  const usPct = totalValue > 0 ? Math.round((overseasMarketKrw / totalValue) * 100) : 0;
  const cashPct = Math.max(0, 100 - krPct - usPct);
  const mask = (v: string) => privacyMode ? '••••••' : v;

  return (
    <div className={`rounded-2xl border p-5 ${combinedPnl > 0 ? 'bg-gradient-to-br from-emerald-950/60 via-emerald-900/20 to-transparent border-emerald-500/20' : combinedPnl < 0 ? 'bg-gradient-to-br from-rose-950/60 via-rose-900/20 to-transparent border-rose-500/20' : 'glass border-white/[0.06]'}`}>
      {/* 상단 헤더 */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs font-semibold text-slate-400 tracking-wide">미실현 손익{showOnlyKr ? ' 🇰🇷 국내' : showOnlyUs ? ' 🇺🇸 해외' : hasOverseasHoldings ? ' (국내+해외)' : ''}</span>
        <button onClick={() => setPrivacyMode(v => !v)} className="text-slate-500 hover:text-slate-300 transition-colors p-1 -m-1 rounded-lg">
          {privacyMode ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
          )}
        </button>
      </div>
      {/* 메인 수치 */}
      <div className="flex items-end gap-4 mb-5">
        <div className="flex-1">
          {showOnlyUs ? (
            <>
              <div className={`text-4xl sm:text-5xl font-black tracking-tight tabular-nums ${pc(overseasPnlUsd)}`}>
                {privacyMode ? '••••••' : `${overseasPnlUsd > 0 ? '+' : ''}$${Math.round(overseasPnlUsd).toLocaleString('en-US')}`}
              </div>
              <div className={`text-sm font-bold mt-1 ${pc(overseasPnlUsd)}`}>
                {overseasInvestedUsd > 0 ? `${((overseasPnlUsd / overseasInvestedUsd) * 100) > 0 ? '+' : ''}${((overseasPnlUsd / overseasInvestedUsd) * 100).toFixed(2)}%` : '0.00%'}
              </div>
            </>
          ) : (
            <>
              <div className={`text-4xl sm:text-5xl font-black tracking-tight tabular-nums ${pc(combinedPnl)}`}>
                {privacyMode ? '••••••원' : `${combinedPnl > 0 ? '+' : ''}${Math.round(animCombined).toLocaleString('ko-KR')}원`}
              </div>
              <div className={`text-sm font-bold mt-1 ${pc(combinedPnl)}`}>
                {combinedPnlPct !== 0 ? `${combinedPnlPct > 0 ? '+' : ''}${combinedPnlPct.toFixed(2)}%` : '0.00%'}
              </div>
            </>
          )}
        </div>
        {(krTabHasData || usTodaySells.length > 0) && (
          <div className="text-right border-l border-white/[0.06] pl-3 min-w-0">
            <div className="text-[10px] text-slate-500 mb-0.5">오늘 실현</div>
            <div className={`text-xl font-black tabular-nums ${pc(showOnlyUs ? usTabPnlUsd : todayRealizedPnl)}`}>
              {privacyMode ? '••••' : showOnlyUs
                ? `${usTabPnlUsd > 0 ? '+' : ''}$${Math.round(usTabPnlUsd).toLocaleString('en-US')}`
                : `${todayRealizedPnl > 0 ? '+' : ''}${Math.round(animToday).toLocaleString('ko-KR')}원`}
            </div>
          </div>
        )}
      </div>
      {/* 미니 스탯 3개 */}
      <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
        <div className="bg-white/[0.04] rounded-xl px-2 sm:px-3 py-2">
          <div className="text-[9px] text-slate-500 mb-0.5">
            주문가능
            {cashSource && !['buyable_api', 'paper_computed', 'ord_psbl_cash'].includes(cashSource) && (
              <span className="ml-1 text-amber-400/90" title={`source: ${cashSource}`}>
                {cashSource === 'dnca_tot_amt' ? '(예수금)' : cashSource === 'd2_deposit' ? '(D+2)' : cashSource === 'zero' ? '(0)' : cashSource === 'overseas_state' ? '(DB)' : `(${cashSource})`}
              </span>
            )}
          </div>
          <div className="text-sm font-bold text-slate-200 tabular-nums truncate">{mask(fmtWon(domesticOrderable))}</div>
          {overseasCashUsd > 0 && <div className="text-[10px] text-slate-600 mt-0.5">해외 {mask(`$${Math.round(overseasCashUsd).toLocaleString('en-US')}`)}</div>}
        </div>
        <div className="bg-white/[0.04] rounded-xl px-2 sm:px-3 py-2">
          <div className="text-[9px] text-slate-500 mb-0.5">투자비중 <span className="text-slate-600">({totalHoldings}종목)</span></div>
          <div className="flex items-baseline gap-1.5">
            {krPct > 0 && <span className="text-sm font-bold tabular-nums text-blue-400">🇰🇷{krPct}%</span>}
            {usPct > 0 && <span className="text-sm font-bold tabular-nums text-indigo-400">🇺🇸{usPct}%</span>}
            {krPct === 0 && usPct === 0 && <span className="text-sm font-bold tabular-nums text-slate-500">0%</span>}
          </div>
          <div className="h-1 rounded-full overflow-hidden bg-white/[0.04] flex mt-1">
            {krPct > 0 && <div className="h-full bg-blue-500/70" style={{ width: `${krPct}%` }} />}
            {usPct > 0 && <div className="h-full bg-indigo-500/70" style={{ width: `${usPct}%` }} />}
            <div className="h-full bg-slate-600/30 flex-1" />
          </div>
        </div>
        <div className="bg-white/[0.04] rounded-xl px-2 sm:px-3 py-2">
          <div className="text-[9px] text-slate-500 mb-0.5">{(withdrawConfig?.totalReserved ?? 0) > 0 ? '인출예약' : '총 자산'}</div>
          {(withdrawConfig?.totalReserved ?? 0) > 0 ? (
            <div className="text-sm font-bold text-amber-400 truncate">{mask(fmtWon(withdrawConfig!.totalReserved!))}</div>
          ) : (
            <>
              <div className="text-sm font-bold text-slate-200 truncate">{mask(fmtWon(totalValue))}</div>
              <div className="text-[9px] text-slate-600 mt-0.5">{todayTradesLength}건 매매</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
