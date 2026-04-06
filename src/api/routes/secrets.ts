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
  telegram_token: { secret: 'telegram-bot-token', envVar: 'TELEGRAM_BOT_TOKEN' },
  telegram_chat: { secret: 'telegram-chat-id', envVar: 'TELEGRAM_CHAT_ID' },
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

// GET /api/secrets — 키 존재 여부 확인 (값은 마스킹)
secretsRoutes.get('/secrets', async (c) => {
  const result: Record<string, { exists: boolean; masked: string }> = {};
  for (const [key, { secret }] of Object.entries(KEY_MAP)) {
    const value = await getSecretValue(secret);
    result[key] = {
      exists: !!value,
      masked: value ? `${value.slice(0, 6)}${'*'.repeat(Math.max(0, value.length - 10))}${value.slice(-4)}` : '',
    };
  }
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

  return c.json({ saved, errors, message: `${saved.length}개 키 저장 완료` });
});
