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

/** 부팅 시 Secret Manager에서 키 로드 → 환경변수 반영 (배포 후 키 유실 방지) */
export async function loadSecretsToEnv(): Promise<void> {
  for (const [key, { secret, envVar }] of Object.entries(KEY_MAP)) {
    try {
      const value = await getSecretValue(secret);
      if (value && value.length > 3) {
        process.env[envVar] = value;
        logger.info(`Secret 로드: ${key} (${envVar})`, { component: 'SECRETS' });
      }
    } catch { /* skip */ }
  }
}

// GET /api/secrets — 키 존재 여부 확인 (값은 마스킹, 30초 캐시)
import { cacheGet, cacheSet } from '../../cache/memory.js';

secretsRoutes.get('/secrets', async (c) => {
  const cached = cacheGet<any>('secrets:status');
  if (cached) return c.json(cached);

  const result: Record<string, { exists: boolean; masked: string }> = {};
  for (const [key, { secret, envVar }] of Object.entries(KEY_MAP)) {
    // 환경변수 먼저 확인 (가장 빠름), 없으면 Secret Manager
    const envVal = process.env[envVar];
    const value = envVal || await getSecretValue(secret);
    result[key] = {
      exists: !!value,
      masked: value ? (value.length > 8 ? `${value.slice(0, 4)}***${value.slice(-4)}` : '***') : '',
    };
  }
  cacheSet('secrets:status', result, 30);
  return c.json(result);
});

// PUT /api/secrets — 키 저장 + 환경변수 반영
secretsRoutes.put('/secrets', async (c) => {
  const body = await c.req.json<Record<string, string>>();
  const saved: string[] = [];
  const errors: string[] = [];

  for (const [key, value] of Object.entries(body)) {
    if (!value || !KEY_MAP[key]) continue;
    try {
      await setSecretValue(KEY_MAP[key].secret, value);
      // 현재 프로세스에도 즉시 반영
      process.env[KEY_MAP[key].envVar] = value;
      saved.push(key);
      logger.info(`Secret 업데이트: ${key}`, { component: 'SECRETS' });
    } catch (err) {
      errors.push(`${key}: ${err}`);
      logger.error(`Secret 저장 실패: ${key} - ${err}`, { component: 'SECRETS' });
    }
  }

  // 캐시 무효화
  if (saved.length > 0) {
    const { memCache } = await import('../../cache/memory.js');
    memCache.delete('secrets:status');
  }

  return c.json({ saved, errors, message: `${saved.length}개 키 저장 완료` });
});
