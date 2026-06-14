import dotenv from 'dotenv';
import { z } from 'zod';
import { getCtxIsPaper, hasCtx } from './context.js';

dotenv.config();

// ── 환경 변수 스키마 (Zod Validation) ──
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  TRADING_MODE: z.enum(['paper', 'live']).default('paper'),
  PAPER_ONLY: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1')
    .pipe(z.boolean()), // true → live 파이프라인 완전 스킵 (자율학습 모드)

  // KIS (한국투자증권) — 모의투자
  KIS_APP_KEY: z.string().default(''),
  KIS_APP_SECRET: z.string().default(''),
  KIS_ACCOUNT_NO: z.string().default('00000000-01'),
  KIS_BASE_URL: z.string().default('https://openapivts.koreainvestment.com:29443'),
  // KIS 실거래 전용 자격증명 (없으면 모의투자 자격증명 사용)
  KIS_APP_KEY_LIVE: z.string().default(''),
  KIS_APP_SECRET_LIVE: z.string().default(''),
  KIS_ACCOUNT_NO_LIVE: z.string().default(''),

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

  // DART Open API (공시 모니터링, 선택)
  DART_API_KEY: z.string().default(''),

  // Finnhub (US 어닝 캘린더, 선택)
  FINNHUB_API_KEY: z.string().default(''),

  // 리스크 한도
  // • 일일 최대 손실: Live 2.5% / Paper 30% (seed-capital.ts, 킬스위치 기준)
  // • 종목당 한도: 총자산 8~25% 동적 (position-sizer/pipeline에서 자동 스케일, Hard Cap 25%)
  // • 최대 동시 포지션: 8종목
  // • 총 투자 비중: 최대 88% (적극 모드)
  RISK_MAX_DAILY_DRAWDOWN_KRW: z.coerce.number().default(200000), // 레거시 절대값 (실제 한도는 seed-capital.ts 30% 사용)
  RISK_MAX_POSITION_KRW: z.coerce.number().default(50000000), // 종목당 절대 안전 상한 (실제 사이징은 totalAssets×20~25% 동적 계산)
  RISK_MAX_TOTAL_INVESTED_PCT: z.coerce.number().default(88), // 최대 88% 투자 (적극 모드)
  RISK_MAX_CONCURRENT_POSITIONS: z.coerce.number().default(8), // 동시 8종목
  RISK_MAX_DAILY_TRADES: z.coerce.number().default(3), // v4: 15→3건 (과잉거래 방지, 고품질 신호만)
});

// ── 파싱 & Export ──
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ 환경 변수 검증 실패:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

// ── 거래 모드 런타임 오버라이드 (DB 기반, 재시작 없이 전환) ──
let _tradingModeOverride: 'paper' | 'live' | null = null;

export function setTradingModeOverride(mode: 'paper' | 'live' | null) {
  _tradingModeOverride = mode;
}

export function getEffectiveTradingMode(): 'paper' | 'live' {
  // AsyncLocalStorage 컨텍스트 우선 (scheduler dual-run, HTTP 미들웨어)
  if (hasCtx()) return getCtxIsPaper() ? 'paper' : 'live';
  // settings 엔드포인트 런타임 전환 (전역 지속 변경)
  return _tradingModeOverride ?? env.TRADING_MODE;
}

/**
 * 서버 기본 거래모드 — 런타임 오버라이드 불가 (env 기준)
 * API 레이어에서 사용: runOverseasDual() 중에도 오염되지 않는 stable fallback
 */
export const baseTradingMode: 'paper' | 'live' = env.TRADING_MODE;
// PAPER_ONLY=true → 대시보드/API 기본 뷰도 paper (live 잔고 혼동 방지)
export const baseIsPaper: boolean = env.PAPER_ONLY || env.TRADING_MODE === 'paper';

/** 자율학습 모드: true면 live 파이프라인 완전 스킵 (paper만 실행) */
export const paperOnly: boolean = env.PAPER_ONLY;

// KIS 설정은 Secret Manager 로드 후 process.env가 갱신되므로 getter로 동적 읽기
function getKisAccountNo(isLive: boolean) {
  if (isLive) {
    const live = process.env.KIS_ACCOUNT_NO_LIVE || env.KIS_ACCOUNT_NO_LIVE;
    if (live) return live.split('-')[0];
  }
  const raw = process.env.KIS_ACCOUNT_NO || env.KIS_ACCOUNT_NO;
  return raw.split('-')[0];
}
function getKisProductCode(isLive: boolean) {
  if (isLive) {
    const live = process.env.KIS_ACCOUNT_NO_LIVE || env.KIS_ACCOUNT_NO_LIVE;
    if (live) return live.split('-')[1] || '01';
  }
  const raw = process.env.KIS_ACCOUNT_NO || env.KIS_ACCOUNT_NO;
  return raw.split('-')[1] || '01';
}

export const config = {
  env: env.NODE_ENV,
  get tradingMode() {
    return getEffectiveTradingMode();
  },
  get isPaper() {
    return getEffectiveTradingMode() === 'paper';
  },

  get kis() {
    const isLive = getEffectiveTradingMode() === 'live';
    const appKey = isLive
      ? process.env.KIS_APP_KEY_LIVE || env.KIS_APP_KEY_LIVE || process.env.KIS_APP_KEY || env.KIS_APP_KEY
      : process.env.KIS_APP_KEY || env.KIS_APP_KEY;
    const appSecret = isLive
      ? process.env.KIS_APP_SECRET_LIVE || env.KIS_APP_SECRET_LIVE || process.env.KIS_APP_SECRET || env.KIS_APP_SECRET
      : process.env.KIS_APP_SECRET || env.KIS_APP_SECRET;
    return {
      appKey,
      appSecret,
      accountNo: getKisAccountNo(isLive),
      accountProductCode: getKisProductCode(isLive),
      baseUrl: isLive ? 'https://openapi.koreainvestment.com:9443' : 'https://openapivts.koreainvestment.com:29443',
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

  /**
   * Paper 모드 리스크 오버라이드 — 로그 최대 축적, 승률 학습 가속
   * 연습모드는 모의돈이므로 제한을 최대한 풀어 거래 데이터를 빠르게 쌓는다.
   * 이 데이터가 실전모드 파라미터 최적화의 근거가 된다.
   */
  paperRisk: {
    maxConcurrentPositions: 20, // 8 → 20종목 (다양한 패턴 학습)
    maxDailyTrades: 20, // 3 → 20건 (장중 신호 다 잡기)
    maxTotalInvestedPct: 97, // 88 → 97% (현금 3%만 보유)
    positionCapRatio: 0.4, // 25% → 40% (집중 투자 테스트)
    cashReserveRatio: 0.03, // 20% → 3% (거의 전액 집행)
    buyThresholdOffset: -30, // 65→35점으로 실질 하향 (적극적 매매 — 좋은 점수 종목 대부분 매수)
    sectorMaxPerSector: 5, // 2 → 5종목 (섹터 제한 완화)
    cooldownMultiplier: 0.2, // 쿨다운 80% 단축 (5연패 60분→12분)
    mddLimit: 80, // 60% → 80% (킬스위치 임계값과 통일 — MDD Guard는 paper에서 비활성)
  },

  /** Gemini API 자동 호출 ON/OFF — false면 규칙기반만 사용 (AI 비용 $0) */
  geminiEnabled: (process.env.GEMINI_ENABLED ?? 'false') === 'true',
};

export type Config = typeof config;
