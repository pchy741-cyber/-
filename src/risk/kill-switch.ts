import { insertRiskEvent, logSystem } from '../db/client.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Kill Switch — 긴급 정지 장치
 * - 연습모드(paper)와 실전모드(live)를 완전히 분리
 * - 연습모드 킬스위치가 실전 매매를 막지 않음 (핵심 격리)
 */

interface KillSwitchState {
  active: boolean;
  reason: string;
  activatedAt: Date | null;
  consecutiveErrors: number;
  manuallyTriggered: boolean;
}

const DEFAULT_STATE = (): KillSwitchState => ({
  active: false,
  reason: '',
  activatedAt: null,
  consecutiveErrors: 0,
  manuallyTriggered: false,
});

// Paper/Live 완전 분리 — 연습모드 킬스위치가 실전 매매를 막지 않음
let paperState: KillSwitchState = DEFAULT_STATE();
let liveState: KillSwitchState = DEFAULT_STATE();

const MAX_CONSECUTIVE_ERRORS = 5;
let updating = false;

function getState(): KillSwitchState {
  return config.isPaper ? paperState : liveState;
}

function setState(s: KillSwitchState): void {
  if (config.isPaper) paperState = s;
  else liveState = s;
}

export function isKillSwitchActive(): boolean {
  return getState().active;
}

export function getKillSwitchStatus() {
  const s = getState();
  return {
    active: s.active,
    reason: s.reason,
    activatedAt: s.activatedAt?.toISOString() ?? null,
    consecutiveErrors: s.consecutiveErrors,
    manuallyTriggered: s.manuallyTriggered,
  };
}

/**
 * @param manual true = 대시보드/텔레그램 수동 발동 → 자동 해제 불가
 */
export async function activateKillSwitch(reason: string, manual = false): Promise<void> {
  const s = getState();
  if (s.active || updating) return;
  updating = true;

  const mode = config.tradingMode;
  const isPaper = config.isPaper;

  try {
    const now = new Date();
    setState({ active: true, reason, activatedAt: now, consecutiveErrors: s.consecutiveErrors, manuallyTriggered: manual });

    logger.error(`🛑 KILL SWITCH 발동${manual ? ' [수동]' : ''} [${mode}]: ${reason}`, { component: 'KILL_SWITCH' });

    import('../notifications/web-push.js').then(m => m.notifyAlert('🛑 긴급정지 발동', `[${mode}] ${reason}`)).catch((e) => {
      logger.error(`킬스위치 푸시 알림 실패: ${e}`, { component: 'KILL_SWITCH' });
    });

    await insertRiskEvent({
      event_type: 'KILL_SWITCH',
      severity: 'CRITICAL',
      details: { reason, activatedAt: now.toISOString(), manual, mode },
      action_taken: '모든 매매 즉시 차단',
    });

    await logSystem('ERROR', 'KILL_SWITCH', `긴급 정지 발동${manual ? ' [수동]' : ''} [${mode}]: ${reason}`);

    persistKillSwitchToDB(true, reason, manual, isPaper).catch(() => {});
  } finally {
    updating = false;
  }
}

/**
 * @param force true = 수동 발동이어도 강제 해제 (대시보드 명시적 해제)
 */
export async function deactivateKillSwitch(force = false): Promise<void> {
  const s = getState();
  if (!s.active) return;

  if (s.manuallyTriggered && !force) {
    logger.warn(
      `🛡️ Kill Switch 자동 해제 거부: 수동 발동 중 (사유: ${s.reason}) — 대시보드에서 수동 해제 필요`,
      { component: 'KILL_SWITCH' },
    );
    return;
  }

  const mode = config.tradingMode;
  const isPaper = config.isPaper;
  const prevReason = s.reason;

  setState(DEFAULT_STATE());

  logger.info(`✅ Kill Switch 해제${force ? ' [강제]' : ''} [${mode}]`, { component: 'KILL_SWITCH' });
  await logSystem('INFO', 'KILL_SWITCH', `긴급 정지 해제${force ? ' [강제]' : ''} [${mode}] (사유: ${prevReason})`);

  import('../notifications/web-push.js').then(m =>
    m.notifyAlert(
      force ? '🔓 긴급정지 수동 해제' : '🔓 긴급정지 자동 해제',
      `[${mode}] 이전 사유: ${prevReason.slice(0, 80)}\n매매 재개됨`,
    )
  ).catch(() => {});

  persistKillSwitchToDB(false, '', false, isPaper).catch(() => {});
}

/**
 * 에러 누적 카운터 — 연속 에러 시 자동 Kill Switch (모드별 독립)
 */
export async function reportError(component: string, error: string): Promise<void> {
  const s = getState();
  setState({ ...s, consecutiveErrors: s.consecutiveErrors + 1 });

  if (getState().consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    await activateKillSwitch(`연속 에러 ${getState().consecutiveErrors}회 (최근: ${component} - ${error})`);
  }
}

export function reportSuccess(): void {
  const s = getState();
  if (s.consecutiveErrors > 0) {
    setState({ ...s, consecutiveErrors: 0 });
  }
}

/** 장 마감 시 에러 카운터 리셋 */
export function resetDailyErrorCount(): void {
  const s = getState();
  setState({ ...s, consecutiveErrors: 0 });
}

// ── DB 영속화 ──────────────────────────────────────────────────────────────

async function persistKillSwitchToDB(active: boolean, reason: string, manual: boolean, isPaper: boolean): Promise<void> {
  try {
    const { getPool } = await import('../db/client.js');
    const key = isPaper ? 'kill_switch_paper' : 'kill_switch_live';
    await getPool().query(
      `INSERT INTO system_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify({ active, reason, manual, updatedAt: new Date().toISOString() })],
    );
  } catch {
    // system_state 테이블 없으면 무시
  }
}

async function loadKillSwitchForMode(isPaper: boolean): Promise<void> {
  try {
    const { getPool } = await import('../db/client.js');
    const newKey = isPaper ? 'kill_switch_paper' : 'kill_switch_live';

    let { rows } = await getPool().query(
      `SELECT value FROM system_state WHERE key = $1 LIMIT 1`,
      [newKey],
    );

    // 없으면 구 키 fallback (live 모드만 — 마이그레이션 호환)
    if (!rows[0] && !isPaper) {
      const legacy = await getPool().query(
        `SELECT value FROM system_state WHERE key = 'kill_switch' LIMIT 1`,
      );
      rows = legacy.rows;
    }

    if (!rows[0]) return;

    const saved = JSON.parse(rows[0].value) as { active?: boolean; reason?: string; manual?: boolean };
    if (!saved.active) return;

    // 연습모드 자동 킬스위치는 재시작 시 자동 해제
    if (isPaper && !saved.manual) {
      logger.info('🔓 [모의] 자동 Kill Switch 재시작 해제', { component: 'KILL_SWITCH' });
      return;
    }

    const restoredState: KillSwitchState = {
      active: true,
      reason: saved.reason ?? '재시작 복원',
      activatedAt: new Date(),
      consecutiveErrors: 0,
      manuallyTriggered: saved.manual ?? false,
    };

    if (isPaper) paperState = restoredState;
    else liveState = restoredState;

    logger.warn(
      `🛑 [시작][${isPaper ? 'paper' : 'live'}] Kill Switch 복원: ${restoredState.reason}${restoredState.manuallyTriggered ? ' [수동]' : ''}`,
      { component: 'KILL_SWITCH' },
    );
  } catch {
    // system_state 테이블 없으면 무시
  }
}

/**
 * 서버 시작 시 DB에서 Kill Switch 상태 복원 (paper/live 각각)
 */
export async function initKillSwitchFromDB(): Promise<void> {
  await Promise.all([
    loadKillSwitchForMode(true),  // paper
    loadKillSwitchForMode(false), // live
  ]);
}
