'use client';

import React, { useState, useCallback } from 'react';
import { Button } from '@/components/ui';
import { api, fmtPct, pc, pbg } from '../../lib/utils';
import { toDisplayName } from '../../lib/helpers';
import VisionScalpPanel from '../../panels/VisionScalpPanel';
import ManualBuyModal from '../../panels/ManualBuyModal';
import { UsHoldingTpSlBar } from './UsHoldingTpSlBar';
import type { UsHolding, UsWatchlistItem, Dashboard, ToastFn, ConfirmFn, ViewMode } from '../../types';

interface UsHoldingsTabProps {
  usHoldings: UsHolding[];
  usW: UsWatchlistItem[];
  dash: Dashboard | null;
  busyAction: string | null;
  guard: (key: string, fn: () => Promise<void>) => () => Promise<void>;
  onRefresh: () => void;
  toast: ToastFn;
  confirm: ConfirmFn;
  viewMode?: ViewMode;
  insightsDraft: string;
  setInsightsDraft: (v: string) => void;
  insightsSaving: boolean;
  setInsightsSaving: (v: boolean) => void;
  usInsights: string;
  setUsInsights: (v: string) => void;
}

export default function UsHoldingsTab({
  usHoldings, usW, dash, busyAction, guard, onRefresh, toast, confirm,
  insightsDraft, setInsightsDraft, insightsSaving, setInsightsSaving, usInsights, setUsInsights,
  viewMode = 'live',
}: UsHoldingsTabProps) {
  const [editingTpSl, setEditingTpSl] = useState<string | null>(null);
  const [editTp, setEditTp] = useState('');
  const [editSl, setEditSl] = useState('');
  const [showManualBuy, setShowManualBuy] = useState(false);

  const saveTpSl = useCallback(async (code: string) => {
    const tp = parseFloat(editTp);
    const sl = parseFloat(editSl);
    if (isNaN(tp) || isNaN(sl)) { toast?.('숫자를 입력하세요', 'err'); return; }
    try {
      await api(`/overseas/holdings/${code}/tpsl`, {
        method: 'PATCH',
        body: JSON.stringify({ tp_pct: tp, sl_pct: sl < 0 ? sl : -sl, is_paper: viewMode === 'paper' }),
      });
      setEditingTpSl(null);
      toast?.('TP/SL 저장됨', 'ok');
      onRefresh();
    } catch (e: unknown) { toast?.((e as Error).message || '저장 실패', 'err'); }
  }, [editTp, editSl, viewMode, toast, onRefresh]);

  return (
    <div>
      {usHoldings.length > 0 && (
        <div className="divide-y divide-white/[0.03]">
          {usHoldings.map((h: UsHolding) => {
            const priceData = usW.find((s: UsWatchlistItem) => s.code === h.stock_code);
            const curPrice = (priceData?.price ?? 0) > 0 ? (priceData!.price ?? 0) : (h.last_price ?? 0);
            const isStale = (priceData?.price ?? 0) === 0 && curPrice > 0;
            const displayPrice = curPrice > 0 ? curPrice : h.avg_price;
            const isAvgFallback = curPrice === 0 && displayPrice > 0;
            const invested = h.avg_price * h.quantity;
            const pnl = displayPrice > 0 ? (displayPrice - h.avg_price) * h.quantity : 0;
            const pnlPct = displayPrice > 0 && h.avg_price > 0 ? ((displayPrice - h.avg_price) / h.avg_price) * 100 : 0;
            const usDisplayName = toDisplayName(priceData?.name, h.stock_code);
            // 동적 TP/SL 데이터
            const tpPct = h.tp_pct;
            const slPct = h.sl_pct;
            const isScalp = !!h.is_scalp;
            const scalpTpPct = isScalp && h.scalp_tp && h.avg_price > 0 ? ((h.scalp_tp - h.avg_price) / h.avg_price) * 100 : null;
            const scalpSlPct = isScalp && h.scalp_sl && h.avg_price > 0 ? ((h.scalp_sl - h.avg_price) / h.avg_price) * 100 : null;
            const effectiveTp: number | null = scalpTpPct ?? tpPct ?? null;
            const effectiveSl: number | null = scalpSlPct ?? slPct ?? null;
            // 트레일링 / 부분익절 데이터
            const trailPct = h.trail_pct ?? 8;
            const trailActive = !!h.trail_active;
            const trailStopPct = h.trail_stop_pct ?? (slPct ?? -5);
            const maxPnlPct = h.max_pnl_pct ?? 0;
            const partialStage = h.partial_tp_stage ?? 0;
            const nextPartialTpPct = h.next_partial_tp_pct ?? null;
            return (
              <div key={h.stock_code} className="px-4 py-3 space-y-2">
                {/* 상단: 종목명 + 수익률 + 매도버튼 */}
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold">{usDisplayName}</span>
                      <span className="text-[10px] text-slate-500">{h.quantity}주</span>
                      {isScalp && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium">단타</span>}
                      {h.sector && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-slate-700/50 text-slate-400">{h.sector}</span>}
                    </div>
                    <div className="text-[11px] text-slate-500">평단 ${h.avg_price.toFixed(2)} · 투자 ${invested.toFixed(0)}</div>
                  </div>
                  <div className="text-right">
                    {displayPrice > 0 ? (
                      <>
                        <div className={`text-base font-bold ${pc(pnl)}`}>{pnlPct > 0 ? '+' : ''}{pnlPct.toFixed(1)}%</div>
                        <div className={`text-[11px] ${pc(pnl)}`}>${pnl.toFixed(0)}</div>
                        {isAvgFallback && <div className="text-[10px] text-slate-600">매수가 기준</div>}
                        {isStale && !isAvgFallback && <div className="text-[10px] text-slate-600">장마감 시세</div>}
                      </>
                    ) : <span className="text-xs text-slate-600">시세 없음</span>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {h.quantity >= 4 && [25, 50, 75].map(pct => {
                      const sellQty = Math.max(1, Math.round(h.quantity * pct / 100));
                      return (
                        <Button key={pct} variant="ghost" size="sm" className="text-[10px] px-1.5 py-1 hover:bg-amber-500/10 hover:text-amber-400 text-slate-600 border border-white/[0.03]"
                          disabled={!!busyAction} onClick={guard(`sell-us-${h.stock_code}-${pct}`, async () => {
                          const liveUS = viewMode === 'live' ? '⚠️ [실전모드] ' : '[연습모드] ';
                          if (!await confirm({title: `${liveUS}${usDisplayName} ${sellQty}주 (${pct}%) 시장가 매도하시겠습니까?`, confirmLabel: '매도', confirmVariant: 'danger'})) return;
                          try {
                            const r = await api(`/sell-overseas/${h.stock_code}`, { method: 'POST', body: JSON.stringify({ is_paper: viewMode === 'paper', quantity: sellQty }), timeout: 40000 });
                            toast(r.message || '매도 완료', 'ok');
                            onRefresh();
                          } catch (err: unknown) { toast('매도 실패: ' + (err as Error).message, 'err'); }
                        })}>
                          {pct}%
                        </Button>
                      );
                    })}
                    <Button variant="ghost" size="sm" className="text-xs hover:bg-rose-500/10 hover:text-rose-400 text-slate-500 border border-white/[0.04] whitespace-nowrap"
                      disabled={!!busyAction} onClick={guard(`sell-us-${h.stock_code}`, async () => {
                      const liveUS = viewMode === 'live' ? '⚠️ [실전모드] ' : '[연습모드] ';
                      if (!await confirm({title: `${liveUS}${usDisplayName} ${h.quantity}주 전량 시장가 매도하시겠습니까?`, confirmLabel: '전량 매도', confirmVariant: 'danger'})) return;
                      try {
                        const r = await api(`/sell-overseas/${h.stock_code}`, { method: 'POST', body: JSON.stringify({ is_paper: viewMode === 'paper' }), timeout: 40000 });
                        toast(r.message || '매도 완료', 'ok');
                        onRefresh();
                      } catch (err: unknown) {
                        if (await confirm({title: `매도 실패: ${(err as Error).message}`, description: `장마감 등으로 KIS 주문 불가 시, 강제 DB 청산하시겠습니까?\n(마지막 시세 $${displayPrice.toFixed(2)} 기준 정산)`, confirmLabel: '강제 청산', confirmVariant: 'danger'})) {
                          try {
                            const r2 = await api(`/sell-overseas-force/${h.stock_code}`, { method: 'POST', body: JSON.stringify({ is_paper: viewMode === 'paper' }), timeout: 20000 });
                            toast(r2.message || '강제 청산 완료', 'ok');
                            onRefresh();
                          } catch (e2: unknown) { toast('강제 청산 실패: ' + (e2 as Error).message, 'err'); }
                        }
                      }
                    })}>
                      전량
                    </Button>
                  </div>
                </div>
                {/* 하단: 동적 TP/SL 프로그레스바 + 트레일링 상태 */}
                {displayPrice > 0 && (
                  <UsHoldingTpSlBar
                    stockCode={h.stock_code} pnlPct={pnlPct}
                    effectiveTp={effectiveTp} effectiveSl={effectiveSl} avgPrice={h.avg_price}
                    editingTpSl={editingTpSl} editTp={editTp} editSl={editSl}
                    setEditingTpSl={setEditingTpSl} setEditTp={setEditTp} setEditSl={setEditSl}
                    saveTpSl={saveTpSl}
                    trailPct={trailPct} trailActive={trailActive} trailStopPct={trailStopPct}
                    maxPnlPct={maxPnlPct} partialStage={partialStage} nextPartialTpPct={nextPartialTpPct}
                  />
                )}
                {/* TP/SL 미설정 시 (레거시 보유종목) */}
                {displayPrice > 0 && (effectiveTp == null || effectiveSl == null) && (
                  <div className="text-[10px] text-slate-600 px-1">TP/SL 미설정 — 다음 사이클에서 자동 계산됩니다</div>
                )}
                {/* 시세 없을 때 (장 마감/API 실패) */}
                {displayPrice === 0 && (
                  <div className="text-[10px] text-slate-600 px-1">시세 대기 — 장 시작 시 자동 업데이트</div>
                )}
              </div>
            );
          })}
          {/* 전종목 일괄 탈출 버튼 */}
          {usHoldings.length >= 2 && (
            <div className="px-4 py-2 border-t border-white/[0.04]">
              <Button variant="ghost" size="sm" className="w-full py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20"
                disabled={!!busyAction} onClick={guard('sell-us-all', async () => {
                const liveUS = viewMode === 'live' ? '⚠️ [실전모드] ' : '[연습모드] ';
                if (!await confirm({title: `${liveUS}해외 보유종목 ${usHoldings.length}종목 전부 일괄 청산하시겠습니까?`, description: '장마감 시 마지막 시세 기준 DB 강제 청산됩니다.', confirmLabel: '일괄 청산', confirmVariant: 'danger'})) return;
                try {
                  const r = await api('/sell-overseas-all', { method: 'POST', body: JSON.stringify({ is_paper: viewMode === 'paper', force_db: true }), timeout: 60000 });
                  toast(r.message || '전종목 청산 완료', 'ok');
                  onRefresh();
                } catch (err: unknown) { toast('일괄 청산 실패: ' + (err as Error).message, 'err'); }
              })}>
                전종목 일괄 청산 ({usHoldings.length}종목)
              </Button>
            </div>
          )}
        </div>
      )}
      {/* 수동매수 버튼 */}
      <div className="px-4 py-2">
        <Button variant="ghost" size="md" className="w-full py-2.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/20"
          onClick={() => setShowManualBuy(true)}>
          수동 매수
        </Button>
      </div>
      {/* 제보 단타 */}
      <VisionScalpPanel toast={toast as (msg: string, type?: string) => void} />
      {/* 감시 종목 그리드 */}
      {usW.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-3.5">
          {usW.map((s: UsWatchlistItem) => {
            const held = usHoldings.find((h: UsHolding) => h.stock_code === s.code);
            const usDisplayName = toDisplayName(s.name, s.code);
            const hasPrice = (s.price ?? 0) > 0;
            return (
              <div key={s.code} className={`rounded-xl border p-3 text-center transition-all hover:scale-[1.02] ${hasPrice ? pbg(s.changePct) : ''} ${held ? 'border-blue-500/40' : 'border-slate-700/30'}`}>
                <div className="text-xs font-bold text-slate-300 truncate">{usDisplayName} {held ? '📌' : ''}</div>
                <div className={`text-base font-bold mt-1 ${!hasPrice ? 'text-slate-600' : ''}`}>{hasPrice ? `$${s.price!.toFixed(1)}` : '-'}</div>
                <div className={`text-[11px] font-semibold mt-0.5 ${hasPrice ? pc(s.changePct) : 'text-slate-600'}`}>{hasPrice ? fmtPct(s.changePct) : '장마감'}</div>
              </div>
            );
          })}
        </div>
      )}
      {usW.length === 0 && usHoldings.length === 0 && (
        <div className="p-8 text-center space-y-2">
          <div className="text-2xl opacity-30">🌏</div>
          <p className="text-sm text-slate-400">장 마감 — 다음 세션 시작 시 시세 자동 업데이트</p>
          <p className="text-[11px] text-slate-600">🇯🇵 09:00~15:00 · 🇹🇼 10:00~14:30 · 🇺🇸 22:30~06:30 (서머타임)</p>
        </div>
      )}
      {/* 수동매수 모달 */}
      <ManualBuyModal
        open={showManualBuy}
        onClose={() => setShowManualBuy(false)}
        onSuccess={onRefresh}
        toast={toast as (msg: string, type?: string) => void}
        confirm={confirm}
        viewMode={viewMode}
        watchlist={usW.map((s: UsWatchlistItem) => ({ code: s.code, name: s.name ?? s.code, exchange: s.exchange ?? 'NASDAQ' }))}
      />
      {/* 운영자 인사이트 입력 */}
      <div className="border-t border-white/[0.04] px-4 py-3">
        <div className="text-[11px] text-slate-500 mb-1.5 font-medium">💡 AI 인사이트 메모 <span className="text-slate-600">(다음 사이클에 AI에게 전달됩니다)</span></div>
        <textarea
          value={insightsDraft}
          onChange={e => setInsightsDraft(e.target.value)}
          placeholder="예: 미국 연준 금리 동결 예상, 반도체 섹터 주목 등 시장 상황을 자유롭게 입력하세요"
          rows={2}
          className="w-full bg-slate-800/60 border border-slate-700/50 rounded-xl px-3 py-2 text-xs text-slate-300 placeholder:text-slate-600 focus:border-blue-500/50 focus:outline-none resize-none"
        />
        <div className="flex items-center justify-between mt-1.5">
          {usInsights && insightsDraft === usInsights
            ? <span className="text-[10px] text-emerald-500/70">✓ 저장됨</span>
            : <span className="text-[10px] text-slate-600">{insightsDraft.length > 0 ? '미저장' : ''}</span>}
          <Button variant="primary" size="sm" className="text-[11px] px-3 py-1 bg-blue-600/70 hover:bg-blue-500/70"
            disabled={insightsSaving || insightsDraft === usInsights}
            onClick={async () => {
              setInsightsSaving(true);
              try {
                await api('/overseas/insights', { method: 'PUT', body: JSON.stringify({ insights: insightsDraft }) });
                setUsInsights(insightsDraft);
                toast?.('인사이트 저장됨', 'ok');
              } catch { toast?.('저장 실패', 'err'); }
              setInsightsSaving(false);
            }}>
            {insightsSaving ? '저장중...' : '저장'}
          </Button>
        </div>
      </div>
    </div>
  );
}
