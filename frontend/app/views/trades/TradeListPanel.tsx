'use client';

import React from 'react';
import { Panel, SideBadge, StatusBadge } from '@/components/ui';
import { fmt, fmtWon, fmtUsd, fmtTime } from '../../lib/utils';
import { simplifyReason } from '../../lib/helpers';
import { STRATEGY_LABELS, TRIGGER_LABELS } from '../strategy-lab/constants';
import type { Trade } from '../../types';

const STRATEGY_COLORS: Record<string, string> = {
  SWING:         'bg-blue-900/30 text-blue-300',
  PULLBACK:      'bg-violet-900/30 text-violet-300',
  BREAKOUT:      'bg-orange-900/30 text-orange-300',
  SCALPING:      'bg-yellow-900/30 text-yellow-300',
  PARKING:       'bg-teal-900/30 text-teal-300',
  EOD_BETTING:   'bg-amber-900/30 text-amber-300',
  SNIPER:        'bg-rose-900/30 text-rose-300',
  DEFENSE:       'bg-cyan-900/30 text-cyan-300',
  BOTTOM_FISHING:'bg-emerald-900/30 text-emerald-300',
  DIVIDEND:      'bg-lime-900/30 text-lime-300',
};

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
      <div className="divide-y divide-white/[0.03]">
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

          const stratMode = chain?.strategy_mode;
          const stratLabel = stratMode ? (STRATEGY_LABELS[stratMode] ?? stratMode) : null;
          const stratColors = stratMode ? (STRATEGY_COLORS[stratMode] ?? 'bg-blue-900/30 text-blue-300') : null;
          const trigLabel = TRIGGER_LABELS[t.trigger_source ?? ''] ?? t.trigger_source ?? '-';

          return (
            <div
              key={tradeKey}
              onClick={() => setExpanded(isOpen ? null : tradeKey)}
              className={`px-4 py-3 cursor-pointer transition-colors hover:bg-white/[0.02] ${overseas ? 'opacity-70' : ''}`}
            >
              {/* Row 1: 시간 + 종목명 + 구분 뱃지 */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-600 tabular-nums shrink-0">{fmtTime(t.created_at)}</span>
                <SideBadge side={t.side} isAverageDown={t.side === 'BUY' && (String(t.ai_reasoning ?? '').includes('AVERAGE') || String(t.ai_reasoning ?? '').includes('물타기') || String(t.ai_reasoning ?? '').includes('추가 매수'))} />
                <span className="text-sm font-bold text-slate-200 truncate">
                  {overseas && <span className="text-[10px] mr-0.5">🌏</span>}
                  {getName(t)}
                </span>
                <div className="ml-auto flex items-center gap-1.5 shrink-0">
                  <StatusBadge status={t.status} />
                  {stratMode ? (
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${stratColors}${stratMode === 'EOD_BETTING' ? ' font-bold' : ''}`}>
                      {stratMode === 'EOD_BETTING' ? '🎰' : ''}{stratLabel}
                    </span>
                  ) : (
                    <span className={`px-1.5 py-0.5 rounded text-[9px] ${t.trigger_source === 'OVERSEAS' ? 'bg-purple-900/30 text-purple-300' : 'bg-slate-700/50 text-slate-400'}`}>
                      {trigLabel}
                    </span>
                  )}
                </div>
              </div>

              {/* Row 2: 수량 + 체결가 + 손익 */}
              <div className="flex items-center justify-between mt-1.5 text-[11px]">
                <div className="flex items-center gap-2 text-slate-500">
                  <span className="tabular-nums">{fmt(t.filled_quantity ?? t.quantity)}주</span>
                  <span className="text-slate-600">×</span>
                  <span className="tabular-nums font-medium text-slate-300">{overseas ? fmtUsd(filledPrice) : fmtWon(filledPrice)}</span>
                </div>
                {tradePnl !== null && tradePnlPct !== null ? (
                  <div className={`text-right shrink-0 ${tradePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    <span className="font-bold tabular-nums">{tradePnlPct >= 0 ? '+' : ''}{tradePnlPct.toFixed(1)}%</span>
                    <span className="text-[10px] opacity-70 ml-1 tabular-nums">
                      {tradePnl >= 0 ? '+' : ''}{overseas ? `$${Math.abs(tradePnl).toFixed(2)}` : `${Math.round(tradePnl).toLocaleString()}원`}
                    </span>
                  </div>
                ) : <span className="text-slate-700 text-[10px]">-</span>}
              </div>

              {/* Row 3: AI 추론 요약 */}
              <div className={`text-[10px] text-slate-500 mt-1 ${isOpen ? 'whitespace-pre-wrap break-words' : 'truncate'}`}>
                {simplifyReason(t.ai_reasoning, t.side)}
              </div>

              {/* 확장: 상세 */}
              {isOpen && (
                <div className="mt-3 pt-2.5 border-t border-white/[0.04] space-y-2 animate-in fade-in duration-200">
                  <div className="text-[11px]">
                    <span className="text-slate-500">상세 내용</span>
                    <p className="text-slate-300 leading-relaxed whitespace-pre-wrap break-words mt-1">{t.ai_reasoning || '기록 없음'}</p>
                  </div>
                  {chain?.strategy_mode ? (
                    <div className="text-[11px] space-y-1 text-slate-400">
                      <span className="text-slate-500 font-medium">매매 전략</span>
                      <p>전략: <span className="text-slate-200 font-medium">{STRATEGY_LABELS[chain.strategy_mode] ?? chain.strategy_mode}</span></p>
                      <p>평단가: <span className="text-slate-200">{overseas ? `$${Number(chain.avg_buy_price).toFixed(2)}` : `${Number(chain.avg_buy_price).toLocaleString()}원`}</span></p>
                      <p>상태: <span className="text-slate-200">{chain.status}</span></p>
                    </div>
                  ) : overseas ? (
                    <p className="text-[11px] text-slate-400">미국주식 자동매매</p>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
