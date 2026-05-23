'use client';

import React from 'react';
import { ConfirmModal } from '@/components/ui';
import { api, fmtWon } from '../lib/utils';

export default function InsightsPanel({ insights: insightsProp, trades, onRefresh, toast }: { insights: any[]; trades?: any[]; onRefresh: () => void; toast?: (msg: string, type: string) => void }) {
  const [deleting, setDeleting] = React.useState<number | null>(null);
  const [applying, setApplying] = React.useState<number | null>(null);
  const [newInsight, setNewInsight] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const [showAdd, setShowAdd] = React.useState(false);
  const [deleteModal, setDeleteModal] = React.useState<{ id: number; insight: string; relatedTrades: any[] } | null>(null);
  const [liveInsights, setLiveInsights] = React.useState<any[] | null>(null);
  React.useEffect(() => {
    const load = () => api('/insights').then((d: any) => setLiveInsights(Array.isArray(d) ? d : [])).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);
  const insights = liveInsights ?? insightsProp;

  const [triggering, setTriggering] = React.useState(false);
  const triggerLearning = async () => {
    setTriggering(true);
    try {
      await api('/run-self-learning', { method: 'POST' });
      toast?.('자기학습 시작 — 잠시 후 인사이트가 업데이트됩니다', 'ok');
      setTimeout(() => api('/insights').then((d: any) => setLiveInsights(Array.isArray(d) ? d : [])).catch(() => {}), 8000);
    } catch { toast?.('자기학습 실행 실패', 'err'); }
    finally { setTriggering(false); }
  };

  const openDeleteModal = (id: number, insight: string) => {
    const words = insight.replace(/[^\w\s가-힣]/g, ' ').split(/\s+/).filter((w: string) => w.length >= 2).slice(0, 8);
    const relatedTrades = (trades ?? []).filter((t: any) => {
      if (t.status !== 'FILLED' || t.side !== 'SELL') return false;
      const avgBuy = Number(t.transaction_chains?.avg_buy_price) || 0;
      const filledPx = Number(t.filled_price) || 0;
      const pnl = avgBuy > 0 && filledPx > 0 ? (filledPx - avgBuy) * (Number(t.quantity) || 0) : 0;
      if (pnl >= 0) return false;
      const hay = ((t.ai_reasoning ?? '') + ' ' + (t.stock_name ?? '')).toLowerCase();
      return words.some((w: string) => hay.includes(w.toLowerCase()));
    }).slice(0, 4);
    setDeleteModal({ id, insight, relatedTrades });
  };

  const confirmDelete = async () => {
    if (!deleteModal) return;
    const id = deleteModal.id;
    setDeleteModal(null);
    setDeleting(id);
    try {
      await api(`/insights/${id}`, { method: 'DELETE', headers: {} });
      setLiveInsights((prev) => (prev ?? []).filter((i) => i.id !== id));
      onRefresh();
    } catch (err: any) {
      alert('삭제 실패: ' + err.message);
    } finally { setDeleting(null); }
  };

  const handleApply = async (id: number) => {
    setApplying(id);
    try {
      const data = await api(`/insights/${id}/apply`, { method: 'POST' });
      if (data.ok) { toast?.(data.message ?? '전략 파라미터 적용 완료', 'ok'); onRefresh(); }
      else toast?.(data.error ?? '적용 실패', 'err');
    } catch { toast?.('적용 요청 실패', 'err'); }
    finally { setApplying(null); }
  };

  const handleAdd = async () => {
    const text = newInsight.trim();
    if (!text) return;
    setAdding(true);
    try {
      await api('/insights', { method: 'POST', body: JSON.stringify({ category: 'MANUAL', insight: text, confidence: 0.9 }) });
      setNewInsight('');
      setShowAdd(false);
      onRefresh();
    } finally { setAdding(false); }
  };

  const categoryColor: Record<string, string> = {
    WIN_PATTERN: 'text-emerald-400 bg-emerald-900/30',
    LOSS_PATTERN: 'text-rose-400 bg-rose-900/30',
    TIMING: 'text-blue-400 bg-blue-900/30',
    SIZING: 'text-amber-400 bg-amber-900/30',
    MANUAL: 'text-purple-400 bg-purple-900/30',
  };
  const categoryLabel: Record<string, string> = {
    WIN_PATTERN: '승리패턴', LOSS_PATTERN: '손실패턴', TIMING: '타이밍',
    SIZING: '사이징', MANUAL: 'CEO가이드',
  };

  const harmful = insights.filter(i => i.category === 'LOSS_PATTERN');

  return (
    <>
      {/* 삭제 승인 모달 */}
      <ConfirmModal
        open={!!deleteModal}
        onClose={() => setDeleteModal(null)}
        onConfirm={confirmDelete}
        title="인사이트 삭제 승인"
        description={deleteModal ? `"${deleteModal.insight}"` : undefined}
        confirmLabel="삭제 승인"
        confirmVariant="danger"
      >
        {deleteModal && deleteModal.relatedTrades.length > 0 ? (
          <div className="bg-rose-950/30 border border-rose-900/30 rounded-xl p-3 space-y-1.5">
            <p className="text-[10px] text-rose-400 font-medium mb-2">이 가이드와 연관된 손실 매매:</p>
            {deleteModal.relatedTrades.map((t: any, i: number) => {
              const avgBuy = Number(t.transaction_chains?.avg_buy_price) || 0;
              const filledPx = Number(t.filled_price) || 0;
              const qty = Number(t.quantity) || 0;
              const pnl = avgBuy > 0 && filledPx > 0 ? (filledPx - avgBuy) * qty : 0;
              return (
                <div key={i} className="flex items-center justify-between text-[10px]">
                  <span className="text-slate-300 font-medium">{t.stock_name || t.stock_code}</span>
                  <span className="text-rose-400 font-bold">{fmtWon(pnl)}</span>
                </div>
              );
            })}
            <p className="text-[9px] text-rose-500/60 mt-1.5">이 인사이트 적용 후 손실이 발생한 매매입니다</p>
          </div>
        ) : (
          <p className="text-[11px] text-slate-500">연관된 손실 매매 내역이 없습니다.</p>
        )}
      </ConfirmModal>

      <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
          <span className="text-sm font-semibold text-slate-200">자기학습 인사이트</span>
          <span className="text-[10px] text-slate-600 ml-1">매일 18:30 자동 반영</span>
          <span className="ml-auto text-[10px] bg-slate-700/60 text-slate-400 px-2 py-0.5 rounded-full">{insights.length}개</span>
          <button onClick={triggerLearning} disabled={triggering}
            className="text-[10px] bg-blue-900/40 hover:bg-blue-900/60 text-blue-300 px-2.5 py-1 rounded-lg transition-all disabled:opacity-50">
            {triggering ? '분석중...' : '지금 분석'}
          </button>
          <button onClick={() => setShowAdd(v => !v)}
            className="text-[10px] bg-purple-900/40 hover:bg-purple-900/60 text-purple-300 px-2.5 py-1 rounded-lg transition-all">
            + 가이드 추가
          </button>
        </div>

        {showAdd && (
          <div className="px-4 py-3 border-b border-white/[0.04] bg-purple-900/10 space-y-2">
            <div className="flex gap-2">
              <input
                value={newInsight}
                onChange={e => setNewInsight(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
                placeholder="예: 공매도 과열 종목은 반드시 제외할 것"
                className="flex-1 bg-white/[0.06] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 outline-none focus:border-purple-500/50"
              />
              <button onClick={handleAdd} disabled={adding}
                className="px-3 py-1.5 bg-purple-700 hover:bg-purple-600 text-white text-xs rounded-lg disabled:opacity-50">
                {adding ? '저장중...' : '저장'}
              </button>
            </div>
            {/* 빠른 템플릿 */}
            <div className="flex flex-wrap gap-1.5">
              {[
                '거래량이 평균의 3배 이상 터질 때만 진입 — 작은 거래량 돌파는 페이크',
                '코스피 200일선 아래에서는 신규 매수 금지, 보유 종목 50% 이하로 유지',
                '개별 종목 최대 투자금은 전체 계좌의 20% 이하 유지',
                '매수 후 -7% 닿으면 이유 불문 손절 — 오를 거라는 기대 금지',
                '외국인/기관 순매도 전환 시 보유 중이면 다음날 개장에 50% 매도',
                '실적 발표 전날 신규 매수 금지 — 발표 후 반응 보고 진입',
                '상한가 다음날 추격 매수 금지 — 단타꾼 물량 출하 시점',
                '하락장(코스피 -1.5% 이상)에선 AI 점수 80점 이상만 매수 허용',
              ].map(t => (
                <button key={t} onClick={() => setNewInsight(t)}
                  className="text-[9px] bg-purple-900/30 hover:bg-purple-900/60 text-purple-300 px-2 py-1 rounded-md transition-all text-left leading-tight max-w-[180px] truncate">
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        {harmful.length > 0 && (
          <div className="px-4 py-2.5 bg-rose-900/10 border-b border-rose-900/20">
            <p className="text-[11px] text-rose-400 font-medium mb-2">
              아래 인사이트는 수익에 악영향을 줄 수 있습니다 — 삭제를 검토하세요
            </p>
            {harmful.map(i => (
              <div key={i.id} className="flex items-start gap-2 py-1.5 border-b border-rose-900/10 last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-slate-300 leading-relaxed">{i.insight}</p>
                  <p className="text-[10px] text-slate-500 mt-0.5">
                    신뢰도 {Math.round(i.confidence * 100)}% · 샘플 {i.sample_count}건
                  </p>
                </div>
                <button
                  onClick={() => openDeleteModal(i.id, i.insight)}
                  disabled={deleting === i.id}
                  className="shrink-0 px-2.5 py-1 bg-rose-800/50 hover:bg-rose-700 text-rose-300 text-[10px] rounded-lg transition-all disabled:opacity-50">
                  {deleting === i.id ? '삭제중...' : '삭제'}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="divide-y divide-white/[0.03] max-h-80 overflow-y-auto">
          {insights.filter(i => i.category !== 'LOSS_PATTERN').length === 0 && !showAdd && (
            <div className="px-4 py-6 text-center">
              <p className="text-xs text-slate-500 mb-1">아직 학습된 패턴이 없습니다</p>
              <p className="text-[10px] text-slate-600">매일 18:30 자동 분석 또는 "지금 분석" 버튼으로 즉시 실행</p>
            </div>
          )}
          {insights.filter(i => i.category !== 'LOSS_PATTERN').map(i => (
            <div key={i.id} className="px-4 py-3 hover:bg-white/[0.02]">
              <div className="flex items-start gap-3">
                <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded mt-0.5 ${categoryColor[i.category] ?? 'text-slate-400 bg-slate-800'}`}>
                  {categoryLabel[i.category] ?? i.category}
                </span>
                <p className="flex-1 text-[11px] text-slate-300 leading-relaxed">{i.insight}</p>
                <div className="shrink-0 flex items-center gap-1.5">
                  {i.is_applied
                    ? <span className="text-[9px] bg-emerald-900/40 text-emerald-400 px-1.5 py-0.5 rounded-full">applied</span>
                    : i.param_change
                      ? <span className="text-[9px] bg-amber-900/40 text-amber-400 px-1.5 py-0.5 rounded-full">대기중</span>
                      : <span className="text-[9px] text-slate-600 px-1.5 py-0.5">AI 자동 반영</span>
                  }
                  <button onClick={() => openDeleteModal(i.id, i.insight)} disabled={deleting === i.id}
                    className="shrink-0 text-slate-700 hover:text-rose-400 text-[11px] transition-colors disabled:opacity-50">
                    X
                  </button>
                </div>
              </div>
              {i.recommendation && (
                <div className="mt-1.5 ml-[52px] flex items-start gap-1.5">
                  <span className="text-[9px] text-amber-400/80 shrink-0 mt-0.5">{'→'} 권장:</span>
                  <p className="text-[10px] text-amber-300/70 leading-relaxed">{i.recommendation}</p>
                </div>
              )}
              {i.param_change && !i.is_applied && (
                <div className="mt-1 ml-[52px]">
                  <span className="text-[9px] text-violet-400/60">
                    파라미터 변경: {i.param_change.field} {'→'} {String(i.param_change.value)}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
