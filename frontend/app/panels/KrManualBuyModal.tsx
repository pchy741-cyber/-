'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { ScoreSparkline } from '@/components/ScoreSparkline';
import { api, fmtWon } from '../lib/utils';
import type { ConfirmFn } from '../types';

/**
 * 🛒 국내 매수 모달 — 갤25 반응형 최적화
 */

interface Props {
  open: boolean;
  stockCode: string;
  stockName: string;
  aiScore: number;
  confidence?: number;
  rsi?: number;
  volumeRatio?: number;
  pullbackSignal?: boolean;
  currentPrice: number;
  viewMode: 'paper' | 'live';
  onClose: () => void;
  onSuccess: () => void;
  toast?: (msg: string, type?: 'ok' | 'err' | 'info') => void;
  confirm?: ConfirmFn;
}

interface EstimateResult {
  amount_krw: number;
  dynPct: number;
  totalCapital: number;
  stopLossPct: number;
  isElite: boolean;
}

export default function KrManualBuyModal({
  open, stockCode, stockName, aiScore, confidence, rsi, volumeRatio, pullbackSignal,
  currentPrice, viewMode, onClose, onSuccess, toast, confirm,
}: Props) {
  const [recommended, setRecommended] = useState<EstimateResult | null>(null);
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
        const est = (await api(`/manual-buy/estimate?${qp.toString()}`)) as EstimateResult;
        if (!cancelled) setRecommended(est);
      } catch (e) {
        if (!cancelled) toast?.((e as Error).message ?? '권장 금액 조회 실패', 'err');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, stockCode, aiScore, viewMode, confidence, pullbackSignal, toast]);

  if (!open) return null;

  const actualAmount = recommended ? Math.round(recommended.amount_krw * multiplier) : 0;
  const actualQty = currentPrice > 0 ? Math.floor(actualAmount / currentPrice) : 0;
  const actualCost = actualQty * currentPrice;
  const positionPct = recommended && recommended.totalCapital > 0 ? (actualCost / recommended.totalCapital) * 100 : 0;
  const overCap = positionPct > 35;
  const needsOverride = overCap;

  async function executeBuy() {
    if (needsOverride && !ceoOverride) { toast?.('35% 초과 → CEO 토글 필요', 'err'); return; }
    if (needsOverride && ceoOverride && !overrideReason.trim()) { toast?.('CEO override 사유 입력 필요', 'err'); return; }
    // 🔒 확인 다이얼로그 — 실수 매수 방지
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
      const r = (await api('/manual-buy', { method: 'POST', body: JSON.stringify(body) })) as { quantity?: number; price?: number };
      toast?.(`${stockName} ${r.quantity ?? actualQty}주 매수 완료`, 'ok');
      onSuccess();
      onClose();
    } catch (e) {
      toast?.((e as Error).message ?? '매수 실패', 'err');
    } finally {
      setExecuting(false);
    }
  }

  const isLive = viewMode === 'live';

  return (
    <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="w-full sm:w-[440px] max-h-[92vh] overflow-y-auto bg-[#0f1422] border border-white/[0.08] rounded-t-2xl sm:rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 — 종목정보 통합 */}
        <div className={`px-4 py-3 border-b ${isLive ? 'border-rose-500/30 bg-rose-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-sm font-bold text-slate-200 truncate">{stockName}</h2>
              <span className="text-[10px] text-slate-500 shrink-0">{stockCode}</span>
            </div>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold shrink-0 ${isLive ? 'bg-rose-500/20 text-rose-400' : 'bg-amber-500/20 text-amber-400'}`}>
              {isLive ? '실전' : '연습'}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1.5 text-[10px] text-slate-500">
            <span className="text-sm font-bold text-slate-200 tabular-nums">₩{currentPrice.toLocaleString('ko-KR')}</span>
            <span>AI {aiScore}점</span>
            {rsi != null && <span>RSI {rsi.toFixed(0)}</span>}
            {volumeRatio != null && <span>거래량 {volumeRatio.toFixed(1)}x</span>}
            <div className="ml-auto">
              <ScoreSparkline stockCode={stockCode} hours={24} width={60} height={20} />
            </div>
          </div>
        </div>

        <div className="px-4 py-3 space-y-3">
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
              {/* 시스템 권장 — 컴팩트 */}
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

              {/* 슬라이더 — 컴팩트 */}
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

              {/* 실제 매수 결과 — 핵심 정보만 */}
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

              {/* CEO 오버라이드 — 컴팩트 */}
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

              {/* 매수 / 닫기 버튼 */}
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
                      <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
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
        </div>
      </div>
    </div>
  );
}
