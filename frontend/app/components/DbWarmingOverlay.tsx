'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../lib/utils';
import { Spinner } from '@/components/ui';

type Phase = 'connecting' | 'waking' | 'ready';

interface Props {
  onReady: () => void;
}

export default function DbWarmingOverlay({ onReady }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [retryCount, setRetryCount] = useState(0);
  const startRef = useRef(Date.now());
  const readyCalledRef = useRef(false);

  const handleReady = useCallback(() => {
    if (readyCalledRef.current) return;
    readyCalledRef.current = true;
    setPhase('ready');
    setTimeout(onReady, 800);
  }, [onReady]);

  // 경과 시간
  useEffect(() => {
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(iv);
  }, []);

  // 3초마다 health 폴링
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const h = await api('/health', { timeout: 5000 });
        if (cancelled) return;
        if (h.db === 'ok') { handleReady(); return; }
        setPhase('waking');
        setRetryCount(0);
      } catch {
        if (cancelled) return;
        setPhase('connecting');
        setRetryCount(c => c + 1);
      }
    };
    poll();
    const iv = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [handleReady]);

  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  const timeStr = min > 0 ? `${min}:${String(sec).padStart(2, '0')}` : `${sec}초`;

  const steps = [
    { key: 'server', label: '서버 연결', done: phase !== 'connecting' },
    { key: 'db', label: 'DB 기상', done: phase === 'ready' },
    { key: 'data', label: '데이터 로드', done: false },
  ];

  return (
    <div className="fixed inset-0 z-[9998] bg-[#0b0f1a] flex flex-col items-center justify-center">
      {/* 로고 */}
      <div className="mb-8">
        <h1 className="text-xl font-black bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
          AI Bot
        </h1>
      </div>

      {/* 메인 아이콘 + 스피너 */}
      <div className="relative mb-8">
        <div className="w-24 h-24 rounded-full bg-slate-800/60 flex items-center justify-center">
          {phase === 'ready' ? (
            <svg width="36" height="36" fill="none" viewBox="0 0 24 24" className="text-emerald-400 animate-[scaleIn_0.3s_ease-out]">
              <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-blue-400" viewBox="0 0 24 24">
              <path d="M20 12a8 8 0 01-8 8m8-8a8 8 0 00-8-8m8 8h-8m0 8a8 8 0 01-8-8m8 8v-8m-8 0a8 8 0 018-8m-8 8h8m0-8v8" strokeLinecap="round" />
            </svg>
          )}
        </div>
        {phase !== 'ready' && (
          <div className="absolute inset-0 w-24 h-24 rounded-full border-2 border-transparent border-t-blue-400/80 border-r-blue-400/30 animate-spin" />
        )}
        {phase === 'ready' && (
          <div className="absolute inset-0 w-24 h-24 rounded-full border-2 border-emerald-400/40 animate-[ping_0.6s_ease-out_1]" />
        )}
      </div>

      {/* 상태 메시지 */}
      <div className="text-center mb-6 space-y-1.5">
        <h2 className="text-base font-medium text-slate-200">
          {phase === 'connecting' && '서버에 연결 중...'}
          {phase === 'waking' && 'DB 기상 중...'}
          {phase === 'ready' && '연결 완료!'}
        </h2>
        <p className="text-xs text-slate-500">
          {phase === 'connecting' && (retryCount > 2 ? '서버가 절전에서 깨어나고 있습니다' : '잠시만 기다려주세요')}
          {phase === 'waking' && '비용 절약을 위해 절전 중이었습니다'}
          {phase === 'ready' && '데이터를 불러옵니다'}
        </p>
      </div>

      {/* 단계 표시 */}
      <div className="flex items-center gap-2 mb-6">
        {steps.map((step, i) => (
          <div key={step.key} className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors duration-300 ${
              step.done
                ? 'bg-emerald-500/15 text-emerald-400'
                : (i === 0 && phase === 'connecting') || (i === 1 && phase === 'waking')
                  ? 'bg-blue-500/15 text-blue-400'
                  : 'bg-slate-800/60 text-slate-600'
            }`}>
              {step.done ? (
                <svg width="12" height="12" fill="none" viewBox="0 0 24 24">
                  <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (i === 0 && phase === 'connecting') || (i === 1 && phase === 'waking') ? (
                <Spinner size="xs" color="current" />
              ) : (
                <div className="w-3 h-3 rounded-full border border-slate-700" />
              )}
              {step.label}
            </div>
            {i < steps.length - 1 && (
              <div className={`w-4 h-px ${step.done ? 'bg-emerald-500/40' : 'bg-slate-800'}`} />
            )}
          </div>
        ))}
      </div>

      {/* 경과 시간 + 프로그레스 */}
      {phase !== 'ready' && (
        <div className="flex flex-col items-center gap-2">
          <div className="w-40 h-0.5 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-1000 ease-out w-[var(--w)]"
              style={{ '--w': `${Math.min((elapsed / 180) * 100, 95)}%` } as React.CSSProperties}
            />
          </div>
          <p className="text-[10px] text-slate-600 tabular-nums">
            {timeStr} · 보통 1~2분
          </p>
        </div>
      )}
    </div>
  );
}
