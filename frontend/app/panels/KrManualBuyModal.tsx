'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { ScoreSparkline } from '@/components/ScoreSparkline';
import { api } from '../lib/utils';

/**
 * 🛒 국내 매수 모달 (자유도)
 *
 * CEO 지시 (2026-06-12):
 *   "모달로 얼마살지 또는 더 살 수 있게끔"
 *   "고정형 황금비율% 좋긴 한데 더 사게끔 — 내가 책임지는 건데"
 *
 * 기능:
 *  - 시스템 권장 금액 표시 (자동 사이징)
 *  - 슬라이더 0.5x ~ 3.0x (배수 조절)
 *  - CEO 책임 매수 토글 (cap 35% 초과 허용)
 *  - 사유 입력
 *  - 예상 수량/실제 매수가 실시간
 *  - 점수 시계열 그래프
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
}

interface EstimateResult {
  amount_krw: number;
  dynPct: number;
  totalCapital: number;
  stopLossPct: number;
  isElite: boolean;
}

export default function KrManualBuyModal({
  open,
  stockCode,
  stockName,
  aiScore,
  confidence,
  rsi,
  volumeRatio,
  pullbackSignal,
  currentPrice,
  viewMode,
  onClose,
  onSuccess,
  toast,
}: Props) {
  const [recommended, setRecommended] = useState<EstimateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  // 슬라이더 배수: 0.3 ~ 3.0 (시스템 권장 × multiplier)
  const [multiplier, setMultiplier] = useState(1.0);
  // CEO 책임 매수 토글
  const [ceoOverride, setCeoOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  // 모달 열릴 때 권장 금액 조회
  useEffect(() => {
    if (!open || !stockCode) return;
    setRecommended(null);
    setMultiplier(1.0);
    setCeoOverride(false);
    setOverrideReason('');
    let cancelled = false;
    async function loadRecommended() {
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
    }
    loadRecommended();
    return () => {
      cancelled = true;
    };
  }, [open, stockCode, aiScore, viewMode, confidence, pullbackSignal, toast]);

  if (!open) return null;

  const actualAmount = recommended ? Math.round(recommended.amount_krw * multiplier) : 0;
  const actualQty = currentPrice > 0 ? Math.floor(actualAmount / currentPrice) : 0;
  const actualCost = actualQty * currentPrice;
  const positionPct =
    recommended && recommended.totalCapital > 0
      ? (actualCost / recommended.totalCapital) * 100
      : 0;
  const overCap = positionPct > 35;
  const needsOverride = overCap;

  async function executeBuy() {
    if (needsOverride && !ceoOverride) {
      toast?.('35% 초과 매수는 CEO 책임 토글 필요', 'err');
      return;
    }
    if (needsOverride && ceoOverride && !overrideReason.trim()) {
      toast?.('CEO override 시 사유 입력 필요', 'err');
      return;
    }
    setExecuting(true);
    try {
      const body = {
        stock_code: stockCode,
        amount_krw: actualAmount,
        ai_score: aiScore,
        is_paper: viewMode === 'paper',
        rsi,
        volume_ratio: volumeRatio,
        pullback_signal: pullbackSignal,
        confidence,
        reasoning: `Manual buy (modal): ${multiplier.toFixed(1)}x 권장${ceoOverride ? ` [CEO: ${overrideReason}]` : ''}`,
        ceo_override: ceoOverride,
        override_reason: ceoOverride ? overrideReason : undefined,
      };
      const r = (await api('/manual-buy', {
        method: 'POST',
        body: JSON.stringify(body),
      })) as { quantity?: number; price?: number };
      toast?.(`${stockCode} ${r.quantity ?? actualQty}주 매수 완료`, 'ok');
      onSuccess();
      onClose();
    } catch (e) {
      toast?.((e as Error).message ?? '매수 실패', 'err');
    } finally {
      setExecuting(false);
    }
  }

  const modeLabel = viewMode === 'live' ? '실전' : '연습';
  const modeColor = viewMode === 'live' ? 'bg-rose-500/20 text-rose-400' : 'bg-amber-500/20 text-amber-400';

  return (
    <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="w-full sm:w-[460px] max-h-[90vh] overflow-y-auto bg-[#0f1422] border border-white/[0.08] rounded-t-2xl sm:rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${viewMode === 'paper' ? 'border-amber-500/30 bg-amber-500/5' : 'border-rose-500/30 bg-rose-500/5'}`}>
          <h2 className="text-sm font-bold text-slate-200">국내주식 수동매수</h2>
          <span className={`text-[11px] px-3 py-1 rounded-full font-bold ${modeColor}`}>{modeLabel} 모드</span>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* 종목 정보 */}
          <div className="bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl px-4 py-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-slate-200">{stockName}</span>
              <span className="text-sm font-bold tabular-nums text-slate-300">
                ₩{currentPrice.toLocaleString('ko-KR')}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-slate-500">
              <span>{stockCode}</span>
              <span>AI {aiScore}점</span>
              {rsi != null && <span>RSI {rsi.toFixed(0)}</span>}
              {volumeRatio != null && <span>거래량 {volumeRatio.toFixed(1)}x</span>}
              <div className="ml-auto">
                <ScoreSparkline stockCode={stockCode} hours={24} width={70} height={24} />
              </div>
            </div>
          </div>

          {/* 로딩 / 권장 결과 */}
          {loading ? (
            <div className="text-center py-6 text-sm text-slate-500">권장 금액 계산 중...</div>
          ) : recommended ? (
            <>
              {/* 시스템 권장 */}
              <div className="bg-blue-500/10 ring-1 ring-blue-500/20 rounded-xl px-4 py-3 space-y-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-400">시스템 권장 (자동 사이징)</span>
                  <span className="text-blue-300 font-bold tabular-nums">
                    ₩{recommended.amount_krw.toLocaleString('ko-KR')}
                  </span>
                </div>
                <div className="flex justify-between text-[10px] text-slate-500">
                  <span>총자본 {recommended.dynPct}%</span>
                  <span>SL {recommended.stopLossPct}%</span>
                </div>
              </div>

              {/* 슬라이더 — CEO가 더/덜 살지 */}
              <div className="space-y-2">
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-400">매수 배수</span>
                  <span className={`font-bold tabular-nums ${multiplier > 1.5 ? 'text-amber-400' : multiplier < 1 ? 'text-slate-400' : 'text-emerald-400'}`}>
                    {multiplier.toFixed(1)}x
                  </span>
                </div>
                <input
                  type="range"
                  min="0.3"
                  max="3.0"
                  step="0.1"
                  value={multiplier}
                  onChange={(e) => setMultiplier(Number(e.target.value))}
                  className="w-full accent-blue-500"
                />
                <div className="flex justify-between text-[9px] text-slate-600">
                  <span>0.3x</span>
                  <span>1.0x (권장)</span>
                  <span>3.0x</span>
                </div>
              </div>

              {/* 실제 매수 금액 */}
              <div className={`rounded-xl px-4 py-3 space-y-1.5 ${overCap ? 'bg-amber-500/10 ring-1 ring-amber-500/30' : 'bg-emerald-500/10 ring-1 ring-emerald-500/20'}`}>
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-400">실제 매수 금액</span>
                  <span className={`font-bold tabular-nums ${overCap ? 'text-amber-300' : 'text-emerald-300'}`}>
                    ₩{actualCost.toLocaleString('ko-KR')} ({actualQty}주)
                  </span>
                </div>
                <div className="flex justify-between text-[10px] text-slate-500">
                  <span>비중 {positionPct.toFixed(1)}%</span>
                  <span>{overCap ? '⚠️ 35% cap 초과' : '✓ cap 이내'}</span>
                </div>
              </div>

              {/* CEO 책임 매수 토글 (cap 초과 시 필수) */}
              {needsOverride && (
                <div className="bg-amber-500/10 ring-1 ring-amber-500/30 rounded-xl px-4 py-3 space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ceoOverride}
                      onChange={(e) => setCeoOverride(e.target.checked)}
                      className="accent-amber-500 w-4 h-4"
                    />
                    <span className="text-[12px] font-bold text-amber-300">CEO 책임 매수 (cap 무시)</span>
                  </label>
                  {ceoOverride && (
                    <input
                      type="text"
                      placeholder="사유 입력 (예: 고확신 종목, CEO 직접 결정)"
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      className="w-full bg-white/[0.05] ring-1 ring-amber-500/30 rounded-lg px-3 py-2 text-[11px] text-amber-200 placeholder:text-amber-700/50 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                    />
                  )}
                  <p className="text-[10px] text-amber-200/70 leading-tight">
                    35% cap 초과 매수는 사용자 책임입니다. 시스템 자동 사이징을 무시합니다.
                  </p>
                </div>
              )}

              {/* 매수 버튼 */}
              <Button
                variant="primary"
                size="lg"
                className="w-full py-3"
                disabled={
                  executing ||
                  actualQty <= 0 ||
                  (needsOverride && (!ceoOverride || !overrideReason.trim()))
                }
                onClick={executeBuy}
              >
                {executing
                  ? '매수 중...'
                  : actualQty <= 0
                    ? '잔고 부족'
                    : `[${modeLabel}] ${stockCode} ${actualQty}주 매수 (₩${actualCost.toLocaleString('ko-KR')})`}
              </Button>
            </>
          ) : (
            <div className="text-center py-6 text-sm text-rose-400">권장 금액 조회 실패</div>
          )}
        </div>

        {/* 닫기 */}
        <div className="px-5 pb-4">
          <Button variant="ghost" size="sm" className="w-full py-2 text-slate-500 hover:text-slate-400" onClick={onClose}>
            닫기
          </Button>
        </div>
      </div>
    </div>
  );
}
