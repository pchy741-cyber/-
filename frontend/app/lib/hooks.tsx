'use client';

import React, { useState } from 'react';

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
export function useToast() {
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string; type: 'ok' | 'err' | 'info' }>>([]);
  const show = (msg: string, type: 'ok' | 'err' | 'info' = 'ok') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  };
  const ToastContainer = () => (
    <div className="fixed top-4 right-4 z-[999] space-y-2 pointer-events-none">
      {toasts.map(t => (
        <div key={t.id} className={`pointer-events-auto px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg backdrop-blur-md animate-[fadeIn_0.2s_ease] ${
          t.type === 'ok' ? 'bg-emerald-600/90 text-white' : t.type === 'err' ? 'bg-rose-600/90 text-white' : 'bg-blue-600/90 text-white'
        }`}>{t.msg}</div>
      ))}
    </div>
  );
  return { show, ToastContainer };
}
