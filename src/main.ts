import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { dashboardRoutes } from './api/routes/dashboard.js';
// API Routes
import { healthRoutes } from './api/routes/health.js';
import { overseasRoutes } from './api/routes/overseas.js';
import { secretsRoutes } from './api/routes/secrets.js';
import { settingsRoutes } from './api/routes/settings.js';
import { sseRoutes } from './api/routes/sse.js';
import { backtestRoutes } from './backtest/api.js';
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
app.route('/', healthRoutes);
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

  // 5.5. 감시목록 종목명 자동 보정 (코드만 있는 경우 KIS API로 이름 조회)
  try {
    const { getPool, getActiveWatchlist } = await import('./db/client.js');
    const { getCurrentPrice } = await import('./kis/market.js');
    const wl = await getActiveWatchlist();
    for (const item of wl) {
      if (!item.stock_name || item.stock_name === item.stock_code || /^\d{6}$/.test(item.stock_name)) {
        try {
          const quote = await getCurrentPrice(item.stock_code);
          if (quote.stockName) {
            await getPool().query('UPDATE watchlist SET stock_name = $1 WHERE stock_code = $2', [quote.stockName, item.stock_code]);
            logger.info(`종목명 보정: ${item.stock_code} → ${quote.stockName}`, { component: 'BOOT' });
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  // 6. 스케줄러 시작
  startScheduler();

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
