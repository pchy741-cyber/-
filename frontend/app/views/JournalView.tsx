'use client';

import React, { useState, useEffect } from 'react';
import { Button, Spinner } from '@/components/ui';
import { ToggleGroup } from '@/components/ToggleGroup';
import { api, fmt, fmtWon, fmtUsd, fmtPct, fmtTime, pc } from '../lib/utils';
import { KNOWN_STOCK_NAMES } from '../lib/stock-names';

interface JournalTrade {
  market: 'KR' | 'US';
  code: string;
  name: string;
  pnlPct: number;
  pnlAmount: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: string;
  closedAt: string;
  holdingDays: number;
  closeReason: string;
  strategyMode?: string;
}

function JournalView({ viewMode = 'live' }: { viewMode?: 'live' | 'paper' }) {
  const [days, setDays] = useState(30);
  const [market, setMarket] = useState<'ALL' | 'KR' | 'US'>('ALL');
  const [data, setData] = useState<{ trades: JournalTrade[]; summary: { totalTrades: number; wins: number; losses: number; winRate: number; avgPnlPct: number } } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api(`/journal?days=${days}&viewMode=${viewMode}`)
      .then((d: any) => { setData(d); })
      .catch((e: any) => { setError(e?.message ?? '매매일지 로드 실패'); })
      .finally(() => setLoading(false));
  }, [days, viewMode]);

  const trades = data?.trades.filter(t => market === 'ALL' || t.market === market) ?? [];
  const wins = trades.filter(t => t.pnlPct > 0).length;
  const losses = trades.length - wins;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  const avgPnl = trades.length > 0 ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0;
  const totalAmountKr = trades.filter(t => t.market === 'KR').reduce((s, t) => s + t.pnlAmount, 0);
  const totalAmountUs = trades.filter(t => t.market === 'US').reduce((s, t) => s + t.pnlAmount, 0);

  const fmtHold = (d: number) => d < 1 ? `${Math.round(d * 24)}h` : d < 2 ? `${Math.round(d * 24)}h` : `${d.toFixed(0)}일`;
  const displayName = (t: JournalTrade) => t.name !== t.code ? t.name : (KNOWN_STOCK_NAMES[t.code] ?? t.code);

  return (
    <div className="space-y-4">
      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          value={market}
          items={[
            { value: 'ALL' as const, label: '전체' },
            { value: 'KR' as const, label: '국내' },
            { value: 'US' as const, label: '해외' },
          ]}
          onChange={setMarket}
        />
        <ToggleGroup
          value={String(days)}
          items={[
            { value: '7', label: '7일' },
            { value: '30', label: '30일' },
            { value: '60', label: '60일' },
            { value: '90', label: '90일' },
          ]}
          onChange={v => setDays(Number(v))}
        />
      </div>

      {/* 요약 카드 — 2x2 그리드 */}
      <div className="grid grid-cols-2 gap-2.5">
        <div className="glass rounded-xl p-3 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">완결 매매</div>
          <div className="text-lg font-black mt-0.5">{trades.length}<span className="text-xs text-slate-500 ml-0.5">건</span></div>
        </div>
        <div className="glass rounded-xl p-3 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">승률</div>
          <div className={`text-lg font-black mt-0.5 ${winRate >= 55 ? 'text-emerald-400' : winRate >= 45 ? 'text-amber-400' : 'text-rose-400'}`}>
            {trades.length > 0 ? winRate.toFixed(0) : '-'}%
          </div>
          <div className="text-[9px] text-slate-600">{wins}승 {losses}패</div>
        </div>
        <div className="glass rounded-xl p-3 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">평균 손익률</div>
          <div className={`text-lg font-black mt-0.5 ${pc(avgPnl)}`}>{trades.length > 0 ? fmtPct(avgPnl) : '-'}</div>
        </div>
        <div className="glass rounded-xl p-3 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">실현 손익</div>
          <div className="mt-0.5 space-y-0.5">
            {totalAmountKr !== 0 && <div className={`text-sm font-bold tabular-nums leading-tight ${pc(totalAmountKr)}`}>{fmtWon(totalAmountKr)}</div>}
            {totalAmountUs !== 0 && <div className={`text-sm font-bold tabular-nums leading-tight ${pc(totalAmountUs)}`}>{fmtUsd(totalAmountUs)}</div>}
            {totalAmountKr === 0 && totalAmountUs === 0 && <div className="text-sm text-slate-500">-</div>}
          </div>
        </div>
      </div>

      {/* 매매 목록 */}
      <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden">
        <div className="px-4 py-3 border-b border-white/[0.04] flex items-center justify-between">
          <span className="text-[13px] font-semibold text-slate-300">완결 매매 목록</span>
          <span className="text-[11px] text-slate-600">{trades.length}건</span>
        </div>
        {loading ? (
          <div className="flex items-center justify-center p-12">
            <Spinner size="xl" />
          </div>
        ) : error ? (
          <div className="p-10 text-center">
            <div className="text-2xl opacity-20 mb-2">⚠️</div>
            <p className="text-sm text-rose-400">{error}</p>
            <p className="text-[11px] text-slate-600 mt-1">매매일지를 불러오지 못했습니다.</p>
            <Button variant="ghost" size="sm" className="mt-3 bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"
              onClick={() => { setLoading(true); setError(null); api(`/journal?days=${days}&viewMode=${viewMode}`).then((d: any) => setData(d)).catch((e: any) => setError(e?.message ?? '로드 실패')).finally(() => setLoading(false)); }}>
              다시 시도
            </Button>
          </div>
        ) : trades.length === 0 ? (
          <div className="p-10 text-center">
            <div className="text-2xl opacity-20 mb-2">📓</div>
            <p className="text-sm text-slate-500">완결된 매매 기록이 없습니다</p>
            <p className="text-[11px] text-slate-600 mt-1">매도 후 손익이 확정된 거래가 여기에 표시됩니다</p>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.03]">
            {trades.map((t, i) => {
              const isExpanded = expandedIdx === i;
              const isProfit = t.pnlPct > 0;
              return (
                <div
                  key={`${t.code}-${t.closedAt}-${i}`}
                  onClick={() => setExpandedIdx(isExpanded ? null : i)}
                  className={`px-4 py-3 cursor-pointer transition-colors hover:bg-white/[0.02] ${isProfit ? 'border-l-2 border-l-emerald-500/40' : 'border-l-2 border-l-rose-500/40'}`}
                >
                  {/* 메인 행: 종목명 + 손익률 */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="text-[10px] shrink-0">{t.market === 'KR' ? '🇰🇷' : '🇺🇸'}</span>
                      <span className="text-sm font-bold text-slate-200 truncate">{displayName(t)}</span>
                      {t.strategyMode && (
                        <span className="text-[9px] bg-white/[0.06] text-slate-400 px-1.5 py-0.5 rounded shrink-0">{t.strategyMode}</span>
                      )}
                    </div>
                    <div className={`text-right shrink-0 ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                      <div className="text-base font-black tabular-nums">{fmtPct(t.pnlPct)}</div>
                    </div>
                  </div>

                  {/* 서브 행: 가격 + 보유기간 + 손익금액 */}
                  <div className="flex items-center justify-between mt-1.5 text-[11px]">
                    <div className="flex items-center gap-2 text-slate-500">
                      <span className="tabular-nums">
                        {t.market === 'KR' ? fmt(t.entryPrice) : `$${t.entryPrice.toFixed(2)}`}
                        <span className="text-slate-600 mx-0.5">→</span>
                        {t.market === 'KR' ? fmt(t.exitPrice) : `$${t.exitPrice.toFixed(2)}`}
                      </span>
                      <span className="text-slate-600">·</span>
                      <span>{fmtHold(t.holdingDays)}</span>
                    </div>
                    <span className={`font-semibold tabular-nums ${pc(t.pnlAmount)}`}>
                      {t.market === 'KR' ? fmtWon(t.pnlAmount) : fmtUsd(t.pnlAmount)}
                    </span>
                  </div>

                  {/* 확장: 청산일 + 사유 */}
                  {isExpanded && (
                    <div className="mt-3 pt-2.5 border-t border-white/[0.04] space-y-2">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-slate-500">청산일</span>
                        <span className="text-slate-300">{fmtTime(t.closedAt)}</span>
                      </div>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-slate-500">진입일</span>
                        <span className="text-slate-300">{fmtTime(t.openedAt)}</span>
                      </div>
                      {t.closeReason && (
                        <div className="text-[11px]">
                          <span className="text-slate-500">청산 사유</span>
                          <p className="text-slate-300 mt-1 leading-relaxed whitespace-pre-wrap break-words">{t.closeReason}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* 접힌 상태: 청산 사유 한줄 미리보기 */}
                  {!isExpanded && t.closeReason && (
                    <p className="text-[10px] text-slate-600 mt-1 truncate">{t.closeReason}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default JournalView;
