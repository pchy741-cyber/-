'use client';

import React, { useState } from 'react';
import { api, fmt, fmtWon, fmtUsd, FALLBACK_FX_RATE } from '../../lib/utils';
import { toDisplayName, isUnresolvedStockName } from '../../lib/helpers';
import { SegmentedBar, WeightBar } from '@/components/SegmentedBar';
import { CumulativePnlChart } from '@/components/CumulativePnlChart';
import type { Dashboard, Chain, UsHolding, UsWatchlistItem, AllocConfig, MpData } from '../../types';

interface StrategyInfo {
  mode?: string;
  [key: string]: unknown;
}

interface PortfolioSectionProps {
  allocConfig: AllocConfig | null;
  setAllocConfig: (v: AllocConfig) => void;
  onGoToSettings?: () => void;
  dash: Dashboard | null;
  chains: Chain[];
  usHoldings: UsHolding[];
  usW: UsWatchlistItem[];
  totalValue: number;
  totalInvested: number;
  domesticInvested: number;
  domesticEval: number;
  domesticCash: number;
  domesticOrderable: number;
  overseasInvestedUsd: number;
  overseasInvestedKrw: number;
  overseasMarketKrw: number;
  overseasCashUsd: number;
  overseasCashKrw: number;
  overseasPnlUsd: number;
  fxRate: number;
  investedPctExact: number;
  cashPctExact: number;
  overseasCashPctExact: number;
  strategy: StrategyInfo | null;
  getStockName: (code: string) => string;
  mpData?: MpData | null;
  viewMode?: 'paper' | 'live';
}

function PortfolioSectionInner(props: PortfolioSectionProps) {
  const {
    allocConfig, setAllocConfig, onGoToSettings, dash, chains, usHoldings, usW,
    totalValue, totalInvested, domesticInvested, domesticEval, domesticCash, domesticOrderable,
    overseasInvestedUsd, overseasInvestedKrw, overseasMarketKrw,
    overseasCashUsd, overseasCashKrw, overseasPnlUsd, fxRate,
    investedPctExact, cashPctExact, overseasCashPctExact,
    strategy, getStockName, mpData, viewMode,
  } = props;

  const [showPortfolio, setShowPortfolio] = useState(false);
  const pctClamp = (v: number) => Math.max(0, Math.min(100, v));

  const krTarget = Number(allocConfig?.kr_pct ?? 70);
  const usTarget = Number(allocConfig?.us_pct ?? 30);
  const krActualPct = domesticInvested > 0
    ? (chains.reduce((s: number, ch: Chain) => {
        const pnl = ch.unrealizedPnl;
        return s + (pnl != null && !isNaN(pnl) ? pnl : 0);
      }, 0) / domesticInvested) * 100
    : 0;
  const usActualPct = overseasInvestedUsd > 0 ? (overseasPnlUsd / overseasInvestedUsd) * 100 : 0;
  const krUnderperform = chains.length > 0 && usHoldings.length > 0 && krActualPct < usActualPct - 2;
  const p = dash?.portfolio;

  const isPaper = viewMode === 'paper';
  const applyPreset = async (kr: number, us: number) => {
    try {
      const upd = await api(`/portfolio/allocation?viewMode=${viewMode ?? 'live'}`, {
        method: 'PUT',
        body: JSON.stringify({ ...allocConfig, kr_pct: kr, us_pct: us, isPaper }),
      });
      setAllocConfig(upd);
    } catch {}
  };

  return (
    <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden">
      {/* 헤더 */}
      <div className="px-4 py-3 flex items-center justify-between">
        <button onClick={() => setShowPortfolio(v => !v)} className="flex items-center gap-2 flex-1 text-left hover:opacity-80 transition-opacity">
          <span className="text-sm font-semibold text-slate-200">포트폴리오 비중</span>
          {totalValue > 0 && investedPctExact > 0 && <span className="text-[10px] bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded-md">투자 {investedPctExact.toFixed(0)}%</span>}
          {krUnderperform && <span className="text-[10px] text-amber-400 animate-pulse ml-1">⚡ 국내 부진</span>}
        </button>
        <div className="flex items-center gap-3">
          <button onClick={() => onGoToSettings?.()} className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors">설정 →</button>
          <button onClick={() => setShowPortfolio(v => !v)} className="text-[11px] text-slate-500">{showPortfolio ? '접기 ▲' : '자세히 ▼'}</button>
        </div>
      </div>
      {/* 항상 보이는 영역 */}
      <div className="px-4 pb-4 space-y-3">
        {/* 14일 누적 실현손익 미니 차트 (CEO 지시 2026-06-12) */}
        <CumulativePnlChart viewMode={viewMode ?? 'live'} days={14} />
        {/* 자금 흐름 시각화 — 3칸 */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5 sm:gap-2">
          <div className={`rounded-xl px-2 sm:px-3 py-2.5 ${krActualPct >= 0 ? 'bg-blue-950/40 border border-blue-500/10' : 'bg-rose-950/30 border border-rose-500/10'}`}>
            <div className="text-[9px] text-slate-500 mb-0.5">🇰🇷 한국주식</div>
            <div className="text-sm font-bold tabular-nums text-blue-300 truncate">{fmtWon(domesticEval)}</div>
            <div className="flex items-center justify-between mt-1">
              <span className="text-[9px] text-slate-600">{totalValue > 0 ? ((domesticEval / totalValue) * 100).toFixed(0) : 0}%</span>
              <span className={`text-[9px] font-medium ${krActualPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{krActualPct > 0 ? '+' : ''}{krActualPct.toFixed(1)}%</span>
            </div>
            <div className="text-[10px] text-slate-600 mt-0.5">{chains.length}종목</div>
          </div>
          <div className="rounded-xl px-2 sm:px-3 py-2.5 bg-slate-800/40 border border-white/[0.06]">
            <div className="text-[9px] text-slate-500 mb-0.5">주문가능</div>
            <div className="text-sm font-bold tabular-nums text-slate-200 truncate">{fmtWon(domesticOrderable)}</div>
            <div className="flex items-center justify-between mt-1">
              <span className="text-[9px] text-slate-600">{totalValue > 0 ? Math.max(0, 100 - Math.round((domesticEval / totalValue) * 100) - Math.round((overseasMarketKrw / totalValue) * 100)) : 0}%</span>
            </div>
            {overseasCashUsd > 0 && <div className="text-[10px] text-slate-600 mt-0.5">해외 ${Math.round(overseasCashUsd)}</div>}
          </div>
          <div className={`rounded-xl px-2 sm:px-3 py-2.5 ${usActualPct >= 0 ? 'bg-indigo-950/40 border border-indigo-500/10' : 'bg-rose-950/30 border border-rose-500/10'}`}>
            <div className="text-[9px] text-slate-500 mb-0.5">🇺🇸 미국주식</div>
            <div className="text-sm font-bold tabular-nums text-indigo-300 truncate">{fmtWon(overseasMarketKrw)}</div>
            <div className="flex items-center justify-between mt-1">
              <span className="text-[9px] text-slate-600">{totalValue > 0 ? ((overseasMarketKrw / totalValue) * 100).toFixed(0) : 0}%</span>
              <span className={`text-[9px] font-medium ${usActualPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{usActualPct > 0 ? '+' : ''}{usActualPct.toFixed(1)}%</span>
            </div>
            <div className="text-[10px] text-slate-600 mt-0.5">{usHoldings.length}종목</div>
          </div>
          {/* 배당 ETF */}
          {(() => {
            const d = mpData?.dividend;
            const divValueKrw = d ? Math.round((d.currentValueUsd ?? 0) * (mpData?.fx ?? FALLBACK_FX_RATE)) : 0;
            const divReturnPct = d?.returnPct ?? 0;
            return (
              <div className={`rounded-xl px-2 sm:px-3 py-2.5 ${divReturnPct >= 0 ? 'bg-emerald-950/30 border border-emerald-500/10' : 'bg-rose-950/30 border border-rose-500/10'}`}>
                <div className="text-[9px] text-slate-500 mb-0.5">📊 배당ETF</div>
                <div className="text-sm font-bold tabular-nums text-emerald-300 truncate">{d?.investedKrw ? fmtWon(divValueKrw || d.investedKrw) : '—'}</div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[9px] text-slate-600">{d?.investedKrw ? `₩${Math.round(d.investedKrw / 10000)}만` : '미투자'}</span>
                  {d?.investedKrw ? <span className={`text-[9px] font-medium ${divReturnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{divReturnPct > 0 ? '+' : ''}{divReturnPct.toFixed(1)}%</span> : null}
                </div>
                <div className="text-[10px] text-slate-600 mt-0.5">{d?.holdings?.length ?? 0}종목 · 월${(d?.monthlyDivUsd ?? 0).toFixed(0)}</div>
              </div>
            );
          })()}
        </div>
        {/* 시장 레짐 인디케이터 */}
        {strategy && (
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${
              strategy.mode === 'DEFENSE' ? 'bg-amber-500/20 text-amber-300' :
              strategy.mode === 'SNIPER' ? 'bg-violet-500/20 text-violet-300' :
              'bg-emerald-500/20 text-emerald-300'
            }`}>{strategy.mode ?? 'SWING'}</span>
            <span className="text-[10px] text-slate-500">
              {strategy.mode === 'DEFENSE' ? '방어 모드 — 자동 현금화 진행 중'
                : strategy.mode === 'SNIPER' ? '저격 모드 — 급락 매수 대기'
                : '일반 운용 중'}
            </span>
            {dash?.riskLimits?.targetCashRatio != null && (
              <span className="text-[9px] text-slate-600 ml-auto">현금 목표 {Math.round(dash.riskLimits.targetCashRatio * 100)}%</span>
            )}
          </div>
        )}
        {/* 목표 비중 바 */}
        <div>
          <div className="flex justify-between text-[9px] text-slate-500 mb-1">
            <span>🇰🇷 국내 목표 {krTarget}%</span>
            <span>🇺🇸 해외 목표 {usTarget}%</span>
          </div>
          <SegmentedBar
            segments={[
              { widthPct: krTarget, className: 'bg-blue-500/70' },
              { widthPct: usTarget, className: 'bg-indigo-500/70' },
            ]}
          />
        </div>
        {/* 프리셋 버튼 */}
        <div className="flex gap-1.5 flex-wrap">
          {[
            { label: '반반 50%', kr: 50, us: 50 },
            { label: '해외 70%', kr: 30, us: 70 },
            { label: '해외 100%', kr: 0, us: 100 },
          ].map(({ label, kr, us }) => (
            <button key={label} onClick={() => applyPreset(kr, us)}
              className={`flex-1 text-[10px] py-1.5 rounded-lg font-semibold transition-all ${krTarget === kr ? 'bg-blue-500/30 text-blue-300 border border-blue-500/40' : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08] hover:text-slate-300'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {/* 접기/펼치기: 종목별 비중 */}
      {showPortfolio && (
        <div className="p-4 sm:p-5 space-y-4 border-t border-white/[0.04]">
          {/* 현금 vs 투자 비율 바 */}
          <div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] mb-2">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-gradient-to-r from-blue-500 to-cyan-500 shrink-0" />투자 중 {investedPctExact.toFixed(0)}%</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-slate-400/50 shrink-0" />현금 {cashPctExact.toFixed(0)}%</span>
            </div>
            <SegmentedBar
              height="h-3"
              segments={[
                { widthPct: pctClamp(investedPctExact), className: 'bg-gradient-to-r from-blue-500 to-cyan-500' },
                { widthPct: pctClamp(cashPctExact), className: 'bg-slate-400/50' },
              ]}
            />
          </div>
          {/* 종목별 비중 — 국내 */}
          {chains.length > 0 && (
            <div className="space-y-2.5">
              {domesticInvested > 0 && usHoldings.length > 0 && (
                <div className="text-[10px] text-slate-500 font-medium">국내 ({fmtWon(domesticInvested)})</div>
              )}
              {chains.map((ch: Chain, i: number) => {
                const inv = Number(ch.total_invested) || 0;
                const pct = totalValue > 0 ? (inv / totalValue) * 100 : 0;
                return (
                  <div key={`kr-${i}`}>
                    <div className="flex justify-between text-[11px] mb-1">
                      <span className="font-medium text-slate-300">
                        {(() => {
                          const resolved = toDisplayName(ch.stock_name, ch.stock_code);
                          return isUnresolvedStockName(resolved, ch.stock_code) ? getStockName(ch.stock_code) : resolved;
                        })()}
                      </span>
                      <span className="text-slate-500">{fmtWon(inv)} ({pct.toFixed(0)}%)</span>
                    </div>
                    <WeightBar
                      pct={pct}
                      colorClass={(ch.unrealizedPnl ?? 0) >= 0 ? 'bg-emerald-500/60' : 'bg-rose-500/60'}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {/* 종목별 비중 — 해외 */}
          {usHoldings.length > 0 && (
            <div className="mt-3 pt-3 border-t border-white/[0.04]">
              <div className="text-[10px] text-slate-500 font-medium mb-2">해외 ({fmtWon(overseasInvestedKrw)})</div>
              <div className="space-y-2">
                {usHoldings.map((h: UsHolding, i: number) => {
                  const invUsd = h.avg_price * h.quantity;
                  const invKrw = invUsd * fxRate;
                  const pct = totalValue > 0 ? (invKrw / totalValue) * 100 : 0;
                  const priceData = usW.find((s: UsWatchlistItem) => s.code === h.stock_code);
                  const curPriceAlloc = (priceData?.price ?? 0) > 0 ? (priceData!.price ?? 0) : (h.last_price ?? 0);
                  const curPnl = curPriceAlloc > 0 ? (curPriceAlloc - h.avg_price) * h.quantity : 0;
                  return (
                    <div key={`us-${i}`}>
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="font-medium text-blue-300">{toDisplayName(priceData?.name, h.stock_code)}</span>
                        <span className="text-slate-500">{fmtWon(invKrw)} ({pct.toFixed(0)}%)</span>
                      </div>
                      <WeightBar
                        pct={pct}
                        colorClass={curPnl >= 0 ? 'bg-blue-500/60' : 'bg-rose-500/60'}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const PortfolioSection = React.memo(PortfolioSectionInner);
export default PortfolioSection;
