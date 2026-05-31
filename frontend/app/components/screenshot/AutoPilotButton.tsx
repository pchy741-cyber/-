'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '../../lib/utils';
import type { LoopStatus } from './screenshot-types';

const MARKET_PHASE_LABEL: Record<string, string> = {
  PREMARKET: '프리마켓',
  OPEN_VOLATILE: '개장변동',
  PRIME: '프라임',
  MIDDAY: '미드데이',
  LUNCH: '런치',
  POWER_HOUR: '파워아워',
  CLOSED: '장마감',
};

export function AutoPilotButton({ loopStatusProp, capturing, toast }: {
  loopStatusProp: LoopStatus | null;
  capturing: boolean;
  toast?: (msg: string, type?: 'ok' | 'err' | 'info') => void;
}) {
  const [togglingLoop, setTogglingLoop] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loopStatus = loopStatusProp;

  // 카운트다운 (다음 실행까지)
  const [countdown, setCountdown] = useState('');
  useEffect(() => {
    if (!loopStatus?.active || !loopStatus.lastRunAt || !loopStatus.adaptiveIntervalMs) {
      setCountdown('');
      return;
    }
    const update = () => {
      const lastRun = new Date(loopStatus.lastRunAt!).getTime();
      const nextRun = lastRun + loopStatus.adaptiveIntervalMs;
      const remaining = Math.max(0, Math.round((nextRun - Date.now()) / 1000));
      if (remaining <= 0) { setCountdown('곧 실행'); return; }
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      setCountdown(`${m}:${String(s).padStart(2, '0')}`);
    };
    update();
    const iv = setInterval(update, 1000);
    return () => clearInterval(iv);
  }, [loopStatus?.active, loopStatus?.lastRunAt, loopStatus?.adaptiveIntervalMs]);

  // confirmStop 3초 후 자동 리셋
  useEffect(() => {
    if (confirmStop) {
      confirmTimer.current = setTimeout(() => setConfirmStop(false), 3000);
      return () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); };
    }
  }, [confirmStop]);

  const loopLabel = 'US';
  const loopName = '해외 자동매매 루프';

  const toggleLoop = useCallback(async () => {
    if (togglingLoop) return;

    // 정지 시 확인 단계
    if (loopStatus?.active && !confirmStop) {
      setConfirmStop(true);
      return;
    }

    setTogglingLoop(true);
    setConfirmStop(false);
    try {
      if (loopStatus?.active) {
        await api('/loop/stop', { method: 'POST' });
        toast?.(`${loopName} 중지됨`, 'info');
      } else {
        const res = await api('/loop/start', { method: 'POST' }) as any;
        if (res?.warning) {
          toast?.(`${loopName} 시작됨 — ${res.warning}`, 'info');
        } else {
          toast?.(`${loopName} 시작됨 (5분 간격)`, 'ok');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '알 수 없는 오류';
      toast?.(`AP 루프 오류: ${msg}`, 'err');
    } finally {
      setTogglingLoop(false);
    }
  }, [togglingLoop, loopStatus, toast, confirmStop]);

  const phaseLabel = loopStatus?.marketPhase ? MARKET_PHASE_LABEL[loopStatus.marketPhase] ?? loopStatus.marketPhase : '';
  const briefLine = loopStatus?.brief ? `${loopStatus.brief.regime}/${loopStatus.brief.risk}` : '';
  const hasErrors = (loopStatus?.consecutiveErrors ?? 0) > 0;

  return (
    <button
      onClick={toggleLoop}
      disabled={togglingLoop || capturing}
      className={`fixed bottom-6 right-[88px] z-50 h-14 px-3 rounded-full shadow-lg shadow-black/50 flex items-center justify-center transition-all duration-300 ${
        confirmStop
          ? 'bg-red-600/90 text-white ring-2 ring-red-400/50'
          : loopStatus?.active
            ? 'bg-emerald-600/90 text-white animate-pulse ring-2 ring-emerald-400/40'
            : 'bg-slate-800/90 text-slate-400 hover:bg-slate-700 hover:text-slate-200 border border-white/10'
      }`}
      title={
        confirmStop
          ? '다시 클릭하면 중지됩니다'
          : loopStatus?.active
            ? `${loopName} ON (${loopStatus.totalRuns}회)\n${phaseLabel} ${briefLine}\n클릭 → 중지 확인`
            : `${loopName} OFF\n클릭하면 5분 간격 자동 실행 시작`
      }
    >
      <div className="flex flex-col items-center leading-none min-w-[28px]">
        {confirmStop ? (
          <>
            <span className="text-[9px] font-black">중지?</span>
            <span className="text-[8px] mt-0.5 opacity-80">확인</span>
          </>
        ) : loopStatus?.active ? (
          <>
            <span className="text-[9px] font-black tracking-wider">{loopLabel}</span>
            <span className="text-[11px] font-bold mt-0.5">{loopStatus.totalRuns}</span>
            {phaseLabel && <span className="text-[7px] opacity-70 mt-0.5">{phaseLabel}</span>}
            {countdown && <span className="text-[7px] opacity-50">{countdown}</span>}
          </>
        ) : (
          <>
            <span className="text-[9px] font-black tracking-wider">{loopLabel}</span>
            <span className="text-[8px] mt-0.5 opacity-60">루프</span>
          </>
        )}
      </div>

      {/* 연속 에러 뱃지 */}
      {hasErrors && loopStatus?.active && (
        <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-600 text-white text-[8px] font-bold rounded-full flex items-center justify-center animate-pulse">
          {loopStatus.consecutiveErrors}
        </span>
      )}
    </button>
  );
}
