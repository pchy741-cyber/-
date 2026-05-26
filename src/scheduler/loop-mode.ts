/**
 * Auto Pilot — 대시보드에서 토글하는 서버사이드 매매 루프
 * 4단계 라이프사이클: REVIEWING → TRADING → (적응형 조정) → STOPPED → 세션 요약
 * 인메모리 상태 → Cloud Run 재시작 시 자동 OFF (안전장치)
 */
import { logger } from '../utils/logger.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { isKillSwitchActive } from '../risk/kill-switch.js';
import {
  generateSessionBrief, checkStrategyValidity, generateSessionSummary,
  clearSessionBrief, getActiveSessionBrief,
  type SessionStrategyBrief,
} from './overseas/session-strategy.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000; // 5분
const FAST_INTERVAL_MS = 3 * 60_000;    // 3분 (VIX STRESS/CRISIS, 활성 매도)
const SLOW_INTERVAL_MS = 8 * 60_000;    // 8분 (유휴 상태)
const MAX_CONSECUTIVE_ERRORS = 3;

export type LoopPhase = 'REVIEWING' | 'TRADING' | 'STOPPED';

interface LoopState {
  active: boolean;
  phase: LoopPhase;
  intervalMs: number;
  adaptiveIntervalMs: number;
  startedAt: string | null;
  lastRunAt: string | null;
  lastRunDurationMs: number | null;
  lastRunResult: 'ok' | 'error' | 'skipped' | null;
  totalRuns: number;
  consecutiveErrors: number;
  sessionBrief: SessionStrategyBrief | null;
  consecutiveNoBuyCandidates: number;
}

const state: LoopState = {
  active: false,
  phase: 'STOPPED',
  intervalMs: DEFAULT_INTERVAL_MS,
  adaptiveIntervalMs: DEFAULT_INTERVAL_MS,
  startedAt: null,
  lastRunAt: null,
  lastRunDurationMs: null,
  lastRunResult: null,
  totalRuns: 0,
  consecutiveErrors: 0,
  sessionBrief: null,
  consecutiveNoBuyCandidates: 0,
};

let timer: ReturnType<typeof setTimeout> | null = null;

async function tick(): Promise<void> {
  if (!state.active) return;

  // Kill Switch 활성이어도 매도(탈출)를 위해 실행 — 매수만 overseas-job 내부에서 차단
  if (isKillSwitchActive('OVERSEAS')) {
    logger.info('Auto Pilot: Kill Switch 활성 — 매도만 실행 (매수 차단은 overseas-job 내부)', { component: 'LOOP' });
  }

  // ── 1. 전략 유효성 체크 (API 호출 없음) ──
  const validity = await checkStrategyValidity().catch(() => ({ adjusted: false, regenerate: false, reason: undefined as string | undefined }));
  if (validity.regenerate) {
    logger.info(`🔄 전략 재생성 트리거: ${validity.reason}`, { component: 'LOOP' });
    const newBrief = await generateSessionBrief().catch(() => null);
    if (newBrief) {
      state.sessionBrief = newBrief;
      sendTelegramMessage(`🔄 세션 전략 재수립: ${newBrief.marketRegime}/${newBrief.riskLevel}\n${newBrief.narrative}`).catch(() => {});
    }
  }

  // ── 2. 매매 실행 ──
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

  // ── 3. 적응형 인터벌 조정 ──
  adaptiveInterval();
  scheduleNext();
}

function adaptiveInterval(): void {
  const brief = getActiveSessionBrief();

  // VIX STRESS/CRISIS → 가속 (3분)
  if (brief && (brief.marketRegime === 'CRISIS' || brief.riskLevel === 'DEFENSIVE')) {
    state.adaptiveIntervalMs = FAST_INTERVAL_MS;
    return;
  }

  // 미국장 시간대별 차등 (ET 기준, KST → ET 변환)
  const usPhase = getUSMarketPhase();
  if (usPhase === 'OPEN_VOLATILE') {
    // 개장 30분 (9:30~10:00 ET): 관찰 위주 — 긴 간격
    state.adaptiveIntervalMs = SLOW_INTERVAL_MS;
    return;
  }
  if (usPhase === 'PRIME') {
    // 10:00~11:30 ET: 주력 매수 구간 — 빠른 간격
    state.adaptiveIntervalMs = FAST_INTERVAL_MS;
    return;
  }
  if (usPhase === 'LUNCH') {
    // 12:00~14:00 ET: 거래량 최저 — 느린 간격
    state.adaptiveIntervalMs = SLOW_INTERVAL_MS;
    return;
  }
  if (usPhase === 'POWER_HOUR') {
    // 15:00~16:00 ET: 기관 물량 — 빠른 간격
    state.adaptiveIntervalMs = FAST_INTERVAL_MS;
    return;
  }

  // 유휴 상태 감지: 2연속 매수 후보 없음 → 감속 (8분)
  if (state.consecutiveNoBuyCandidates >= 2) {
    state.adaptiveIntervalMs = SLOW_INTERVAL_MS;
    return;
  }

  // 표준 (5분)
  state.adaptiveIntervalMs = DEFAULT_INTERVAL_MS;
}

type USMarketPhase = 'PREMARKET' | 'OPEN_VOLATILE' | 'PRIME' | 'MIDDAY' | 'LUNCH' | 'POWER_HOUR' | 'CLOSED';

function getUSMarketPhase(): USMarketPhase {
  const now = new Date();
  // ET = UTC-5 (EST) or UTC-4 (EDT)
  // 간단 판단: 3월 둘째 일요일~11월 첫째 일요일 = EDT
  const month = now.getUTCMonth(); // 0-indexed
  const isDST = month >= 2 && month <= 10; // 대략적 DST
  const etOffset = isDST ? -4 : -5;
  const etHour = (now.getUTCHours() + etOffset + 24) % 24;
  const etMin = now.getUTCMinutes();
  const etTime = etHour * 100 + etMin;

  if (etTime < 930) return 'PREMARKET';
  if (etTime < 1000) return 'OPEN_VOLATILE';
  if (etTime < 1130) return 'PRIME';
  if (etTime < 1200) return 'MIDDAY';
  if (etTime < 1400) return 'LUNCH';
  if (etTime < 1500) return 'MIDDAY';
  if (etTime < 1600) return 'POWER_HOUR';
  return 'CLOSED';
}

function scheduleNext(): void {
  if (!state.active) return;
  timer = setTimeout(tick, state.adaptiveIntervalMs);
}

// ── Public API ──

/** 매수 후보 없음 카운터 — overseas-job에서 호출 */
export function reportNoBuyCandidates(noCandidates: boolean): void {
  if (noCandidates) {
    state.consecutiveNoBuyCandidates++;
  } else {
    state.consecutiveNoBuyCandidates = 0;
  }
}

export async function startLoop(): Promise<{ ok: boolean; error?: string }> {
  if (state.active) return { ok: false, error: '이미 실행 중' };
  if (isKillSwitchActive('OVERSEAS')) return { ok: false, error: 'Kill Switch 활성 — 먼저 해제하세요' };

  state.active = true;
  state.startedAt = new Date().toISOString();
  state.totalRuns = 0;
  state.consecutiveErrors = 0;
  state.consecutiveNoBuyCandidates = 0;
  state.lastRunResult = null;
  state.adaptiveIntervalMs = DEFAULT_INTERVAL_MS;

  // ── 1단계: 세션 전략 리뷰 ──
  state.phase = 'REVIEWING';
  logger.info(`🤖 Auto Pilot 시작 — 세션 전략 수립 중...`, { component: 'LOOP' });
  sendTelegramMessage(`🤖 Auto Pilot 시작\n세션 전략 수립 중...`).catch(() => {});

  const brief = await generateSessionBrief().catch(() => null);
  state.sessionBrief = brief;

  if (brief) {
    const msg = `📋 세션 전략 수립 완료\n레짐: ${brief.marketRegime} | 리스크: ${brief.riskLevel}\n${brief.narrative}`;
    logger.info(msg, { component: 'LOOP' });
    sendTelegramMessage(msg).catch(() => {});
  } else {
    logger.info(`⚠️ 전략 생성 스킵 — 기존 로직으로 진행`, { component: 'LOOP' });
  }

  // ── 2단계: 매매 시작 ──
  state.phase = 'TRADING';
  tick();

  return { ok: true };
}

export async function stopLoop(reason?: string): Promise<{ ok: boolean }> {
  if (timer) { clearTimeout(timer); timer = null; }
  const wasActive = state.active;
  state.active = false;
  state.phase = 'STOPPED';

  if (wasActive) {
    const msg = `🤖 Auto Pilot 정지${reason ? `: ${reason}` : ''}\n총 ${state.totalRuns}회 실행`;
    logger.info(msg, { component: 'LOOP' });
    sendTelegramMessage(msg).catch(() => {});

    // ── 4단계: 세션 요약 ──
    if (state.sessionBrief) {
      await generateSessionSummary({
        startedAt: state.startedAt ?? new Date().toISOString(),
        totalRuns: state.totalRuns,
        briefGenerated: true,
      }).catch((err) => {
        logger.warn(`세션 요약 실패: ${(err as Error).message}`, { component: 'LOOP' });
      });
    }

    clearSessionBrief();
    state.sessionBrief = null;
  }

  return { ok: true };
}

export function getLoopStatus() {
  return { ...state };
}

export function isLoopActive(): boolean {
  return state.active;
}
