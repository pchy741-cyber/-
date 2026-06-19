import { getCtxIsPaper } from '../config/context.js';
import { config } from '../config/index.js';
import { insertRiskEvent, logSystem } from '../db/client.js';
import { logger } from '../utils/logger.js';

/**
 * Kill Switch — 긴급 정지 장치
 *
 * 2축 완전 분리:
 *   1) Paper / Live  — 연습모드 킬스위치가 실전 매매를 막지 않음
 *   2) KR / OVERSEAS — 해외 에러가 국내 매매를 차단하지 않음 (그 반대도)
 *
 * 총 4개 독립 상태: paper_kr, paper_overseas, live_kr, live_overseas
 */

export type KillSwitchScope = 'KR' | 'OVERSEAS';

const MDD_GRACE_PERIOD_MS = 10 * 60 * 1000; // 수동 해제 후 10분간 자동 재발동 차단

interface KillSwitchState {
  active: boolean;
  reason: string;
  activatedAt: Date | null;
  consecutiveErrors: number;
  manuallyTriggered: boolean;
  forcedDeactivatedAt: Date | null;
}

const DEFAULT_STATE = (): KillSwitchState => ({
  active: false,
  reason: '',
  activatedAt: null,
  consecutiveErrors: 0,
  manuallyTriggered: false,
  forcedDeactivatedAt: null,
});

// 4개 독립 상태 — paper/live × KR/OVERSEAS
const states: Record<string, KillSwitchState> = {
  paper_kr: DEFAULT_STATE(),
  paper_overseas: DEFAULT_STATE(),
  live_kr: DEFAULT_STATE(),
  live_overseas: DEFAULT_STATE(),
};

const MAX_CONSECUTIVE_ERRORS = 5;
const updatingKeys = new Set<string>(); // 스코프별 동시 발동 방지

function stateKey(scope: KillSwitchScope, isPaperOverride?: boolean): string {
  const mode = isPaperOverride !== undefined ? isPaperOverride : getCtxIsPaper();
  return `${mode ? 'paper' : 'live'}_${scope.toLowerCase()}`;
}

function getState(scope: KillSwitchScope, isPaper?: boolean): KillSwitchState {
  return states[stateKey(scope, isPaper)];
}

function setState(scope: KillSwitchScope, s: KillSwitchState, isPaper?: boolean): void {
  states[stateKey(scope, isPaper)] = s;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function isKillSwitchActive(scope: KillSwitchScope = 'KR', isPaper?: boolean): boolean {
  return getState(scope, isPaper).active;
}

export function getKillSwitchStatus(scope: KillSwitchScope = 'KR') {
  const s = getState(scope);
  return {
    scope,
    active: s.active,
    reason: s.reason,
    activatedAt: s.activatedAt?.toISOString() ?? null,
    consecutiveErrors: s.consecutiveErrors,
    manuallyTriggered: s.manuallyTriggered,
  };
}

/** 대시보드용 — KR/OVERSEAS 양쪽 상태 한번에 조회 */
export function getKillSwitchStatusAll() {
  return {
    kr: getKillSwitchStatus('KR'),
    overseas: getKillSwitchStatus('OVERSEAS'),
  };
}

/**
 * Kill Switch 발동
 * @param manual true = 대시보드/텔레그램 수동 발동 → 자동 해제 불가
 * @param scope 'KR' | 'OVERSEAS' — 어느 시장의 매매를 차단할지
 */
export async function activateKillSwitch(reason: string, manual = false, scope: KillSwitchScope = 'KR'): Promise<void> {
  const key = stateKey(scope);
  const s = getState(scope);
  if (s.active || updatingKeys.has(key)) return;

  // 수동 해제 후 grace period 내 자동 재발동 차단 (MDD re-trigger 방지)
  if (!manual && s.forcedDeactivatedAt) {
    const elapsed = Date.now() - s.forcedDeactivatedAt.getTime();
    if (elapsed < MDD_GRACE_PERIOD_MS) {
      const remainMin = Math.ceil((MDD_GRACE_PERIOD_MS - elapsed) / 60000);
      logger.info(`⏳ Kill Switch 자동 재발동 차단 [${scope}]: 수동 해제 후 grace period ${remainMin}분 남음`, { component: 'KILL_SWITCH' });
      return;
    }
  }
  // 🔒 active=true를 즉시 설정 — 비동기 작업 전에 isKillSwitchActive()가 true 반환하도록
  // 이전: updatingKeys.add() 후 async 작업 중 race window 존재
  const now = new Date();
  setState(scope, {
    active: true,
    reason,
    activatedAt: now,
    consecutiveErrors: s.consecutiveErrors,
    manuallyTriggered: manual,
    forcedDeactivatedAt: null,
  });
  updatingKeys.add(key);

  const isPaper = getCtxIsPaper();
  const mode = isPaper ? 'paper' : 'live';
  const scopeLabel = scope === 'OVERSEAS' ? '해외' : '국내';

  try {

    logger.error(`🛑 KILL SWITCH 발동 [${scopeLabel}]${manual ? ' [수동]' : ''} [${mode}]: ${reason}`, {
      component: 'KILL_SWITCH',
    });

    import('../notifications/web-push.js')
      .then((m) => m.notifyAlert(`🛑 긴급정지 [${scopeLabel}]`, `[${mode}] ${reason}`))
      .catch((e) => {
        logger.error(`킬스위치 푸시 알림 실패: ${e}`, { component: 'KILL_SWITCH' });
      });

    await insertRiskEvent({
      event_type: 'KILL_SWITCH',
      severity: 'CRITICAL',
      details: { reason, activatedAt: now.toISOString(), manual, mode, scope },
      action_taken: `${scopeLabel} 매매 즉시 차단`,
    });

    await logSystem(
      'ERROR',
      'KILL_SWITCH',
      `긴급 정지 발동 [${scopeLabel}]${manual ? ' [수동]' : ''} [${mode}]: ${reason}`,
    );

    await persistKillSwitchToDB(true, reason, manual, isPaper, scope).catch((e) =>
      logger.error(`킬스위치 DB 저장 실패: ${e}`, { component: 'KILL_SWITCH' }),
    );
  } finally {
    updatingKeys.delete(key);
  }
}

/** 수동 발동 시 KR+OVERSEAS 동시 차단 (텔레그램 /kill, 대시보드 긴급정지) */
export async function activateKillSwitchAll(reason: string, manual = false): Promise<void> {
  await Promise.all([activateKillSwitch(reason, manual, 'KR'), activateKillSwitch(reason, manual, 'OVERSEAS')]);
}

/**
 * Kill Switch 해제
 * @param force true = 수동 발동이어도 강제 해제 (대시보드 명시적 해제)
 * @param scope 'KR' | 'OVERSEAS'
 */
export async function deactivateKillSwitch(force = false, scope: KillSwitchScope = 'KR'): Promise<void> {
  const s = getState(scope);
  if (!s.active) return;

  const scopeLabel = scope === 'OVERSEAS' ? '해외' : '국내';

  if (s.manuallyTriggered && !force) {
    logger.warn(
      `🛡️ Kill Switch 자동 해제 거부 [${scopeLabel}]: 수동 발동 중 (사유: ${s.reason}) — 대시보드에서 수동 해제 필요`,
      { component: 'KILL_SWITCH' },
    );
    return;
  }

  const isPaper = getCtxIsPaper();
  const mode = isPaper ? 'paper' : 'live';
  const prevReason = s.reason;

  const newState = DEFAULT_STATE();
  if (force) newState.forcedDeactivatedAt = new Date();
  setState(scope, newState);

  logger.info(`✅ Kill Switch 해제 [${scopeLabel}]${force ? ' [강제]' : ''} [${mode}]`, { component: 'KILL_SWITCH' });
  await logSystem(
    'INFO',
    'KILL_SWITCH',
    `긴급 정지 해제 [${scopeLabel}]${force ? ' [강제]' : ''} [${mode}] (사유: ${prevReason})`,
  );

  import('../notifications/web-push.js')
    .then((m) =>
      m.notifyAlert(
        force ? `🔓 긴급정지 수동 해제 [${scopeLabel}]` : `🔓 긴급정지 자동 해제 [${scopeLabel}]`,
        `[${mode}] 이전 사유: ${prevReason.slice(0, 80)}\n${scopeLabel} 매매 재개됨`,
      ),
    )
    .catch(() => {});

  await persistKillSwitchToDB(false, '', false, isPaper, scope).catch((e) =>
    logger.warn(`킬스위치 해제 DB 저장 실패: ${e}`, { component: 'KILL_SWITCH' }),
  );
}

/** KR+OVERSEAS 동시 해제 (대시보드/텔레그램) */
export async function deactivateKillSwitchAll(force = false): Promise<void> {
  await Promise.all([deactivateKillSwitch(force, 'KR'), deactivateKillSwitch(force, 'OVERSEAS')]);
}

/**
 * 모드 명시적 지정 Kill Switch 해제 — ALS 컨텍스트 없이 호출 가능
 * (스케줄러 08:50 자동 리셋, 설정 API에서 paper+live 동시 처리용)
 */
export async function deactivateKillSwitchForMode(
  force: boolean,
  isPaper: boolean,
  scope: KillSwitchScope = 'KR',
): Promise<void> {
  const sKey = `${isPaper ? 'paper' : 'live'}_${scope.toLowerCase()}`;
  const s = states[sKey];
  if (!s.active) return;
  if (s.manuallyTriggered && !force) {
    logger.warn(
      `🛡️ Kill Switch 자동 해제 거부 [${scope}][${isPaper ? 'paper' : 'live'}]: 수동 발동 중 — 대시보드에서 수동 해제 필요`,
      { component: 'KILL_SWITCH' },
    );
    return;
  }

  const prevReason = s.reason;
  const mode = isPaper ? 'paper' : 'live';
  const scopeLabel = scope === 'OVERSEAS' ? '해외' : '국내';

  // force 해제 시 grace period 기록 — 10분간 자동 재발동 차단
  const newState = DEFAULT_STATE();
  if (force) newState.forcedDeactivatedAt = new Date();
  states[sKey] = newState;

  logger.info(`✅ Kill Switch 해제 [${scopeLabel}]${force ? ' [강제]' : ''} [${mode}]`, { component: 'KILL_SWITCH' });
  await logSystem(
    'INFO',
    'KILL_SWITCH',
    `긴급 정지 해제 [${scopeLabel}]${force ? ' [강제]' : ''} [${mode}] (사유: ${prevReason})`,
  );

  import('../notifications/web-push.js')
    .then((m) =>
      m.notifyAlert(
        force ? `🔓 긴급정지 수동 해제 [${scopeLabel}]` : `🔓 긴급정지 자동 해제 [${scopeLabel}]`,
        `[${mode}] 이전 사유: ${prevReason.slice(0, 80)}\n${scopeLabel} 매매 재개됨`,
      ),
    )
    .catch(() => {});

  await persistKillSwitchToDB(false, '', false, isPaper, scope).catch(() => {});
}

/** 모드 명시적 지정 — 활성 여부 확인 (ALS 컨텍스트 없이 호출 가능) */
export function isKillSwitchActiveForMode(scope: KillSwitchScope, isPaper: boolean): boolean {
  const sKey = `${isPaper ? 'paper' : 'live'}_${scope.toLowerCase()}`;
  return states[sKey].active;
}

/**
 * 에러 누적 카운터 — 연속 에러 시 자동 Kill Switch (스코프별 독립)
 */
export async function reportError(component: string, error: string, scope: KillSwitchScope = 'KR'): Promise<void> {
  const s = getState(scope);
  if (s.active) return; // kill switch already active — 중복 카운트 방지
  setState(scope, { ...s, consecutiveErrors: s.consecutiveErrors + 1 });

  if (getState(scope).consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    await activateKillSwitch(
      `연속 에러 ${getState(scope).consecutiveErrors}회 (최근: ${component} - ${error})`,
      false,
      scope,
    );
  }
}

export function reportSuccess(scope: KillSwitchScope = 'KR'): void {
  const s = getState(scope);
  if (s.consecutiveErrors > 0) {
    setState(scope, { ...s, consecutiveErrors: 0 });
  }
}

/** 장 마감 시 에러 카운터 리셋 */
export function resetDailyErrorCount(scope: KillSwitchScope = 'KR'): void {
  const s = getState(scope);
  setState(scope, { ...s, consecutiveErrors: 0 });
}

// ── DB 영속화 ──────────────────────────────────────────────────────────────

function dbKey(isPaper: boolean, scope: KillSwitchScope): string {
  return `kill_switch_${isPaper ? 'paper' : 'live'}_${scope.toLowerCase()}`;
}

async function persistKillSwitchToDB(
  active: boolean,
  reason: string,
  manual: boolean,
  isPaper: boolean,
  scope: KillSwitchScope,
): Promise<void> {
  try {
    const { getPool } = await import('../db/client.js');
    const key = dbKey(isPaper, scope);
    await getPool().query(
      `INSERT INTO system_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify({ active, reason, manual, scope, updatedAt: new Date().toISOString() })],
    );
  } catch (e) {
    logger.error(`킬스위치 DB 저장 실패 [${scope}/${isPaper ? 'paper' : 'live'}]: ${e}`, { component: 'KILL_SWITCH' });
  }
}

async function loadKillSwitchState(isPaper: boolean, scope: KillSwitchScope): Promise<void> {
  try {
    const { getPool } = await import('../db/client.js');
    const key = dbKey(isPaper, scope);

    const { rows } = await getPool().query(`SELECT value FROM system_state WHERE key = $1 LIMIT 1`, [key]);

    if (!rows[0]) return;

    const saved = JSON.parse(rows[0].value) as { active?: boolean; reason?: string; manual?: boolean };
    if (!saved.active) return;

    // 연습모드 자동 킬스위치는 재시작 시 자동 해제 + DB 기록 삭제
    if (isPaper && !saved.manual) {
      const scopeLabel = scope === 'OVERSEAS' ? '해외' : '국내';
      logger.info(`🔓 [모의][${scopeLabel}] 자동 Kill Switch 재시작 해제`, { component: 'KILL_SWITCH' });
      // DB에서도 삭제하여 다음 재시작 시 불필요한 로드 방지
      try {
        const { getPool: getDbPool } = await import('../db/client.js');
        await getDbPool().query(`DELETE FROM system_state WHERE key = $1`, [key]);
      } catch { /* 삭제 실패 시 무시 — 인메모리 상태는 이미 리셋됨 */ }
      return;
    }

    const restoredState: KillSwitchState = {
      active: true,
      reason: saved.reason ?? '재시작 복원',
      activatedAt: new Date(),
      consecutiveErrors: 0,
      manuallyTriggered: saved.manual ?? false,
      forcedDeactivatedAt: null,
    };

    const sKey = `${isPaper ? 'paper' : 'live'}_${scope.toLowerCase()}`;
    states[sKey] = restoredState;

    const scopeLabel = scope === 'OVERSEAS' ? '해외' : '국내';
    logger.warn(
      `🛑 [시작][${isPaper ? 'paper' : 'live'}][${scopeLabel}] Kill Switch 복원: ${restoredState.reason}${restoredState.manuallyTriggered ? ' [수동]' : ''}`,
      { component: 'KILL_SWITCH' },
    );
  } catch {
    // system_state 테이블 없으면 무시
  }
}

/** 레거시 킬스위치 키 정리 (스플릿 이전 형식 → 삭제) */
async function cleanupLegacyKeys(): Promise<void> {
  try {
    const { getPool } = await import('../db/client.js');
    const legacyKeys = ['kill_switch', 'kill_switch_paper', 'kill_switch_live'];
    const { rowCount } = await getPool().query(`DELETE FROM system_state WHERE key = ANY($1)`, [legacyKeys]);
    if ((rowCount ?? 0) > 0) {
      logger.info(`🧹 레거시 킬스위치 키 ${rowCount}개 정리 완료`, { component: 'KILL_SWITCH' });
    }
  } catch {
    // 무시
  }
}

/**
 * 서버 시작 시 DB에서 Kill Switch 상태 복원
 * — 현재 모드(paper/live)의 상태만 복원 (스플릿 서버 병행운영 대응)
 * — 다른 모드의 상태는 다른 서버가 관리하므로 로드하지 않음
 */
export async function initKillSwitchFromDB(): Promise<void> {
  const isPaper = getCtxIsPaper();
  const modeLabel = isPaper ? 'PAPER' : 'LIVE';
  logger.info(`🔄 Kill Switch 복원 시작 [${modeLabel} 모드만]`, { component: 'KILL_SWITCH' });

  await Promise.all([loadKillSwitchState(isPaper, 'KR'), loadKillSwitchState(isPaper, 'OVERSEAS')]);

  // 레거시 키 정리 (구 kill_switch, kill_switch_paper, kill_switch_live → 삭제)
  cleanupLegacyKeys().catch(() => {});
}
