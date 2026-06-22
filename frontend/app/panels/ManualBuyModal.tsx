'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui';
import { api, pc } from '../lib/utils';

interface ManualBuyModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  toast?: (msg: string, type?: string) => void;
  confirm: (opts: {title: string, description?: string, confirmLabel?: string, confirmVariant?: 'danger'|'primary'|'ghost'}) => Promise<boolean>;
  viewMode: 'paper' | 'live';
  watchlist: Array<{ code: string; name: string; exchange: string }>;
}

interface Recommendation {
  code: string;
  exchange: string;
  sector: string;
  price: number;
  changePct: number;
  score: number;
  rsi: number;
  adx: number;
  tpPct: number;
  slPct: number;
  tpLabel: string;
  tpPrice: number;
  slPrice: number;
  cashUsd: number;
  portfolio: number;
  recommendedAmount: number;
  recommendedQty: number;
  totalCost: number;
  vix: number;
  vixRegime: string;
  mode: string;
  stockName: string;
}

export default function ManualBuyModal({ open, onClose, onSuccess, toast, confirm, viewMode, watchlist }: ManualBuyModalProps) {
  const [ticker, setTicker] = useState('');
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [qty, setQty] = useState(0);
  const [tpPct, setTpPct] = useState(0);
  const [slPct, setSlPct] = useState(0);
  const [filtered, setFiltered] = useState<typeof watchlist>([]);
  const [showDropdown, setShowDropdown] = useState(false);

  useEffect(() => {
    if (!open) { setRec(null); setTicker(''); setFiltered([]); }
  }, [open]);

  const handleTickerInput = useCallback((val: string) => {
    const upper = val.toUpperCase();
    setTicker(upper);
    if (upper.length >= 1) {
      setFiltered(watchlist.filter(w => w.code.includes(upper) || w.name.toLowerCase().includes(val.toLowerCase())).slice(0, 8));
      setShowDropdown(true);
    } else {
      setFiltered([]);
      setShowDropdown(false);
    }
  }, [watchlist]);

  const selectStock = useCallback((code: string, exchange: string) => {
    setTicker(code);
    setShowDropdown(false);
    fetchRecommendation(code, exchange);
  }, []);

  const fetchRecommendation = async (code: string, exchange?: string) => {
    setLoading(true);
    setRec(null);
    try {
      const ex = exchange || watchlist.find(w => w.code === code)?.exchange || 'NASDAQ';
      const data = await api(`/overseas/buy-recommend/${code}?exchange=${ex}&viewMode=${viewMode}`, { timeout: 10000 });
      setRec(data);
      setQty(data.recommendedQty);
      setTpPct(data.tpPct);
      setSlPct(data.slPct);
    } catch (e: unknown) {
      toast?.((e as Error).message || '추천값 조회 실패', 'err');
    }
    setLoading(false);
  };

  const executeBuy = async () => {
    if (!rec || qty <= 0) return;
    const liveTag = viewMode === 'live' ? '[실전] ' : '[연습] ';
    if (!await confirm({
      title: `${liveTag}${rec.stockName} (${rec.code}) ${qty}주 매수`,
      description: `예상 금액: $${(qty * rec.price * 1.0025).toFixed(0)} · TP +${tpPct}% · SL -${slPct}%`,
      confirmLabel: '매수', confirmVariant: 'primary',
    })) return;
    setExecuting(true);
    try {
      const amountUsd = qty * rec.price * 1.0025;
      const r = await api(`/overseas/vision-scalp/execute?viewMode=${viewMode}`, {
        method: 'POST',
        body: JSON.stringify({ ticker: rec.code, exchange: rec.exchange, amountUsd, reasoning: `수동매수 TP+${tpPct}%/SL-${slPct}%`, tp_pct: tpPct, sl_pct: slPct }),
        timeout: 40000,
      });
      toast?.(`${rec.code} ${r.qty}주 매수 @$${r.price?.toFixed(2)}`, 'ok');
      onSuccess();
      onClose();
    } catch (e: unknown) {
      toast?.((e as Error).message || '매수 실패', 'err');
    }
    setExecuting(false);
  };

  if (!open) return null;

  const isLive = viewMode === 'live';
  const totalCost = rec ? +(qty * rec.price * 1.0025).toFixed(2) : 0;
  const cashPct = rec && rec.cashUsd > 0 ? +((totalCost / rec.cashUsd) * 100).toFixed(1) : 0;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="w-full sm:w-[420px] max-h-[92vh] overflow-y-auto bg-[#0f1422] border border-white/[0.08] rounded-t-2xl sm:rounded-2xl shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* 헤더 */}
        <div className={`flex items-center justify-between px-4 py-3 border-b ${isLive ? 'border-rose-500/30 bg-rose-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
          <h2 className="text-sm font-bold text-slate-200">해외 수동매수</h2>
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${isLive ? 'bg-rose-500/20 text-rose-400' : 'bg-amber-500/20 text-amber-400'}`}>
            {isLive ? '실전' : '연습'}
          </span>
        </div>

        <div className="px-4 py-3 space-y-3">
          {/* 종목 검색 */}
          <div className="relative">
            <label className="text-[10px] text-slate-500 mb-1 block">종목 검색</label>
            <input type="text" value={ticker}
              onChange={e => handleTickerInput(e.target.value)}
              onFocus={() => ticker.length >= 1 && setShowDropdown(true)}
              onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
              placeholder="티커 또는 종목명 (예: NVDA)"
              className="w-full bg-white/[0.05] ring-1 ring-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50" />
            {showDropdown && filtered.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-[#0f1422] ring-1 ring-white/[0.08] rounded-xl shadow-xl max-h-40 overflow-y-auto">
                {filtered.map(w => (
                  <button key={w.code} onMouseDown={() => selectStock(w.code, w.exchange)}
                    className="w-full text-left px-3 py-2 hover:bg-white/[0.06] text-sm text-slate-300 flex justify-between items-center">
                    <span className="font-medium">{w.code}</span>
                    <span className="text-[10px] text-slate-500 truncate ml-2">{w.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 로딩 스켈레톤 */}
          {loading && (
            <div className="space-y-3 animate-pulse">
              <div className="rounded-xl bg-white/[0.04] p-3 h-16" />
              <div className="grid grid-cols-2 gap-3"><div className="h-16 bg-white/[0.04] rounded-xl" /><div className="h-16 bg-white/[0.04] rounded-xl" /></div>
              <div className="h-14 bg-white/[0.04] rounded-xl" />
            </div>
          )}

          {/* 추천 결과 */}
          {rec && !loading && (
            <>
              {/* 종목 정보 — 컴팩트 */}
              <div className="bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-slate-200 truncate">{rec.stockName}</span>
                  <span className={`text-sm font-bold shrink-0 ${pc(rec.changePct)}`}>
                    ${rec.price.toFixed(2)} <span className="text-[10px]">({rec.changePct >= 0 ? '+' : ''}{rec.changePct.toFixed(1)}%)</span>
                  </span>
                </div>
                <div className="flex gap-2 text-[10px] text-slate-500 mt-1 flex-wrap">
                  {rec.sector && <span className="px-1.5 py-0.5 bg-slate-700/50 rounded">{rec.sector}</span>}
                  <span>점수 {rec.score}</span>
                  <span>RSI {rec.rsi.toFixed(0)}</span>
                  <span>ADX {rec.adx.toFixed(0)}</span>
                  <span>VIX {rec.vixRegime}</span>
                </div>
              </div>

              {/* TP/SL — 컴팩트 */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-emerald-400/70 mb-0.5 block">TP %</label>
                  <input type="number" step="0.5" min="1" value={tpPct}
                    onChange={e => setTpPct(Number(e.target.value) || 0)}
                    className="w-full bg-white/[0.05] ring-1 ring-emerald-500/20 rounded-lg px-3 py-1.5 text-sm text-emerald-400 text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-500/40" />
                  <div className="text-[9px] text-slate-600 mt-0.5 text-center">${(rec.price * (1 + tpPct / 100)).toFixed(2)}</div>
                </div>
                <div>
                  <label className="text-[10px] text-rose-400/70 mb-0.5 block">SL %</label>
                  <input type="number" step="0.5" max="0" value={-slPct}
                    onChange={e => setSlPct(-(Number(e.target.value) || 0))}
                    className="w-full bg-white/[0.05] ring-1 ring-rose-500/20 rounded-lg px-3 py-1.5 text-sm text-rose-400 text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-rose-500/40" />
                  <div className="text-[9px] text-slate-600 mt-0.5 text-center">${(rec.price * (1 - slPct / 100)).toFixed(2)}</div>
                </div>
              </div>

              {/* 수량 + 예상 비용 통합 */}
              <div className="bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-500 shrink-0">수량</span>
                  <Button variant="secondary" size="sm" className="w-8 h-8 text-base p-0" onClick={() => setQty(Math.max(1, qty - 1))}>-</Button>
                  <input type="number" min="1" value={qty}
                    onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))}
                    className="flex-1 bg-white/[0.05] ring-1 ring-white/[0.08] rounded-lg px-2 py-1.5 text-center text-sm text-slate-200 tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-500/50" />
                  <Button variant="secondary" size="sm" className="w-8 h-8 text-base p-0" onClick={() => setQty(qty + 1)}>+</Button>
                </div>
                <div className="flex justify-between mt-2 text-[11px]">
                  <span className="text-slate-500">예상금액</span>
                  <span className="text-slate-200 font-bold tabular-nums">${totalCost.toFixed(0)}</span>
                </div>
                <div className="flex justify-between text-[10px] mt-0.5">
                  <span className="text-slate-500">현금 대비</span>
                  <span className={`font-medium ${cashPct > 40 ? 'text-amber-400' : 'text-slate-400'}`}>{cashPct}% (잔고 ${rec.cashUsd.toFixed(0)})</span>
                </div>
              </div>

              {/* 버튼 */}
              <div className="flex gap-2 pt-1">
                <Button variant="ghost" size="sm" className="px-4 py-2.5 text-slate-500 shrink-0" onClick={onClose}>취소</Button>
                <Button variant="primary" size="lg" className="flex-1 py-2.5"
                  disabled={executing || qty <= 0 || totalCost > rec.cashUsd} onClick={executeBuy}>
                  {executing ? (
                    <span className="flex items-center justify-center gap-1.5">
                      <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      매수 중
                    </span>
                  ) : totalCost > rec.cashUsd ? '잔고 부족' : (
                    <span className="truncate">{rec.code} {qty}주 매수 (${totalCost.toFixed(0)})</span>
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
