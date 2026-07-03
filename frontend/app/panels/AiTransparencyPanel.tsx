'use client';

import React from 'react';
import { api, fmtWon, fmtTime } from '../lib/utils';
import { ScoreBar } from './SmallPanels';
import type { WatchlistItem, UsDashboard, UsWatchlistItem } from '../types';

interface AiHolding {
  stock_code: string;
  stock_name: string;
  entry_score?: number;
  current_score?: number;
  current_signal?: string;
  avg_buy_price?: number;
  total_quantity?: number;
  buy_reason?: string;
  opened_at?: string;
}

interface AiDecision {
  side: 'BUY' | 'SELL';
  stock_name: string;
  ai_reasoning?: string;
  created_at: string;
}

interface AiTransparencyData {
  holdings: AiHolding[];
  decisions: AiDecision[];
  winRate: number | null;
  wins?: number;
  losses?: number;
  totalTrades?: number;
}

/**
 * AI 판단 근거 투명성 — 보유 종목 중심
 *
 * 기존: watchlist 랜덤 종목의 무관한 점수 나열
 * 개선: 실제 보유 종목의 매수 이유, 진입/현재 점수, 최근 결정, 적중률
 */
function AiTransparencyPanel({ watchlist, tab, usDash, viewMode = 'live' }: { watchlist: WatchlistItem[]; tab?: 'KR' | 'US'; usDash?: UsDashboard | null; viewMode?: string }) {
  const [data, setData] = React.useState<AiTransparencyData | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [usSel, setUsSel] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (tab === 'US') return;
    api(`/ai-transparency?viewMode=${viewMode}`).then((r: AiTransparencyData) => {
      if (r) setData(r);
    }).catch(() => {});
  }, [viewMode, tab]);

  // US 탭: 기존 로직 유지
  if (tab === 'US') {
    const usStocks = (usDash?.watchlist ?? []).filter(s => typeof s.score === 'number' || typeof s.ai_score === 'number').slice(0, 8);
    if (usStocks.length === 0) return null;
    const activeUsSel = usSel ?? usStocks[0]?.code ?? null;
    const selStock = usStocks.find(s => s.code === activeUsSel);
    const score = selStock?.score ?? selStock?.ai_score ?? 0;
    const signal = selStock?.signal ?? '';
    return (
      <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3">
        <div className="text-[11px] font-semibold text-slate-400 mb-2">AI 판단 근거</div>
        <div className="flex gap-1 flex-wrap mb-3">
          {usStocks.map(s => {
            const sc = s.score ?? s.ai_score ?? 0;
            const active = activeUsSel === s.code;
            return (
              <button key={s.code} onClick={() => setUsSel(s.code)}
                className={`text-[9px] px-2 py-0.5 rounded-full font-semibold transition-colors ${active ? 'bg-blue-500/30 text-blue-300 border border-blue-500/40' : 'bg-white/[0.04] text-slate-500 hover:text-slate-300'}`}>
                {s.name ?? s.code} <span className={sc >= 60 ? 'text-emerald-400' : sc <= 40 ? 'text-rose-400' : 'text-amber-400'}>{Math.round(sc)}</span>
              </button>
            );
          })}
        </div>
        {selStock && (
          <div className="space-y-1.5">
            <ScoreBar label="AI점수" value={score} color="blue" />
            {selStock.confidence != null && <ScoreBar label="신뢰도" value={selStock.confidence} color="emerald" />}
            <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/[0.04]">
              <span className="text-[10px] text-slate-500">시그널</span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${signal === 'BUY' || signal === 'STRONG_BUY' ? 'bg-emerald-500/20 text-emerald-300' : signal === 'SELL' ? 'bg-rose-500/20 text-rose-300' : 'bg-white/[0.04] text-slate-400'}`}>{signal || 'HOLD'}</span>
              {selStock.price != null && <span className="text-[10px] text-slate-500 ml-auto">${selStock.price?.toFixed(2)}</span>}
            </div>
            {selStock.reason && (
              <div className="text-[10px] text-slate-500 leading-relaxed line-clamp-2">{selStock.reason}</div>
            )}
          </div>
        )}
      </div>
    );
  }

  // KR 탭 — 보유 종목 중심 투명성
  const holdings = data?.holdings ?? [];
  const decisions = data?.decisions ?? [];
  const winRate = data?.winRate;
  const totalTrades = data?.totalTrades ?? 0;

  if (holdings.length === 0 && decisions.length === 0) return null;

  const sel = selected ?? holdings[0]?.stock_code ?? null;
  const selH = holdings.find(h => h.stock_code === sel);

  return (
    <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden">
      {/* 헤더 + 적중률 */}
      <div className="px-4 py-3 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-slate-400">AI 판단 근거</span>
        {winRate != null && totalTrades > 0 && (
          <div className="flex items-center gap-1.5">
            <span className={`text-[11px] font-bold ${winRate >= 50 ? 'text-emerald-400' : 'text-rose-400'}`}>
              적중 {winRate}%
            </span>
            <span className="text-[9px] text-slate-600">({data?.wins ?? 0}승 {data?.losses ?? 0}패 / 30일)</span>
          </div>
        )}
      </div>

      {/* 보유 종목 탭 */}
      {holdings.length > 0 && (
        <div className="px-4 pb-2">
          <div className="flex gap-1 flex-wrap">
            {holdings.map(h => {
              const score = Number(h.current_score ?? 0);
              const active = sel === h.stock_code;
              return (
                <button key={h.stock_code} onClick={() => setSelected(h.stock_code)}
                  className={`text-[9px] px-2 py-0.5 rounded-full font-semibold transition-colors ${active ? 'bg-blue-500/30 text-blue-300 border border-blue-500/40' : 'bg-white/[0.04] text-slate-500 hover:text-slate-300'}`}>
                  {h.stock_name} <span className={score >= 60 ? 'text-emerald-400' : score <= 40 ? 'text-rose-400' : 'text-amber-400'}>{score > 0 ? Math.round(score) : '-'}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 선택 종목 상세 */}
      {selH && (
        <div className="px-4 pb-3 space-y-2">
          {/* 진입 → 현재 점수 변화 */}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="text-[9px] text-slate-600 mb-0.5">진입 시 점수</div>
              <ScoreBar label="" value={Number(selH.entry_score ?? 0)} color="slate" />
            </div>
            <span className="text-slate-600 text-[10px] mt-3">→</span>
            <div className="flex-1">
              <div className="text-[9px] text-slate-600 mb-0.5">현재 점수</div>
              <ScoreBar label="" value={Number(selH.current_score ?? 0)} color="blue" />
            </div>
          </div>

          {/* 현재 시그널 */}
          {selH.current_signal && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-500">AI 시그널</span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                selH.current_signal === 'STRONG_BUY' ? 'bg-emerald-500/20 text-emerald-300' :
                selH.current_signal === 'BUY' ? 'bg-green-500/15 text-green-300' :
                selH.current_signal === 'SELL' ? 'bg-rose-500/20 text-rose-300' :
                'bg-white/[0.04] text-slate-400'
              }`}>{selH.current_signal}</span>
              <span className="text-[9px] text-slate-600 ml-auto">
                {fmtWon(Number(selH.avg_buy_price))} × {selH.total_quantity}주
              </span>
            </div>
          )}

          {/* 매수 이유 */}
          {selH.buy_reason && (
            <div className="bg-white/[0.02] rounded-lg px-3 py-2 border border-white/[0.04]">
              <div className="text-[9px] text-blue-400/70 mb-0.5">매수 판단 이유</div>
              <div className="text-[10px] text-slate-400 leading-relaxed line-clamp-3">
                {selH.buy_reason}
              </div>
            </div>
          )}

          {selH.opened_at && (
            <div className="text-[9px] text-slate-700 text-right">
              {fmtTime(selH.opened_at)} 진입
            </div>
          )}
        </div>
      )}

      {/* 최근 AI 결정 로그 */}
      {decisions.length > 0 && (
        <div className="border-t border-white/[0.04] px-4 py-3 space-y-1.5">
          <div className="text-[9px] text-slate-600 mb-1">최근 AI 결정</div>
          {decisions.map((d, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className={`text-[9px] font-bold shrink-0 mt-0.5 ${d.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>
                {d.side === 'BUY' ? '매수' : '매도'}
              </span>
              <div className="flex-1 min-w-0">
                <span className="text-[10px] text-slate-300">{d.stock_name}</span>
                {d.ai_reasoning && (
                  <div className="text-[9px] text-slate-500 leading-relaxed line-clamp-1 mt-0.5">
                    {d.ai_reasoning}
                  </div>
                )}
              </div>
              <span className="text-[9px] text-slate-700 shrink-0">{fmtTime(d.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default React.memo(AiTransparencyPanel);
