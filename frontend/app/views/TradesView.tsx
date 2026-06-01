'use client';

import React, { useState, useMemo } from 'react';
import { Panel, SideBadge, StatusBadge, EmptyMsg } from '@/components/ui';
import { ToggleGroup } from '@/components/ToggleGroup';
import { fmt, fmtWon, fmtUsd, fmtPct, fmtTime, pc } from '../lib/utils';
import { toDisplayName, isUnresolvedStockName, simplifyReason } from '../lib/helpers';

// ── 일자별 요약 타입 ──
interface DaySummary {
  date: string;
  label: string;
  trades: any[];
  buys: number;
  sells: number;
  realizedPnl: number;
  realizedPnlUsd: number;
  wins: number;
  losses: number;
  winRate: number;
}

function TradesView({ trades, watchlist }: { trades: any[]; watchlist: any[] }) {
  const nameMap = new Map(watchlist.map((w: any) => [w.stock_code, w.stock_name]));
  const getName = (t: any) => {
    const apiName = toDisplayName(t.stock_name, t.stock_code);
    if (!isUnresolvedStockName(apiName, t.stock_code)) return apiName;
    return toDisplayName(nameMap.get(t.stock_code), t.stock_code);
  };
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mktFilter, setMktFilter] = useState<'ALL' | 'KR' | 'US'>('ALL');
  const [viewMode, setViewMode] = useState<'DAILY' | 'ALL'>('DAILY');
  const [expandedDate, setExpandedDate] = useState<string | null>(null);

  const filled = trades.filter((t: any) => t.status === 'FILLED' || (t.status === 'PENDING' && t.trigger_source === 'OVERSEAS'));
  const isOverseas = (t: any) => t.trigger_source === 'OVERSEAS';
  const filtered = mktFilter === 'ALL' ? filled : mktFilter === 'KR' ? filled.filter((t: any) => !isOverseas(t)) : filled.filter((t: any) => isOverseas(t));

  // ── 일자별 그룹핑 ──
  const dailySummaries = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const t of filtered) {
      const d = new Date(t.created_at);
      // KST 기준 날짜
      const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      const dateKey = kst.toISOString().slice(0, 10);
      if (!groups.has(dateKey)) groups.set(dateKey, []);
      groups.get(dateKey)!.push(t);
    }

    const days: DaySummary[] = [];
    const weekNames = ['일', '월', '화', '수', '목', '금', '토'];
    for (const [date, dayTrades] of [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      const dt = new Date(date + 'T00:00:00+09:00');
      const label = `${date.slice(5)} (${weekNames[dt.getDay()]})`;
      const sellTrades = dayTrades.filter((t: any) => t.side === 'SELL');
      let pnl = 0;
      let pnlUsd = 0;
      let wins = 0;
      let losses = 0;

      for (const t of sellTrades) {
        const os = isOverseas(t);
        const chain = t.transaction_chains;
        const avgBuy = Number(chain?.avg_buy_price) || 0;
        const fillPrice = Number(t.filled_price) || 0;
        const qty = Number(t.filled_quantity ?? t.quantity) || 0;
        const apiPnl = typeof t.realized_pnl === 'number' ? Number(t.realized_pnl) : null;
        const apiPnlUsd = typeof t.realized_pnl_usd === 'number' ? Number(t.realized_pnl_usd) : null;
        const calcPnl = avgBuy > 0 && fillPrice > 0 ? (fillPrice - avgBuy) * qty : null;
        const tradePnl = os ? (apiPnlUsd ?? calcPnl) : (apiPnl ?? calcPnl);

        if (tradePnl !== null) {
          if (os) pnlUsd += tradePnl;
          else pnl += tradePnl;
          if (tradePnl > 0) wins++;
          else losses++;
        }
      }

      days.push({
        date,
        label,
        trades: dayTrades,
        buys: dayTrades.filter((t: any) => t.side === 'BUY').length,
        sells: sellTrades.length,
        realizedPnl: Math.round(pnl),
        realizedPnlUsd: Math.round(pnlUsd * 100) / 100,
        wins,
        losses,
        winRate: (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0,
      });
    }
    return days;
  }, [filtered]);

  // ── 전체 통계 ──
  const totalPnlKrw = dailySummaries.reduce((s, d) => s + d.realizedPnl, 0);
  const totalPnlUsd = dailySummaries.reduce((s, d) => s + d.realizedPnlUsd, 0);
  const totalWins = dailySummaries.reduce((s, d) => s + d.wins, 0);
  const totalLosses = dailySummaries.reduce((s, d) => s + d.losses, 0);
  const profitDays = dailySummaries.filter(d => d.realizedPnl + d.realizedPnlUsd > 0).length;
  const lossDays = dailySummaries.filter(d => d.realizedPnl + d.realizedPnlUsd < 0).length;

  return (
    <div className="space-y-4">
      {/* 필터 행 */}
      <div className="flex items-center gap-3 flex-wrap">
        <ToggleGroup
          value={mktFilter}
          items={[
            { value: 'ALL' as const, label: '전체' },
            { value: 'KR' as const, label: '국내' },
            { value: 'US' as const, label: '해외' },
          ]}
          onChange={setMktFilter}
        />
        <ToggleGroup
          value={viewMode}
          items={[
            { value: 'DAILY' as const, label: '일자별' },
            { value: 'ALL' as const, label: '전체목록' },
          ]}
          onChange={setViewMode}
        />
      </div>

      {/* 종합 통계 */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">총 체결</div>
          <div className="text-lg font-black mt-1">{filtered.length}건</div>
        </div>
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">실현 손익(원)</div>
          <div className={`text-lg font-black mt-1 ${totalPnlKrw >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {totalPnlKrw >= 0 ? '+' : ''}{totalPnlKrw.toLocaleString()}
          </div>
        </div>
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">실현 손익($)</div>
          <div className={`text-lg font-black mt-1 ${totalPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {totalPnlUsd >= 0 ? '+' : ''}${Math.abs(totalPnlUsd).toFixed(2)}
          </div>
        </div>
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">승률</div>
          <div className="text-lg font-black mt-1">
            {(totalWins + totalLosses) > 0 ? Math.round((totalWins / (totalWins + totalLosses)) * 100) : 0}%
            <span className="text-[11px] text-slate-500 ml-1">{totalWins}W/{totalLosses}L</span>
          </div>
        </div>
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">수익일/손실일</div>
          <div className="text-lg font-black mt-1">
            <span className="text-emerald-400">{profitDays}</span>
            <span className="text-slate-600 mx-1">/</span>
            <span className="text-rose-400">{lossDays}</span>
          </div>
        </div>
      </div>

      {/* ── 일자별 뷰 ── */}
      {viewMode === 'DAILY' && (
        <Panel title="일자별 손익" badge={`${dailySummaries.length}일`}>
          {dailySummaries.length === 0 ? (
            <EmptyMsg icon="📊" text="매매 기록이 없습니다" />
          ) : (
            <div className="divide-y divide-slate-800/30">
              {dailySummaries.map(day => {
                const isExp = expandedDate === day.date;
                const combinedPnl = day.realizedPnl + day.realizedPnlUsd * 1500;
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

                    {/* 펼친 상태: 해당 일자 거래 목록 */}
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
                            {day.trades.map((t: any, i: number) => {
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
      )}

      {/* ── 전체 목록 뷰 (기존) ── */}
      {viewMode === 'ALL' && (
        <Panel title="매매내역" badge={`${filtered.length}건`}>
          {filtered.length === 0 ? (
            <div className="p-8 text-center space-y-2">
              <div className="text-2xl opacity-30">📋</div>
              <p className="text-sm text-slate-400">아직 매매 기록이 없습니다</p>
            </div>
          ) : (
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
                {filtered.map((t: any, i: number) => {
                  const chain = t.transaction_chains;
                  const tradeKey = t.id || t.kis_order_no || `t${i}`;
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
                      {chain?.strategy_mode
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
          )}
        </Panel>
      )}
    </div>
  );
}

export default TradesView;
