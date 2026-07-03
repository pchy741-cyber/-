'use client';

import React, { useState, useCallback, useRef } from 'react';
import { ConfirmModal } from '@/components/ui';

// ── 숫자 롤업 애니메이션 ──
export function useCountUp(target: number, duration = 500) {
  const [val, setVal] = React.useState(target);
  const prev = React.useRef(target);
  const mounted = React.useRef(false);
  React.useEffect(() => {
    if (!mounted.current) { mounted.current = true; prev.current = target; setVal(target); return; }
    const from = prev.current;
    const diff = target - from;
    if (Math.abs(diff) < 100) { prev.current = target; setVal(target); return; }
    const steps = Math.ceil(duration / 16);
    let step = 0;
    const id = setInterval(() => {
      step++;
      setVal(Math.round(from + diff * (step / steps)));
      if (step >= steps) { clearInterval(id); prev.current = target; }
    }, 16);
    return () => clearInterval(id);
  }, [target, duration]);
  return val;
}

// ── 토스트 알림 시스템 ──
// CEO 지시 (2026-06-12): "알림도 실전/연습 컬러 구분"
//   mode='live' → 좌측 빨간 띠 + 🔴 [실전] 뱃지
//   mode='paper' → 좌측 노란 띠 + 🟡 [연습] 뱃지
//   mode 미지정 → 기본 (시스템 알림)
export type ToastMode = 'live' | 'paper' | undefined;
export function useToast() {
  const [toasts, setToasts] = useState<
    Array<{ id: number; msg: string; type: 'ok' | 'err' | 'info'; mode?: ToastMode }>
  >([]);
  const show = useCallback((msg: string, type: 'ok' | 'err' | 'info' = 'ok', mode?: ToastMode) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, msg, type, mode }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
  }, []);
  const ToastContainer = () => (
    <div className="fixed top-4 right-4 z-[999] space-y-2 pointer-events-none">
      {toasts.map((t) => {
        const baseColor =
          t.type === 'ok' ? 'bg-emerald-600/90' : t.type === 'err' ? 'bg-rose-600/90' : 'bg-blue-600/90';
        const modeBorder =
          t.mode === 'live'
            ? 'border-l-4 border-rose-400 ring-2 ring-rose-500/30'
            : t.mode === 'paper'
              ? 'border-l-4 border-amber-400 ring-2 ring-amber-500/30'
              : '';
        const modeBadge =
          t.mode === 'live' ? (
            <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-rose-900/60 text-rose-100 mr-1.5">🔴 실전</span>
          ) : t.mode === 'paper' ? (
            <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-100 mr-1.5">🟡 연습</span>
          ) : null;
        return (
          <div
            key={t.id}
            className={`pointer-events-auto px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg backdrop-blur-md animate-[fadeIn_0.2s_ease] flex items-center text-white ${baseColor} ${modeBorder}`}
          >
            {modeBadge}
            {t.msg}
          </div>
        );
      })}
    </div>
  );
  return { show, ToastContainer };
}

// ── Promise 기반 확인 다이얼로그 ──
export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  confirmVariant?: 'danger' | 'primary' | 'ghost';
}

export function useConfirm() {
  const [state, setState] = useState<{ open: boolean } & ConfirmOptions>({
    open: false, title: '',
  });
  const resolveRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise(resolve => {
      resolveRef.current = resolve;
      setState({ open: true, ...opts });
    });
  }, []);

  const handleClose = useCallback(() => {
    setState(s => ({ ...s, open: false }));
    resolveRef.current?.(false);
    resolveRef.current = null;
  }, []);

  const handleConfirm = useCallback(() => {
    setState(s => ({ ...s, open: false }));
    resolveRef.current?.(true);
    resolveRef.current = null;
  }, []);

  const ConfirmDialog = () => (
    <ConfirmModal
      open={state.open}
      onClose={handleClose}
      onConfirm={handleConfirm}
      title={state.title}
      description={state.description}
      confirmLabel={state.confirmLabel ?? '확인'}
      confirmVariant={state.confirmVariant ?? 'danger'}
    />
  );

  return { confirm, ConfirmDialog };
}
