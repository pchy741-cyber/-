import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { dashboardRoutes } from './api/routes/dashboard.js';
// API Routes
import { authRoutes } from './api/routes/auth.js';
import { healthRoutes } from './api/routes/health.js';
import { overseasRoutes } from './api/routes/overseas.js';
import { secretsRoutes } from './api/routes/secrets.js';
import { settingsRoutes } from './api/routes/settings.js';
import { sseRoutes } from './api/routes/sse.js';
import { backtestRoutes } from './backtest/api.js';
import { requireAuth } from './api/middleware/auth.js';
import { initBigQuery } from './automation/bigquery-pipeline.js';
import { setupMonitoring } from './automation/gcp-monitoring.js';
import { initRedisCache } from './cache/redis.js';
import { config } from './config/index.js';
import { checkDb, enableMemoryMode } from './db/client.js';
import { getAccessToken } from './kis/auth.js';
import { initTelegram } from './notifications/telegram.js';
import { startScheduler } from './scheduler/runner.js';
import { logger } from './utils/logger.js';

// ── Hono App (Express 대비 4x 빠름, TypeScript-first) ──
const app = new Hono();

// ── 미들웨어 ──
app.use('*', secureHeaders());
app.use('*', cors());
app.use('*', honoLogger());

// ── 라우트 마운트 ──
// 인증 불필요 (공개)
app.route('/', healthRoutes);   // /health
app.route('/', authRoutes);     // /auth/login, /auth/logout, /auth/me

// 🔒 이하 모든 라우트: 로그인 필요
app.use('*', requireAuth);
app.route('/', dashboardRoutes);
app.route('/', secretsRoutes);
app.route('/', settingsRoutes);
app.route('/', sseRoutes);
app.route('/', backtestRoutes);
app.route('/', overseasRoutes);

// ── 루트 앱 (프론트엔드 프록시 + API) ──
const rootApp = new Hono();
rootApp.route('/api', app);

// Non-API 요청 → Next.js (localhost:3000)
rootApp.all('*', async (c) => {
  try {
    const url = new URL(c.req.url);
    url.host = 'localhost:3000';
    url.protocol = 'http:';
    // Accept-Encoding 제거해서 Next.js가 plain text로 응답하게 함
    const headers = new Headers(c.req.raw.headers);
    headers.delete('accept-encoding');
    const proxyRes = await fetch(url.toString(), {
      method: c.req.method,
      headers,
    });
    // content-encoding 헤더 제거 (Hono/Cloud Run이 자체 압축 처리)
    const resHeaders = new Headers(proxyRes.headers);
    resHeaders.delete('content-encoding');
    resHeaders.delete('content-length');
    return new Response(proxyRes.body, {
      status: proxyRes.status,
      headers: resHeaders,
    });
  } catch {
    return c.text('Frontend loading...', 503);
  }
});

// ── 서버 시작 ──
const PORT = Number(process.env.PORT ?? 8080);

async function bootstrap() {
  logger.info('========================================');
  logger.info('  👑 QUANTOPS v0.2.0 시작');
  logger.info(`  모드: ${config.tradingMode.toUpperCase()}`);
  logger.info(`  환경: ${config.env}`);
  logger.info(`  프레임워크: Hono (고성능)`);
  logger.info('========================================');

  // 1. PostgreSQL 연결 확인
  try {
    const ok = await checkDb();
    if (!ok) throw new Error('DB health check failed');
    logger.info('✅ PostgreSQL 연결 성공', { component: 'BOOT' });
    // 1-1. 스키마 마이그레이션 (무중단 ALTER TABLE)
    try {
      const { getPool } = await import('./db/client.js');
      await getPool().query(`ALTER TABLE transaction_chains ADD COLUMN IF NOT EXISTS peak_price NUMERIC`).catch(() => {});
      await getPool().query(`ALTER TABLE orders ALTER COLUMN kis_order_no TYPE VARCHAR(100)`);
      logger.info('✅ DB 마이그레이션: kis_order_no VARCHAR(100)', { component: 'BOOT' });
    } catch (e: any) {
      // 이미 적용된 경우 무시
      if (!e.message?.includes('already')) logger.warn(`DB 마이그레이션 경고: ${e.message}`, { component: 'BOOT' });
    }
    // buy_threshold 보정: SWING 65, DEFENSE 85 (과거 보수적 값 75 자동 수정)
    try {
      const { getPool } = await import('./db/client.js');
      await getPool().query(
        `UPDATE strategy_config SET buy_threshold = 65 WHERE is_active = true AND mode = 'SWING' AND buy_threshold > 65`,
      );
      logger.info('✅ buy_threshold 보정: SWING 65점으로 완화', { component: 'BOOT' });
    } catch (e: any) {
      logger.warn(`buy_threshold 보정 실패: ${e.message}`, { component: 'BOOT' });
    }
    // 익절/손절 목표 동기화: STRATEGY_PARAMS 기본값으로 업데이트 (DB 구버전 덮어쓰기)
    try {
      const { getPool: gp } = await import('./db/client.js');
      const { STRATEGY_PARAMS } = await import('./config/constants.js');
      const { rows: sr } = await gp().query(`SELECT mode FROM strategy_config WHERE is_active = true LIMIT 1`);
      const activeMode = (sr[0]?.mode ?? 'SWING') as keyof typeof STRATEGY_PARAMS;
      const sp = STRATEGY_PARAMS[activeMode] ?? STRATEGY_PARAMS.SWING;
      await gp().query(
        `UPDATE strategy_config SET take_profit_pct=$1, stop_loss_pct=$2 WHERE is_active = true`,
        [sp.takeProfitPct, sp.stopLossPct],
      );
      logger.info(`✅ 익절/손절 동기화: take_profit=${sp.takeProfitPct}% stop_loss=${sp.stopLossPct}%`, { component: 'BOOT' });
    } catch (e: any) {
      logger.warn(`익절/손절 동기화 실패: ${e.message}`, { component: 'BOOT' });
    }
    // score_accuracy 테이블 자동 생성 (마이그레이션 010)
    try {
      const { getPool: gp } = await import('./db/client.js');
      await gp().query(`
        CREATE TABLE IF NOT EXISTS score_accuracy (
          id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          stock_code       VARCHAR(20) NOT NULL,
          chain_id         UUID,
          entry_score      SMALLINT,
          entry_signal     VARCHAR(20),
          entry_confidence DECIMAL(4,3),
          realized_pnl_pct DECIMAL(8,4),
          outcome          VARCHAR(10) NOT NULL DEFAULT 'BREAK_EVEN',
          holding_days     SMALLINT,
          close_reason     TEXT,
          strategy_mode    VARCHAR(15),
          recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_score_accuracy_stock ON score_accuracy(stock_code);
        CREATE INDEX IF NOT EXISTS idx_score_accuracy_recorded ON score_accuracy(recorded_at DESC);
      `);
      logger.info('✅ score_accuracy 테이블 준비 완료', { component: 'BOOT' });
    } catch (e: any) {
      logger.warn(`score_accuracy 테이블 생성 경고: ${e.message}`, { component: 'BOOT' });
    }
  } catch (err) {
    logger.warn(`⚠️ PostgreSQL 미연결: ${err}`, { component: 'BOOT' });
    enableMemoryMode();
    logger.info('📦 인메모리 DB 모드로 전환 (감시목록 7종목 자동 로드)', { component: 'BOOT' });
  }

  // 2. Redis 캐시 초기화
  try {
    await initRedisCache();
    logger.info('✅ Upstash Redis 캐시 연결', { component: 'BOOT' });
  } catch (err) {
    logger.warn(`⚠️ Redis 미연결 (DB fallback): ${err}`, { component: 'BOOT' });
  }

  // 2.5. Secret Manager에서 API 키 로드 (KIS 토큰 발급 전에 실행)
  try {
    const { loadSecretsToEnv } = await import('./api/routes/secrets.js');
    await loadSecretsToEnv();
  } catch (err) {
    logger.warn(`Secret Manager 로드 실패 (환경변수 fallback): ${err}`, { component: 'BOOT' });
  }

  // 3. KIS 토큰 발급
  try {
    await getAccessToken();
    logger.info('✅ KIS 토큰 발급 성공', { component: 'BOOT' });
  } catch (err) {
    logger.error(`❌ KIS 토큰 발급 실패: ${err}`, { component: 'BOOT' });
  }

  // 4. 텔레그램 봇 시작
  try {
    initTelegram();
  } catch (err) {
    logger.warn(`⚠️ Telegram 초기화 실패: ${err}`, { component: 'BOOT' });
  }

  // 5. GCP 서비스 초기화 (Monitoring + BigQuery)
  try {
    setupMonitoring();
    logger.info('✅ Cloud Monitoring 연결', { component: 'BOOT' });
  } catch (err) {
    logger.warn(`⚠️ Monitoring 초기화 실패: ${err}`, { component: 'BOOT' });
  }

  try {
    await initBigQuery();
    logger.info('✅ BigQuery 파이프라인 연결', { component: 'BOOT' });
  } catch (err) {
    logger.warn(`⚠️ BigQuery 초기화 실패: ${err}`, { component: 'BOOT' });
  }

  // 5.6. 감시목록 종목명 보정 (하드코딩 우선 → KIS API fallback)
  try {
    const { getPool, getActiveWatchlist } = await import('./db/client.js');
    const { getCurrentPrice } = await import('./kis/market.js');
    const NAME_MAP: Record<string, string> = {
      '005930': '삼성전자', '000660': 'SK하이닉스', '373220': 'LG에너지솔루션',
      '005380': '현대자동차', '009540': 'HD한국조선해양', '035420': 'NAVER',
      '035720': '카카오', '006400': '삼성SDI', '051910': 'LG화학',
      '003670': '포스코퓨처엠', '336260': '두산로보틱스', '012450': '한화에어로스페이스',
      '267260': 'HD현대일렉트릭', '042700': '한미반도체', '068270': '셀트리온',
    };
    const wl = await getActiveWatchlist();
    for (const item of wl) {
      const known = NAME_MAP[item.stock_code];
      const needsFix = !item.stock_name || item.stock_name === item.stock_code
        || /^\d{6}$/.test(item.stock_name) || /[^\w\sㄱ-ㅎ가-힣().-]/.test(item.stock_name);
      if (needsFix) {
        let name = known;
        if (!name) {
          try { const q = await getCurrentPrice(item.stock_code); name = q.stockName?.trim(); } catch { /* skip */ }
        }
        if (name) {
          await getPool().query('UPDATE watchlist SET stock_name = $1 WHERE stock_code = $2', [name, item.stock_code]);
          logger.info(`종목명 보정: ${item.stock_code} → ${name}`, { component: 'BOOT' });
        }
      }
    }
  } catch { /* skip */ }

  // 6. 스케줄러 시작
  startScheduler();

  // 6-1. 오늘 AI 점수가 없으면 즉시 Track A 실행 (재배포 후 점수 공백 자동 복구)
  try {
    const { getActiveWatchlist, getLatestScores } = await import('./db/client.js');
    const wl = await getActiveWatchlist();
    const codes = wl.map((w: any) => w.stock_code).slice(0, 5);
    if (codes.length > 0) {
      const scores = await getLatestScores(codes);
      const today = new Date().toISOString().split('T')[0];
      const hasTodayScore = scores.some((s: any) => s.score_date === today && (s.composite_score ?? 0) > 0);
      if (!hasTodayScore) {
        logger.info('🔄 오늘 AI 점수 없음 → Track A 자동 실행', { component: 'BOOT' });
        const { runTrackAJob } = await import('./scheduler/track-a-job.js');
        runTrackAJob().catch((e: Error) => logger.error(`부팅 Track A 실패: ${e.message}`, { component: 'BOOT' }));
      } else {
        logger.info('✅ 오늘 AI 점수 존재 — Track A 스킵', { component: 'BOOT' });
      }
    }
  } catch (e: any) {
    logger.warn(`부팅 Track A 체크 실패: ${e.message}`, { component: 'BOOT' });
  }

  // 6. Hono 서버 시작
  serve({ fetch: rootApp.fetch, port: PORT }, () => {
    logger.info(`🚀 Hono 서버 시작: http://localhost:${PORT}`, { component: 'BOOT' });
    logger.info(`📋 헬스: http://localhost:${PORT}/api/health`, { component: 'BOOT' });
    logger.info(`📡 SSE: http://localhost:${PORT}/api/stream`, { component: 'BOOT' });
  });

  if (config.isPaper) {
    logger.info('📝 *** 모의투자(Paper Trading) 모드 ***', { component: 'BOOT' });
  }
}

bootstrap().catch((err) => {
  logger.error(`치명적 오류: ${err}`);
  process.exit(1);
});
