import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// ── 환경 변수 스키마 (Zod Validation) ──
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  TRADING_MODE: z.enum(['paper', 'live']).default('paper'),

  // KIS (한국투자증권)
  KIS_APP_KEY: z.string().default(''),
  KIS_APP_SECRET: z.string().default(''),
  KIS_ACCOUNT_NO: z.string().default('00000000-01'),
  KIS_BASE_URL: z.string().default('https://openapivts.koreainvestment.com:29443'),

  // Cloud SQL (PostgreSQL)
  DATABASE_URL: z.string().default(''),
  DB_HOST: z.string().default(''),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string().default('quantops'),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default(''),
  // Cloud Run → Cloud SQL Unix socket (e.g. /cloudsql/project:region:instance)
  INSTANCE_UNIX_SOCKET: z.string().default(''),

  // AI
  GEMINI_API_KEY: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),

  // 리스크 하드 리밋
  RISK_MAX_DAILY_DRAWDOWN_KRW: z.coerce.number().default(500000),
  RISK_MAX_POSITION_KRW: z.coerce.number().default(2000000),
  RISK_MAX_TOTAL_INVESTED_PCT: z.coerce.number().default(80),
  RISK_MAX_CONCURRENT_POSITIONS: z.coerce.number().default(7),
  RISK_MAX_DAILY_TRADES: z.coerce.number().default(20),
});

// ── 파싱 & Export ──
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ 환경 변수 검증 실패:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  tradingMode: env.TRADING_MODE as 'paper' | 'live',
  isPaper: env.TRADING_MODE === 'paper',

  kis: {
    appKey: env.KIS_APP_KEY,
    appSecret: env.KIS_APP_SECRET,
    accountNo: env.KIS_ACCOUNT_NO.split('-')[0],
    accountProductCode: env.KIS_ACCOUNT_NO.split('-')[1] || '01',
    // 모의투자/실거래 URL 자동 분기
    baseUrl:
      env.TRADING_MODE === 'paper'
        ? 'https://openapivts.koreainvestment.com:29443'
        : env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443',
  },

  db: {
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    // Cloud Run에서는 Unix socket으로 연결
    unixSocket: env.INSTANCE_UNIX_SOCKET,
    databaseUrl: env.DATABASE_URL,
  },

  ai: {
    geminiKey: env.GEMINI_API_KEY,
    openaiKey: env.OPENAI_API_KEY,
    anthropicKey: env.ANTHROPIC_API_KEY,
  },

  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
  },

  risk: {
    maxDailyDrawdownKrw: env.RISK_MAX_DAILY_DRAWDOWN_KRW,
    maxPositionKrw: env.RISK_MAX_POSITION_KRW,
    maxTotalInvestedPct: env.RISK_MAX_TOTAL_INVESTED_PCT,
    maxConcurrentPositions: env.RISK_MAX_CONCURRENT_POSITIONS,
    maxDailyTrades: env.RISK_MAX_DAILY_TRADES,
  },
} as const;

export type Config = typeof config;
