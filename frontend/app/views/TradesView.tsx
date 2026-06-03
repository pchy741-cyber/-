'use client';

import React, { useState } from 'react';
import { ToggleGroup } from '@/components/ToggleGroup';
import { toDisplayName, isUnresolvedStockName } from '../lib/helpers';
import type { Trade, WatchlistItem } from '../types';
import { useTradeSummaries } from './trades/useTradeSummaries';
import { DailySummaryPanel } from './trades/DailySummaryPanel';
import { TradeListPanel } from './trades/TradeListPanel';

function TradesView({ trades, watchlist }: { trades: Trade[]; watchlist: WatchlistItem[] }) {
  const nameMap = new Map(watchlist.map((w: WatchlistItem) => [w.stock_code, w.stock_name]));
  const getName = (t: Trade) => {
    const apiName = toDisplayName(t.stock_name, t.stock_code);
    if (!isUnresolvedStockName(apiName, t.stock_code)) return apiName;
    return toDisplayName(nameMap.get(t.stock_code), t.stock_code);
  };
  const [mktFilter, setMktFilter] = useState<'ALL' | 'KR' | 'US'>('ALL');
  const [viewMode, setViewMode] = useState<'DAILY' | 'ALL'>('DAILY');
  const [expandedDate, setExpandedDate] = useState<string | null>(null);

  const filled = trades.filter((t: Trade) => t.status === 'FILLED' || (t.status === 'PENDING' && t.trigger_source === 'OVERSEAS'));
  const isOverseas = (t: Trade) => t.trigger_source === 'OVERSEAS';
  const filtered = mktFilter === 'ALL' ? filled : mktFilter === 'KR' ? filled.filter((t: Trade) => !isOverseas(t)) : filled.filter((t: Trade) => isOverseas(t));

  const dailySummaries = useTradeSummaries(filtered, isOverseas);

  // 전체 통계
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

      {viewMode === 'DAILY' && (
        <DailySummaryPanel
          dailySummaries={dailySummaries}
          expandedDate={expandedDate}
          setExpandedDate={setExpandedDate}
          isOverseas={isOverseas}
          getName={getName}
        />
      )}

      {viewMode === 'ALL' && (
        <TradeListPanel filtered={filtered} isOverseas={isOverseas} getName={getName} />
      )}
    </div>
  );
}

export default TradesView;
