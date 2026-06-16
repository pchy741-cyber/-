'use client';

import React, { useMemo } from 'react';
import { api, fmt, fmtWon, pc } from '../../lib/utils';
import { toDisplayName, isUnresolvedStockName, livePrefix } from '../../lib/helpers';
import { usePriceFlash } from '../../hooks/usePriceFlash';
import type { Chain, Dashboard, ToastFn, ConfirmFn, ViewMode } from '../../types';

interface KrHoldingsTabProps {
  chains: Chain[];
  dash: Dashboard | null;
  busyAction: string | null;
  guard: (key: string, fn: () => Promise<void>) => () => Promise<void>;
  getStockName: (code: string) => string;
  onRefresh: () => void;
  viewMode?: ViewMode;
  toast: ToastFn;
  confirm: ConfirmFn;
}

const STRATEGY_TP_SL: Record<string, [number, number]> = {
  SWING: [5.5, -3.0], DEFENSE: [5.0, -2.0], SCALPING: [0.8, -0.8], DIVIDEND: [3.0, -1.5], SNIPER: [8.0, -4.0], EOD_BETTING: [5.0, -3.0],
};

export default function KrHoldingsTab({ chains, dash, busyAction, guard, getStockName, onRefresh, viewMode = 'live', toast, confirm }: KrHoldingsTabProps) {
  const priceMap = useMemo(() => {
    const m: Record<string, number> = {};
    chains.forEach(ch => { if ((ch.currentPrice ?? 0) > 0) m[ch.stock_code] = ch.currentPrice!; });
    return m;
  }, [chains]);
  const flashMap = usePriceFlash(priceMap);

  if (chains.length === 0) {
    return (
      <div className="p-8 text-center space-y-3">
        <div className="text-2xl opacity-30">📦</div>
        <p className="text-sm text-slate-400">아직 투자 중인 종목이 없습니다</p>
        <p className="text-[11px] text-slate-600">장 중 10분 간격으로 자동 탐색 중</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-white/[0.03]">
      {chains.map((ch: Chain, i: number) => {
        const avgPrice = Number(ch.avg_buy_price) || 0;
        const qty = Number(ch.total_quantity) || 0;
        const invested = Number(ch.invested) || avgPrice * qty;
        const curAvg = Number(ch.current_averaging_count) || 0;
        const maxAvg = Number(ch.max_averaging_count) || 1;
        const [fallbackTp, fallbackSl] = STRATEGY_TP_SL[ch.strategy_mode as string] ?? [5.5, -3.0];
        const targetPct = Number(ch.target_profit_pct) || fallbackTp;
        const stopPct = Number(ch.stop_loss_pct) || fallbackSl;
        const pnl = ch.unrealizedPnl ?? 0;
        const pnlPct = ch.unrealizedPnlPct ?? 0;
        const resolvedName = toDisplayName(ch.stock_name, ch.stock_code);
        const displayName = isUnresolvedStockName(resolvedName, ch.stock_code)
          ? getStockName(ch.stock_code) : resolvedName;
        const isParking = ch.isParking === true;
        const weight = typeof ch.weight === 'number' ? ch.weight : null;

        /* 파킹 ETF 카드 */
        if (isParking) return (
          <div key={`c${i}`} className="p-4 bg-sky-950/50 border-l-2 border-sky-500/60">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] bg-sky-500/25 text-sky-300 border border-sky-500/40 px-2 py-0.5 rounded-full font-bold shrink-0">💰 파킹중</span>
                <span className="text-sm font-bold text-sky-100 truncate">{displayName}</span>
              </div>
              <div className="text-right shrink-0 ml-3">
                <div className="text-base font-black text-sky-300">{pnlPct > 0 ? '+' : ''}{pnlPct.toFixed(2)}%</div>
                <div className="text-[11px] text-sky-500">{pnl > 0 ? '+' : ''}{fmtWon(pnl)}</div>
              </div>
            </div>
            <div className="flex gap-4 mt-3">
              <div>
                <div className="text-[9px] text-slate-500">파킹금액</div>
                <div className="text-[12px] font-bold text-sky-200">{fmtWon(invested)}</div>
              </div>
              <div>
                <div className="text-[9px] text-slate-500">평단 / 현재가</div>
                <div className="text-[12px] font-bold text-slate-300">{fmtWon(avgPrice)} → {(ch.currentPrice ?? 0) > 0 ? fmtWon(ch.currentPrice!) : '-'}</div>
              </div>
              <div className="ml-auto text-right">
                <div className="text-[9px] text-sky-600">자산비중</div>
                <div className="text-[15px] font-black text-sky-400">{weight !== null ? `${weight}%` : '-'}</div>
              </div>
            </div>
            <div className="flex justify-end mt-3">
              <button disabled={!!busyAction} onClick={guard(`sell-park-${ch.stock_code}`, async () => {
                const lwP = livePrefix(viewMode);
                if (!await confirm({ title: `${lwP}${displayName} ${qty}주 전량 매도하시겠습니까?`, description: '파킹 해제', confirmLabel: '매도', confirmVariant: 'danger' })) return;
                try { const r = await api(`/sell-stock/${ch.stock_code}`, { method: 'POST', body: JSON.stringify({ is_paper: viewMode === 'paper' }), timeout: 40000 }); toast(r.message || '매도 완료', 'ok'); onRefresh(); }
                catch (err: unknown) { toast('매도 실패: ' + (err as Error).message, 'err'); }
              })} className="text-xs px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-rose-500/10 hover:text-rose-400 text-slate-500 transition-colors border border-white/[0.05] disabled:opacity-40">
                파킹 해제
              </button>
            </div>
          </div>
        );

        /* 일반 종목 카드 */
        const isClaudeBought = ch.trigger_source === 'CLAUDE';
        const range = targetPct - stopPct;
        const barPos = Math.max(0, Math.min(100, ((pnlPct - stopPct) / range) * 100));
        return (
          <div key={`c${i}`} className={`p-4 hover:bg-white/[0.01] transition-colors ${isClaudeBought ? 'bg-violet-950/40 border-l-2 border-violet-500/70' : 'bg-[#0f1320]'}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-bold truncate">{displayName}</span>
                  {isClaudeBought && <span className="text-[10px] bg-violet-500/20 text-violet-300 border border-violet-500/40 px-1.5 py-0.5 rounded font-bold shrink-0">AI픽</span>}
                  {ch.strategy_mode === 'EOD_BETTING'
                    ? <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.5 rounded font-bold shrink-0">🎰 종가베팅</span>
                    : <span className="text-[10px] bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded font-medium shrink-0">{ch.strategy_mode}</span>}
                  {ch.status === 'PROFIT_TAKING' && <span className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 rounded font-bold shrink-0">2단계↑</span>}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">평단 {fmtWon(avgPrice)} · {fmt(qty)}주{weight !== null ? ` · 비중 ${weight}%` : ''}</div>
              </div>
              <div className={`text-right shrink-0 rounded-lg px-1.5 py-0.5 transition-colors duration-300 ${flashMap[ch.stock_code] === 'up' ? 'bg-emerald-500/15' : flashMap[ch.stock_code] === 'down' ? 'bg-rose-500/15' : ''}`}>
                {(ch.currentPrice ?? 0) > 0 ? (
                  <>
                    <div className={`text-lg font-black ${pc(pnl)}`}>
                      {flashMap[ch.stock_code] === 'up' && <span className="text-emerald-400 text-xs mr-0.5">&#9650;</span>}
                      {flashMap[ch.stock_code] === 'down' && <span className="text-rose-400 text-xs mr-0.5">&#9660;</span>}
                      {pnlPct > 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                    </div>
                    <div className={`text-[11px] ${pc(pnl)}`}>{pnl > 0 ? '+' : ''}{fmtWon(pnl)}</div>
                  </>
                ) : <span className="text-xs text-slate-600">시세 로딩중</span>}
              </div>
            </div>
            {(ch.currentPrice ?? 0) > 0 && avgPrice > 0 && (
              <div className="mt-3">
                <div className="relative h-1.5 bg-white/[0.05] rounded-full overflow-visible">
                  <div className={`absolute h-full rounded-full transition-all duration-700 ${pnlPct >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`} style={{ width: `${barPos}%` }} />
                  <div className="absolute h-3 w-0.5 bg-white/20 rounded-full top-1/2 -translate-y-1/2" style={{ left: `${((0 - stopPct) / range) * 100}%` }} />
                </div>
                <div className="flex justify-between mt-0.5">
                  <span className="text-[9px] text-rose-500 tabular-nums">
                    {stopPct}% <span className="text-rose-600">({fmtWon(Math.round(avgPrice * (1 + stopPct / 100)))})</span>
                  </span>
                  <span className="text-[9px] text-emerald-500 tabular-nums">
                    +{targetPct}% <span className="text-emerald-600">({fmtWon(Math.round(avgPrice * (1 + targetPct / 100)))})</span>
                  </span>
                </div>
              </div>
            )}
            <div className="grid grid-cols-3 gap-2 mt-2">
              <div>
                <div className="text-[9px] text-slate-500 mb-0.5">투자금</div>
                <div className="text-[11px] font-bold truncate">{fmtWon(invested)}</div>
              </div>
              <div>
                <div className="text-[9px] text-slate-500 mb-0.5">진입가 → 현재</div>
                <div className="text-[10px] font-bold text-slate-300">{fmtWon(avgPrice)}</div>
                <div className="text-[10px] font-bold">{(ch.currentPrice ?? 0) > 0 ? fmtWon(ch.currentPrice!) : '-'}</div>
              </div>
              <div>
                <div className="text-[9px] text-slate-500 mb-0.5">목표가 / 손절가</div>
                <div className="text-[10px] font-bold text-emerald-400">{avgPrice > 0 ? fmtWon(Math.round(avgPrice * (1 + targetPct / 100))) : '-'} <span className="text-[9px] text-emerald-600">+{targetPct}%</span></div>
                <div className="text-[10px] font-bold text-rose-400">{avgPrice > 0 ? fmtWon(Math.round(avgPrice * (1 + stopPct / 100))) : '-'} <span className="text-[9px] text-rose-700">{stopPct}%</span></div>
              </div>
            </div>
            <div className="flex items-center gap-1.5 mt-3">
              <div className="flex gap-0.5">
                {Array.from({ length: maxAvg }, (_, j) => (
                  <span key={j} className={`w-3.5 h-3.5 rounded-full text-[8px] font-bold flex items-center justify-center ${j < curAvg ? 'bg-blue-500 text-white' : 'bg-white/[0.06] text-slate-600'}`}>{j + 1}</span>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-1">
                {ch.escape_target_price ? (
                  <button disabled={!!busyAction} onClick={guard(`esc-del-${ch.id}`, async () => {
                    try { await api(`/escape/${ch.id}?viewMode=${viewMode}`, { method: 'DELETE' }); onRefresh(); }
                    catch (err: unknown) { toast('취소 실패: ' + (err as Error).message, 'err'); }
                  })} className="text-xs px-2.5 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 font-bold border border-amber-500/30 animate-pulse whitespace-nowrap disabled:opacity-40">
                    탈출대기
                  </button>
                ) : (
                  <button disabled={!!busyAction} onClick={guard(`esc-${ch.id}`, async () => {
                    if (!await confirm({ title: displayName, description: '현재가 기준 +0.5% 돌파 시 자동 전량 매도합니다.' })) return;
                    try {
                      const r = await api(`/escape/${ch.id}?viewMode=${viewMode}`, { method: 'POST' });
                      toast(`탈출가 설정: ${fmtWon(r.escape_target_price)}`, 'ok');
                      onRefresh();
                    } catch (err: unknown) { toast('탈출 설정 실패: ' + (err as Error).message, 'err'); }
                  })} className="text-xs px-2.5 py-1.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 font-bold border border-amber-500/20 whitespace-nowrap disabled:opacity-40">
                    탈출
                  </button>
                )}
                <button disabled={!!busyAction} onClick={guard(`sell-${ch.stock_code}`, async () => {
                  const liveW = livePrefix(viewMode);
                  if (!await confirm({ title: `${liveW}${displayName} ${qty}주 전량 시장가 매도하시겠습니까?`, confirmLabel: '매도', confirmVariant: 'danger' })) return;
                  try { const r = await api(`/sell-stock/${ch.stock_code}`, { method: 'POST', body: JSON.stringify({ is_paper: viewMode === 'paper' }), timeout: 40000 }); toast(r.message || '매도 완료', 'ok'); onRefresh(); }
                  catch (err: unknown) { toast('매도 실패: ' + (err as Error).message, 'err'); }
                })} className="text-xs px-2.5 py-1.5 rounded-xl bg-white/[0.04] hover:bg-rose-500/10 hover:text-rose-400 text-slate-500 font-medium border border-white/[0.04] whitespace-nowrap disabled:opacity-40">
                  전량 매도
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
