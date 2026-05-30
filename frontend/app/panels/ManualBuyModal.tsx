'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { api, pc } from '../lib/utils';

interface ManualBuyModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  toast?: (msg: string, type?: string) => void;
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

export default function ManualBuyModal({ open, onClose, onSuccess, toast, viewMode, watchlist }: ManualBuyModalProps) {
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
      const data = await api(`/overseas/buy-recommend/${code}?exchange=${ex}`, { timeout: 10000 });
      setRec(data);
      setQty(data.recommendedQty);
      setTpPct(data.tpPct);
      setSlPct(data.slPct);
    } catch (e: any) {
      toast?.(e.message || '추천값 조회 실패', 'err');
    }
    setLoading(false);
  };

  const executeBuy = async () => {
    if (!rec || qty <= 0) return;
    const liveTag = viewMode === 'live' ? '⚠️ [실전모드] ' : '[연습모드] ';
    if (!confirm(`${liveTag}${rec.stockName} (${rec.code}) ${qty}주 매수하시겠습니까?\n\n예상 금액: $${(qty * rec.price * 1.0025).toFixed(0)}\nTP: +${tpPct}% ($${(rec.price * (1 + tpPct / 100)).toFixed(2)})\nSL: -${slPct}% ($${(rec.price * (1 - slPct / 100)).toFixed(2)})`)) return;

    setExecuting(true);
    try {
      const amountUsd = qty * rec.price * 1.0025;
      const r = await api('/overseas/vision-scalp/execute', {
        method: 'POST',
        body: JSON.stringify({
          ticker: rec.code,
          exchange: rec.exchange,
          amountUsd,
          reasoning: `수동매수 TP+${tpPct}%/SL-${slPct}%`,
          tp_pct: tpPct,
          sl_pct: slPct,
        }),
        timeout: 40000,
      });
      toast?.(`${rec.code} ${r.qty}주 매수 완료 @$${r.price?.toFixed(2)}`, 'ok');
      onSuccess();
      onClose();
    } catch (e: any) {
      toast?.(e.message || '매수 실패', 'err');
    }
    setExecuting(false);
  };

  if (!open) return null;

  const totalCost = rec ? +(qty * rec.price * 1.0025).toFixed(2) : 0;
  const cashPct = rec && rec.cashUsd > 0 ? +((totalCost / rec.cashUsd) * 100).toFixed(1) : 0;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="w-full sm:w-[420px] max-h-[85vh] overflow-y-auto bg-slate-900 border border-slate-700/50 rounded-t-2xl sm:rounded-2xl shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* 헤더 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.04]">
          <h2 className="text-sm font-bold text-slate-200">해외주식 수동매수</h2>
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${viewMode === 'live' ? 'bg-rose-500/20 text-rose-400' : 'bg-amber-500/20 text-amber-400'}`}>
            {viewMode === 'live' ? '실전' : '연습'}
          </span>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* 종목 검색 */}
          <div className="relative">
            <label className="text-[10px] text-slate-500 mb-1 block">종목 검색</label>
            <input
              type="text"
              value={ticker}
              onChange={e => handleTickerInput(e.target.value)}
              onFocus={() => ticker.length >= 1 && setShowDropdown(true)}
              placeholder="티커 또는 종목명 입력 (예: NVDA)"
              className="w-full bg-slate-800/60 border border-slate-700/50 rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-blue-500/50 focus:outline-none"
            />
            {showDropdown && filtered.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-slate-800 border border-slate-700/50 rounded-xl shadow-xl max-h-48 overflow-y-auto">
                {filtered.map(w => (
                  <button key={w.code} onClick={() => selectStock(w.code, w.exchange)}
                    className="w-full text-left px-3 py-2 hover:bg-slate-700/50 text-sm text-slate-300 flex justify-between items-center">
                    <span className="font-medium">{w.code}</span>
                    <span className="text-[10px] text-slate-500 truncate ml-2">{w.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 로딩 */}
          {loading && <div className="text-center py-6 text-sm text-slate-500">추천값 계산 중...</div>}

          {/* 추천 결과 */}
          {rec && !loading && (
            <>
              {/* 종목 정보 */}
              <div className="bg-slate-800/40 rounded-xl px-4 py-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-slate-200">{rec.stockName}</span>
                  <span className={`text-sm font-bold ${pc(rec.changePct)}`}>
                    ${rec.price.toFixed(2)} <span className="text-[11px]">({rec.changePct >= 0 ? '+' : ''}{rec.changePct.toFixed(1)}%)</span>
                  </span>
                </div>
                <div className="flex gap-2 text-[10px] text-slate-500">
                  {rec.sector && <span className="px-1.5 py-0.5 bg-slate-700/50 rounded">{rec.sector}</span>}
                  <span>점수 {rec.score}</span>
                  <span>RSI {rec.rsi.toFixed(0)}</span>
                  <span>ADX {rec.adx.toFixed(0)}</span>
                  <span>VIX {rec.vixRegime}</span>
                </div>
              </div>

              {/* TP/SL 조절 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-emerald-400/70 mb-1 block">목표 수익 (TP %)</label>
                  <input type="number" step="0.5" min="1" value={tpPct}
                    onChange={e => setTpPct(Number(e.target.value))}
                    className="w-full bg-slate-800/60 border border-emerald-500/20 rounded-lg px-3 py-2 text-sm text-emerald-400 text-center tabular-nums focus:border-emerald-500/50 focus:outline-none" />
                  <div className="text-[9px] text-slate-600 mt-0.5 text-center">
                    ${(rec.price * (1 + tpPct / 100)).toFixed(2)}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-rose-400/70 mb-1 block">손절 (SL %)</label>
                  <input type="number" step="0.5" max="0" value={-slPct}
                    onChange={e => setSlPct(-Number(e.target.value))}
                    className="w-full bg-slate-800/60 border border-rose-500/20 rounded-lg px-3 py-2 text-sm text-rose-400 text-center tabular-nums focus:border-rose-500/50 focus:outline-none" />
                  <div className="text-[9px] text-slate-600 mt-0.5 text-center">
                    ${(rec.price * (1 - slPct / 100)).toFixed(2)}
                  </div>
                </div>
              </div>
              <div className="text-[9px] text-slate-600 text-center">{rec.tpLabel}</div>

              {/* 수량 조절 */}
              <div>
                <label className="text-[10px] text-slate-500 mb-1 block">수량</label>
                <div className="flex items-center gap-2">
                  <button onClick={() => setQty(Math.max(1, qty - 1))} className="w-9 h-9 rounded-lg bg-slate-800 text-slate-400 hover:bg-slate-700 text-lg font-bold">-</button>
                  <input type="number" min="1" value={qty}
                    onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))}
                    className="flex-1 bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-2 text-center text-sm text-slate-200 tabular-nums focus:border-blue-500/50 focus:outline-none" />
                  <button onClick={() => setQty(qty + 1)} className="w-9 h-9 rounded-lg bg-slate-800 text-slate-400 hover:bg-slate-700 text-lg font-bold">+</button>
                </div>
              </div>

              {/* 예상 비용 */}
              <div className="bg-slate-800/40 rounded-xl px-4 py-3">
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-500">예상 금액</span>
                  <span className="text-slate-200 font-bold tabular-nums">${totalCost.toFixed(0)}</span>
                </div>
                <div className="flex justify-between text-[11px] mt-1">
                  <span className="text-slate-500">현금 대비</span>
                  <span className={`font-medium ${cashPct > 40 ? 'text-amber-400' : 'text-slate-400'}`}>{cashPct}% (잔고 ${rec.cashUsd.toFixed(0)})</span>
                </div>
              </div>

              {/* 매수 버튼 */}
              <button
                disabled={executing || qty <= 0 || totalCost > rec.cashUsd}
                onClick={executeBuy}
                className="w-full py-3 rounded-xl font-bold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-blue-600 hover:bg-blue-500 text-white"
              >
                {executing ? '매수 중...' : totalCost > rec.cashUsd ? '잔고 부족' : `${rec.code} ${qty}주 매수 ($${totalCost.toFixed(0)})`}
              </button>
            </>
          )}
        </div>

        {/* 닫기 */}
        <div className="px-5 pb-4">
          <button onClick={onClose} className="w-full py-2 text-xs text-slate-500 hover:text-slate-400">닫기</button>
        </div>
      </div>
    </div>
  );
}
