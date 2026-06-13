'use client';

import React from 'react';
import { api, fmtWon } from '../lib/utils';
import { isOverseasTrade as isOvTrade } from '../lib/helpers';
import type { Trade, Strategy, ToastFn } from '../types';

export default function PerformancePanel({ trades, strategy, setStrategy, toast, fxRate = 1420 }: { trades: Trade[]; strategy: Strategy | null; setStrategy?: (s: Strategy) => void; toast?: ToastFn; fxRate?: number }) {
  const [quickPrompt, setQuickPrompt] = React.useState('');
  const [savingPrompt, setSavingPrompt] = React.useState(false);

  const isOverseasTrade = (t: Trade) => isOvTrade(t);

  // 일별 실현 손익 계산 (SELL 체결 기준) — 해외 USD → KRW 변환
  const sellTrades = trades.filter(t => t.status === 'FILLED' && t.side === 'SELL');
  const dailyMap = new Map<string, number>();
  for (const t of sellTrades) {
    const date = new Date(t.created_at).toISOString().slice(0, 10);
    if (t.realized_pnl != null) {
      const pnlKrw = isOverseasTrade(t) ? Number(t.realized_pnl) * fxRate : Number(t.realized_pnl);
      dailyMap.set(date, (dailyMap.get(date) ?? 0) + pnlKrw);
    } else {
      const avgBuy = Number(t.transaction_chains?.avg_buy_price ?? t.avg_buy_price) || 0;
      const filledPx = Number(t.filled_price) || 0;
      const qty = Number(t.filled_quantity ?? t.quantity) || 0;
      const isUs = isOverseasTrade(t);
      const BUY_FEE = isUs ? 0 : 0.00015; const SELL_FEE = isUs ? 0 : 0.00245;
      if (avgBuy > 0 && filledPx > 0 && qty > 0) {
        const gross = (filledPx - avgBuy) * qty;
        const fees = Math.round(avgBuy * qty * BUY_FEE) + Math.round(filledPx * qty * SELL_FEE);
        const pnl = gross - fees;
        dailyMap.set(date, (dailyMap.get(date) ?? 0) + (isUs ? pnl * fxRate : pnl));
      }
    }
  }

  const sortedDays = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let cumPnl = 0; let peak = 0; let trough = 0; let maxDdPct = 0; let maxDdAmt = 0;
  const dailySeries = sortedDays.map(([date, pnl]) => {
    cumPnl += pnl;
    if (cumPnl > peak) { peak = cumPnl; trough = cumPnl; }
    if (cumPnl < trough) trough = cumPnl;
    const ddAmt = peak - trough;
    const dd = peak > 0 ? (ddAmt / peak) * 100 : 0;
    if (ddAmt > maxDdAmt) { maxDdAmt = ddAmt; maxDdPct = dd; }
    return { date, pnl, cumPnl };
  });

  const allPnls = dailySeries.map(d => d.pnl);
  const avgPnl = allPnls.length > 0 ? allPnls.reduce((s, v) => s + v, 0) / allPnls.length : 0;
  const tradePnls = sellTrades
    .filter(t => t.realized_pnl != null)
    .map(t => {
      const pnl = Number(t.realized_pnl);
      return isOverseasTrade(t) ? pnl * fxRate : pnl;
    });
  const winPnls = tradePnls.filter((p: number) => p > 0);
  const lossPnls = tradePnls.filter((p: number) => p < 0);
  const winRate = tradePnls.length > 0 ? Math.round((winPnls.length / tradePnls.length) * 100) : 0;
  const avgWin = winPnls.length > 0 ? winPnls.reduce((s, v) => s + v, 0) / winPnls.length : 0;
  const avgLoss = lossPnls.length > 0 ? Math.abs(lossPnls.reduce((s, v) => s + v, 0) / lossPnls.length) : 0;
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 99 : 0);
  let streak = 0; let streakDir: 'win' | 'loss' | 'none' = 'none';
  for (let k = allPnls.length - 1; k >= 0; k--) {
    const p = allPnls[k];
    if (streak === 0) { streakDir = p > 0 ? 'win' : 'loss'; streak = 1; }
    else if ((streakDir === 'win' && p > 0) || (streakDir === 'loss' && p < 0)) streak++;
    else break;
  }

  const last14 = dailySeries.slice(-14);
  const last7 = dailySeries.slice(-7);
  const pos7 = last7.filter(d => d.pnl > 0).length;
  const neg7 = last7.filter(d => d.pnl < 0).length;
  const trendUp = pos7 > neg7; const trendDown = neg7 > pos7;
  const trendLabel = trendDown ? '하락세' : trendUp ? '상승세' : '횡보';
  const trendColor = trendDown ? 'text-rose-400' : trendUp ? 'text-emerald-400' : 'text-slate-400';
  const trendBg = trendDown ? 'bg-rose-900/20 border-rose-900/20' : trendUp ? 'bg-emerald-900/20 border-emerald-900/20' : 'bg-slate-700/20 border-slate-700/20';
  const maxBar = last14.length > 0 ? Math.max(...last14.map(d => Math.abs(d.pnl)), 1) : 1;

  const saveQuickPrompt = async () => {
    if (!quickPrompt.trim() || !setStrategy) return;
    setSavingPrompt(true);
    try {
      const body = {
        ...strategy,
        claude_prompt: (strategy?.claude_prompt ?? '') + '\n\n[CEO 추가 지시 ' + new Date().toLocaleDateString('ko') + ']\n' + quickPrompt.trim(),
      };
      const u = await api('/strategy', { method: 'PUT', body: JSON.stringify(body) });
      setStrategy(u);
      setQuickPrompt('');
      toast?.('전략 지시 추가됨', 'ok');
    } finally { setSavingPrompt(false); }
  };

  if (dailySeries.length === 0 && !strategy) return null;

  return (
    <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
        <span className="text-sm font-semibold text-slate-200">성과 종합 분석</span>
        <span className={`ml-auto text-[10px] font-bold px-2.5 py-1 rounded-full border ${trendBg} ${trendColor}`}>
          {trendDown ? '↓' : trendUp ? '↑' : '→'} {trendLabel} (7일)
        </span>
      </div>
      <div className="p-4 space-y-4">
        {/* 4개 핵심 지표 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white/[0.03] rounded-xl p-3">
            <div className="text-[10px] text-slate-500 mb-1">누적 실현 손익</div>
            <div className={`text-base font-black ${cumPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {cumPnl >= 0 ? '+' : ''}{fmtWon(cumPnl)}
            </div>
            <div className="text-[9px] text-slate-600 mt-1">일평균 {avgPnl >= 0 ? '+' : ''}{fmtWon(avgPnl)}</div>
          </div>
          <div className="bg-white/[0.03] rounded-xl p-3">
            <div className="text-[10px] text-slate-500 mb-1">최대 낙폭 (MDD)</div>
            <div className={`text-base font-black ${maxDdAmt > 500000 ? 'text-rose-400' : maxDdAmt > 200000 ? 'text-amber-400' : 'text-slate-300'}`}>
              -{fmtWon(maxDdAmt)}
            </div>
            <div className="text-[9px] text-slate-600 mt-1">{maxDdPct <= 100 ? `-${maxDdPct.toFixed(1)}% (수익곡선)` : '수익곡선 기준'}</div>
          </div>
          <div className="bg-white/[0.03] rounded-xl p-3">
            <div className="text-[10px] text-slate-500 mb-1">승률</div>
            <div className={`text-base font-black ${winRate >= 60 ? 'text-emerald-400' : winRate >= 45 ? 'text-amber-400' : 'text-rose-400'}`}>
              {winRate}%
            </div>
            <div className="text-[9px] text-slate-600 mt-1">{winPnls.length}승 {lossPnls.length}패 ({tradePnls.length}매매)</div>
          </div>
          <div className="bg-white/[0.03] rounded-xl p-3">
            <div className="text-[10px] text-slate-500 mb-1">손익비</div>
            <div className={`text-base font-black ${profitFactor >= 1.5 ? 'text-emerald-400' : profitFactor >= 1.0 ? 'text-amber-400' : 'text-rose-400'}`}>
              {profitFactor === 99 ? '∞' : profitFactor.toFixed(2)}
            </div>
            <div className="text-[9px] mt-1">
              {streak > 1 && streakDir !== 'none'
                ? <span className={streakDir === 'win' ? 'text-emerald-500' : 'text-rose-500'}>{streakDir === 'win' ? `${streak}연승` : `${streak}연패`}</span>
                : <span className="text-slate-600">평균 +{fmtWon(avgWin)} / -{fmtWon(avgLoss)}</span>
              }
            </div>
          </div>
        </div>

        {/* 최근 14일 미니 바 차트 */}
        {last14.length > 0 && (
          <div>
            <div className="text-[10px] text-slate-500 mb-2">최근 {last14.length}일 일별 손익</div>
            <div className="flex items-end gap-0.5 h-10">
              {last14.map((d, i) => {
                const barH = Math.max(3, (Math.abs(d.pnl) / maxBar) * 36);
                return (
                  <div key={i} className="flex-1 flex flex-col items-center justify-end" title={`${d.date}: ${d.pnl >= 0 ? '+' : ''}${fmtWon(d.pnl)}`}>
                    <div className={`w-full rounded-sm ${d.pnl >= 0 ? 'bg-emerald-500/70' : 'bg-rose-500/70'}`} style={{ height: `${barH}px` }} />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[9px] text-slate-700 mt-1">
              <span>{last14[0]?.date?.slice(5)}</span>
              <span>오늘</span>
            </div>
          </div>
        )}

        {/* 빠른 전략 지시 입력창 */}
        {setStrategy && (
          <div className="border-t border-white/[0.04] pt-3">
            <div className="text-[10px] text-slate-500 mb-2">빠른 전략 지시 <span className="text-slate-700">(Claude 프롬프트에 추가됨)</span></div>
            <div className="flex gap-2">
              <textarea
                value={quickPrompt}
                onChange={e => setQuickPrompt(e.target.value)}
                placeholder="예: 오늘부터 바이오 전면 제외, 반도체만 공략..."
                rows={2}
                className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2 text-[11px] text-slate-200 placeholder:text-slate-700 outline-none focus:border-blue-500/40 resize-none"
              />
              <button
                onClick={saveQuickPrompt}
                disabled={savingPrompt || !quickPrompt.trim()}
                className="px-4 bg-blue-700/60 hover:bg-blue-600/80 text-blue-300 text-xs rounded-xl transition-all disabled:opacity-40 shrink-0">
                {savingPrompt ? '...' : '저장'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
