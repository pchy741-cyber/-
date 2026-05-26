/**
 * Auto Pilot — 대시보드에서 토글하는 서버사이드 매매 루프
 * 5분 간격으로 runOverseasJob() 반복 실행
 * 인메모리 상태 → Cloud Run 재시작 시 자동 OFF (안전장치)
 */
import { logger } from '../utils/logger.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { isKillSwitchActive } from '../risk/kill-switch.js';

const INTERVAL_MS = 5 * 60_000; // 5분
const MAX_CONSECUTIVE_ERRORS = 3;

interface LoopState {
  active: boolean;
  intervalMs: number;
  startedAt: string | null;
  lastRunAt: string | null;
  lastRunDurationMs: number | null;
  lastRunResult: 'ok' | 'error' | 'skipped' | null;
  totalRuns: number;
  consecutiveErrors: number;
}

const state: LoopState = {
  active: false,
  intervalMs: INTERVAL_MS,
  startedAt: null,
  lastRunAt: null,
  lastRunDurationMs: null,
  lastRunResult: null,
  totalRuns: 0,
  consecutiveErrors: 0,
};

let timer: ReturnType<typeof setTimeout> | null = null;

async function tick(): Promise<void> {
  if (!state.active) return;

  // Kill Switch 활성이어도 매도(탈출)를 위해 실행 — 매수만 overseas-job 내부에서 차단
  if (isKillSwitchActive('OVERSEAS')) {
    logger.info('Auto Pilot: Kill Switch 활성 — 매도만 실행 (매수 차단은 overseas-job 내부)', { component: 'LOOP' });
  }

  state.lastRunAt = new Date().toISOString();
  state.totalRuns++;
  const t0 = Date.now();

  try {
    const { runOverseasDual } = await import('./overseas-job.js');
    await runOverseasDual();
    state.lastRunDurationMs = Date.now() - t0;
    state.lastRunResult = 'ok';
    state.consecutiveErrors = 0;
  } catch (err) {
    state.lastRunDurationMs = Date.now() - t0;
    state.lastRunResult = 'error';
    state.consecutiveErrors++;
    logger.error(`Auto Pilot 에러 (${state.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${(err as Error).message}`, { component: 'LOOP' });

    if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      stopLoop(`연속 ${MAX_CONSECUTIVE_ERRORS}회 에러 — 자동 정지`);
      return;
    }
  }

  scheduleNext();
}

function scheduleNext(): void {
  if (!state.active) return;
  timer = setTimeout(tick, state.intervalMs);
}

// ── Public API ──

export function startLoop(): { ok: boolean; error?: string } {
  if (state.active) return { ok: false, error: '이미 실행 중' };
  if (isKillSwitchActive('OVERSEAS')) return { ok: false, error: 'Kill Switch 활성 — 먼저 해제하세요' };

  state.active = true;
  state.startedAt = new Date().toISOString();
  state.totalRuns = 0;
  state.consecutiveErrors = 0;
  state.lastRunResult = null;

  logger.info(`🤖 Auto Pilot 시작 (${state.intervalMs / 60_000}분 간격)`, { component: 'LOOP' });
  sendTelegramMessage(`🤖 Auto Pilot 시작\n간격: ${state.intervalMs / 60_000}분`).catch(() => {});

  // 즉시 첫 실행
  tick();

  return { ok: true };
}

export function stopLoop(reason?: string): { ok: boolean } {
  if (timer) { clearTimeout(timer); timer = null; }
  const wasActive = state.active;
  state.active = false;

  if (wasActive) {
    const msg = `🤖 Auto Pilot 정지${reason ? `: ${reason}` : ''}\n총 ${state.totalRuns}회 실행`;
    logger.info(msg, { component: 'LOOP' });
    sendTelegramMessage(msg).catch(() => {});
  }

  return { ok: true };
}

export function getLoopStatus(): LoopState {
  return { ...state };
}

export function isLoopActive(): boolean {
  return state.active;
}
