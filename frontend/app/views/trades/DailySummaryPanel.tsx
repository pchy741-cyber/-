'use client';

import React from 'react';
import { Panel, SideBadge, EmptyMsg } from '@/components/ui';
import { fmt, fmtWon, fmtUsd } from '../../lib/utils';
import { simplifyReason } from '../../lib/helpers';
import type { Trade, DaySummary } from '../../types';

export function DailySummaryPanel({
  dailySummaries,
  expandedDate,
  setExpandedDate,
  isOverseas,
  getName,
}: {
  dailySummaries: DaySummary[];
  expandedDate: string | null;
  setExpandedDate: (d: string | null) => void;
  isOverseas: (t: Trade) => boolean;
  getName: (t: Trade) => string;
}) {
  return (
    <Panel title="일자별 손익" badge={`${dailySummaries.length}일`}>
      {dailySummaries.length === 0 ? (
        <EmptyMsg icon="📊">매매 기록이 없습니다</EmptyMsg>
      ) : (
        <div className="divide-y divide-slate-800/30">
          {dailySummaries.map(day => {
            const isExp = expandedDate === day.date;
            return (
              <div key={day.date}>
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-800/20 transition-colors"
                  onClick={() => setExpandedDate(isExp ? null : day.date)}
                >
                  <div className="font-semibold text-sm w-24 shrink-0">{day.label}</div>
                  <div className="flex items-center gap-2 text-[12px] text-slate-500 shrink-0">
                    <span>{day.trades.length}건</span>
                    <span className="text-emerald-500/60">{day.buys}매수</span>
                    <span className="text-rose-500/60">{day.sells}매도</span>
                  </div>
                  <div className="flex-1" />
                  {day.sells > 0 && (
                    <div className="text-right shrink-0">
                      {day.realizedPnl !== 0 && (
                        <span className={`text-sm font-bold ${day.realizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {day.realizedPnl >= 0 ? '+' : ''}{day.realizedPnl.toLocaleString()}원
                        </span>
                      )}
                      {day.realizedPnlUsd !== 0 && (
                        <span className={`text-sm font-bold ml-2 ${day.realizedPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {day.realizedPnlUsd >= 0 ? '+' : ''}${Math.abs(day.realizedPnlUsd).toFixed(2)}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="shrink-0 text-[12px] w-16 text-right">
                    {day.wins + day.losses > 0 ? (
                      <span className={day.winRate >= 50 ? 'text-emerald-400' : 'text-rose-400'}>
                        {day.winRate}% <span className="text-slate-600">{day.wins}/{day.wins + day.losses}</span>
                      </span>
                    ) : <span className="text-slate-600">-</span>}
                  </div>
                  <span className="text-[10px] text-slate-600 shrink-0">{isExp ? '▲' : '▼'}</span>
                </div>

                {isExp && (
                  <div className="bg-slate-900/30 px-4 pb-3">
                    <table className="w-full text-[12px]">
                      <thead><tr className="text-slate-500 border-b border-slate-700/20">
                        <th className="px-2 py-2 text-left">시간</th>
                        <th className="px-2 py-2 text-left">종목</th>
                        <th className="px-2 py-2 text-center">구분</th>
                        <th className="px-2 py-2 text-right">수량</th>
                        <th className="px-2 py-2 text-right">체결가</th>
                        <th className="px-2 py-2 text-right">손익</th>
                        <th className="px-2 py-2 text-left">내용</th>
                      </tr></thead>
                      <tbody className="divide-y divide-slate-800/15">
                        {day.trades.map((t: Trade, i: number) => {
                          const chain = t.transaction_chains;
                          const os = isOverseas(t);
                          const isSell = t.side === 'SELL';
                          const avgBuy = Number(chain?.avg_buy_price) || 0;
                          const fillPrice = Number(t.filled_price) || 0;
                          const qty = Number(t.filled_quantity ?? t.quantity) || 0;
                          const apiPnl = typeof t.realized_pnl === 'number' ? t.realized_pnl : null;
                          const apiPnlPct = typeof t.realized_pnl_pct === 'number' ? t.realized_pnl_pct : null;
                          const apiPnlUsd = typeof t.realized_pnl_usd === 'number' ? t.realized_pnl_usd : null;
                          const calcPnl = avgBuy > 0 && fillPrice > 0 ? (fillPrice - avgBuy) * qty : null;
                          const calcPct = avgBuy > 0 && fillPrice > 0 ? ((fillPrice - avgBuy) / avgBuy) * 100 : null;
                          const tradePnl = os ? (apiPnlUsd ?? calcPnl) : (apiPnl ?? calcPnl);
                          const tradePnlPct = apiPnlPct ?? calcPct;

                          return (
                            <tr key={t.id || i} className="hover:bg-slate-800/10">
                              <td className="px-2 py-2 text-slate-500">{new Date(t.created_at).toLocaleTimeString('ko', { hour: '2-digit', minute: '2-digit' })}</td>
                              <td className="px-2 py-2 font-medium">
                                {os && <span className="text-[9px] mr-0.5">🌏</span>}
                                {getName(t)}
                              </td>
                              <td className="px-2 py-2 text-center"><SideBadge side={t.side} isAverageDown={false} /></td>
                              <td className="px-2 py-2 text-right">{fmt(t.filled_quantity ?? t.quantity)}</td>
                              <td className="px-2 py-2 text-right">{os ? fmtUsd(fillPrice) : fmtWon(fillPrice)}</td>
                              <td className="px-2 py-2 text-right">
                                {isSell && tradePnl !== null && tradePnlPct !== null ? (
                                  <span className={tradePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                    {tradePnlPct >= 0 ? '+' : ''}{tradePnlPct.toFixed(1)}%
                                    <span className="text-[10px] opacity-70 ml-0.5">
                                      ({os ? `$${Math.abs(tradePnl).toFixed(1)}` : `${Math.round(tradePnl).toLocaleString()}`})
                                    </span>
                                  </span>
                                ) : <span className="text-slate-700">-</span>}
                              </td>
                              <td className="px-2 py-2 text-slate-400 truncate max-w-[150px]" title={t.ai_reasoning}>
                                {simplifyReason(t.ai_reasoning, t.side)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
