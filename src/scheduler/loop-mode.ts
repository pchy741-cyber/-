/**
 * Auto Pilot — 대시보드에서 토글하는 서버사이드 매매 루프
 * 라이프사이클: REVIEWING → TRADING ↔ PAUSED → STOPPED → 세션 요약
 * DB 영속 (loop_sessions/loop_ticks) + 서버 재시작 시 자동 재개
 */

import { getCopilotLiteScore } from '../api/routes/review/copilot-lite.js';
import { runWithMode } from '../config/context.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { isKillSwitchActive } from '../risk/kill-switch.js';
import { logger } from '../utils/logger.js';
import { getOpenMarketRegions } from './overseas/session.js';
import {
  checkStrategyValidity,
  clearSessionBrief,
  generateSessionBrief,
  generateSessionSummary,
  getActiveSessionBrief,
  type SessionStrategyBrief,
} from './overseas/session-strategy.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000; // 5분
const FAST_INTERVAL_MS = 3 * 60_000; // 3분 (VIX STRESS/CRISIS, 황금구간)
const TURBO_INTERVAL_MS = 2 * 60_000; // 2분 (개장벨 09:00~09:30, 마감벨 15:00~15:20)
const SLOW_INTERVAL_MS = 8 * 60_000; // 8분 (유휴 상태)
const PAUSE_CHECK_MS = 15 * 60_000; // 15분 (장외 PAUSED 상태 체크 — 시장 오픈 빠른 감지)
const MAX_CONSECUTIVE_ERRORS = 3;
const RECOVERY_COOLDOWN_MS = 5 * 60_000; // 5분 — 에러 정지 후 자동 재시도까지 대기
const MAX_RECOVERY_ATTEMPTS = 3; // 자동 재시도 최대 횟수 (이후 진짜 정지)
const RESUME_WINDOW_MIN = 60; // checkPendingLoop 윈도우 10분 → 1시간

export type LoopPhase = 'REVIEWING' | 'TRADING' | 'PAUSED' | 'STOPPED';
export type USMarketPhase = 'PREMARKET' | 'OPEN_VOLATILE' | 'PRIME' | 'MIDDAY' | 'LUNCH' | 'POWER_HOUR' | 'CLOSED';

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
  dbSessionId: number | null;
  // 메트릭 (강화 #1)
  buyCount: number;
  sellCount: number;
  realizedPnlKrw: number;
  errorCountTotal: number;
  // 자동 복구 (강화 #3)
  recoveryAttempts: number;
  lastRecoveryAt: string | null;
  // 킬스위치 연동 (강화 #4)
  pausedReason: string | null;
  killSwitchPauses: number;
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
  dbSessionId: null,
  buyCount: 0,
  sellCount: 0,
  realizedPnlKrw: 0,
  errorCountTotal: 0,
  recoveryAttempts: 0,
  lastRecoveryAt: null,
  pausedReason: null,
  killSwitchPauses: 0,
};

let timer: ReturnType<typeof setTimeout> | null = null;
let _autoStopTimer: ReturnType<typeof setTimeout> | null = null;
const LOOP_MAX_DURATION_MS = 6 * 60 * 60_000; // 6시간 자동 정지 — advisory lock 무한 점유 방지

// ── DB 헬퍼 (실패해도 루프 진행) ──

async function dbCreateSession(brief: SessionStrategyBrief | null): Promise<number | null> {
  try {
    const { getPool } = await import('../db/client.js');
    const { rows } = await getPool().query(
      `INSERT INTO loop_sessions (started_at, phase, session_brief) VALUES (NOW(), 'REVIEWING', $1) RETURNING id`,
      [brief ? JSON.stringify(brief) : null],
    );
    return rows[0]?.id ?? null;
  } catch (e) {
    logger.warn(`loop_sessions INSERT 실패: ${(e as Error).message}`, { component: 'LOOP' });
    return null;
  }
}

const ALLOWED_SESSION_COLS = new Set([
  'phase',
  'session_brief',
  'total_runs',
  'buy_count',
  'sell_count',
  'realized_pnl_krw',
  'error_count',
  'last_recovery_at',
  'paused_reason',
  'kill_switch_pauses',
  'last_run_result',
  'adaptive_interval_ms',
  'ended_at',
  'stop_reason',
]);

async function dbUpdateSession(id: number | null, updates: Record<string, unknown>): Promise<void> {
  if (!id) return;
  try {
    const { getPool } = await import('../db/client.js');
    const keys = Object.keys(updates).filter((k) => ALLOWED_SESSION_COLS.has(k));
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await getPool().query(`UPDATE loop_sessions SET ${sets} WHERE id = $1`, [id, ...keys.map((k) => updates[k])]);
  } catch (e) {
    logger.warn(`loop_sessions UPDATE 실패: ${(e as Error).message}`, { component: 'LOOP' });
  }
}

async function dbInsertTick(
  sessionId: number | null,
  tickNum: number,
  result: string,
  durationMs: number | null,
  intervalMs: number,
): Promise<void> {
  if (!sessionId) return;
  try {
    const { getPool } = await import('../db/client.js');
    await getPool().query(
      `INSERT INTO loop_ticks (session_id, tick_num, result, duration_ms, interval_ms, market_phase) VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, tickNum, result, durationMs, intervalMs, getUSMarketPhase()],
    );
  } catch (e) {
    logger.warn(`Loop tick DB 기록 실패: ${e}`, { component: 'LOOP' });
  }
}

/** 임계 이벤트 시 Copilot Lite 점검 → DB 저장 + Telegram */
async function runCopilotCheck(reason: string): Promise<void> {
  try {
    const result = await getCopilotLiteScore(false); // live 기준
    logger.info(`🩺 Auto Copilot [${reason}]: score=${result.score}, issues=${result.issues.length}`, {
      component: 'LOOP',
    });

    if (result.issues.length > 0) {
      const issueText = result.issues.map((i) => `[${i.level}] ${i.label}`).join(', ');
      sendTelegramMessage(`🩺 Auto Copilot (${reason})\nScore: ${result.score}\n${issueText}`).catch(() => {});
    }

    // DB 기록
    if (state.dbSessionId) {
      const { getPool } = await import('../db/client.js');
      await getPool().query(
        `INSERT INTO loop_ticks (session_id, tick_num, result, market_phase)
         VALUES ($1, $2, $3, $4)`,
        [state.dbSessionId, state.totalRuns, `copilot:${reason}:${result.score}`, getUSMarketPhase()],
      );
    }
  } catch (e) {
    logger.warn(`Auto Copilot 실패: ${(e as Error).message}`, { component: 'LOOP' });
  }
}

// ── 세션 메트릭 집계 (강화 #1) ──
// 직전 메트릭 누적 시점부터 dbSessionId 기간 동안의 orders 테이블 집계
let _lastMetricsAt = 0;
async function updateSessionMetrics(): Promise<void> {
  if (!state.dbSessionId || !state.startedAt) return;
  // 1분 내 중복 집계 스킵 (오버헤드 방지)
  const now = Date.now();
  if (now - _lastMetricsAt < 60_000) return;
  _lastMetricsAt = now;
  try {
    const { getPool } = await import('../db/client.js');
    const startIso = state.startedAt;
    const { rows } = await getPool().query(
      `SELECT
        COUNT(*) FILTER (WHERE side = 'BUY' AND status = 'FILLED') AS buys,
        COUNT(*) FILTER (WHERE side = 'SELL' AND status = 'FILLED') AS sells,
        COALESCE(SUM(CASE WHEN side = 'SELL' AND status = 'FILLED' AND avg_buy_price IS NOT NULL
          THEN (filled_price - avg_buy_price) * filled_quantity END), 0) AS realized_pnl
       FROM orders
       WHERE created_at >= $1 AND stock_code ~ '^[0-9]{6}$'`,
      [startIso],
    );
    state.buyCount = Number(rows[0]?.buys ?? 0);
    state.sellCount = Number(rows[0]?.sells ?? 0);
    state.realizedPnlKrw = Number(rows[0]?.realized_pnl ?? 0);
  } catch {
    // 집계 실패는 루프 진행에 영향 없음
  }
}

/** 최근 N개 루프 세션 히스토리 — /api/loop/sessions 노출용 */
export async function getLoopSessionsHistory(limit = 20): Promise<unknown[]> {
  try {
    const { getPool } = await import('../db/client.js');
    const { rows } = await getPool().query(
      `SELECT id, started_at, ended_at, phase, total_runs,
              buy_count, sell_count, realized_pnl_krw, error_count,
              kill_switch_pauses, last_recovery_at, paused_reason,
              session_brief, stop_reason, last_run_result
       FROM loop_sessions
       ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      phase: r.phase,
      totalRuns: Number(r.total_runs ?? 0),
      buyCount: Number(r.buy_count ?? 0),
      sellCount: Number(r.sell_count ?? 0),
      realizedPnlKrw: Number(r.realized_pnl_krw ?? 0),
      errorCount: Number(r.error_count ?? 0),
      killSwitchPauses: Number(r.kill_switch_pauses ?? 0),
      lastRecoveryAt: r.last_recovery_at,
      pausedReason: r.paused_reason,
      stopReason: r.stop_reason,
      lastRunResult: r.last_run_result,
      regime: r.session_brief?.marketRegime ?? null,
      risk: r.session_brief?.riskLevel ?? null,
    }));
  } catch {
    return [];
  }
}

// ── 틱 실행 ──

async function tick(): Promise<void> {
  if (!state.active) return;

  // ── 0. 시장 상태 1회 캐시 (tick 전체에서 재사용 — 중복 호출 제거) ──
  const tickMarketPhase = getUSMarketPhase();
  const tickOpenRegions = getOpenMarketRegions();
  const anyMarketOpen = tickOpenRegions.size > 0;

  // PAUSED 체크: 모든 시장 마감 → PAUSED
  if (!anyMarketOpen && (tickMarketPhase === 'CLOSED' || tickMarketPhase === 'PREMARKET')) {
    if (state.phase === 'TRADING') {
      state.phase = 'PAUSED';
      const prevInterval = state.adaptiveIntervalMs;
      state.adaptiveIntervalMs = PAUSE_CHECK_MS;
      logger.info(`Auto Pilot: 전체 장외 시간 → PAUSED (${prevInterval / 1000}s → ${PAUSE_CHECK_MS / 1000}s)`, {
        component: 'LOOP',
      });
      dbUpdateSession(state.dbSessionId, { phase: 'PAUSED' }).catch(() => {});
    }
    scheduleNext();
    return;
  }

  // ── 킬스위치 자동 PAUSED 연동 (강화 #4) ──
  // 양 스코프 모두 발동 시 → 매매 자체가 의미 없음 → PAUSED 전환
  const krKs = isKillSwitchActive('KR');
  const ovKs = isKillSwitchActive('OVERSEAS');
  if (krKs && ovKs && state.phase === 'TRADING') {
    state.phase = 'PAUSED';
    state.pausedReason = 'kill_switch_both';
    state.killSwitchPauses++;
    state.adaptiveIntervalMs = PAUSE_CHECK_MS;
    logger.warn(`Auto Pilot: KR+OVERSEAS Kill Switch 양쪽 발동 → PAUSED 자동 전환`, { component: 'LOOP' });
    dbUpdateSession(state.dbSessionId, {
      phase: 'PAUSED',
      paused_reason: 'kill_switch_both',
      kill_switch_pauses: state.killSwitchPauses,
    }).catch(() => {});
    sendTelegramMessage('🛑 Auto Pilot 자동 PAUSED — KR+OVERSEAS 킬스위치 양쪽 발동').catch(() => {});
    runCopilotCheck('kill_switch_both').catch(() => {});
    // 캡쳐 강화 #2: 자동 트리거 (paper + live 둘 다)
    import('../api/routes/review/capture-trigger.js')
      .then(async (m) => {
        await m.triggerCapture('kill_switch', 'live', state.dbSessionId).catch(() => {});
        await m.triggerCapture('kill_switch', 'paper', state.dbSessionId).catch(() => {});
      })
      .catch(() => {});
    scheduleNext();
    return;
  }

  // PAUSED → TRADING 자동 복귀 (시장 오픈 OR 킬스위치 해제)
  if (state.phase === 'PAUSED' && anyMarketOpen && !(krKs && ovKs)) {
    const regions = [...tickOpenRegions].join(',');
    const wasKsPause = state.pausedReason === 'kill_switch_both';
    state.phase = 'TRADING';
    state.pausedReason = null;
    state.adaptiveIntervalMs = DEFAULT_INTERVAL_MS;
    logger.info(`Auto Pilot: ${wasKsPause ? '킬스위치 해제' : '장 오픈'} (${regions}) → TRADING 복귀`, {
      component: 'LOOP',
    });
    dbUpdateSession(state.dbSessionId, { phase: 'TRADING', paused_reason: null }).catch(() => {});
    if (wasKsPause) sendTelegramMessage(`🟢 Auto Pilot TRADING 복귀 — 킬스위치 해제 감지`).catch(() => {});
  }

  // Kill Switch 부분 발동 로그
  if (krKs && !ovKs) logger.info('Auto Pilot: KR Kill Switch 활성 — 국내 매도만', { component: 'LOOP' });
  if (ovKs && !krKs) {
    logger.info('Auto Pilot: OVERSEAS Kill Switch 활성 — 해외 매도만', { component: 'LOOP' });
    runCopilotCheck('kill_switch').catch(() => {});
  }

  // ── 1. 전략 유효성 체크 (3틱마다) ──
  const shouldCheckValidity = state.totalRuns % 3 === 0;
  const validity = shouldCheckValidity
    ? await checkStrategyValidity().catch(() => ({
        adjusted: false,
        regenerate: false,
        reason: undefined as string | undefined,
      }))
    : { adjusted: false, regenerate: false, reason: undefined as string | undefined };
  if (validity.regenerate) {
    logger.info(`🔄 전략 재생성 트리거: ${validity.reason}`, { component: 'LOOP' });
    const newBrief = await generateSessionBrief().catch(() => null);
    if (newBrief) {
      state.sessionBrief = newBrief;
      dbUpdateSession(state.dbSessionId, { session_brief: JSON.stringify(newBrief) }).catch(() => {});
      sendTelegramMessage(
        `🔄 세션 전략 재수립: ${newBrief.marketRegime}/${newBrief.riskLevel}\n${newBrief.narrative}`,
      ).catch(() => {});
      runCopilotCheck('strategy_regen').catch(() => {});
    }
  }

  // ── 2. 매매 실행 — 국내/해외 분기 ──
  const krOpen = tickOpenRegions.has('KR');
  const overseasOpen = [...tickOpenRegions].some((r) => r !== 'KR');
  const activeMarkets = [krOpen && '🇰🇷국내', overseasOpen && '🌏해외'].filter(Boolean).join('+');
  logger.info(`Auto Pilot 틱 #${state.totalRuns + 1}: ${activeMarkets || '장외'} 실행`, { component: 'LOOP' });

  state.lastRunAt = new Date().toISOString();
  state.totalRuns++;
  const t0 = Date.now();

  try {
    // 국내장 + 해외장 동시 실행 가능 시 병렬화
    const jobs: Promise<void>[] = [];

    if (krOpen) {
      // Track B paper+live 병렬 (독립 컨텍스트 — 충돌 없음)
      const { runTrackBJob } = await import('./track-b-job.js');
      jobs.push(
        Promise.all([
          runWithMode(true, () => runTrackBJob()).catch((e) =>
            logger.error(`Loop KR paper: ${e}`, { component: 'LOOP' }),
          ),
          runWithMode(false, () => runTrackBJob()).catch((e) =>
            logger.error(`Loop KR live: ${e}`, { component: 'LOOP' }),
          ),
        ]).then(() => {}),
      );
    }
    if (overseasOpen) {
      const { runOverseasDual } = await import('./overseas-job.js');
      jobs.push(runOverseasDual());
    }

    if (jobs.length > 0) await Promise.all(jobs);

    state.lastRunDurationMs = Date.now() - t0;
    state.lastRunResult = 'ok';
    state.consecutiveErrors = 0;
    state.consecutiveNoBuyCandidates = 0; // 실행 성공 시 idle 카운터 리셋
  } catch (err) {
    state.lastRunDurationMs = Date.now() - t0;
    state.lastRunResult = 'error';
    state.consecutiveErrors++;
    state.errorCountTotal++;
    logger.error(`Auto Pilot 에러 (${state.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${(err as Error).message}`, {
      component: 'LOOP',
    });

    if (state.consecutiveErrors === 2) {
      runCopilotCheck('consecutive_errors_2').catch(() => {});
    }
    if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      // 자동 복구 (강화 #3): MAX_RECOVERY_ATTEMPTS 까지 쿨다운 후 자동 재시도
      if (state.recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
        state.recoveryAttempts++;
        state.lastRecoveryAt = new Date().toISOString();
        const cooldown = RECOVERY_COOLDOWN_MS * state.recoveryAttempts; // 지수 backoff: 5m, 10m, 15m
        logger.warn(
          `Auto Pilot 자동 복구 #${state.recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS} — ${cooldown / 60_000}분 쿨다운 후 재시도`,
          { component: 'LOOP' },
        );
        sendTelegramMessage(
          `🔄 Auto Pilot 자동복구 #${state.recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS} — ${cooldown / 60_000}분 후 재시도`,
        ).catch(() => {});
        // 캡쳐 강화 #2: 에러 폭주 자동 트리거
        import('../api/routes/review/capture-trigger.js')
          .then((m) => m.triggerCapture('error_burst', 'live', state.dbSessionId).catch(() => {}))
          .catch(() => {});
        state.consecutiveErrors = 0; // 재시도 위해 초기화
        state.adaptiveIntervalMs = cooldown;
        dbUpdateSession(state.dbSessionId, {
          last_recovery_at: state.lastRecoveryAt,
          error_count: state.errorCountTotal,
        }).catch(() => {});
        scheduleNext();
        return;
      }
      // 복구 소진 → 루프 정지 직전 loop_paused 캡처 (최후 상태 기록)
      import('../api/routes/review/capture-trigger.js')
        .then((m) => m.triggerCapture('loop_paused', 'live', state.dbSessionId).catch(() => {}))
        .catch(() => {});
      stopLoop(`연속 ${MAX_CONSECUTIVE_ERRORS}회 에러 × ${MAX_RECOVERY_ATTEMPTS}회 복구 시도 모두 실패 — 진짜 정지`);
      return;
    }
  }

  // 성공 시 복구 카운터 리셋
  if (state.lastRunResult === 'ok' && state.recoveryAttempts > 0) {
    logger.info(`Auto Pilot 복구 성공 (시도 ${state.recoveryAttempts}회)`, { component: 'LOOP' });
    state.recoveryAttempts = 0;
  }

  // DB 틱 기록
  dbInsertTick(
    state.dbSessionId,
    state.totalRuns,
    state.lastRunResult ?? 'error',
    state.lastRunDurationMs,
    state.adaptiveIntervalMs,
  ).catch(() => {});
  // 메트릭 누적 (강화 #1): 직전 틱 이후 발생한 매수/매도/PnL을 orders 테이블에서 집계
  updateSessionMetrics().catch(() => {});
  dbUpdateSession(state.dbSessionId, {
    total_runs: state.totalRuns,
    last_run_result: state.lastRunResult,
    buy_count: state.buyCount,
    sell_count: state.sellCount,
    realized_pnl_krw: Math.round(state.realizedPnlKrw),
    error_count: state.errorCountTotal,
  }).catch(() => {});

  // ── 3. 적응형 인터벌 조정 (캐시된 시장 상태 전달) ──
  const prevInterval = state.adaptiveIntervalMs;
  adaptiveInterval(tickOpenRegions, tickMarketPhase);
  if (prevInterval !== state.adaptiveIntervalMs) {
    logger.debug(`interval: ${prevInterval / 60_000}m→${state.adaptiveIntervalMs / 60_000}m (${tickMarketPhase})`, {
      component: 'LOOP',
    });
  }
  scheduleNext();
}

const DEEP_IDLE_INTERVAL_MS = 15 * 60_000; // 15분 (3연속 무활동 시 깊은 유휴)

function adaptiveInterval(cachedRegions?: Set<string>, cachedPhase?: USMarketPhase): void {
  const brief = getActiveSessionBrief();
  const openRegions = cachedRegions ?? getOpenMarketRegions();
  const krOpen = openRegions.has('KR');

  // VIX STRESS/CRISIS → 가속 (3분)
  if (brief && (brief.marketRegime === 'CRISIS' || brief.riskLevel === 'DEFENSIVE')) {
    state.adaptiveIntervalMs = FAST_INTERVAL_MS;
    return;
  }

  // ── 국내장 시간대별 정밀 인터벌 (CLAUDE.md 시간대 규칙 반영) ──
  if (krOpen) {
    const phase = getKrMarketPhase();
    switch (phase) {
      case 'OPENING_BELL': // 09:00~09:30 백엔드 자동, Claude 매수금지 — 단축 폴링
      case 'CLOSING_BELL': // 15:00~15:20 신규 금지, 손절 모니터만
        state.adaptiveIntervalMs = TURBO_INTERVAL_MS;
        return;
      case 'GOLDEN_AM': // 09:30~10:20 ★ 황금 오전
      case 'GOLDEN_PM': // 13:00~15:00 ★ 황금 오후
        state.adaptiveIntervalMs = FAST_INTERVAL_MS;
        return;
      case 'CURSED': // 10:20~13:00 ☠️ 마의 시간대 — 신규매수 금지, 매도감시는 유지
        // 신규매수는 pipeline이 차단하므로 루프 주기는 DEFAULT(5분) 유지 — 손절/익절 감시 공백 방지
        state.adaptiveIntervalMs = DEFAULT_INTERVAL_MS;
        return;
      default:
        state.adaptiveIntervalMs = DEFAULT_INTERVAL_MS;
        return;
    }
  }

  // 미국장 시간대별 차등 (캐시된 phase 사용)
  const usPhase = cachedPhase ?? getUSMarketPhase();
  if (usPhase === 'OPEN_VOLATILE' || usPhase === 'PRIME' || usPhase === 'POWER_HOUR') {
    state.adaptiveIntervalMs = FAST_INTERVAL_MS;
    return;
  }
  if (usPhase === 'LUNCH' || usPhase === 'MIDDAY') {
    state.adaptiveIntervalMs = SLOW_INTERVAL_MS;
    return;
  }
  // 미국 프리/포스트마켓 (US_EXTENDED) — 정규장보다 느리지만 매도감시 유지
  const isUSExtended = openRegions.has('US_EXTENDED') && !openRegions.has('US');
  if (isUSExtended) {
    state.adaptiveIntervalMs = SLOW_INTERVAL_MS; // 8분 (보유종목 손절/익절 감시)
    return;
  }

  // 깊은 유휴: 3연속 무활동 → 15분 (API/DB 부하 최소화)
  if (state.consecutiveNoBuyCandidates >= 3) {
    state.adaptiveIntervalMs = DEEP_IDLE_INTERVAL_MS;
    return;
  }
  // 유휴: 2연속 무활동 → 8분
  if (state.consecutiveNoBuyCandidates >= 2) {
    state.adaptiveIntervalMs = SLOW_INTERVAL_MS;
    return;
  }

  // 세션 전략 BULL+AGGRESSIVE → 가속
  if (brief && brief.marketRegime === 'BULL' && brief.riskLevel === 'AGGRESSIVE') {
    state.adaptiveIntervalMs = FAST_INTERVAL_MS;
    return;
  }

  state.adaptiveIntervalMs = DEFAULT_INTERVAL_MS;
}

/** 정확한 US DST 판별 — 3월 둘째 일요일 2AM ET ~ 11월 첫째 일요일 2AM ET */
function isUSDST(d: Date): boolean {
  const year = d.getUTCFullYear();
  const mar1 = new Date(Date.UTC(year, 2, 1));
  const marSun2 = 8 + (7 - mar1.getUTCDay()) % 7; // 3월 둘째 일요일
  const dstStart = Date.UTC(year, 2, marSun2, 7);
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const novSun1 = nov1.getUTCDay() === 0 ? 1 : 8 - nov1.getUTCDay();
  const dstEnd = Date.UTC(year, 10, novSun1, 6);
  return d.getTime() >= dstStart && d.getTime() < dstEnd;
}

// ── 한국 시장 정밀 페이즈 (CLAUDE.md 황금/마의 시간대 규칙) ──
export type KrMarketPhase =
  | 'OPENING_BELL' // 09:00~09:30 백엔드 자동매매, Claude 신규금지
  | 'GOLDEN_AM' // 09:30~10:20 ★ 황금 오전
  | 'CURSED' // 10:20~13:00 ☠️ 마의 시간대 (신규 매수 금지)
  | 'GOLDEN_PM' // 13:00~15:00 ★ 황금 오후
  | 'CLOSING_BELL' // 15:00~15:20 신규 금지, 손절 모니터만
  | 'CLOSED';

export function getKrMarketPhase(date?: Date): KrMarketPhase {
  const now = date ?? new Date();
  const kstH = (now.getUTCHours() + 9) % 24;
  const kstM = now.getUTCMinutes();
  const t = kstH * 100 + kstM;
  if (t < 900 || t > 1530) return 'CLOSED';
  if (t < 930) return 'OPENING_BELL';
  if (t < 1020) return 'GOLDEN_AM';
  if (t < 1300) return 'CURSED';
  if (t < 1500) return 'GOLDEN_PM';
  return 'CLOSING_BELL';
}

export function getUSMarketPhase(date?: Date): USMarketPhase {
  const now = date ?? new Date();
  const etOffset = isUSDST(now) ? -4 : -5;
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
  if (timer) clearTimeout(timer);
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

// 강화 P1-5: 서버 Auto Pilot + Claude Code /loop 동시 실행 차단
// DB advisory lock으로 단일 인스턴스만 활성 보장 (Cloud Run 다중 인스턴스 + Claude 토큰 루프 모두 차단)
const LOOP_ADVISORY_LOCK_ID = 73091234; // 임의 큰 정수 (loop-mode 전용)
let _lockClient: import('pg').PoolClient | null = null;

async function acquireLoopLock(): Promise<boolean> {
  try {
    const { getPool } = await import('../db/client.js');
    const pool = getPool();
    _lockClient = await pool.connect();
    const { rows } = await _lockClient.query('SELECT pg_try_advisory_lock($1) AS acquired', [LOOP_ADVISORY_LOCK_ID]);
    const acquired = rows[0]?.acquired === true;
    if (!acquired) {
      _lockClient.release();
      _lockClient = null;
    }
    return acquired;
  } catch (e) {
    // pool.connect() 성공 후 query 실패 시 client 반환
    if (_lockClient) {
      try { _lockClient.release(); } catch { /* ignore */ }
      _lockClient = null;
    }
    logger.warn(`Loop advisory lock 획득 실패: ${(e as Error).message}`, { component: 'LOOP' });
    return true; // DB 실패 시 락 없이 진행 (가용성 우선)
  }
}

async function releaseLoopLock(): Promise<void> {
  if (!_lockClient) return;
  try {
    await _lockClient.query('SELECT pg_advisory_unlock($1)', [LOOP_ADVISORY_LOCK_ID]).catch(() => {});
    _lockClient.release();
  } catch {
    /* ignore */
  }
  _lockClient = null;
}

export async function startLoop(): Promise<{ ok: boolean; error?: string; warning?: string }> {
  if (state.active) return { ok: false, error: '이미 실행 중' };
  if (isKillSwitchActive('OVERSEAS')) return { ok: false, error: 'Kill Switch 활성 — 먼저 해제하세요' };

  // 강화 P1-5: 다른 인스턴스/Claude /loop이 이미 활성이면 차단
  const lockAcquired = await acquireLoopLock();
  if (!lockAcquired) {
    return { ok: false, error: '다른 곳에서 이미 루프 실행 중 (DB advisory lock) — 그쪽 정지 후 재시도' };
  }

  // 장외 시간 경고 (시작은 허용)
  const marketPhase = getUSMarketPhase();
  const startOpenRegions = getOpenMarketRegions();
  const isMarketClosed = startOpenRegions.size === 0 && (marketPhase === 'CLOSED' || marketPhase === 'PREMARKET');
  let warning: string | undefined;
  if (isMarketClosed) {
    warning = `현재 전체 장외 시간 (${marketPhase}) — PAUSED 상태로 시작, 장 오픈 시 자동 TRADING 전환`;
  }

  state.active = true;
  state.startedAt = new Date().toISOString();
  state.totalRuns = 0;
  state.consecutiveErrors = 0;
  state.consecutiveNoBuyCandidates = 0;
  state.lastRunResult = null;
  state.adaptiveIntervalMs = DEFAULT_INTERVAL_MS;

  // 6시간 자동 정지 — advisory lock 무한 점유 방지
  _autoStopTimer = setTimeout(() => {
    logger.warn('Loop 6시간 자동 정지 — 최대 세션 시간 초과', { component: 'LOOP' });
    stopLoop('6시간 자동 정지').catch((err) => {
      // 6시간 안전장치 실패 → 강제 상태 초기화 (무한 루프 방지)
      logger.error(`⛔ 6시간 자동 정지 실패 → 강제 플래그 해제: ${err}`, { component: 'LOOP' });
      state.active = false;
      state.phase = 'STOPPED';
    });
  }, LOOP_MAX_DURATION_MS);

  // ── 1단계: 세션 전략 리뷰 ──
  state.phase = 'REVIEWING';
  logger.info(`🤖 Auto Pilot 시작 — 세션 전략 수립 중...`, { component: 'LOOP' });
  sendTelegramMessage(`🤖 Auto Pilot 시작\n세션 전략 수립 중...`).catch(() => {});

  const brief = await generateSessionBrief().catch(() => null);
  state.sessionBrief = brief;

  // DB 세션 생성
  state.dbSessionId = await dbCreateSession(brief);

  if (brief) {
    const msg = `📋 세션 전략 수립 완료\n레짐: ${brief.marketRegime} | 리스크: ${brief.riskLevel}\n${brief.narrative}`;
    logger.info(msg, { component: 'LOOP' });
    sendTelegramMessage(msg).catch(() => {});
  } else {
    logger.info(`⚠️ 전략 생성 스킵 — 기존 로직으로 진행`, { component: 'LOOP' });
  }

  // ── 2단계: 매매 시작 (또는 PAUSED) ──
  if (isMarketClosed) {
    state.phase = 'PAUSED';
    state.adaptiveIntervalMs = PAUSE_CHECK_MS;
    dbUpdateSession(state.dbSessionId, { phase: 'PAUSED' }).catch(() => {});
    scheduleNext();
  } else {
    state.phase = 'TRADING';
    dbUpdateSession(state.dbSessionId, { phase: 'TRADING' }).catch(() => {});
    tick();
  }

  return { ok: true, warning };
}

export async function stopLoop(reason?: string): Promise<{ ok: boolean }> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (_autoStopTimer) {
    clearTimeout(_autoStopTimer);
    _autoStopTimer = null;
  }
  const wasActive = state.active;
  state.active = false;
  state.phase = 'STOPPED';
  // 강화 P1-5: advisory lock 해제 (다른 인스턴스가 이어받을 수 있도록)
  await releaseLoopLock();

  if (wasActive) {
    const msg = `🤖 Auto Pilot 정지${reason ? `: ${reason}` : ''}\n총 ${state.totalRuns}회 실행`;
    logger.info(msg, { component: 'LOOP' });
    sendTelegramMessage(msg).catch(() => {});

    // 최종 Copilot 점검
    runCopilotCheck('session_end').catch(() => {});

    // DB 세션 종료
    dbUpdateSession(state.dbSessionId, {
      ended_at: new Date().toISOString(),
      stop_reason: reason ?? 'manual',
      total_runs: state.totalRuns,
      phase: 'STOPPED',
    }).catch(() => {});

    // ── 세션 요약 ──
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
    state.dbSessionId = null;
  }

  return { ok: true };
}

/** 서버 시작 시 미종료 세션 자동 재개 (RESUME_WINDOW_MIN 이내) */
export async function checkPendingLoop(): Promise<void> {
  try {
    const { getPool } = await import('../db/client.js');
    const { rows } = await getPool().query(
      `SELECT id, started_at, total_runs, consecutive_errors, session_brief,
              buy_count, sell_count, realized_pnl_krw, error_count, kill_switch_pauses
       FROM loop_sessions
       WHERE ended_at IS NULL AND started_at > NOW() - INTERVAL '${RESUME_WINDOW_MIN} minutes'
       ORDER BY id DESC LIMIT 1`,
    );
    if (rows.length === 0) return;

    const session = rows[0];
    logger.info(`🔄 미종료 루프 세션 발견 (id=${session.id}) — 자동 재개`, { component: 'LOOP' });

    // Advisory lock 획득 — 다른 인스턴스 동시 재개 방지
    const lockAcquired = await acquireLoopLock();
    if (!lockAcquired) {
      logger.info(`🔒 다른 인스턴스에서 루프 실행 중 → 재개 스킵`, { component: 'LOOP' });
      return;
    }

    state.active = true;
    state.dbSessionId = session.id;
    state.startedAt = session.started_at;
    state.totalRuns = session.total_runs ?? 0;
    state.consecutiveErrors = session.consecutive_errors ?? 0;
    state.sessionBrief = session.session_brief;
    state.adaptiveIntervalMs = DEFAULT_INTERVAL_MS;
    // 메트릭 복원 (강화 #1)
    state.buyCount = Number(session.buy_count ?? 0);
    state.sellCount = Number(session.sell_count ?? 0);
    state.realizedPnlKrw = Number(session.realized_pnl_krw ?? 0);
    state.errorCountTotal = Number(session.error_count ?? 0);
    state.killSwitchPauses = Number(session.kill_switch_pauses ?? 0);
    state.recoveryAttempts = 0; // 재개 시 복구 시도 리셋

    // 6시간 자동 정지 타이머 (startLoop과 동일) — 무한 실행 방지
    _autoStopTimer = setTimeout(() => {
      logger.warn('Loop 6시간 자동 정지 — 최대 세션 시간 초과 (재개)', { component: 'LOOP' });
      stopLoop('6시간 자동 정지 (재개)').catch((err) => {
        logger.error(`⛔ 6시간 자동 정지 실패: ${err}`, { component: 'LOOP' });
        state.active = false;
        state.phase = 'STOPPED';
      });
    }, LOOP_MAX_DURATION_MS);

    const resumeMarketPhase = getUSMarketPhase();
    const resumeOpenRegions = getOpenMarketRegions();
    if (resumeOpenRegions.size === 0 && (resumeMarketPhase === 'CLOSED' || resumeMarketPhase === 'PREMARKET')) {
      state.phase = 'PAUSED';
      state.adaptiveIntervalMs = PAUSE_CHECK_MS;
    } else {
      state.phase = 'TRADING';
    }

    dbUpdateSession(state.dbSessionId, { phase: state.phase }).catch(() => {});
    const regions = [...resumeOpenRegions].join(',') || 'NONE';
    sendTelegramMessage(`🔄 Auto Pilot 자동 재개 (세션 #${session.id}, ${state.totalRuns}회, 시장:${regions})`).catch(
      () => {},
    );
    scheduleNext();
  } catch (e) {
    logger.warn(`checkPendingLoop 실패: ${(e as Error).message}`, { component: 'LOOP' });
  }
}

export function getLoopStatus() {
  const regions = getOpenMarketRegions();
  return {
    ...state,
    marketPhase: getUSMarketPhase(),
    openMarkets: [...regions],
    anyMarketOpen: regions.size > 0,
  };
}

export function isLoopActive(): boolean {
  return state.active;
}
