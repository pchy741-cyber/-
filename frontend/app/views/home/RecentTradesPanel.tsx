'use client';

import React from 'react';
import { Panel, SideBadge, EmptyMsg } from '@/components/ui';
import { fmt, fmtWon, fmtUsd, fmtTime, pc } from '../../lib/utils';
import { toDisplayName, isUnresolvedStockName, simplifyReason, isOverseasTrade as isOvTrade } from '../../lib/helpers';
import { TRIGGER_LABELS } from '../strategy-lab/constants';
import type { Trade } from '../../types';

interface RecentTradesPanelProps {
  filled: Trade[];
  holdingsTab: 'KR' | 'US';
  expandedTradeIdx: number | null;
  setExpandedTradeIdx: (v: number | null) => void;
  getStockName: (code: string) => string;
}

export default function RecentTradesPanel({
  filled, holdingsTab, expandedTradeIdx, setExpandedTradeIdx, getStockName,
}: RecentTradesPanelProps) {
  const isUsTab = holdingsTab === 'US';
  const tabFiltered = filled.filter((t: Trade) => {
    const isOv = isOvTrade(t);
    return isUsTab ? isOv : !isOv;
  });
  const kstToday = new Date(Date.now() + 9 * 3600_000).toISOString().split('T')[0];
  const todayTabTrades = tabFiltered.filter((t: Trade) => new Date(new Date(t.created_at).getTime() + 9 * 3600_000).toISOString().split('T')[0] === kstToday);

  return (
    <Panel title={isUsTab ? '최근 매매 (미국)' : '최근 매매'} badge={`오늘 ${todayTabTrades.length}건`} badgeColor={todayTabTrades.length > 0 ? 'emerald' : undefined}>
      {tabFiltered.length === 0 ? <EmptyMsg>매매 기록 없음</EmptyMsg> : (
        <div className="divide-y divide-white/[0.03]">
          {tabFiltered.slice(0, 10).map((t: Trade, i: number) => {
            const isOverseas = isOvTrade(t);
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
                    <span className="text-[9px] bg-white/[0.06] text-slate-400 px-1.5 py-0.5 rounded-md">{TRIGGER_LABELS[t.trigger_source ?? ''] ?? t.trigger_source ?? '-'}</span>
                    {t.status === 'PENDING' && <span className="text-[9px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded-md animate-pulse font-bold">{t.side === 'BUY' ? '구매중' : '매도중'}</span>}
                    <span className="text-[10px] text-slate-600">{fmtTime(t.created_at)}</span>
                  </div>
                  <div className={`text-[11px] text-slate-500 mt-0.5 ${isExpanded ? 'whitespace-pre-wrap break-words' : 'truncate'}`}>
                    {simplifyReason(t.ai_reasoning, t.side)}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-bold">{isOverseas ? fmtUsd(Number(t.filled_price)) : fmtWon(Number(t.filled_price))}</div>
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
