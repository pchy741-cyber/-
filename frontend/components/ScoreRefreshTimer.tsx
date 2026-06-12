'use client';

import { useEffect, useState } from 'react';

/**
 * 다음 AI 점수 갱신까지 카운트다운 + 진행률 바
 *
 * - 매 1초 갱신
 * - 진행률 = (경과시간 / 전체간격)
 * - phase에 따라 간격 자동 적응 (황금구간 3분 등)
 */

interface Status {
  phase: string;
  intervalMin: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  secondsToNext: number | null;
  scored: number;
  elapsedSec: number | null;
}

export function ScoreRefreshTimer({ apiBase = '' }: { apiBase?: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${apiBase}/api/ai-loop/scores/refresh-status`, { credentials: 'include' });
        const data = await res.json();
        if (!cancelled) setStatus(data);
      } catch {
        /* ignore */
      }
    }
    load();
    const reload = setInterval(load, 15_000); // 15초마다 fresh fetch
    const ticker = setInterval(() => setTick((t) => t + 1), 1_000); // 1초마다 UI 갱신
    return () => {
      cancelled = true;
      clearInterval(reload);
      clearInterval(ticker);
    };
  }, [apiBase]);

  if (!status) {
    return <div className="text-[10px] text-slate-600">점수 상태 로딩...</div>;
  }

  // 실시간 카운트다운 계산 (서버 fetch는 15초마다, 화면은 1초마다 갱신)
  const now = Date.now();
  const nextMs = status.nextRunAt ? new Date(status.nextRunAt).getTime() : null;
  const lastMs = status.lastRunAt ? new Date(status.lastRunAt).getTime() : null;
  const remaining = nextMs != null ? Math.max(0, Math.floor((nextMs - now) / 1000)) : null;
  const totalSec = status.intervalMin * 60;
  const elapsed = lastMs != null ? Math.min(totalSec, Math.floor((now - lastMs) / 1000)) : 0;
  const progressPct = totalSec > 0 ? Math.min(100, (elapsed / totalSec) * 100) : 0;
  const isRefreshing = remaining === 0;

  const phaseLabel: Record<string, string> = {
    GOLDEN_AM: '★ 황금 오전',
    GOLDEN_PM: '★ 황금 오후',
    OPENING_BELL: '🔔 개장벨',
    CLOSING_BELL: '🔔 마감벨',
    CURSED: '☠️ 마의시간',
    CLOSED: '🌙 장외',
  };
  const phaseColor =
    status.phase === 'GOLDEN_AM' || status.phase === 'GOLDEN_PM'
      ? 'text-emerald-400'
      : status.phase === 'CURSED'
        ? 'text-rose-400'
        : status.phase === 'CLOSED'
          ? 'text-slate-500'
          : 'text-amber-400';

  return (
    <div className="flex flex-col gap-1 px-2 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.04]" data-testid="score-refresh-timer">
      <div className="flex items-center justify-between text-[10px]">
        <span className={`font-semibold ${phaseColor}`}>{phaseLabel[status.phase] ?? status.phase}</span>
        <span className="text-slate-500">
          {isRefreshing ? (
            <span className="text-cyan-400 animate-pulse">🔄 갱신 중...</span>
          ) : remaining != null ? (
            <>
              다음 갱신:{' '}
              <span className="font-bold text-slate-300 tabular-nums">
                {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
              </span>
            </>
          ) : (
            '대기'
          )}
        </span>
      </div>
      {/* 진행률 바 */}
      <div className="h-1 bg-white/[0.04] rounded-full overflow-hidden">
        <div
          className={`h-full ${isRefreshing ? 'bg-cyan-400 animate-pulse' : 'bg-blue-500/60'} transition-all duration-1000`}
          style={
            {
              '--p': `${progressPct}%`,
              width: 'var(--p)',
            } as React.CSSProperties
          }
        />
      </div>
      {status.lastRunAt && (
        <div className="text-[9px] text-slate-600 flex justify-between">
          <span>마지막: {new Date(status.lastRunAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span>
          <span>
            ⚡ {status.intervalMin}분 간격 · {status.scored}종목
          </span>
        </div>
      )}
    </div>
  );
}
