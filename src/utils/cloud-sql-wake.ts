/**
 * Cloud SQL 자동 기상/수면 — 비용 최적화 + 온디맨드 접근
 *
 * 문제: Cloud SQL NEVER 정책 → 폰 접속 시 DB 없어서 데이터 안 잡힘
 * 해결: Cloud Run 부팅 시 DB 자동 켜기 + 30분 미사용 시 자동 끄기
 *
 * Cloud Run 서비스 계정에 `Cloud SQL Admin` 역할 필요
 */
import { logger } from './logger.js';
import { getKSTNow } from './time.js';

const PROJECT = process.env.GCP_PROJECT ?? 'quantops-trading';
const INSTANCE = process.env.CLOUD_SQL_INSTANCE ?? 'quantops-db';

let _lastActivityAt = Date.now();
let _idleTimer: ReturnType<typeof setInterval> | null = null;
let _waking = false;
let _lastWakeAttemptAt = 0;
const WAKE_COOLDOWN_MS = 5 * 60_000; // wake 재시도 최소 간격 5분

/** GCP 메타데이터 서버에서 액세스 토큰 조회 (Cloud Run 전용) */
async function getAccessToken(): Promise<string | null> {
  try {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  } catch {
    // 로컬 개발 환경에선 메타데이터 서버 없음 → null
    return null;
  }
}

/** Cloud SQL 인스턴스 활성화 정책 조회 — ALWAYS=실행중, NEVER=중지됨 */
async function getActivationPolicy(token: string): Promise<string> {
  const res = await fetch(`https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances/${INSTANCE}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`SQL Admin API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { state: string; settings?: { activationPolicy?: string } };
  // state는 인프라 존재 여부 (RUNNABLE=존재). activationPolicy가 실제 실행 상태
  return data.settings?.activationPolicy ?? 'UNKNOWN';
}

/** Cloud SQL 인스턴스 시작 (activationPolicy → ALWAYS), 409 시 재시도 */
async function startInstance(token: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances/${INSTANCE}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { activationPolicy: 'ALWAYS' } }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return;
    const text = await res.text();
    // 409 = DB가 아직 전환 중 (STOP→START 또는 MAINTENANCE) — 대기 후 재시도
    if (res.status === 409 && attempt < 3) {
      logger.warn(`☁️ Cloud SQL 시작 409 (전환 중) — ${attempt}/3 재시도 (30초 대기)`, { component: 'SQL_WAKE' });
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    throw new Error(`시작 실패 ${res.status}: ${text}`);
  }
}

/** Cloud SQL 인스턴스 중지 (activationPolicy → NEVER) */
async function stopInstance(token: string): Promise<void> {
  const res = await fetch(`https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances/${INSTANCE}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { activationPolicy: 'NEVER' } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`중지 실패 ${res.status}: ${await res.text()}`);
}

/**
 * DB가 꺼져있으면 자동으로 켠다 (부팅 시 1회 호출)
 * - Cloud Run 환경에서만 동작 (로컬은 스킵)
 * - 이미 RUNNABLE이면 아무것도 안 함
 */
export async function wakeCloudSqlIfNeeded(): Promise<void> {
  if (_waking) return;
  _waking = true;
  _lastWakeAttemptAt = Date.now();

  try {
    logger.info(`☁️ Cloud SQL 자동기상 시도 (${PROJECT}/${INSTANCE})`, { component: 'SQL_WAKE' });

    const token = await getAccessToken();
    if (!token) {
      logger.info('☁️ Cloud SQL 자동기상: 메타데이터 토큰 없음 (로컬 환경) → 스킵', { component: 'SQL_WAKE' });
      return;
    }
    logger.info('☁️ GCP 토큰 획득 성공', { component: 'SQL_WAKE' });

    const policy = await getActivationPolicy(token);
    logger.info(`☁️ Cloud SQL activationPolicy: ${policy}`, { component: 'SQL_WAKE' });

    if (policy === 'ALWAYS') {
      logger.info('☁️ Cloud SQL 이미 ALWAYS → 기상 불필요', { component: 'SQL_WAKE' });
      return;
    }

    logger.info(`☁️ Cloud SQL NEVER → ALWAYS 전환 (자동 기상)...`, { component: 'SQL_WAKE' });
    await startInstance(token);
    logger.info('☁️ Cloud SQL 기상 명령 전송 완료 (2~3분 후 연결 가능)', { component: 'SQL_WAKE' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`☁️ Cloud SQL 자동기상 실패: ${msg}`, { component: 'SQL_WAKE' });
  } finally {
    _waking = false;
  }
}

/**
 * Recovery interval에서 호출 — DB 연결 실패 시 wake 재시도
 * 쿨다운 5분 적용 (API 스팸 방지)
 */
export async function tryWakeIfNeeded(): Promise<void> {
  const now = Date.now();
  if (now - _lastWakeAttemptAt < WAKE_COOLDOWN_MS) return;
  await wakeCloudSqlIfNeeded();
}

/** Cloud SQL 기상 중인지 확인 */
export function isWaking(): boolean {
  return _waking;
}

/** 한국 장중 여부 확인 — 평일 KST 09:00~15:30 */
export function isInMarketHours(): boolean {
  const kst = getKSTNow();
  const day = kst.getUTCDay(); // 0=Sun,6=Sat
  if (day === 0 || day === 6) return false;
  const t = kst.getUTCHours() * 100 + kst.getUTCMinutes();
  return t >= 900 && t <= 1530;
}

/** API 요청 시 호출 — 활동 시간 갱신 */
export function touchActivity(): void {
  _lastActivityAt = Date.now();
}

/**
 * 유휴 감시 — 장중(09:00~15:30) 30초마다 활동 갱신 → DB 헬스워처 활성 유지
 * 장외시간은 no-op (DB 헬스워처 절전 존중)
 */
export function startIdleWatcher(): void {
  if (_idleTimer) return;
  _idleTimer = setInterval(() => {
    if (isInMarketHours()) touchActivity(); // 장중에만 활동 갱신 (DB 연결 keepalive)
  }, 30_000);
}

// ── DB 헬스 워처 — 부팅 후에도 DB 끊기면 자동 기상 + 재연결 ──
let _healthTimer: ReturnType<typeof setInterval> | null = null;

/**
 * DB 헬스 워처 시작 — 2분마다 DB 연결 확인, 실패 시 wake + reconnect
 * 부팅 시 DB 연결 성공한 경우에도 동작 (idle watcher가 DB 끈 후 복구용)
 */
export function startDbHealthWatcher(checkDb: () => Promise<boolean>, onReconnect: () => Promise<void>): void {
  if (_healthTimer) return;

  _healthTimer = setInterval(async () => {
    // 주말 가드: 최근 15분 이내 활동 있으면 주말에도 DB 복구 시도 (사용자 접속 중)
    const kstH = getKSTNow();
    const d = kstH.getUTCDay(),
      hh = kstH.getUTCHours();
    const isWeekendOff = d === 0 || (d === 6 && hh >= 9) || (d === 1 && hh < 6);
    const recentActivity = Date.now() - _lastActivityAt < 15 * 60_000; // 15분 이내 활동
    if (isWeekendOff && !recentActivity) return; // 주말 동면 중 + 사용자 비활성 → 복구 스킵

    try {
      const ok = await checkDb();
      if (ok) return; // DB 정상
    } catch {
      /* connection failed */
    }

    // DB 연결 실패 — 즉시 메모리 모드 전환 (대시보드 8초 타임아웃 방지)
    try {
      const { enableMemoryMode, isMemoryMode } = await import('../db/client.js');
      if (!isMemoryMode()) enableMemoryMode();
    } catch {
      /* ignore */
    }

    // pool 리셋 + wake 시도 (쿨다운 적용)
    logger.warn('🔌 DB 연결 끊김 감지 → pool 리셋 + 자동 복구 시도', { component: 'SQL_WAKE' });
    try {
      const { resetPool } = await import('../db/client.js');
      await resetPool();
    } catch {
      /* ignore */
    }
    try {
      await tryWakeIfNeeded();
    } catch {
      /* ignore */
    }

    // wake 후 잠시 대기 → 재연결 시도
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const ok2 = await checkDb();
      if (ok2) {
        logger.info('🔌 DB 자동 복구 성공', { component: 'SQL_WAKE' });
        try {
          const { disableMemoryMode } = await import('../db/client.js');
          disableMemoryMode();
        } catch {
          /* ignore */
        }
        await onReconnect();
      }
    } catch {
      /* 다음 주기에 재시도 */
    }
  }, 30_000); // 30초마다 체크 (Cloud SQL 기상 2~3분, 빠른 감지 필요)
}

// ── Cloud Run 자동 스케일링 — 주말 min=0, 평일 min=1 ──
const CR_SERVICE = process.env.K_SERVICE ?? 'ai-auto-bot';
const CR_REGION = 'asia-northeast3';

/**
 * Cloud Run min-instances 변경 (Cloud Run Admin API v2)
 * 서비스 계정에 `Cloud Run Developer` 또는 `Cloud Run Admin` 역할 필요
 */
async function setCloudRunMinInstances(min: number): Promise<void> {
  const token = await getAccessToken();
  if (!token) return; // 로컬 환경

  const baseUrl = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${CR_REGION}/services/${CR_SERVICE}`;

  // 1. 현재 설정 조회 (변경 필요 여부 확인)
  const getRes = await fetch(baseUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!getRes.ok) throw new Error(`Cloud Run GET ${getRes.status}: ${await getRes.text()}`);
  const svc = (await getRes.json()) as Record<string, unknown>;
  const template = (svc.template ?? {}) as Record<string, unknown>;
  const scaling = (template.scaling ?? {}) as Record<string, unknown>;
  const current = scaling.minInstanceCount ?? 1;
  if (current === min) {
    logger.info(`🚀 Cloud Run min-instances 이미 ${min} → 변경 불필요`, { component: 'CR_SCALE' });
    return;
  }

  // 2. updateMask로 변경할 필드만 PATCH (read-only 필드 충돌 방지)
  const patchUrl = `${baseUrl}?updateMask=template.scaling.minInstanceCount`;
  const patchRes = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: { scaling: { minInstanceCount: min } },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!patchRes.ok) throw new Error(`Cloud Run PATCH ${patchRes.status}: ${await patchRes.text()}`);
  logger.info(`🚀 Cloud Run min-instances: ${current} → ${min}`, { component: 'CR_SCALE' });
}

/**
 * 주말 절전 — Cloud Run min=0만 수행 (Cloud SQL은 항상 ALWAYS 유지)
 * DB 중지 시 재기동 2~3분 delay + 상태 꼬임 문제로 비활성화
 */
export async function weekendHibernate(): Promise<void> {
  if (isInMarketHours()) {
    logger.warn('🌙 주말 절전 거부 — 장중 보호 중 (09:00~15:30 평일)', { component: 'HIBERNATE' });
    return;
  }
  logger.info('🌙 주말 절전 — Cloud Run min=0 (Cloud SQL은 ALWAYS 유지)', { component: 'HIBERNATE' });

  try {
    await setCloudRunMinInstances(0);
    logger.info('🌙 Cloud Run min=0 완료', { component: 'HIBERNATE' });
  } catch (e) {
    logger.warn(`🚀 Cloud Run min=0 실패: ${e}`, { component: 'HIBERNATE' });
  }
}

/**
 * 월요일 기상 — Cloud Run min=1 복원 (Cloud SQL은 wakeCloudSqlIfNeeded에서 처리)
 * 부팅 시 또는 월요일 06:00 cron에서 호출
 */
export async function weekdayWakeUp(): Promise<void> {
  logger.info('☀️ 평일 기상 — Cloud Run min=1 복원', { component: 'HIBERNATE' });
  try {
    await setCloudRunMinInstances(1);
  } catch (e) {
    logger.warn(`☀️ Cloud Run min=1 복원 실패: ${e}`, { component: 'HIBERNATE' });
  }
}

/** 정리 (shutdown 시) */
export function stopIdleWatcher(): void {
  if (_idleTimer) {
    clearInterval(_idleTimer);
    _idleTimer = null;
  }
  if (_healthTimer) {
    clearInterval(_healthTimer);
    _healthTimer = null;
  }
}
