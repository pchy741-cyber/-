'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Button, Spinner } from '@/components/ui';
import { ScoreSparkline } from '@/components/ScoreSparkline';
import { api, pc } from '../lib/utils';
import type { ConfirmFn, ToastFn } from '../types';

// ── 공통 타입 ──

interface UnifiedBuyModalProps {
  market: 'KR' | 'US';
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  toast?: ToastFn;
  confirm?: ConfirmFn;
  viewMode: 'paper' | 'live';
  // US 전용
  watchlist?: Array<{ code: string; name: string; exchange: string }>;
  // KR 전용
  stockCode?: string;
  stockName?: string;
  aiScore?: number;
  confidence?: number;
  rsi?: number;
  volumeRatio?: number;
  pullbackSignal?: boolean;
  currentPrice?: number;
}

// ── US 타입 ──

interface UsRecommendation {
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

// ── KR 타입 ──

interface KrEstimate {
  amount_krw: number;
  dynPct: number;
  totalCapital: number;
  stopLossPct: number;
  isElite: boolean;
}

// ═══════════════════════════════════════════
// US 매수 바디
// ═══════════════════════════════════════════

function UsBody({ open, onClose, onSuccess, toast, confirm, viewMode, watchlist = [] }: Omit<UnifiedBuyModalProps, 'market'>) {
  const [ticker, setTicker] = useState('');
  const [rec, setRec] = useState<UsRecommendation | null>(null);
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

  const selectStock = useCallback((code: string, exchange: string) => {
    setTicker(code);
    setShowDropdown(false);
    fetchRecommendation(code, exchange);
  }, []);

  const executeBuy = async () => {
    if (!rec || qty <= 0) return;
    const liveTag = viewMode === 'live' ? '[실전] ' : '[연습] ';
    if (confirm && !await confirm({
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

  const totalCost = rec ? +(qty * rec.price * 1.0025).toFixed(2) : 0;
  const cashPct = rec && rec.cashUsd > 0 ? +((totalCost / rec.cashUsd) * 100).toFixed(1) : 0;

  return (
    <>
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

          <div className="flex gap-2 pt-1">
            <Button variant="ghost" size="sm" className="px-4 py-2.5 text-slate-500 shrink-0" onClick={onClose}>취소</Button>
            <Button variant="primary" size="lg" className="flex-1 py-2.5"
              disabled={executing || qty <= 0 || totalCost > rec.cashUsd} onClick={executeBuy}>
              {executing ? (
                <span className="flex items-center justify-center gap-1.5">
                  <Spinner size="sm" color="white" as="span" />
                  매수 중
                </span>
              ) : totalCost > rec.cashUsd ? '잔고 부족' : (
                <span className="truncate">{rec.code} {qty}주 매수 (${totalCost.toFixed(0)})</span>
              )}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

// ═══════════════════════════════════════════
// KR 매수 바디
// ═══════════════════════════════════════════

function KrBody({ open, onClose, onSuccess, toast, confirm, viewMode, stockCode = '', stockName = '', aiScore = 0, confidence, rsi, volumeRatio, pullbackSignal, currentPrice = 0 }: Omit<UnifiedBuyModalProps, 'market'>) {
  const [recommended, setRecommended] = useState<KrEstimate | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [multiplier, setMultiplier] = useState(1.0);
  const [ceoOverride, setCeoOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  useEffect(() => {
    if (!open || !stockCode) return;
    setRecommended(null);
    setMultiplier(1.0);
    setCeoOverride(false);
    setOverrideReason('');
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const qp = new URLSearchParams({
          stock_code: stockCode,
          ai_score: String(aiScore),
          is_paper: String(viewMode === 'paper'),
          ...(confidence != null ? { confidence: String(confidence) } : {}),
          ...(pullbackSignal != null ? { pullback_signal: String(pullbackSignal) } : {}),
        });
        const est = (await api(`/manual-buy/estimate?${qp.toString()}`)) as KrEstimate;
        if (!cancelled) setRecommended(est);
      } catch (e) {
        if (!cancelled) toast?.((e as Error).message ?? '권장 금액 조회 실패', 'err');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, stockCode, aiScore, viewMode, confidence, pullbackSignal, toast]);

  const actualAmount = recommended ? Math.round(recommended.amount_krw * multiplier) : 0;
  const actualQty = currentPrice > 0 ? Math.floor(actualAmount / currentPrice) : 0;
  const actualCost = actualQty * currentPrice;
  const positionPct = recommended && recommended.totalCapital > 0 ? (actualCost / recommended.totalCapital) * 100 : 0;
  const overCap = positionPct > 35;
  const needsOverride = overCap;
  const isLive = viewMode === 'live';

  async function executeBuy() {
    if (needsOverride && !ceoOverride) { toast?.('35% 초과 → CEO 토글 필요', 'err'); return; }
    if (needsOverride && ceoOverride && !overrideReason.trim()) { toast?.('CEO override 사유 입력 필요', 'err'); return; }
    const liveTag = viewMode === 'live' ? '[실전] ' : '[연습] ';
    if (confirm && !await confirm({
      title: `${liveTag}${stockName} (${stockCode}) ${actualQty}주 매수`,
      description: `예상 금액: ₩${actualCost.toLocaleString('ko-KR')} · 비중 ${positionPct.toFixed(1)}%`,
      confirmLabel: '매수',
      confirmVariant: viewMode === 'live' ? 'danger' : 'primary',
    })) return;
    setExecuting(true);
    try {
      const body = {
        stock_code: stockCode, amount_krw: actualAmount, ai_score: aiScore, is_paper: viewMode === 'paper',
        rsi, volume_ratio: volumeRatio, pullback_signal: pullbackSignal, confidence,
        reasoning: `Manual buy (modal): ${multiplier.toFixed(1)}x 권장${ceoOverride ? ` [CEO: ${overrideReason}]` : ''}`,
        ceo_override: ceoOverride, override_reason: ceoOverride ? overrideReason : undefined,
      };
      const r = (await api(`/manual-buy?viewMode=${viewMode}`, { method: 'POST', body: JSON.stringify(body) })) as { quantity?: number; price?: number };
      toast?.(`${stockName} ${r.quantity ?? actualQty}주 매수 완료`, 'ok');
      onSuccess();
      onClose();
    } catch (e) {
      toast?.((e as Error).message ?? '매수 실패', 'err');
    } finally {
      setExecuting(false);
    }
  }

  return (
    <>
      {/* 종목정보 헤더 */}
      <div className="flex items-center gap-3 text-[10px] text-slate-500">
        <span className="text-sm font-bold text-slate-200 tabular-nums">₩{currentPrice.toLocaleString('ko-KR')}</span>
        <span>AI {aiScore}점</span>
        {rsi != null && <span>RSI {rsi.toFixed(0)}</span>}
        {volumeRatio != null && <span>거래량 {volumeRatio.toFixed(1)}x</span>}
        <div className="ml-auto">
          <ScoreSparkline stockCode={stockCode} hours={24} width={60} height={20} />
        </div>
      </div>

      {/* 로딩 스켈레톤 */}
      {loading ? (
        <div className="space-y-3 animate-pulse">
          <div className="rounded-xl bg-white/[0.04] p-3 space-y-2">
            <div className="h-2.5 w-24 bg-white/[0.06] rounded" />
            <div className="h-5 w-32 bg-white/[0.06] rounded" />
          </div>
          <div className="h-6 w-full bg-white/[0.04] rounded-full" />
          <div className="rounded-xl bg-white/[0.04] p-3 h-14" />
          <div className="h-10 w-full bg-white/[0.06] rounded-xl" />
        </div>
      ) : recommended ? (
        <>
          {/* 시스템 권장 */}
          <div className="bg-blue-500/10 ring-1 ring-blue-500/20 rounded-xl px-3 py-2.5">
            <div className="flex justify-between items-center text-[11px]">
              <span className="text-slate-400">시스템 권장</span>
              <span className="text-blue-300 font-bold tabular-nums">₩{recommended.amount_krw.toLocaleString('ko-KR')}</span>
            </div>
            <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
              <span>총자본의 {recommended.dynPct}%</span>
              <span>SL {recommended.stopLossPct}%</span>
            </div>
          </div>

          {/* 슬라이더 */}
          <div>
            <div className="flex justify-between text-[11px] mb-1">
              <span className="text-slate-400">매수 배수</span>
              <span className={`font-bold tabular-nums ${multiplier > 1.5 ? 'text-amber-400' : multiplier < 1 ? 'text-slate-400' : 'text-emerald-400'}`}>
                {multiplier.toFixed(1)}x
              </span>
            </div>
            <input type="range" min="0.3" max="3.0" step="0.1" value={multiplier}
              onChange={(e) => setMultiplier(Number(e.target.value))}
              className="w-full accent-blue-500 h-1.5" />
            <div className="flex justify-between text-[9px] text-slate-600 mt-0.5">
              <span>0.3x</span><span>1.0x</span><span>3.0x</span>
            </div>
          </div>

          {/* 실제 매수 결과 */}
          <div className={`rounded-xl px-3 py-2.5 ${overCap ? 'bg-amber-500/10 ring-1 ring-amber-500/30' : 'bg-emerald-500/10 ring-1 ring-emerald-500/20'}`}>
            <div className="flex justify-between items-baseline">
              <div>
                <span className={`text-lg font-black tabular-nums ${overCap ? 'text-amber-300' : 'text-emerald-300'}`}>
                  {actualQty}<span className="text-xs ml-0.5">주</span>
                </span>
                <span className="text-[11px] text-slate-400 ml-2 tabular-nums">₩{actualCost.toLocaleString('ko-KR')}</span>
              </div>
              <span className={`text-[11px] font-medium shrink-0 ${overCap ? 'text-amber-400' : 'text-slate-500'}`}>
                비중 {positionPct.toFixed(1)}% {overCap ? '⚠️' : '✓'}
              </span>
            </div>
          </div>

          {/* CEO 오버라이드 */}
          {needsOverride && (
            <div className="bg-amber-500/10 ring-1 ring-amber-500/30 rounded-xl px-3 py-2.5 space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={ceoOverride} onChange={(e) => setCeoOverride(e.target.checked)} className="accent-amber-500 w-4 h-4" />
                <span className="text-[11px] font-bold text-amber-300">CEO 책임 매수 (cap 무시)</span>
              </label>
              {ceoOverride && (
                <input type="text" placeholder="사유 (예: 고확신 종목)"
                  value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)}
                  className="w-full bg-white/[0.05] ring-1 ring-amber-500/30 rounded-lg px-3 py-2 text-[11px] text-amber-200 placeholder:text-amber-700/50 focus:outline-none focus:ring-2 focus:ring-amber-500/50" />
              )}
            </div>
          )}

          {/* 버튼 */}
          <div className="flex gap-2 pt-1">
            <Button variant="ghost" size="sm" className="px-4 py-2.5 text-slate-500 shrink-0" onClick={onClose}>취소</Button>
            <Button
              variant="primary"
              size="lg"
              className="flex-1 py-2.5"
              disabled={executing || actualQty <= 0 || (needsOverride && (!ceoOverride || !overrideReason.trim()))}
              onClick={executeBuy}
            >
              {executing ? (
                <span className="flex items-center justify-center gap-1.5">
                  <Spinner size="sm" color="white" as="span" />
                  매수 중
                </span>
              ) : actualQty <= 0 ? '잔고 부족' : (
                <span className="truncate">{isLive ? '실전' : '연습'} {actualQty}주 매수</span>
              )}
            </Button>
          </div>
        </>
      ) : (
        <div className="text-center py-4">
          <p className="text-sm text-rose-400">권장 금액 조회 실패</p>
          <Button variant="ghost" size="sm" className="mt-2 text-slate-500" onClick={onClose}>닫기</Button>
        </div>
      )}
    </>
  );
}

// ═══════════════════════════════════════════
// 통합 모달
// ═══════════════════════════════════════════

export default function UnifiedBuyModal(props: UnifiedBuyModalProps) {
  const { market, open, onClose, viewMode, stockName, stockCode } = props;

  if (!open) return null;

  const isLive = viewMode === 'live';
  const title = market === 'KR'
    ? (stockName ? `${stockName}` : '국내 수동매수')
    : '해외 수동매수';
  const subtitle = market === 'KR' && stockCode ? stockCode : undefined;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className={`w-full ${market === 'KR' ? 'sm:w-[440px]' : 'sm:w-[420px]'} max-h-[92vh] overflow-y-auto bg-[#0f1422] border border-white/[0.08] rounded-t-2xl sm:rounded-2xl shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 공통 헤더 */}
        <div className={`px-4 py-3 border-b ${isLive ? 'border-rose-500/30 bg-rose-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-sm font-bold text-slate-200 truncate">{title}</h2>
              {subtitle && <span className="text-[10px] text-slate-500 shrink-0">{subtitle}</span>}
            </div>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold shrink-0 ${isLive ? 'bg-rose-500/20 text-rose-400' : 'bg-amber-500/20 text-amber-400'}`}>
              {isLive ? '실전' : '연습'}
            </span>
          </div>
        </div>

        <div className="px-4 py-3 space-y-3">
          {market === 'US' ? <UsBody {...props} /> : <KrBody {...props} />}
        </div>
      </div>
    </div>
  );
}
