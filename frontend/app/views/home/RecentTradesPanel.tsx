'use client';

import React from 'react';
import { Panel, SideBadge, EmptyMsg } from '@/components/ui';
import { fmt, fmtWon, fmtUsd, fmtTime, pc } from '../../lib/utils';
import { toDisplayName, isUnresolvedStockName } from '../../lib/helpers';

interface RecentTradesPanelProps {
  filled: any[];
  holdingsTab: 'KR' | 'US';
  expandedTradeIdx: number | null;
  setExpandedTradeIdx: (v: number | null) => void;
  getStockName: (code: string) => string;
}

export default function RecentTradesPanel({
  filled, holdingsTab, expandedTradeIdx, setExpandedTradeIdx, getStockName,
}: RecentTradesPanelProps) {
  const isUsTab = holdingsTab === 'US';
  const tabFiltered = filled.filter((t: any) => {
    const isOv = t.trigger_source === 'OVERSEAS' || Number(t.filled_price) < 1000;
    return isUsTab ? isOv : !isOv;
  });
  const todayTabTrades = tabFiltered.filter((t: any) => new Date(t.created_at).toDateString() === new Date().toDateString());

  return (
    <Panel title={isUsTab ? '최근 매매 (미국)' : '최근 매매'} badge={`오늘 ${todayTabTrades.length}건`} badgeColor={todayTabTrades.length > 0 ? 'emerald' : undefined}>
      {tabFiltered.length === 0 ? <EmptyMsg>매매 기록 없음</EmptyMsg> : (
        <div className="divide-y divide-white/[0.03]">
          {tabFiltered.slice(0, 10).map((t: any, i: number) => {
            const isOverseasTrade = t.trigger_source === 'OVERSEAS' || Number(t.filled_price) < 1000;
            const isExpanded = expandedTradeIdx === i;
            return (
              <div key={i} onClick={() => setExpandedTradeIdx(isExpanded ? null : i)}
                className="flex items-start gap-3 px-4 py-3 hover:bg-white/[0.02] cursor-pointer">
                <SideBadge side={t.side} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-slate-200">
                      {(() => {
                        const resolved = toDisplayName(t.stock_name, t.stock_code);
                        return isUnresolvedStockName(resolved, t.stock_code) ? getStockName(t.stock_code) : resolved;
                      })()}
                    </span>
                    {isOverseasTrade && <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-md">🇺🇸</span>}
                    <span className="text-[10px] text-slate-600">{fmtTime(t.created_at)}</span>
                  </div>
                  <div className={`text-[11px] text-slate-500 mt-0.5 ${isExpanded ? 'whitespace-pre-wrap break-words' : 'truncate'}`}>
                    {t.ai_reasoning || '-'}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-bold">{isOverseasTrade ? fmtUsd(Number(t.filled_price)) : fmtWon(Number(t.filled_price))}</div>
                  <div className="text-[10px] text-slate-500">{fmt(t.quantity)}주</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
