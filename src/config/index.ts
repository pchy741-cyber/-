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

  // Slack
  SLACK_WEBHOOK_URL: z.string().default(''),

  // 리스크 한도 (연구 기반: 10M 기준)
  // • 일일 최대 손실: 총자산 2% = 200,000원 (손실 누적 시 당일 거래 중단)
  // • 종목당 한도: 총자산 15% (pipeline에서 min(maxPositionKrw, assets×15%) 적용 — 자동 스케일)
  // • 최대 동시 포지션: 5종목 (비체계적 리스크 80% 감소 달성)
  // • 총 투자 비중: 최대 75% (25%는 항상 현금/파킹 유지)
  RISK_MAX_DAILY_DRAWDOWN_KRW: z.coerce.number().default(200000),  // 일일 2% = 200,000원
  RISK_MAX_POSITION_KRW: z.coerce.number().default(5000000),       // 종목당 최대 한도 (pipeline에서 총자산 15%와 min 취함 — 자동 스케일)
  RISK_MAX_TOTAL_INVESTED_PCT: z.coerce.number().default(88),       // 최대 88% 투자 (적극 모드)
  RISK_MAX_CONCURRENT_POSITIONS: z.coerce.number().default(8),      // 동시 8종목
  RISK_MAX_DAILY_TRADES: z.coerce.number().default(30),             // 하루 30건 (과매매 방지)
});

// ── 파싱 & Export ──
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ 환경 변수 검증 실패:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

// KIS 설정은 Secret Manager 로드 후 process.env가 갱신되므로 getter로 동적 읽기
function getKisAccountNo() {
  const raw = process.env.KIS_ACCOUNT_NO || env.KIS_ACCOUNT_NO;
  return raw.split('-')[0];
}
function getKisProductCode() {
  const raw = process.env.KIS_ACCOUNT_NO || env.KIS_ACCOUNT_NO;
  return raw.split('-')[1] || '01';
}

export const config = {
  env: env.NODE_ENV,
  tradingMode: env.TRADING_MODE as 'paper' | 'live',
  isPaper: env.TRADING_MODE === 'paper',

  get kis() {
    return {
      appKey: process.env.KIS_APP_KEY || env.KIS_APP_KEY,
      appSecret: process.env.KIS_APP_SECRET || env.KIS_APP_SECRET,
      accountNo: getKisAccountNo(),
      accountProductCode: getKisProductCode(),
      baseUrl:
        env.TRADING_MODE === 'paper'
          ? 'https://openapivts.koreainvestment.com:29443'
          : process.env.KIS_BASE_URL || env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443',
    };
  },

  get ai() {
    return {
      geminiKey: process.env.GEMINI_API_KEY || env.GEMINI_API_KEY,
      openaiKey: process.env.OPENAI_API_KEY || env.OPENAI_API_KEY,
      anthropicKey: process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY,
    };
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

  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
  },

  slack: {
    webhookUrl: env.SLACK_WEBHOOK_URL,
  },

  risk: {
    maxDailyDrawdownKrw: env.RISK_MAX_DAILY_DRAWDOWN_KRW,
    maxPositionKrw: env.RISK_MAX_POSITION_KRW,
    maxTotalInvestedPct: env.RISK_MAX_TOTAL_INVESTED_PCT,
    maxConcurrentPositions: env.RISK_MAX_CONCURRENT_POSITIONS,
    maxDailyTrades: env.RISK_MAX_DAILY_TRADES,
  },
};

export type Config = typeof config;
