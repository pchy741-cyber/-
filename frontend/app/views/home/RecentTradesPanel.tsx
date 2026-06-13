'use client';

import React from 'react';
import { Panel, SideBadge, EmptyMsg } from '@/components/ui';
import { fmt, fmtWon, fmtUsd, fmtTime, pc } from '../../lib/utils';
import { toDisplayName, isUnresolvedStockName } from '../../lib/helpers';
import { TRIGGER_LABELS } from '../strategy-lab/constants';
import type { Trade } from '../../types';

/** AI 사유를 초보자 친화적 한글로 요약 */
function simplifyReason(raw: string | null | undefined): string {
  if (!raw) return '-';
  let s = raw;
  // 기술적 메타데이터 제거
  s = s.replace(/\[avgBuy:[\d.]+\]/g, '');
  s = s.replace(/\[score:[\d.]+\]/g, '');
  s = s.replace(/\[kelly:[\d.]+\]/g, '');
  s = s.replace(/\[atr:[\d.]+\]/g, '');
  // 영어 전략명 → 한글
  s = s.replace(/trailing\s*stop/gi, '트레일링 스톱(고점 추적 매도)');
  s = s.replace(/stop\s*loss/gi, '손절');
  s = s.replace(/take\s*profit/gi, '익절');
  s = s.replace(/partial\s*(?:TP|take.?profit)/gi, '부분익절');
  s = s.replace(/scale[_\s]?in/gi, '추가매수');
  s = s.replace(/concentration[_\s]?cap/gi, '집중도 상한');
  s = s.replace(/rotation[_\s]?sell/gi, '순환매도');
  s = s.replace(/vision[_\s]?scalp/gi, '단타 청산');
  s = s.replace(/defense[_\s]?park/gi, '방어적 주차');
  s = s.replace(/turtle[_\s]?exit/gi, '터틀 탈출');
  s = s.replace(/MDD/g, '최대 낙폭');
  s = s.replace(/ATR/g, '변동폭');
  return s.trim() || '-';
}

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
  const isOverseasCode = (code: string) => !/^[0-9]{6}$/.test(code);
  const tabFiltered = filled.filter((t: Trade) => {
    const isOv = t.trigger_source === 'OVERSEAS' && isOverseasCode(t.stock_code);
    return isUsTab ? isOv : !isOv;
  });
  const todayTabTrades = tabFiltered.filter((t: Trade) => new Date(t.created_at).toDateString() === new Date().toDateString());

  return (
    <Panel title={isUsTab ? '최근 매매 (미국)' : '최근 매매'} badge={`오늘 ${todayTabTrades.length}건`} badgeColor={todayTabTrades.length > 0 ? 'emerald' : undefined}>
      {tabFiltered.length === 0 ? <EmptyMsg>매매 기록 없음</EmptyMsg> : (
        <div className="divide-y divide-white/[0.03]">
          {tabFiltered.slice(0, 10).map((t: Trade, i: number) => {
            const isOverseasTrade = t.trigger_source === 'OVERSEAS' && isOverseasCode(t.stock_code);
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
                    {simplifyReason(t.ai_reasoning)}
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
