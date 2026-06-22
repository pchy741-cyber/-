import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Hono } from 'hono';
import { logger } from '../../utils/logger.js';

const PROJECT_ID = 'quantops-trading';
const client = new SecretManagerServiceClient();

export const secretsRoutes = new Hono();

// 키 이름 매핑 (프론트 key → Secret Manager secret name → env var name)
const KEY_MAP: Record<string, { secret: string; envVar: string }> = {
  gemini: { secret: 'gemini-api-key', envVar: 'GEMINI_API_KEY' },
  openai: { secret: 'openai-api-key', envVar: 'OPENAI_API_KEY' },
  anthropic: { secret: 'anthropic-api-key', envVar: 'ANTHROPIC_API_KEY' },
  kis_appkey: { secret: 'kis-app-key', envVar: 'KIS_APP_KEY' },
  kis_appsecret: { secret: 'kis-app-secret', envVar: 'KIS_APP_SECRET' },
  kis_account: { secret: 'kis-account-no', envVar: 'KIS_ACCOUNT_NO' },
  kis_appkey_live: { secret: 'kis-app-key-live', envVar: 'KIS_APP_KEY_LIVE' },
  kis_appsecret_live: { secret: 'kis-app-secret-live', envVar: 'KIS_APP_SECRET_LIVE' },
  kis_account_live: { secret: 'kis-account-no-live', envVar: 'KIS_ACCOUNT_NO_LIVE' },
  telegram_token: { secret: 'telegram-bot-token', envVar: 'TELEGRAM_BOT_TOKEN' },
  telegram_chat: { secret: 'telegram-chat-id', envVar: 'TELEGRAM_CHAT_ID' },
  dashboard_password: { secret: 'dashboard-password', envVar: 'DASHBOARD_PASSWORD' },
};

async function ensureSecret(secretId: string) {
  const parent = `projects/${PROJECT_ID}`;
  try {
    await client.getSecret({ name: `${parent}/secrets/${secretId}` });
  } catch {
    await client.createSecret({
      parent,
      secretId,
      secret: { replication: { automatic: {} } },
    });
    logger.info(`Secret 생성: ${secretId}`, { component: 'SECRETS' });
  }
}

async function setSecretValue(secretId: string, value: string) {
  await ensureSecret(secretId);
  const parent = `projects/${PROJECT_ID}/secrets/${secretId}`;
  await client.addSecretVersion({
    parent,
    payload: { data: Buffer.from(value) },
  });
}

async function getSecretValue(secretId: string): Promise<string | null> {
  try {
    const name = `projects/${PROJECT_ID}/secrets/${secretId}/versions/latest`;
    const [version] = await client.accessSecretVersion({ name });
    return version.payload?.data?.toString() ?? null;
  } catch {
    return null;
  }
}

/** 부팅 시 Secret Manager → DB 폴백 순서로 키 로드 → 환경변수 반영 */
export async function loadSecretsToEnv(): Promise<void> {
  // 1차: GCP Secret Manager
  for (const [key, { secret, envVar }] of Object.entries(KEY_MAP)) {
    try {
      const value = await getSecretValue(secret);
      if (value && value.length > 3) {
        process.env[envVar] = value;
        logger.info(`Secret 로드 (GCP): ${key}`, { component: 'SECRETS' });
      }
    } catch { /* skip */ }
  }
  // 2차: DB 폴백 (GCP 없는 환경 or 로컬 개발)
  try {
    const { getPool } = await import('../../db/client.js');
    const keys = Object.values(KEY_MAP).map((m) => `secret:${m.envVar}`);
    const { rows } = await getPool().query(
      `SELECT key, value FROM system_state WHERE key = ANY($1)`,
      [keys],
    );
    for (const row of rows) {
      const envVar = (row.key as string).replace('secret:', '');
      if (!process.env[envVar] && row.value && String(row.value).length > 3) {
        process.env[envVar] = String(row.value);
        logger.info(`Secret 로드 (DB 폴백): ${envVar}`, { component: 'SECRETS' });
      }
    }
  } catch { /* DB 폴백 실패 무시 */ }
}

// GET /api/secrets — 키 존재 여부 확인 (값은 마스킹, 30초 캐시)
import { cacheGet, cacheSet } from '../../cache/memory.js';

secretsRoutes.get('/secrets', async (c) => {
  const cached = cacheGet<Record<string, { exists: boolean; masked: string }>>('secrets:status');
  if (cached) return c.json(cached);

  const result: Record<string, { exists: boolean; masked: string }> = {};
  for (const [key, { secret, envVar }] of Object.entries(KEY_MAP)) {
    // 환경변수 먼저 확인 (가장 빠름), 없으면 Secret Manager
    const envVal = process.env[envVar];
    const value = envVal || (await getSecretValue(secret));
    result[key] = {
      exists: !!value,
      masked: value
        ? value.length > 8
          ? `${value.slice(0, 2)}${'*'.repeat(Math.min(value.length - 2, 10))}`
          : '***'
        : '',
    };
  }
  cacheSet('secrets:status', result, 30);
  return c.json(result);
});

// 🔒 보안: KIS 인증정보, 비밀번호, 텔레그램은 API로 변경 불가 (GCP Console만 허용)
const BLOCKED_SECRETS = new Set([
  'kis_appkey',
  'kis_appsecret',
  'kis_account',
  'kis_appkey_live',
  'kis_appsecret_live',
  'kis_account_live',
  'dashboard_password',
  'telegram_token',
  'telegram_chat',
]);

// PUT /api/secrets — AI API 키만 저장 가능 (KIS/비밀번호 차단)
secretsRoutes.put('/secrets', async (c) => {
  const body = await c.req.json<Record<string, string>>();
  const saved: string[] = [];
  const errors: string[] = [];

  for (const [key, value] of Object.entries(body)) {
    if (!value || !KEY_MAP[key]) continue;
    if (BLOCKED_SECRETS.has(key)) {
      logger.warn(`🚨 보안 차단: ${key} 변경 시도 (API 차단됨, GCP Console 사용 필요)`, { component: 'SECURITY' });
      errors.push(`${key}: 보안상 API로 변경 불가 — GCP Secret Manager Console에서 직접 변경하세요`);
      continue;
    }
    // env 먼저 세팅 (GCP 실패해도 이 세션에서 즉시 동작)
    process.env[KEY_MAP[key].envVar] = value;
    // DB 폴백 저장 (재시작 견딤, GCP 없어도)
    try {
      const { getPool } = await import('../../db/client.js');
      await getPool().query(
        `INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [`secret:${KEY_MAP[key].envVar}`, value],
      );
    } catch { /* DB 폴백 실패 무시 */ }
    // GCP Secret Manager (베스트 에포트)
    try {
      await setSecretValue(KEY_MAP[key].secret, value);
      logger.info(`Secret 업데이트: ${key} (GCP+DB)`, { component: 'SECRETS' });
    } catch (err) {
      logger.warn(`GCP Secret 저장 실패 (DB 폴백 사용): ${key} - ${err}`, { component: 'SECRETS' });
    }
    saved.push(key);
  }

  // 캐시 무효화
  if (saved.length > 0) {
    const { memCache } = await import('../../cache/memory.js');
    memCache.delete('secrets:status');
  }

  return c.json({ saved, errors, message: `${saved.length}개 키 저장 완료` });
});
