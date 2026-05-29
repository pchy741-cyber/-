'use client';

import React from 'react';
import { api, fmtPct, pc, pbg } from '../../lib/utils';
import { toDisplayName } from '../../lib/helpers';
import VisionScalpPanel from '../../panels/VisionScalpPanel';

interface UsHoldingsTabProps {
  usHoldings: any[];
  usW: any[];
  dash: any;
  busyAction: string | null;
  guard: (key: string, fn: () => Promise<void>) => () => Promise<void>;
  onRefresh: () => void;
  toast: any;
  viewMode?: 'paper' | 'live';
  insightsDraft: string;
  setInsightsDraft: (v: string) => void;
  insightsSaving: boolean;
  setInsightsSaving: (v: boolean) => void;
  usInsights: string;
  setUsInsights: (v: string) => void;
}

export default function UsHoldingsTab({
  usHoldings, usW, dash, busyAction, guard, onRefresh, toast,
  insightsDraft, setInsightsDraft, insightsSaving, setInsightsSaving, usInsights, setUsInsights,
  viewMode = 'live',
}: UsHoldingsTabProps) {
  return (
    <div>
      {usHoldings.length > 0 && (
        <div className="divide-y divide-white/[0.03]">
          {usHoldings.map((h: any) => {
            const priceData = usW.find((s: any) => s.code === h.stock_code);
            const curPrice = (priceData?.price ?? 0) > 0 ? priceData!.price : (h.last_price ?? 0);
            const isStale = (priceData?.price ?? 0) === 0 && curPrice > 0;
            const displayPrice = curPrice > 0 ? curPrice : (h.avg_price ?? 0);
            const isAvgFallback = curPrice === 0 && displayPrice > 0;
            const invested = h.avg_price * h.quantity;
            const pnl = displayPrice > 0 ? (displayPrice - h.avg_price) * h.quantity : 0;
            const pnlPct = displayPrice > 0 && h.avg_price > 0 ? ((displayPrice - h.avg_price) / h.avg_price) * 100 : 0;
            const usDisplayName = toDisplayName(priceData?.name, h.stock_code);
            // 동적 TP/SL 데이터 (서버 매매엔진에서 실시간 계산됨)
            const tpPct = h.tp_pct ?? 20;
            const slPct = h.sl_pct ?? -5;
            const trailPct = h.trail_pct ?? 8;
            const trailActive = !!h.trail_active;
            const trailStopPct = h.trail_stop_pct ?? slPct;
            const maxPnlPct = h.max_pnl_pct ?? 0;
            const partialStage = h.partial_tp_stage ?? 0;
            const nextPartialTpPct = h.next_partial_tp_pct;
            const isScalp = !!h.is_scalp;
            const scalpTpPct = isScalp && h.scalp_tp && h.avg_price > 0 ? ((h.scalp_tp - h.avg_price) / h.avg_price) * 100 : null;
            const scalpSlPct = isScalp && h.scalp_sl && h.avg_price > 0 ? ((h.scalp_sl - h.avg_price) / h.avg_price) * 100 : null;
            const effectiveTp = scalpTpPct ?? tpPct;
            const effectiveSl = scalpSlPct ?? slPct;
            // 프로그레스바: SL~TP 범위에서 현재 위치
            const range = effectiveTp - effectiveSl;
            const progress = range > 0 ? Math.max(0, Math.min(100, ((pnlPct - effectiveSl) / range) * 100)) : 50;
            const targetPrice = h.avg_price * (1 + effectiveTp / 100);
            const stopPrice = h.avg_price * (1 + effectiveSl / 100);
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
                  <button disabled={!!busyAction} onClick={guard(`sell-us-${h.stock_code}`, async () => {
                    const liveUS = viewMode === 'live' ? '⚠️ [실전모드] ' : '[연습모드] ';
                    if (!confirm(`${liveUS}${usDisplayName} ${h.quantity}주 전량 시장가 매도하시겠습니까?`)) return;
                    try {
                      const r = await api(`/sell-overseas/${h.stock_code}`, { method: 'POST', body: JSON.stringify({ is_paper: viewMode === 'paper' }), timeout: 40000 });
                      alert(r.message || '매도 완료');
                      onRefresh();
                    } catch (err: any) {
                      // KIS 실패 시 강제 DB 청산 제안
                      if (confirm(`매도 실패: ${err.message}\n\n장마감 등으로 KIS 주문 불가 시, 강제 DB 청산하시겠습니까?\n(마지막 시세 $${displayPrice.toFixed(2)} 기준 정산)`)) {
                        try {
                          const r2 = await api(`/sell-overseas-force/${h.stock_code}`, { method: 'POST', body: JSON.stringify({ is_paper: viewMode === 'paper' }), timeout: 20000 });
                          alert(r2.message || '강제 청산 완료');
                          onRefresh();
                        } catch (e2: any) { alert('강제 청산 실패: ' + e2.message); }
                      }
                    }
                  })} className="text-xs px-2.5 py-1.5 rounded-xl bg-white/[0.04] hover:bg-rose-500/10 hover:text-rose-400 text-slate-500 font-medium border border-white/[0.04] whitespace-nowrap shrink-0 disabled:opacity-40">
                    매도
                  </button>
                </div>
                {/* 하단: 동적 TP/SL 프로그레스바 + 트레일링 상태 */}
                {displayPrice > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span className="text-rose-400 font-medium tabular-nums text-right">{effectiveSl.toFixed(1)}%</span>
                      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden relative">
                        <div className="absolute inset-0 flex">
                          <div className="h-full bg-gradient-to-r from-rose-500/40 to-slate-600/20" style={{ width: '100%' }} />
                        </div>
                        <div
                          className={`absolute top-0 left-0 h-full rounded-full transition-all ${pnlPct >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`}
                          style={{ width: `${progress}%` }}
                        />
                        {/* 부분익절 단계 마커들 */}
                        {nextPartialTpPct != null && nextPartialTpPct !== effectiveTp && range > 0 && (
                          <div
                            className="absolute top-0 h-full w-px bg-cyan-400/50"
                            style={{ left: `${Math.max(0, Math.min(100, ((nextPartialTpPct - effectiveSl) / range) * 100))}%` }}
                            title={`부분익절 +${nextPartialTpPct}%`}
                          />
                        )}
                        {/* 트레일링 활성화/스톱 마커 */}
                        {range > 0 && !trailActive && (
                          <div
                            className="absolute top-0 h-full w-px bg-yellow-500/40"
                            style={{ left: `${Math.max(0, Math.min(100, ((trailPct - effectiveSl) / range) * 100))}%` }}
                            title={`트레일 활성: +${trailPct}%`}
                          />
                        )}
                        {trailActive && range > 0 && (
                          <div
                            className="absolute top-0 h-full w-[3px] bg-yellow-400/80 rounded-full"
                            style={{ left: `${Math.max(0, Math.min(100, ((trailStopPct - effectiveSl) / range) * 100))}%` }}
                            title={`트레일 스톱: ${trailStopPct >= 0 ? '+' : ''}${trailStopPct.toFixed(1)}%`}
                          />
                        )}
                      </div>
                      <span className="text-emerald-400 font-medium tabular-nums">+{effectiveTp.toFixed(1)}%</span>
                    </div>
                    <div className="flex justify-between text-[10px] text-slate-600 px-1">
                      <span>{trailActive
                        ? <span className="text-yellow-500">트레일 ${(h.avg_price * (1 + trailStopPct / 100)).toFixed(2)}</span>
                        : <>손절 ${stopPrice.toFixed(2)}</>
                      }</span>
                      <span>{trailActive
                        ? <span className="text-yellow-500">고점+{maxPnlPct.toFixed(1)}%</span>
                        : partialStage > 0
                          ? <span className="text-cyan-500">{partialStage}단계 실현</span>
                          : nextPartialTpPct != null
                            ? <span className="text-slate-500">1차 +{nextPartialTpPct}%</span>
                            : <span className="text-slate-500">트레일 +{trailPct}%</span>
                      }</span>
                      <span>목표 ${targetPrice.toFixed(2)}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {/* 전종목 일괄 탈출 버튼 */}
          {usHoldings.length >= 2 && (
            <div className="px-4 py-2 border-t border-white/[0.04]">
              <button disabled={!!busyAction} onClick={guard('sell-us-all', async () => {
                const liveUS = viewMode === 'live' ? '⚠️ [실전모드] ' : '[연습모드] ';
                if (!confirm(`${liveUS}해외 보유종목 ${usHoldings.length}종목 전부 일괄 청산하시겠습니까?\n\n장마감 시 마지막 시세 기준 DB 강제 청산됩니다.`)) return;
                try {
                  const r = await api('/sell-overseas-all', { method: 'POST', body: JSON.stringify({ is_paper: viewMode === 'paper', force_db: true }), timeout: 60000 });
                  alert(r.message || '전종목 청산 완료');
                  onRefresh();
                } catch (err: any) { alert('일괄 청산 실패: ' + err.message); }
              })} className="w-full text-xs py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 font-medium border border-rose-500/20 disabled:opacity-40">
                전종목 일괄 청산 ({usHoldings.length}종목)
              </button>
            </div>
          )}
        </div>
      )}
      {/* 제보 단타 */}
      <VisionScalpPanel toast={toast} />
      {/* 감시 종목 그리드 */}
      {usW.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-3.5">
          {usW.map((s: any) => {
            const held = usHoldings.find((h: any) => h.stock_code === s.code);
            const usDisplayName = toDisplayName(s.name, s.code);
            const hasPrice = s.price > 0;
            return (
              <div key={s.code} className={`rounded-xl border p-3 text-center transition-all hover:scale-[1.02] ${hasPrice ? pbg(s.changePct) : ''} ${held ? 'border-blue-500/40' : 'border-slate-700/30'}`}>
                <div className="text-xs font-bold text-slate-300 truncate">{usDisplayName} {held ? '📌' : ''}</div>
                <div className={`text-base font-bold mt-1 ${!hasPrice ? 'text-slate-600' : ''}`}>{hasPrice ? `$${s.price.toFixed(1)}` : '-'}</div>
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
          <button
            disabled={insightsSaving || insightsDraft === usInsights}
            onClick={async () => {
              setInsightsSaving(true);
              try {
                await api('/overseas/insights', { method: 'PUT', body: JSON.stringify({ insights: insightsDraft }) });
                setUsInsights(insightsDraft);
                toast?.('인사이트 저장됨', 'ok');
              } catch { toast?.('저장 실패', 'err'); }
              setInsightsSaving(false);
            }}
            className="text-[11px] px-3 py-1 bg-blue-600/70 hover:bg-blue-500/70 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg transition-all"
          >
            {insightsSaving ? '저장중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
