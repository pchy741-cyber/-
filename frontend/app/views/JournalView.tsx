'use client';

import React, { useState, useEffect } from 'react';
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

  useEffect(() => {
    setLoading(true);
    setError(null);
    api(`/journal?days=${days}&viewMode=${viewMode}`)
      .then((d: any) => { setData(d); })
      .catch((e: any) => { setError(e?.message ?? '매매일지 로드 실패'); })
      .finally(() => setLoading(false));
  }, [days, viewMode]);

  const trades = data?.trades.filter(t => market === 'ALL' || t.market === market) ?? [];
  const wins = trades.filter(t => t.pnlPct >= 0).length;
  const losses = trades.length - wins;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  const avgPnl = trades.length > 0 ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0;
  const totalAmountKr = trades.filter(t => t.market === 'KR').reduce((s, t) => s + t.pnlAmount, 0);
  const totalAmountUs = trades.filter(t => t.market === 'US').reduce((s, t) => s + t.pnlAmount, 0);

  return (
    <div className="space-y-4">
      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl overflow-hidden border border-white/[0.06] text-[12px]">
          {(['ALL', 'KR', 'US'] as const).map(m => (
            <button key={m} onClick={() => setMarket(m)}
              className={`px-3 py-1.5 transition-all ${market === m ? 'bg-blue-500/20 text-blue-400 font-semibold' : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.03]'}`}>
              {m === 'ALL' ? '전체' : m === 'KR' ? '🇰🇷 국내' : '🇺🇸 해외'}
            </button>
          ))}
        </div>
        <div className="flex rounded-xl overflow-hidden border border-white/[0.06] text-[12px]">
          {[7, 30, 60, 90].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`px-3 py-1.5 transition-all ${days === d ? 'bg-blue-500/20 text-blue-400 font-semibold' : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.03]'}`}>
              {d}일
            </button>
          ))}
        </div>
      </div>

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">완결 매매</div>
          <div className="text-xl font-black mt-1">{trades.length}건</div>
        </div>
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">승률</div>
          <div className={`text-xl font-black mt-1 ${winRate >= 55 ? 'text-emerald-400' : winRate >= 45 ? 'text-amber-400' : 'text-rose-400'}`}>
            {trades.length > 0 ? winRate.toFixed(0) : '-'}%
          </div>
          <div className="text-[10px] text-slate-600 mt-0.5">{wins}승 {losses}패</div>
        </div>
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">평균 손익률</div>
          <div className={`text-xl font-black mt-1 ${pc(avgPnl)}`}>{trades.length > 0 ? fmtPct(avgPnl) : '-'}</div>
        </div>
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">실현 손익</div>
          {totalAmountKr !== 0 && <div className={`text-sm font-bold tabular-nums ${pc(totalAmountKr)}`}>{fmtWon(totalAmountKr)}</div>}
          {totalAmountUs !== 0 && <div className={`text-sm font-bold tabular-nums ${pc(totalAmountUs)}`}>{fmtUsd(totalAmountUs)}</div>}
          {totalAmountKr === 0 && totalAmountUs === 0 && <div className="text-sm text-slate-500 mt-1">-</div>}
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
            <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="p-10 text-center">
            <div className="text-2xl opacity-20 mb-2">⚠️</div>
            <p className="text-sm text-rose-400">{error}</p>
            <p className="text-[11px] text-slate-600 mt-1">매매일지를 불러오지 못했습니다.</p>
            <button onClick={() => { setLoading(true); setError(null); api(`/journal?days=${days}&viewMode=${viewMode}`).then((d: any) => setData(d)).catch((e: any) => setError(e?.message ?? '로드 실패')).finally(() => setLoading(false)); }}
              className="mt-3 px-4 py-1.5 text-xs bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 transition-colors">
              다시 시도
            </button>
          </div>
        ) : trades.length === 0 ? (
          <div className="p-10 text-center">
            <div className="text-2xl opacity-20 mb-2">📓</div>
            <p className="text-sm text-slate-500">완결된 매매 기록이 없습니다</p>
            <p className="text-[11px] text-slate-600 mt-1">매도 후 손익이 확정된 거래가 여기에 표시됩니다</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead><tr className="text-slate-500 border-b border-slate-700/30 text-[11px]">
                <th className="px-4 py-2.5 text-left font-medium">청산일</th>
                <th className="px-4 py-2.5 text-left font-medium">종목</th>
                <th className="px-4 py-2.5 text-center font-medium">시장</th>
                <th className="px-4 py-2.5 text-right font-medium">진입가</th>
                <th className="px-4 py-2.5 text-right font-medium">청산가</th>
                <th className="px-4 py-2.5 text-right font-medium">손익률</th>
                <th className="px-4 py-2.5 text-right font-medium">손익</th>
                <th className="px-4 py-2.5 text-right font-medium">보유</th>
                <th className="px-4 py-2.5 text-left font-medium">사유</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-800/20">
                {trades.map((t, i) => (
                  <tr key={i} className={`hover:bg-white/[0.02] transition-colors ${t.pnlPct > 0 ? 'bg-emerald-950/10' : t.pnlPct < 0 ? 'bg-rose-950/10' : ''}`}>
                    <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">{fmtTime(t.closedAt)}</td>
                    <td className="px-4 py-2.5">
                      <div className="font-semibold text-slate-200">{t.name !== t.code ? t.name : (KNOWN_STOCK_NAMES[t.code] ?? t.code)}</div>
                      <div className="text-[10px] text-slate-600">{t.code}{t.strategyMode ? ` · ${t.strategyMode}` : ''}</div>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.05] text-slate-400">{t.market === 'KR' ? '🇰🇷' : '🇺🇸'}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums">
                      {t.market === 'KR' ? fmt(t.entryPrice) : `$${t.entryPrice.toFixed(2)}`}
                    </td>
                    <td className="px-4 py-2.5 text-right text-slate-300 tabular-nums font-medium">
                      {t.market === 'KR' ? fmt(t.exitPrice) : `$${t.exitPrice.toFixed(2)}`}
                    </td>
                    <td className={`px-4 py-2.5 text-right font-bold tabular-nums ${pc(t.pnlPct)}`}>
                      {fmtPct(t.pnlPct)}
                    </td>
                    <td className={`px-4 py-2.5 text-right tabular-nums text-[12px] ${pc(t.pnlAmount)}`}>
                      {t.market === 'KR' ? fmtWon(t.pnlAmount) : fmtUsd(t.pnlAmount)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-slate-500 tabular-nums text-[12px]">
                      {t.holdingDays < 1 ? `${Math.round(t.holdingDays * 24)}h` : `${t.holdingDays.toFixed(1)}일`}
                    </td>
                    <td className="px-4 py-2.5 text-slate-500 text-[11px] max-w-[200px] truncate" title={t.closeReason}>
                      {t.closeReason || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default JournalView;
