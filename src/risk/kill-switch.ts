import { insertRiskEvent, logSystem } from '../db/client.js';
import { logger } from '../utils/logger.js';

/**
 * Kill Switch — 긴급 정지 장치
 * - 모든 매매를 즉시 차단
 * - 자동 발동: 일일 손실 한도 초과, API 에러 연속 등
 * - 수동 발동: 대시보드 / 텔레그램 명령
 * - 수동 발동 시: 자동 해제(08:50/22:20) 제외 — 명시적 force=true 해제만 허용
 */

// 원자적 상태 객체 (개별 변수 대신 단일 객체로 관리 → 읽기/쓰기 일관성 보장)
interface KillSwitchState {
  active: boolean;
  reason: string;
  activatedAt: Date | null;
  consecutiveErrors: number;
  manuallyTriggered: boolean; // 수동 발동 여부 — true면 자동 해제 불가
}

let state: KillSwitchState = {
  active: false,
  reason: '',
  activatedAt: null,
  consecutiveErrors: 0,
  manuallyTriggered: false,
};

const MAX_CONSECUTIVE_ERRORS = 5;
let updating = false; // 간이 뮤텍스

export function isKillSwitchActive(): boolean {
  return state.active;
}

export function getKillSwitchStatus() {
  // 스냅샷 반환 (원자적 읽기)
  const s = state;
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
  if (state.active || updating) return;
  updating = true;

  try {
    const now = new Date();
    // 원자적 상태 교체
    state = { active: true, reason, activatedAt: now, consecutiveErrors: state.consecutiveErrors, manuallyTriggered: manual };

    logger.error(`🛑 KILL SWITCH 발동${manual ? ' [수동]' : ''}: ${reason}`, { component: 'KILL_SWITCH' });

    // 푸시 알림
    import('../notifications/web-push.js').then(m => m.notifyAlert('🛑 긴급정지 발동', reason)).catch((e) => {
      logger.error(`킬스위치 푸시 알림 실패: ${e}`, { component: 'KILL_SWITCH' });
    });

    await insertRiskEvent({
      event_type: 'KILL_SWITCH',
      severity: 'CRITICAL',
      details: { reason, activatedAt: now.toISOString(), manual },
      action_taken: '모든 매매 즉시 차단',
    });

    await logSystem('ERROR', 'KILL_SWITCH', `긴급 정지 발동${manual ? ' [수동]' : ''}: ${reason}`);

    // DB 영속화 (재시작 후에도 유지)
    persistKillSwitchToDB(true, reason, manual).catch(() => {});
  } finally {
    updating = false;
  }
}

/**
 * @param force true = 수동 발동이어도 강제 해제 (대시보드 명시적 해제)
 *              false (기본) = 자동 해제 — 수동 발동 중이면 거부
 */
export async function deactivateKillSwitch(force = false): Promise<void> {
  if (!state.active) return;

  if (state.manuallyTriggered && !force) {
    logger.warn(
      `🛡️ Kill Switch 자동 해제 거부: 수동 발동 중 (사유: ${state.reason}) — 대시보드에서 수동 해제 필요`,
      { component: 'KILL_SWITCH' },
    );
    return;
  }

  const prevReason = state.reason;
  // 원자적 상태 교체
  state = { active: false, reason: '', activatedAt: null, consecutiveErrors: 0, manuallyTriggered: false };

  logger.info(`✅ Kill Switch 해제${force ? ' [강제]' : ''}`, { component: 'KILL_SWITCH' });
  await logSystem('INFO', 'KILL_SWITCH', `긴급 정지 해제${force ? ' [강제]' : ''} (사유: ${prevReason})`);

  import('../notifications/web-push.js').then(m =>
    m.notifyAlert(
      force ? '🔓 긴급정지 수동 해제' : '🔓 긴급정지 자동 해제',
      `이전 사유: ${prevReason.slice(0, 80)}\n매매 재개됨`,
    )
  ).catch(() => {});

  // DB 영속화
  persistKillSwitchToDB(false, '', false).catch(() => {});
}

/**
 * 에러 누적 카운터 — 연속 에러 시 자동 Kill Switch
 * 네트워크 일시적 에러와 로직 에러를 구분
 */
export async function reportError(component: string, error: string): Promise<void> {
  state = { ...state, consecutiveErrors: state.consecutiveErrors + 1 };

  if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    await activateKillSwitch(`연속 에러 ${state.consecutiveErrors}회 (최근: ${component} - ${error})`);
  }
}

export function reportSuccess(): void {
  if (state.consecutiveErrors > 0) {
    state = { ...state, consecutiveErrors: 0 };
  }
}

/** 장 마감 시 에러 카운터 리셋 (다음 날 깨끗하게 시작) */
export function resetDailyErrorCount(): void {
  state = { ...state, consecutiveErrors: 0 };
}

// ── DB 영속화 ──────────────────────────────────────────────────────────────

async function persistKillSwitchToDB(active: boolean, reason: string, manual: boolean): Promise<void> {
  try {
    const { getPool } = await import('../db/client.js');
    await getPool().query(
      `INSERT INTO system_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['kill_switch', JSON.stringify({ active, reason, manual, updatedAt: new Date().toISOString() })],
    );
  } catch {
    // system_state 테이블 없으면 무시 (마이그레이션 전)
  }
}

/**
 * 서버 시작 시 DB에서 Kill Switch 상태 복원
 * runner.ts initializeSystem() 에서 호출
 */
export async function initKillSwitchFromDB(): Promise<void> {
  try {
    const { getPool } = await import('../db/client.js');
    const { rows } = await getPool().query(
      `SELECT value FROM system_state WHERE key = 'kill_switch' LIMIT 1`,
    );
    if (!rows[0]) return;

    const saved = JSON.parse(rows[0].value) as { active?: boolean; reason?: string; manual?: boolean };
    if (saved.active) {
      state = {
        active: true,
        reason: saved.reason ?? '재시작 복원',
        activatedAt: new Date(),
        consecutiveErrors: 0,
        manuallyTriggered: saved.manual ?? false,
      };
      logger.warn(
        `🛑 [시작] Kill Switch 복원: ${state.reason}${state.manuallyTriggered ? ' [수동]' : ''}`,
        { component: 'KILL_SWITCH' },
      );
    }
  } catch {
    // system_state 테이블 없으면 무시
  }
}
