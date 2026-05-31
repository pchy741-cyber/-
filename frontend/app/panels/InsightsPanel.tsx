'use client';

import React from 'react';
import { ConfirmModal, Button } from '@/components/ui';
import { api, fmtWon } from '../lib/utils';
import { categoryColor, categoryLabel } from './insight-types';
import { InsightsAddForm } from './InsightsAddForm';
import { InsightsPromotables } from './InsightsPromotables';

export default function InsightsPanel({ insights: insightsProp, trades, onRefresh, toast }: { insights: any[]; trades?: any[]; onRefresh: () => void; toast?: (msg: string, type: string) => void }) {
  const [deleting, setDeleting] = React.useState<number | null>(null);
  const [applying, setApplying] = React.useState<number | null>(null);
  const [newInsight, setNewInsight] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const [showAdd, setShowAdd] = React.useState(false);
  const [deleteModal, setDeleteModal] = React.useState<{ id: number; insight: string; relatedTrades: any[] } | null>(null);
  const [liveInsights, setLiveInsights] = React.useState<any[] | null>(null);
  const [promotables, setPromotables] = React.useState<any[]>([]);
  const [promoting, setPromoting] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<string | null>(null);

  React.useEffect(() => {
    const load = () => api('/insights').then((d: any) => setLiveInsights(Array.isArray(d) ? d : [])).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  // 연습모드 프로모션 후보 로드
  React.useEffect(() => {
    api('/insights/promotable')
      .then((d: any) => setPromotables(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [liveInsights]); // 인사이트 변경 시 후보도 갱신

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
      toast?.('삭제 실패: ' + err.message, 'err');
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

  // 연습→실전 프로모션
  const handlePromote = async (id: string) => {
    setPromoting(id);
    try {
      const data = await api(`/insights/${id}/promote`, { method: 'POST' });
      if (data.ok) {
        toast?.('연습 인사이트를 실전에 적용했습니다 (신뢰도 0.7x)', 'ok');
        setPromotables((prev) => prev.filter((p) => p.id !== id));
        // 인사이트 목록 새로고침
        api('/insights').then((d: any) => setLiveInsights(Array.isArray(d) ? d : [])).catch(() => {});
        onRefresh();
      } else {
        toast?.(data.error ?? '프로모션 실패', 'err');
      }
    } catch { toast?.('프로모션 요청 실패', 'err'); }
    finally { setPromoting(null); }
  };

  // 프로모션 취소
  const handleRevoke = async (id: string) => {
    setRevoking(id);
    try {
      const data = await api(`/insights/${id}/revoke`, { method: 'POST' });
      if (data.ok) {
        toast?.('프로모션 취소 완료', 'ok');
        setLiveInsights((prev) => (prev ?? []).filter((i) => i.id !== id));
        onRefresh();
      } else {
        toast?.(data.error ?? '취소 실패', 'err');
      }
    } catch { toast?.('취소 요청 실패', 'err'); }
    finally { setRevoking(null); }
  };

  // 프로모션 검증 상태 뱃지
  const validationBadge = (i: any) => {
    if (i.source_mode !== 'promoted_from_paper') return null;
    const status = i.live_validation_status;
    if (status === 'validated') return <span className="text-[8px] bg-emerald-900/50 text-emerald-300 px-1.5 py-0.5 rounded-full font-medium">실전확인</span>;
    if (status === 'invalidated') return <span className="text-[8px] bg-slate-800/60 text-slate-500 px-1.5 py-0.5 rounded-full font-medium line-through">미검증</span>;
    return <span className="text-[8px] bg-cyan-900/40 text-cyan-300 px-1.5 py-0.5 rounded-full font-medium">연습검증</span>;
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

      <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/40">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.04]">
          <span className="text-sm font-semibold text-slate-200">자기학습 인사이트</span>
          <span className="text-[10px] text-slate-600 ml-1">매일 18:30 자동 반영</span>
          <span className="ml-auto text-[10px] bg-slate-700/60 text-slate-400 px-2 py-0.5 rounded-full">{insights.length}개</span>
          <Button variant="ghost" size="sm" className="text-[10px] bg-blue-900/40 hover:bg-blue-900/60 text-blue-300 px-2.5 py-1"
            disabled={triggering} onClick={triggerLearning}>
            {triggering ? '분석중...' : '지금 분석'}
          </Button>
          <Button variant="ghost" size="sm" className="text-[10px] bg-purple-900/40 hover:bg-purple-900/60 text-purple-300 px-2.5 py-1"
            onClick={() => setShowAdd(v => !v)}>
            + 가이드 추가
          </Button>
        </div>

        {showAdd && (
          <InsightsAddForm newInsight={newInsight} setNewInsight={setNewInsight} onAdd={handleAdd} adding={adding} />
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
                <Button variant="danger" size="sm" className="shrink-0 text-[10px] bg-rose-800/50 hover:bg-rose-700 text-rose-300"
                  disabled={deleting === i.id} onClick={() => openDeleteModal(i.id, i.insight)}>
                  {deleting === i.id ? '삭제중...' : '삭제'}
                </Button>
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
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    {validationBadge(i)}
                    <p className="text-[11px] text-slate-300 leading-relaxed">{i.insight}</p>
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  {i.source_mode === 'promoted_from_paper' && (
                    <button onClick={() => handleRevoke(i.id)} disabled={revoking === i.id}
                      className="text-[9px] bg-slate-700/50 hover:bg-rose-900/50 text-slate-400 hover:text-rose-300 px-1.5 py-0.5 rounded-md transition-all disabled:opacity-50">
                      {revoking === i.id ? '...' : '취소'}
                    </button>
                  )}
                  {i.is_applied
                    ? <span className="text-[9px] bg-emerald-900/40 text-emerald-400 px-1.5 py-0.5 rounded-full">applied</span>
                    : i.param_change
                      ? <span className="text-[9px] bg-amber-900/40 text-amber-400 px-1.5 py-0.5 rounded-full">대기중</span>
                      : <span className="text-[9px] text-slate-600 px-1.5 py-0.5">AI 자동 반영</span>
                  }
                  <button onClick={() => openDeleteModal(i.id, i.insight)} disabled={deleting === i.id}
                    className="shrink-0 text-slate-600 hover:text-rose-400 hover:bg-rose-900/30 text-[11px] px-1 py-0.5 rounded-md transition-all disabled:opacity-50">
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

        <InsightsPromotables promotables={promotables} promoting={promoting} onPromote={handlePromote} />
      </div>
    </>
  );
}
