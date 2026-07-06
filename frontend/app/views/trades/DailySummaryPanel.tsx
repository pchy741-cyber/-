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
            const dayPnl = day.realizedPnl + day.realizedPnlUsd;
            return (
              <div key={day.date}>
                {/* 일자별 요약 행 */}
                <div
                  className="flex items-center gap-2 px-4 py-3 cursor-pointer hover:bg-slate-800/20 transition-colors"
                  onClick={() => setExpandedDate(isExp ? null : day.date)}
                >
                  {/* 날짜 */}
                  <div className="font-semibold text-sm shrink-0 w-[60px] sm:w-20">{day.label}</div>

                  {/* 건수 */}
                  <div className="flex items-center gap-1 text-[11px] text-slate-500 shrink-0">
                    <span>{day.trades.length}건</span>
                    <span className="hidden sm:inline text-emerald-500/60">{day.buys}매수</span>
                    <span className="hidden sm:inline text-rose-500/60">{day.sells}매도</span>
                  </div>

                  <div className="flex-1" />

                  {/* 손익 */}
                  {day.sells > 0 && (
                    <div className="text-right shrink-0 flex flex-col items-end">
                      {day.realizedPnl !== 0 && (
                        <span className={`text-sm font-bold tabular-nums ${day.realizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {day.realizedPnl >= 0 ? '+' : ''}{day.realizedPnl.toLocaleString()}원
                        </span>
                      )}
                      {day.realizedPnlUsd !== 0 && (
                        <span className={`text-[11px] font-bold tabular-nums ${day.realizedPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {day.realizedPnlUsd >= 0 ? '+' : '-'}${Math.abs(day.realizedPnlUsd).toFixed(2)}
                        </span>
                      )}
                    </div>
                  )}

                  {/* 승률 */}
                  <div className="shrink-0 text-[11px] w-10 text-right tabular-nums">
                    {day.wins + day.losses > 0 ? (
                      <span className={day.winRate >= 50 ? 'text-emerald-400' : 'text-rose-400'}>
                        {day.winRate}%
                      </span>
                    ) : <span className="text-slate-600">-</span>}
                  </div>

                  <span className="text-[10px] text-slate-600 shrink-0 ml-0.5">{isExp ? '▲' : '▼'}</span>
                </div>

                {/* 확장: 매매 카드 리스트 */}
                {isExp && (
                  <div className="bg-slate-900/30 px-3 pb-3 space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
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
                      // Fallback: 수수료 반영 (국내 매도 0.195%, 해외 매수+매도 각 0.35%)
                      const KR_SELL_FEE = 0.00195;
                      const OS_FEE = 0.0035;
                      const fallbackPnl = !os && isSell && avgBuy > 0 && fillPrice > 0
                        ? (fillPrice * (1 - KR_SELL_FEE) - avgBuy) * qty : null;
                      const fallbackPct = !os && isSell && avgBuy > 0 && fillPrice > 0
                        ? ((fillPrice * (1 - KR_SELL_FEE) - avgBuy) / avgBuy) * 100 : null;
                      const osCostBasis = avgBuy * (1 + OS_FEE);
                      const osFallbackPnl = os && isSell && avgBuy > 0 && fillPrice > 0
                        ? (fillPrice * (1 - OS_FEE) - osCostBasis) * qty : null;
                      const osFallbackPct = os && isSell && avgBuy > 0 && fillPrice > 0
                        ? ((fillPrice * (1 - OS_FEE) - osCostBasis) / osCostBasis) * 100 : null;
                      const tradePnl = os ? (apiPnlUsd ?? osFallbackPnl) : (apiPnl ?? fallbackPnl);
                      const tradePnlPct = apiPnlPct ?? (os ? osFallbackPct : fallbackPct);

                      return (
                        <div key={t.id || i} className="flex items-center gap-2 bg-white/[0.02] hover:bg-white/[0.04] rounded-xl px-3 py-2 transition-colors">
                          <SideBadge side={t.side} isAverageDown={false} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              {os && <span className="text-[9px]">🌏</span>}
                              <span className="text-[12px] font-semibold text-slate-200 truncate">{getName(t)}</span>
                              <span className="text-[10px] text-slate-600 tabular-nums shrink-0">
                                {new Date(t.created_at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-500">
                              <span className="tabular-nums">{fmt(t.filled_quantity ?? t.quantity)}주 × {os ? fmtUsd(fillPrice) : fmtWon(fillPrice)}</span>
                              <span className="truncate text-slate-600">{simplifyReason(t.ai_reasoning, t.side)}</span>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            {isSell && tradePnl !== null && tradePnlPct !== null ? (
                              <div className={tradePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                <div className="text-[12px] font-bold tabular-nums">{tradePnlPct >= 0 ? '+' : ''}{tradePnlPct.toFixed(1)}%</div>
                                <div className="text-[10px] opacity-70 tabular-nums">
                                  {os ? `$${Math.abs(tradePnl).toFixed(1)}` : `${Math.round(tradePnl).toLocaleString()}`}
                                </div>
                              </div>
                            ) : <span className="text-slate-700 text-[10px]">-</span>}
                          </div>
                        </div>
                      );
                    })}
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
