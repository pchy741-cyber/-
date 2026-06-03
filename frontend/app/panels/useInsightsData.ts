import React from 'react';
import { api } from '../lib/utils';
import type { Trade, Insight, ToastFn } from '../types';

export function useInsightsData(insightsProp: Insight[], trades: Trade[] | undefined, onRefresh: () => void, toast?: ToastFn) {
  const [deleting, setDeleting] = React.useState<string | number | null>(null);
  const [applying, setApplying] = React.useState<string | number | null>(null);
  const [newInsight, setNewInsight] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const [showAdd, setShowAdd] = React.useState(false);
  const [deleteModal, setDeleteModal] = React.useState<{ id: string | number; insight: string; relatedTrades: Trade[] } | null>(null);
  const [liveInsights, setLiveInsights] = React.useState<Insight[] | null>(null);
  const [promotables, setPromotables] = React.useState<Insight[]>([]);
  const [promoting, setPromoting] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [triggering, setTriggering] = React.useState(false);

  React.useEffect(() => {
    const load = () => api('/insights').then((d: Insight[]) => setLiveInsights(Array.isArray(d) ? d : [])).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  React.useEffect(() => {
    api('/insights/promotable')
      .then((d: Insight[]) => setPromotables(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [liveInsights]);

  const insights = liveInsights ?? insightsProp;

  const triggerLearning = async () => {
    setTriggering(true);
    try {
      await api('/run-self-learning', { method: 'POST' });
      toast?.('자기학습 시작 — 잠시 후 인사이트가 업데이트됩니다', 'ok');
      setTimeout(() => api('/insights').then((d: Insight[]) => setLiveInsights(Array.isArray(d) ? d : [])).catch(() => {}), 8000);
    } catch { toast?.('자기학습 실행 실패', 'err'); }
    finally { setTriggering(false); }
  };

  const openDeleteModal = (id: string | number, insight: string) => {
    const words = insight.replace(/[^\w\s가-힣]/g, ' ').split(/\s+/).filter((w: string) => w.length >= 2).slice(0, 8);
    const relatedTrades = (trades ?? []).filter((t: Trade) => {
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
    } catch (err: unknown) {
      toast?.('삭제 실패: ' + (err as Error).message, 'err');
    } finally { setDeleting(null); }
  };

  const handleApply = async (id: string | number) => {
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

  const handlePromote = async (id: string | number) => {
    setPromoting(String(id));
    try {
      const data = await api(`/insights/${id}/promote`, { method: 'POST' });
      if (data.ok) {
        toast?.('연습 인사이트를 실전에 적용했습니다 (신뢰도 0.7x)', 'ok');
        setPromotables((prev) => prev.filter((p) => p.id !== id));
        api('/insights').then((d: Insight[]) => setLiveInsights(Array.isArray(d) ? d : [])).catch(() => {});
        onRefresh();
      } else {
        toast?.(data.error ?? '프로모션 실패', 'err');
      }
    } catch { toast?.('프로모션 요청 실패', 'err'); }
    finally { setPromoting(null); }
  };

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

  return {
    insights, promotables, promoting, revoking, deleting, applying,
    newInsight, setNewInsight, adding, showAdd, setShowAdd,
    deleteModal, setDeleteModal, triggering,
    triggerLearning, openDeleteModal, confirmDelete,
    handleApply, handleAdd, handlePromote, handleRevoke,
  };
}
