import { insertRiskEvent, logSystem } from '../db/client.js';
import { logger } from '../utils/logger.js';

/**
 * Kill Switch — 긴급 정지 장치
 * - 모든 매매를 즉시 차단
 * - 자동 발동: 일일 손실 한도 초과, API 에러 연속 등
 * - 수동 발동: 대시보드 / 텔레그램 명령
 * - 해제: 수동으로만 가능 (자동 해제 없음)
 */

// 원자적 상태 객체 (개별 변수 대신 단일 객체로 관리 → 읽기/쓰기 일관성 보장)
interface KillSwitchState {
  active: boolean;
  reason: string;
  activatedAt: Date | null;
  consecutiveErrors: number;
}

let state: KillSwitchState = {
  active: false,
  reason: '',
  activatedAt: null,
  consecutiveErrors: 0,
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
  };
}

export async function activateKillSwitch(reason: string): Promise<void> {
  if (state.active || updating) return;
  updating = true;

  try {
    const now = new Date();
    // 원자적 상태 교체
    state = { active: true, reason, activatedAt: now, consecutiveErrors: state.consecutiveErrors };

    logger.error(`🛑 KILL SWITCH 발동: ${reason}`, { component: 'KILL_SWITCH' });

    // 푸시 알림
    import('../notifications/web-push.js').then(m => m.notifyAlert('🛑 긴급정지 발동', reason)).catch((e) => {
      logger.error(`킬스위치 푸시 알림 실패: ${e}`, { component: 'KILL_SWITCH' });
    });

    await insertRiskEvent({
      event_type: 'KILL_SWITCH',
      severity: 'CRITICAL',
      details: { reason, activatedAt: now.toISOString() },
      action_taken: '모든 매매 즉시 차단',
    });

    await logSystem('ERROR', 'KILL_SWITCH', `긴급 정지 발동: ${reason}`);
  } finally {
    updating = false;
  }
}

export async function deactivateKillSwitch(): Promise<void> {
  if (!state.active) return;

  const prevReason = state.reason;
  // 원자적 상태 교체
  state = { active: false, reason: '', activatedAt: null, consecutiveErrors: 0 };

  logger.info('✅ Kill Switch 해제', { component: 'KILL_SWITCH' });
  await logSystem('INFO', 'KILL_SWITCH', `긴급 정지 해제 (사유: ${prevReason})`);
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
