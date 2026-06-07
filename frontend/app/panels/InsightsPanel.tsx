'use client';

import React from 'react';
import { ConfirmModal, Button } from '@/components/ui';
import { fmtWon } from '../lib/utils';
import { categoryColor, categoryLabel } from './insight-types';
import { InsightsAddForm } from './InsightsAddForm';
import { InsightsPromotables } from './InsightsPromotables';
import { useInsightsData } from './useInsightsData';
import type { Trade, Insight, ToastFn } from '../types';

function validationBadge(i: Insight) {
  if (i.source_mode !== 'promoted_from_paper') return null;
  const status = i.live_validation_status;
  if (status === 'validated') return <span className="text-[10px] bg-emerald-900/50 text-emerald-300 px-1.5 py-0.5 rounded-full font-medium">실전확인</span>;
  if (status === 'invalidated') return <span className="text-[10px] bg-slate-800/60 text-slate-500 px-1.5 py-0.5 rounded-full font-medium line-through">미검증</span>;
  return <span className="text-[10px] bg-cyan-900/40 text-cyan-300 px-1.5 py-0.5 rounded-full font-medium">연습검증</span>;
}

export default function InsightsPanel({ insights: insightsProp, trades, onRefresh, toast }: { insights: Insight[]; trades?: Trade[]; onRefresh: () => void; toast?: ToastFn }) {
  const d = useInsightsData(insightsProp, trades, onRefresh, toast);
  const harmful = d.insights.filter(i => (i.category ?? '') === 'LOSS_PATTERN');
  const normal = d.insights.filter(i => (i.category ?? '') !== 'LOSS_PATTERN');

  return (
    <>
      <ConfirmModal
        open={!!d.deleteModal}
        onClose={() => d.setDeleteModal(null)}
        onConfirm={d.confirmDelete}
        title="인사이트 삭제 승인"
        description={d.deleteModal ? `"${d.deleteModal.insight}"` : undefined}
        confirmLabel="삭제 승인"
        confirmVariant="danger"
      >
        {d.deleteModal && d.deleteModal.relatedTrades.length > 0 ? (
          <div className="bg-rose-950/30 border border-rose-900/30 rounded-xl p-3 space-y-1.5">
            <p className="text-[10px] text-rose-400 font-medium mb-2">이 가이드와 연관된 손실 매매:</p>
            {d.deleteModal.relatedTrades.map((t: Trade, i: number) => {
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
          <span className="ml-auto text-[10px] bg-slate-700/60 text-slate-400 px-2 py-0.5 rounded-full">{d.insights.length}개</span>
          <Button variant="ghost" size="sm" className="text-[10px] bg-blue-900/40 hover:bg-blue-900/60 text-blue-300 px-2.5 py-1"
            disabled={d.triggering} onClick={d.triggerLearning}>
            {d.triggering ? '분석중...' : '지금 분석'}
          </Button>
          <Button variant="ghost" size="sm" className="text-[10px] bg-purple-900/40 hover:bg-purple-900/60 text-purple-300 px-2.5 py-1"
            onClick={() => d.setShowAdd(v => !v)}>
            + 가이드 추가
          </Button>
        </div>

        {d.showAdd && (
          <InsightsAddForm newInsight={d.newInsight} setNewInsight={d.setNewInsight} onAdd={d.handleAdd} adding={d.adding} />
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
                    신뢰도 {Math.round((i.confidence ?? 0) * 100)}% · 샘플 {i.sample_count}건
                  </p>
                </div>
                <Button variant="danger" size="sm" className="shrink-0 text-[10px] bg-rose-800/50 hover:bg-rose-700 text-rose-300"
                  disabled={d.deleting === i.id} onClick={() => d.openDeleteModal(i.id, i.insight ?? i.content)}>
                  {d.deleting === i.id ? '삭제중...' : '삭제'}
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="divide-y divide-white/[0.03] max-h-80 overflow-y-auto">
          {normal.length === 0 && !d.showAdd && (
            <div className="px-4 py-6 text-center">
              <p className="text-xs text-slate-500 mb-1">아직 학습된 패턴이 없습니다</p>
              <p className="text-[10px] text-slate-600">매일 18:30 자동 분석 또는 &quot;지금 분석&quot; 버튼으로 즉시 실행</p>
            </div>
          )}
          {normal.map(i => (
            <div key={i.id} className="px-4 py-3 hover:bg-white/[0.02]">
              <div className="flex items-start gap-3">
                <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded mt-0.5 ${categoryColor[i.category ?? ''] ?? 'text-slate-400 bg-slate-800'}`}>
                  {categoryLabel[i.category ?? ''] ?? i.category}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    {validationBadge(i)}
                    <p className="text-[11px] text-slate-300 leading-relaxed">{i.insight ?? i.content}</p>
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  {i.source_mode === 'promoted_from_paper' && (
                    <button onClick={() => d.handleRevoke(String(i.id))} disabled={d.revoking === String(i.id)}
                      className="text-[9px] bg-slate-700/50 hover:bg-rose-900/50 text-slate-400 hover:text-rose-300 px-1.5 py-0.5 rounded-md transition-all disabled:opacity-50">
                      {d.revoking === String(i.id) ? '...' : '취소'}
                    </button>
                  )}
                  {i.is_applied
                    ? <span className="text-[9px] bg-emerald-900/40 text-emerald-400 px-1.5 py-0.5 rounded-full">applied</span>
                    : i.param_change
                      ? <span className="text-[9px] bg-amber-900/40 text-amber-400 px-1.5 py-0.5 rounded-full">대기중</span>
                      : <span className="text-[9px] text-slate-600 px-1.5 py-0.5">AI 자동 반영</span>
                  }
                  <button onClick={() => d.openDeleteModal(i.id, i.insight ?? i.content)} disabled={d.deleting === i.id}
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

        <InsightsPromotables promotables={d.promotables} promoting={d.promoting} onPromote={d.handlePromote} />
      </div>
    </>
  );
}
