'use client';

import React from 'react';
import { Panel, SideBadge, StatusBadge } from '@/components/ui';
import { fmt, fmtWon, fmtUsd, fmtTime } from '../../lib/utils';
import { simplifyReason } from '../../lib/helpers';
import type { Trade } from '../../types';

export function TradeListPanel({
  filtered,
  isOverseas,
  getName,
}: {
  filtered: Trade[];
  isOverseas: (t: Trade) => boolean;
  getName: (t: Trade) => string;
}) {
  const [expanded, setExpanded] = React.useState<string | null>(null);

  if (filtered.length === 0) {
    return (
      <Panel title="매매내역" badge={`${filtered.length}건`}>
        <div className="p-8 text-center space-y-2">
          <div className="text-2xl opacity-30">📋</div>
          <p className="text-sm text-slate-400">아직 매매 기록이 없습니다</p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="매매내역" badge={`${filtered.length}건`}>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead><tr className="text-slate-500 border-b border-slate-700/30">
            <th className="px-4 py-3 text-left font-medium">시간</th>
            <th className="px-4 py-3 text-left font-medium">종목</th>
            <th className="px-4 py-3 text-center font-medium">구분</th>
            <th className="px-4 py-3 text-right font-medium">수량</th>
            <th className="px-4 py-3 text-right font-medium">체결가</th>
            <th className="px-4 py-3 text-right font-medium">손익</th>
            <th className="px-4 py-3 text-center font-medium">상태</th>
            <th className="px-4 py-3 text-center font-medium">모드</th>
            <th className="px-4 py-3 text-left font-medium">내용</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-800/20">
            {filtered.map((t: Trade, i: number) => {
              const chain = t.transaction_chains;
              const tradeKey = String(t.id || t.kis_order_no || `t${i}`);
              const isOpen = expanded === tradeKey;
              const isSell = t.side === 'SELL';
              const overseas = isOverseas(t);
              const avgBuy = Number(chain?.avg_buy_price) || 0;
              const filledPrice = Number(t.filled_price) || 0;
              const qty = Number(t.quantity) || 0;
              const apiPnl = typeof t.realized_pnl === 'number' ? Number(t.realized_pnl) : null;
              const apiPnlPct = typeof t.realized_pnl_pct === 'number' ? Number(t.realized_pnl_pct) : null;
              const apiPnlUsd = typeof t.realized_pnl_usd === 'number' ? Number(t.realized_pnl_usd) : null;
              const fallbackPnl = !overseas && isSell && avgBuy > 0 && filledPrice > 0 ? (filledPrice - avgBuy) * qty : null;
              const fallbackPnlPct = !overseas && isSell && avgBuy > 0 && filledPrice > 0 ? ((filledPrice - avgBuy) / avgBuy) * 100 : null;
              const overseasFallbackPnl = overseas && isSell && avgBuy > 0 && filledPrice > 0 ? (filledPrice - avgBuy) * qty : null;
              const overseasFallbackPnlPct = overseas && isSell && avgBuy > 0 && filledPrice > 0 ? ((filledPrice - avgBuy) / avgBuy) * 100 : null;
              const overseasReasonPct = overseas && isSell && apiPnlPct === null
                ? (() => { const m = String(t.ai_reasoning || '').match(/[익손절]+\(([+-]?[\d.]+)%\)/); return m ? Number(m[1]) : null; })()
                : null;
              const overseasPnlUsdAmt = overseasReasonPct !== null && filledPrice > 0 && qty > 0
                ? filledPrice * qty * (overseasReasonPct / 100) : null;
              const tradePnl = overseas ? (apiPnlUsd ?? overseasPnlUsdAmt ?? overseasFallbackPnl) : (apiPnl ?? fallbackPnl);
              const tradePnlPct = apiPnlPct ?? (overseas ? (overseasReasonPct ?? overseasFallbackPnlPct) : fallbackPnlPct);
              return (
              <React.Fragment key={tradeKey}>
              <tr onClick={() => setExpanded(isOpen ? null : tradeKey)} className={`hover:bg-slate-800/20 transition-colors cursor-pointer${overseas ? ' opacity-60' : ''}`}>
                <td className="px-4 py-3 text-slate-500">{fmtTime(t.created_at)}</td>
                <td className="px-4 py-3 font-semibold">
                  {overseas && <span className="text-[10px] mr-1">🌏</span>}
                  {getName(t)}
                </td>
                <td className="px-4 py-3 text-center"><SideBadge side={t.side} isAverageDown={t.side === 'BUY' && (String(t.ai_reasoning ?? '').includes('AVERAGE') || String(t.ai_reasoning ?? '').includes('물타기') || String(t.ai_reasoning ?? '').includes('추가 매수'))} /></td>
                <td className="px-4 py-3 text-right">{fmt(t.filled_quantity ?? t.quantity)}</td>
                <td className="px-4 py-3 text-right font-medium">{overseas ? fmtUsd(filledPrice) : fmtWon(filledPrice)}</td>
                <td className="px-4 py-3 text-right">
                  {tradePnl !== null && tradePnlPct !== null ? (
                    <div className={tradePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      <div className="font-semibold text-[12px]">{tradePnlPct >= 0 ? '+' : ''}{tradePnlPct.toFixed(1)}%</div>
                      <div className="text-[11px] opacity-80">
                        {tradePnl >= 0 ? '+' : ''}{overseas ? `$${Math.abs(tradePnl).toFixed(2)}` : `${Math.round(tradePnl).toLocaleString()}원`}
                      </div>
                    </div>
                  ) : <span className="text-slate-600 text-[11px]">-</span>}
                </td>
                <td className="px-4 py-3 text-center"><StatusBadge status={t.status} /></td>
                <td className="px-4 py-3 text-center">
                  {chain?.strategy_mode === 'EOD_BETTING'
                    ? <span className="px-1.5 py-0.5 rounded text-[11px] bg-amber-900/30 text-amber-300 font-bold">🎰 종가</span>
                    : chain?.strategy_mode
                    ? <span className="px-1.5 py-0.5 rounded text-[11px] bg-blue-900/30 text-blue-300">{chain.strategy_mode}</span>
                    : t.trigger_source === 'OVERSEAS'
                      ? <span className="px-1.5 py-0.5 rounded text-[11px] bg-purple-900/30 text-purple-300">미국</span>
                      : t.trigger_source === 'MANUAL'
                        ? <span className="px-1.5 py-0.5 rounded text-[11px] bg-slate-700/50 text-slate-400">수동</span>
                        : <span className="px-1.5 py-0.5 rounded text-[11px] bg-slate-700/50 text-slate-500">{t.trigger_source ?? '-'}</span>
                  }
                </td>
                <td className="px-4 py-3 text-slate-400 max-w-[200px]">
                  <div className="flex items-center gap-1">
                    <div className="truncate font-medium text-slate-300" title={t.ai_reasoning}>{simplifyReason(t.ai_reasoning, t.side)}</div>
                    <span className="text-[10px] text-slate-600 shrink-0">{isOpen ? '▲' : '▼'}</span>
                  </div>
                </td>
              </tr>
              {isOpen && (
                <tr className="bg-slate-900/40">
                  <td colSpan={9} className="px-5 py-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                      <div>
                        <p className="text-slate-500 font-medium mb-1.5">상세 내용</p>
                        <p className="text-slate-300 leading-relaxed whitespace-pre-wrap">{t.ai_reasoning || '기록 없음'}</p>
                      </div>
                      <div>
                        <p className="text-slate-500 font-medium mb-1.5">매매 전략</p>
                        {chain?.strategy_mode ? (
                          <div className="space-y-1 text-slate-400">
                            <p>전략: <span className="text-slate-200 font-medium">{chain.strategy_mode}</span></p>
                            <p>평단가: <span className="text-slate-200">{Number(chain.avg_buy_price).toLocaleString()}원</span></p>
                            <p>상태: <span className="text-slate-200">{chain.status}</span></p>
                          </div>
                        ) : overseas ? (
                          <p className="text-slate-400">미국주식 자동매매</p>
                        ) : (
                          <p className="text-slate-500">체인 정보 없음</p>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
