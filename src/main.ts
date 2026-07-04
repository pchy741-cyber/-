// ── HTTP keep-alive 전역 설정 (KIS, SerpApi, FRED 등 fetch() 자동 적용) ──
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 16,
  pipelining: 1,
}));

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { requireAuth } from './api/middleware/auth.js';
import { aiCostRoutes } from './api/routes/ai-cost.js';
import { aiLoopRoutes } from './api/routes/ai-loop.js';
// API Routes
import { authRoutes } from './api/routes/auth.js';
import { dashboardRoutes } from './api/routes/dashboard.js';
import { dashboardAnalysisRoutes } from './api/routes/dashboard-analysis/index.js';
import { dashboardNewsRoutes } from './api/routes/dashboard-news.js';
import { healthDetailRoutes, healthRoutes } from './api/routes/health.js';
import { qaRoutes } from './api/routes/qa.js';
import { journalRoutes } from './api/routes/journal.js';
import { kakaoAlertRoutes } from './api/routes/kakao-alert.js';
import { overseasRoutes } from './api/routes/overseas.js';
import reviewRoutes from './api/routes/review/index.js';
import { secretsRoutes } from './api/routes/secrets.js';
import { settingsRoutes } from './api/routes/settings/index.js';
import { sseRoutes } from './api/routes/sse.js';
import { webauthnProtectedRoutes, webauthnPublicRoutes } from './api/routes/webauthn.js';
import { initBigQuery } from './automation/bigquery-pipeline.js';
import { setupMonitoring } from './automation/gcp-monitoring.js';
import { backtestRoutes } from './backtest/api.js';
import { initRedisCache } from './cache/redis.js';
import { runWithMode } from './config/context.js';
import { baseIsPaper, config, reportConfigDrift, setTradingModeOverride } from './config/index.js';
import {
  checkDb,
  checkDbWithRetry,
  disableMemoryMode,
  enableMemoryMode,
  isMemoryMode,
  logSystem,
  resetPool,
} from './db/client.js';
import { getAccessToken } from './kis/auth.js';
import { initEmail } from './notifications/email.js';
import { initSlack } from './notifications/slack.js';
import { initTelegram } from './notifications/telegram.js';
import { startScheduler } from './scheduler/runner.js';
import {
  startDbHealthWatcher,
  startIdleWatcher,
  stopIdleWatcher,
  touchActivity,
  tryWakeIfNeeded,
  wakeCloudSqlIfNeeded,
} from './utils/cloud-sql-wake.js';
import { injectDbLogger, logger } from './utils/logger.js';
import { getKSTNow } from './utils/time.js';

// ── Hono App (Express 대비 4x 빠름, TypeScript-first) ──
const app = new Hono();

// ── 미들웨어 ──
app.use('*', secureHeaders());
app.use(
  '*',
  cors({
    origin: [
      'https://ai-auto-bot-807105550136.asia-northeast3.run.app',
      'http://localhost:8080',
      'http://localhost:3000',
    ],
    credentials: true,
  }),
);
app.use('*', honoLogger());
// ☁️ Cloud SQL 유휴 감시용 — 요청 시 활동 시간 갱신
app.use('*', async (_c, next) => {
  touchActivity();
  return next();
});

// ── API Rate Limiting (인메모리) ──
const rateMap = new Map<string, { count: number; resetAt: number }>();
const RATE_MAP_MAX = 10_000;
function rateLimit(max: number, windowMs: number) {
  return async (c: any, next: any) => {
    // Cloud Run: x-forwarded-for 마지막 값이 진짜 클라이언트 IP
    const xff = c.req.header('x-forwarded-for') as string | undefined;
    const ip = xff?.split(',').pop()?.trim() ?? 'unknown';
    // DoS 방어: 만료된 엔트리부터 제거 (핵클리어 대신 점진적 정리)
    if (rateMap.size > RATE_MAP_MAX) {
      const now = Date.now();
      for (const [k, v] of rateMap) {
        if (now > v.resetAt) rateMap.delete(k);
        if (rateMap.size <= RATE_MAP_MAX * 0.7) break;
      }
      if (rateMap.size > RATE_MAP_MAX) {
        // 만료 엔트리 없으면 가장 오래된 30% 제거
        const entries = [...rateMap.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
        entries.slice(0, Math.floor(entries.length * 0.3)).forEach(([k]) => {
          rateMap.delete(k);
        });
      }
    }
    const now = Date.now();
    const entry = rateMap.get(ip);
    if (!entry || now > entry.resetAt) {
      rateMap.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (++entry.count > max) return c.json({ error: 'Too many requests' }, 429);
    return next();
  };
}
// 2분마다 만료 엔트리 정리 (5분→2분, 장기운영 메모리 방지)
setInterval(() => {
  const n = Date.now();
  for (const [k, v] of rateMap) if (n > v.resetAt) rateMap.delete(k);
}, 120_000);

// Rate limit 적용: 로그인 5회/분, 매매 엔드포인트 10회/분
app.use('/auth/login', rateLimit(5, 60_000));
app.use('/overseas/sell', rateLimit(10, 60_000));
app.use('/overseas/vision-scalp/*', rateLimit(5, 60_000));
app.use('/manual-buy', rateLimit(10, 60_000));
app.use('/sell-stock/*', rateLimit(5, 60_000));
app.use('/sell-overseas/*', rateLimit(5, 60_000));
app.use('/kill-switch/*', rateLimit(3, 60_000));
// 🔒 추가 보안: 위험한 설정 변경 엔드포인트 제한
app.use('/trading-mode', rateLimit(2, 60_000)); // 거래 모드 전환
// /strategy: rate limit 제거 — 인증 뒤이므로 보호 충분, prefix match로 GET/PUT 모두 카운트되어 대시보드 사용 불편
app.use('/overseas-holdings-fix', rateLimit(2, 60_000)); // 포지션 조작
app.use('/secrets', rateLimit(3, 60_000)); // 시크릿 관리
app.use('/run-track-*', rateLimit(2, 60_000)); // 수동 작업 트리거
app.use('/run-overseas', rateLimit(2, 60_000)); // 수동 해외매매 트리거

// ── 거래 모드 컨텍스트 주입 미들웨어 ──
// 각 HTTP 요청에 viewMode를 AsyncLocalStorage로 주입 → config.isPaper 오염 원천 차단
app.use('*', async (c, next) => {
  const vm = c.req.query('viewMode');
  const isPaper = vm === 'paper' ? true : vm === 'live' ? false : baseIsPaper;
  return runWithMode(isPaper, next as () => Promise<void>);
});

// ── 라우트 마운트 ──
// ⚠️ 중요: 아래 app은 rootApp.route('/api', app)으로 마운트되므로
//    실제 외부 URL은 모두 /api/... 형태
//
// 공개 (인증 불필요)
app.route('/', healthRoutes); // GET  /api/health
app.route('/', authRoutes); // POST /api/auth/login, GET /api/auth/me
app.route('/', webauthnPublicRoutes); // POST /api/auth/webauthn/authenticate/*, GET /api/auth/webauthn/available
// 🔒 이하 모든 라우트: x-api-key 헤더 필요
app.use('*', requireAuth);
app.route('/', webauthnProtectedRoutes); // POST /api/auth/webauthn/register/*
app.route('/', healthDetailRoutes); // GET  /api/health/detail (인증 필요)
app.route('/', qaRoutes); // GET /api/qa/reports, /api/qa/latest, POST /api/qa/run
app.route('/', reviewRoutes); // POST /api/review/*, /api/capture/*
app.route('/', dashboardRoutes); // GET  /api/dashboard, /api/sell/:id, /api/manual-buy ...
app.route('/', dashboardNewsRoutes); // GET  /api/news/*
app.route('/', dashboardAnalysisRoutes); // GET /api/analysis/*, /api/sync-positions, /api/scores/*
app.route('/', secretsRoutes); // GET/POST /api/secrets/*
app.route('/', settingsRoutes); // GET/POST /api/strategy, /api/kill-switch, /api/overseas-holdings-fix ...
app.route('/', sseRoutes); // GET  /api/sse (실시간 스트림)
app.route('/', backtestRoutes); // GET  /api/backtest/*
app.route('/', journalRoutes); // GET  /api/journal/*
app.route('/', overseasRoutes); // GET  /api/overseas/dashboard, /api/overseas/scores ...
app.route('/', kakaoAlertRoutes); // POST /api/kakao-alert (카카오페이 알림 webhook)
app.route('/', aiCostRoutes); // GET  /api/ai-cost (AI 비용 현황)
app.route('/', aiLoopRoutes); // GET  /api/ai-loop/* (AI Loop 매매 조절)

import { referenceRoutes } from './api/routes/references.js';
import { researchRoutes } from './api/routes/research.js';

app.route('/', referenceRoutes); // GET/POST/DELETE /api/references (트레이딩 레퍼런스)
app.route('/', researchRoutes); // GET /api/research/files, POST /api/research/upload, POST /api/research/query

// 확장 기능 (OFF by default, 설정에서 켜야 사용)
import { dividendRoutes } from './api/routes/dividend.js';
import { strategyLabRoutes } from './api/routes/strategy-lab.js';

app.route('/', dividendRoutes); // GET  /api/dividend/*, 월배당 투자
app.route('/', strategyLabRoutes); // GET/POST /api/strategy-lab/*, 전략 Lab

// ── 전역 에러 핸들러: 내부 에러 메시지를 클라이언트에 노출하지 않음 ──
app.onError((err, c) => {
  const reqPath = c.req.path;
  logger.error(`API 에러 [${c.req.method} ${reqPath}]: ${err.message}`, {
    component: 'API',
    stack: err.stack?.split('\n').slice(0, 3).join(' | '),
  });
  return c.json({ error: '서버 오류가 발생했습니다' }, 500);
});

// ── 루트 앱 (프론트엔드 프록시 + API) ──
// 모든 API 경로는 /api 하위 — Non-API는 Next.js(localhost:3000)로 프록시
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
    // Next.js 빌드 해시 포함 정적 자산 — 영구 캐시
    if (url.pathname.startsWith('/_next/static/')) {
      resHeaders.set('cache-control', 'public, max-age=31536000, immutable');
    }
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
  logger.info('  🤖 AI Auto Bot v0.2.0 시작');
  logger.info(`  모드: ${config.tradingMode.toUpperCase()}`);
  logger.info(`  환경: ${config.env}`);
  logger.info(`  프레임워크: Hono (고성능)`);

  // 빌드 메타 검증 — Docker 빌드 시점 기록, 캐시/마이그레이션 문제 진단
  try {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const metaPath = resolve(import.meta.dirname ?? '.', 'build-meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    logger.info(`  빌드: ${meta.builtAt} (${meta.nodeVersion})`);
  } catch {
    logger.info('  빌드: 로컬 개발 (build-meta.json 없음)');
  }

  logger.info('========================================');

  // 0. Config-drift 리포트 — env가 코드 기본값을 덮어쓰는지 감지
  reportConfigDrift();

  // 1. PostgreSQL 연결 확인 (최대 12회 재시도, 15초 간격 = 최대 3분 대기)
  //    Cloud SQL 기상 소요시간 2~3분 — 기존 20초(4×5s)로는 부족
  try {
    const ok = await checkDbWithRetry(12, 15_000);
    if (!ok) throw new Error('DB health check failed after 12 retries');
    logger.info('✅ PostgreSQL 연결 성공', { component: 'BOOT' });
    injectDbLogger(logSystem);
    // 1-1. SQL 마이그레이션 파일 순차 실행 (src/db/migrations/*.sql)
    try {
      const { runMigrations } = await import('./db/migrate.js');
      await runMigrations();
    } catch (e: any) {
      logger.warn(`DB 마이그레이션 경고: ${e.message}`, { component: 'BOOT' });
    }
    // 1-1b. DB 거래 모드 오버라이드 로드 (재시작 시 유지)
    try {
      const { getPool: gp } = await import('./db/client.js');
      const { rows: tmRows } = await gp().query(
        'SELECT trading_mode_override FROM portfolio_allocation_config WHERE is_paper = false ORDER BY id DESC LIMIT 1',
      );
      const dbMode = tmRows[0]?.trading_mode_override;
      if (dbMode === 'paper' || dbMode === 'live') {
        setTradingModeOverride(dbMode);
        logger.info(`✅ 거래 모드 DB 복원: ${dbMode.toUpperCase()}`, { component: 'BOOT' });
      }
    } catch (e: any) {
      logger.warn(`거래 모드 로드 실패 (기본값 사용): ${e.message}`, { component: 'BOOT' });
    }
    // 1-2. 전략 파라미터 동기화: STRATEGY_PARAMS 상수 → DB
    try {
      const { getPool: gp } = await import('./db/client.js');
      const { STRATEGY_PARAMS } = await import('./config/constants.js');
      // is_paper 분리: 현재 실행 모드에 맞는 strategy_config만 조회/수정
      const { rows: sr } = await gp().query(
        `SELECT mode FROM strategy_config WHERE is_active = true AND is_paper = $1 LIMIT 1`,
        [baseIsPaper],
      );
      const activeMode = (sr[0]?.mode ?? 'SWING') as keyof typeof STRATEGY_PARAMS;
      const sp = STRATEGY_PARAMS[activeMode] ?? STRATEGY_PARAMS.SWING;
      // 🔒 사용자 커스텀 설정 보호: NULL 값만 채움 (매 부팅마다 덮어쓰기 방지)
      await gp().query(
        `UPDATE strategy_config SET
           take_profit_pct = CASE WHEN take_profit_pct IS NULL THEN $1 ELSE take_profit_pct END,
           stop_loss_pct = CASE WHEN stop_loss_pct IS NULL THEN $2 ELSE stop_loss_pct END,
           buy_threshold = CASE WHEN buy_threshold IS NULL THEN $3 ELSE buy_threshold END,
           use_dynamic_tpsl = COALESCE(use_dynamic_tpsl, true)
         WHERE is_active = true AND is_paper = $4`,
        [sp.takeProfitPct, sp.stopLossPct, sp.buyThreshold, baseIsPaper],
      );
      logger.info(
        `✅ 전략 파라미터 NULL값 보충 (${baseIsPaper ? 'paper' : 'live'}): defaults: buy=${sp.buyThreshold} tp=${sp.takeProfitPct}% sl=${sp.stopLossPct}%`,
        { component: 'BOOT' },
      );
      // is_paper 분리: 현재 모드 체인만 null값 보충 — live 체인에 paper SL 덮어쓰기 방지
      // paper 전용: SL -3.5% (물타기 트리거 -2.5%보다 넓은 SL 공간 확보)
      const effectiveBootSl = baseIsPaper ? -3.5 : sp.stopLossPct;
      await gp().query(
        `UPDATE transaction_chains SET stop_loss_pct=$1 WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING') AND stop_loss_pct IS NULL AND is_paper = $2`,
        [effectiveBootSl, baseIsPaper],
      );
      await gp().query(
        `UPDATE transaction_chains SET target_profit_pct=$1 WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING') AND target_profit_pct IS NULL AND is_paper = $2`,
        [sp.takeProfitPct, baseIsPaper],
      );
      // paper 마이그레이션: 기존 타이트한 SL(-1.5% ~ -2.5%) → -3.5% (일반 종목만, MEGA_CAP 제외)
      if (baseIsPaper) {
        const { MEGA_CAP_PRIORITY_CODES } = await import('./ai/track-b/trading-rules.js');
        const megaList = [...MEGA_CAP_PRIORITY_CODES];
        const { rowCount: migrated } = await gp().query(
          `UPDATE transaction_chains SET stop_loss_pct = -3.5
           WHERE is_paper = true AND status IN ('OPEN','AVERAGING','PROFIT_TAKING')
             AND stop_loss_pct > -3.5 AND stop_loss_pct IS NOT NULL
             AND NOT (stock_code = ANY($1::text[]))`,
          [megaList],
        );
        if (migrated && migrated > 0) {
          logger.info(`✅ paper SL 마이그레이션: ${migrated}개 체인 → -3.5% (물타기 공간 확보)`, { component: 'BOOT' });
        }
      }
      logger.info(
        `✅ 기존 체인 null값 보충 (${baseIsPaper ? 'paper' : 'live'}): stop_loss=${effectiveBootSl}% target=${sp.takeProfitPct}%`,
        { component: 'BOOT' },
      );
      // 전략 모드별 TP/SL 보정 — 현재 모드 체인만 (이전 마이그레이션 기본값 4.0/-3.0 수정)
      const { STRATEGY_PARAMS: SP } = await import('./config/constants.js');
      for (const [mode, params] of Object.entries(SP) as [string, { takeProfitPct: number; stopLossPct: number }][]) {
        await gp().query(
          `UPDATE transaction_chains SET target_profit_pct=$1, stop_loss_pct=$2
           WHERE strategy_mode=$3 AND status IN ('OPEN','AVERAGING','PROFIT_TAKING') AND is_paper = $4
             AND (target_profit_pct = 4.0 OR stop_loss_pct = -3.0)`,
          [params.takeProfitPct, params.stopLossPct, mode, baseIsPaper],
        );
      }
      logger.info('✅ 체인 전략모드별 TP/SL 보정 완료', { component: 'BOOT' });
    } catch (e: any) {
      logger.warn(`전략 파라미터 동기화 실패: ${e.message}`, { component: 'BOOT' });
    }
  } catch (err) {
    logger.warn(`⚠️ PostgreSQL 미연결: ${err}`, { component: 'BOOT' });
    enableMemoryMode();
    logger.info('📦 인메모리 DB 모드로 전환 (감시목록 7종목 자동 로드)', { component: 'BOOT' });

    // ☁️ Cloud SQL 자동 기상 — DB 꺼져있으면 API로 켠다 (2~3분 후 연결됨)
    try {
      await wakeCloudSqlIfNeeded();
    } catch (wakeErr) {
      logger.error(`☁️ Cloud SQL 자동기상 실패: ${wakeErr}`, { component: 'BOOT' });
    }

    // DB 복구 감시 — 30초마다 재시도, 연결 성공 시 메모리 모드 해제
    const recoveryInterval = setInterval(async () => {
      if (!isMemoryMode()) {
        clearInterval(recoveryInterval);
        return;
      }
      // DB 연결 실패 지속 시 → Cloud SQL 자동기상 재시도 (5분 쿨다운)
      try {
        await tryWakeIfNeeded();
      } catch {
        /* ignore */
      }
      // stale pool 폐기 → 새 커넥션으로 재시도
      try {
        await resetPool();
      } catch {
        /* ignore */
      }
      try {
        const ok = await checkDb();
        if (ok) {
          disableMemoryMode();
          clearInterval(recoveryInterval);
          // 대시보드 캐시 완전 삭제 — 오래된 stale 데이터 표시 방지
          try {
            const { hardInvalidateDashboardCache } = await import('./api/routes/dashboard/helpers.js');
            hardInvalidateDashboardCache();
          } catch {
            /* ignore */
          }
          // 마이그레이션 + 모드 오버라이드 복원
          try {
            const { runMigrations } = await import('./db/migrate.js');
            await runMigrations();
          } catch {
            /* ignore */
          }
          try {
            const { getPool: gp } = await import('./db/client.js');
            const { rows: tmRows } = await gp().query(
              'SELECT trading_mode_override FROM portfolio_allocation_config WHERE is_paper = false ORDER BY id DESC LIMIT 1',
            );
            const dbMode = tmRows[0]?.trading_mode_override;
            if (dbMode === 'paper' || dbMode === 'live') {
              setTradingModeOverride(dbMode);
              logger.info(`✅ DB 복구 후 거래 모드 복원: ${dbMode.toUpperCase()}`, { component: 'BOOT' });
            }
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }, 30_000); // 30초 (자동기상 후 빠른 재연결)
  }

  // 2. 인프라 서비스 병렬 초기화 ──────────────────────────────────────────
  // Secrets는 KIS 토큰 발급 전 필수 → 나머지와 동시 실행
  const bootParallel1 = [
    // Redis
    initRedisCache()
      .then(() => logger.info('✅ Upstash Redis 캐시 연결', { component: 'BOOT' }))
      .catch((err) => logger.warn(`⚠️ Redis 미연결 (DB fallback): ${err}`, { component: 'BOOT' })),
    // AI Loop 오버라이드 캐시
    import('./ai/ai-overrides.js').then(({ loadOverridesCache }) => loadOverridesCache()).catch(() => {}),
    // VAPID 푸시 알림
    import('./notifications/web-push.js')
      .then(({ initVapid }) => initVapid())
      .then(() => logger.info('✅ VAPID 푸시 알림 초기화 완료', { component: 'BOOT' }))
      .catch((err) => logger.warn(`⚠️ VAPID 초기화 실패 (알림 비활성): ${err}`, { component: 'BOOT' })),
    // Monitoring (동기지만 Promise로 래핑)
    Promise.resolve()
      .then(() => {
        setupMonitoring();
        logger.info('✅ Cloud Monitoring 연결', { component: 'BOOT' });
      })
      .catch((err) => logger.warn(`⚠️ Monitoring 초기화 실패: ${err}`, { component: 'BOOT' })),
    // BigQuery
    initBigQuery()
      .then((ok) =>
        ok
          ? logger.info('✅ BigQuery 파이프라인 연결', { component: 'BOOT' })
          : logger.warn('⚠️ BigQuery 파이프라인 비활성 (인증 실패 또는 설정 없음)', { component: 'BOOT' }),
      )
      .catch((err) => logger.warn(`⚠️ BigQuery 초기화 실패: ${err}`, { component: 'BOOT' })),
  ];

  // Secrets 로드 (KIS 토큰 발급 전 완료 필요) — 나머지와 병렬
  const secretsReady = import('./api/routes/secrets.js')
    .then(({ loadSecretsToEnv }) => loadSecretsToEnv())
    .catch((err) => logger.warn(`Secret Manager 로드 실패 (환경변수 fallback): ${err}`, { component: 'BOOT' }));

  // Secrets 완료 후 → KIS 토큰 발급
  await secretsReady;
  try {
    await getAccessToken();
    logger.info('✅ KIS 토큰 발급 성공', { component: 'BOOT' });
  } catch (err) {
    logger.error(`❌ KIS 토큰 발급 실패: ${err}`, { component: 'BOOT' });
  }

  // KIS 토큰 이후: 휴장일 캐시 + Telegram/Slack (나머지 병렬 완료 대기)
  bootParallel1.push(
    import('./kis/market.js')
      .then(async ({ refreshMarketHolidayCache }) => {
        await refreshMarketHolidayCache();
        const msUntilMidnight = (() => {
          const now = new Date();
          const kstMs = now.getTime() + 9 * 3600_000;
          const kstDate = new Date(kstMs);
          const nextMidnight = new Date(
            Date.UTC(kstDate.getUTCFullYear(), kstDate.getUTCMonth(), kstDate.getUTCDate() + 1, -9, 5),
          );
          return Math.max(nextMidnight.getTime() - now.getTime(), 60_000);
        })();
        setTimeout(function tick() {
          refreshMarketHolidayCache().catch(() => {});
          setTimeout(tick, 24 * 3600_000);
        }, msUntilMidnight);
      })
      .catch((err) => logger.warn(`⚠️ KIS 휴장일 캐시 갱신 실패 (하드코딩 fallback): ${err}`, { component: 'BOOT' })),
  );

  // Telegram/Slack (빠름, 병렬 포함)
  try {
    initTelegram();
  } catch (err) {
    logger.warn(`⚠️ Telegram 초기화 실패: ${err}`, { component: 'BOOT' });
  }
  const { config: cfg } = await import('./config/index.js');
  if (cfg.slack.webhookUrl) initSlack(cfg.slack.webhookUrl);
  initEmail(cfg.email);

  // 모든 병렬 서비스 완료 대기
  await Promise.allSettled(bootParallel1);

  // 5.5. 씨앗 감시목록 — KOSPI 시총 상위 우량주 자동 등록 (없으면 insert)
  try {
    const { seedWatchlist } = await import('./automation/seed-watchlist.js');
    await seedWatchlist();
  } catch (err) {
    logger.warn(`씨앗 감시목록 등록 실패 (무시): ${err}`, { component: 'BOOT' });
  }

  // 5.6. 감시목록 종목명 보정 (하드코딩 우선 → KIS API fallback)
  try {
    const { getPool, getActiveWatchlist } = await import('./db/client.js');
    const { getCurrentPrice } = await import('./kis/market.js');
    const NAME_MAP: Record<string, string> = {
      '005930': '삼성전자',
      '000660': 'SK하이닉스',
      '373220': 'LG에너지솔루션',
      '005380': '현대자동차',
      '009540': 'HD한국조선해양',
      '035420': 'NAVER',
      '035720': '카카오',
      '006400': '삼성SDI',
      '051910': 'LG화학',
      '003670': '포스코퓨처엠',
      '336260': '두산로보틱스',
      '012450': '한화에어로스페이스',
      '267260': 'HD현대일렉트릭',
      '042700': '한미반도체',
      '068270': '셀트리온',
      '003535': '한화투자증권우',
      '009830': '한화솔루션',
      '352820': '하이브',
      '012610': '경인양행',
    };
    const wl = await getActiveWatchlist();
    // 이름 보정이 필요한 종목만 필터
    const toFix = wl.filter((item) => {
      return (
        !item.stock_name ||
        item.stock_name === item.stock_code ||
        /^\d{6}$/.test(item.stock_name) ||
        /[^\w\sㄱ-ㅎ가-힣().-]/.test(item.stock_name)
      );
    });
    // 5개씩 병렬 처리 (KIS API rate limit 20 req/s 안전 범위)
    for (let i = 0; i < toFix.length; i += 5) {
      const batch = toFix.slice(i, i + 5);
      await Promise.allSettled(
        batch.map(async (item) => {
          let name = NAME_MAP[item.stock_code];
          if (!name) {
            try {
              const q = await getCurrentPrice(item.stock_code);
              name = q.stockName?.trim();
            } catch {
              /* skip */
            }
          }
          if (!name) {
            try {
              const nr = await fetch(`https://finance.naver.com/item/main.naver?code=${item.stock_code}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(5000),
              });
              const html = await nr.text();
              const m = html.match(/<title>([^:<]+?)\s*:\s*Npay 증권<\/title>/);
              if (m?.[1]) name = m[1].trim();
            } catch {
              /* skip */
            }
          }
          if (name) {
            await getPool().query('UPDATE watchlist SET stock_name = $1 WHERE stock_code = $2', [
              name,
              item.stock_code,
            ]);
            logger.info(`종목명 보정: ${item.stock_code} → ${name}`, { component: 'BOOT' });
          }
        }),
      );
    }
  } catch {
    /* skip */
  }

  // 5.7. 자기학습 인사이트 초기화 (비어있으면 즉시 분석 실행)
  try {
    const { getPool: gp } = await import('./db/client.js');
    const { rows: ins } = await gp().query(`SELECT COUNT(*) FROM learned_insights`);
    if (Number(ins[0]?.count ?? 0) === 0) {
      logger.info('🧠 learned_insights 비어있음 → 즉시 자기학습 실행', { component: 'BOOT' });
      const { runDailyLearning } = await import('./automation/self-learning.js');
      runDailyLearning().catch((e: Error) => logger.warn(`부팅 자기학습 실패: ${e.message}`, { component: 'BOOT' }));
    } else {
      logger.info(`✅ 학습 인사이트 ${ins[0]?.count}건 로드됨`, { component: 'BOOT' });
    }
  } catch (e: any) {
    logger.warn(`자기학습 초기화 체크 실패: ${e.message}`, { component: 'BOOT' });
  }

  // 6. 상태 복원 병렬 실행 (Kill Switch, 해외 세션, 기준자본, 쿨다운, Pre-TP peak)
  await Promise.allSettled([
    import('./risk/kill-switch.js')
      .then(({ initKillSwitchFromDB }) => initKillSwitchFromDB())
      .catch((e: any) => logger.warn(`Kill Switch 복원 실패 (무시): ${e.message}`, { component: 'BOOT' })),
    import('./scheduler/overseas-job.js')
      .then(({ restoreSessionStartValue }) => restoreSessionStartValue())
      .catch((e: any) => logger.warn(`해외 세션 시작값 복원 실패 (무시): ${e.message}`, { component: 'BOOT' })),
    import('./risk/seed-capital.js')
      .then(({ initSeedCapital }) => initSeedCapital())
      .catch((e: any) => logger.warn(`기준자본 로드 실패 (기본값 사용): ${e.message}`, { component: 'BOOT' })),
    import('./risk/trade-gate.js')
      .then(({ restoreCooldownResetAt }) => restoreCooldownResetAt())
      .catch((e: any) => logger.warn(`쿨다운 리셋 복원 실패 (무시): ${e.message}`, { component: 'BOOT' })),
    import('./api/routes/settings/manual-triggers.js')
      .then(({ initAutoTrade }) => initAutoTrade())
      .catch((e: any) => logger.warn(`자동매매 상태 복원 실패 (기본 ON 사용): ${e.message}`, { component: 'BOOT' })),
    // Pre-TP peak 복원: 재시작 시 _preTpPeakMap 손실 방지
    (async () => {
      const { getPool: gp } = await import('./db/client.js');
      const { rows } = await gp().query(
        `SELECT stock_code, avg_buy_price, peak_price_since_open FROM transaction_chains
         WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING') AND peak_price_since_open IS NOT NULL
           AND is_paper = $1`,
        [baseIsPaper],
      );
      if (rows.length > 0) {
        const { restorePreTpPeakMap } = await import('./ai/track-b/sell-signals.js');
        restorePreTpPeakMap(rows, baseIsPaper);
      }
    })().catch((e: any) => logger.warn(`Pre-TP peak 복원 실패 (무시): ${e.message}`, { component: 'BOOT' })),
  ]);

  // 6-1.5. ScaleIn 미완료 트랜치 복구 — 프로세스 재시작 시 유실된 2차/3차 분할 매수 실행
  try {
    const { tradeExecutor } = await import('./trading/executor.js');
    await tradeExecutor.recoverPendingScaleIns();
  } catch (e: any) {
    logger.warn(`ScaleIn 복구 실패 (무시): ${e.message}`, { component: 'BOOT' });
  }

  // 6-2. 필수 시크릿 검증 — 없으면 킬스위치 자동 활성화 (사고 방지)
  {
    const missing: string[] = [];
    if (!config.kis.appKey) missing.push('KIS_APP_KEY');
    if (!config.kis.appSecret) missing.push('KIS_APP_SECRET');
    if (!process.env.DASHBOARD_PASSWORD) missing.push('DASHBOARD_PASSWORD');
    if (missing.length > 0) {
      const msg = `필수 시크릿 누락: ${missing.join(', ')}`;
      logger.error(msg, { component: 'BOOT' });
      try {
        const { activateKillSwitchAll } = await import('./risk/kill-switch.js');
        await activateKillSwitchAll(`Startup: ${msg}`);
      } catch {}
    }
  }

  // 7. 스케줄러 시작
  startScheduler();

  // 7-0. Cloud SQL 유휴 자동 중지 감시 (30분 미사용 + 장외시간 → DB 끔)
  startIdleWatcher();

  // 7-0b. DB 헬스 워처 — 부팅 후에도 DB 끊기면 자동 기상 + 재연결 (2분 주기)
  startDbHealthWatcher(checkDb, async () => {
    await resetPool(); // stale 커넥션 폐기 → 새 pool 생성
    disableMemoryMode();
    // 대시보드 캐시 완전 삭제 — 오래된 stale 데이터 표시 방지
    try {
      const { hardInvalidateDashboardCache } = await import('./api/routes/dashboard/helpers.js');
      hardInvalidateDashboardCache();
      logger.info('🔄 대시보드 캐시 hard invalidate (DB 복구)', { component: 'BOOT' });
    } catch {
      /* ignore */
    }
    try {
      const { runMigrations } = await import('./db/migrate.js');
      await runMigrations();
    } catch {
      /* ignore */
    }
    try {
      const { getPool: gp } = await import('./db/client.js');
      const { rows: tmRows } = await gp().query(
        'SELECT trading_mode_override FROM portfolio_allocation_config WHERE is_paper = false ORDER BY id DESC LIMIT 1',
      );
      const dbMode = tmRows[0]?.trading_mode_override;
      if (dbMode === 'paper' || dbMode === 'live') {
        setTradingModeOverride(dbMode);
        logger.info(`✅ DB 복구 후 거래 모드 복원: ${dbMode.toUpperCase()}`, { component: 'BOOT' });
      }
    } catch {
      /* ignore */
    }
  });

  // 7-1. 미종료 루프 세션 자동 재개
  try {
    const { checkPendingLoop, isLoopActive, startLoop } = await import('./scheduler/loop-mode.js');
    await checkPendingLoop();
    // AUTO_START_LOOP=true 환경변수 시 재배포 후에도 루프 자동 시작
    if (process.env.AUTO_START_LOOP === 'true' && !isLoopActive()) {
      const result = await startLoop();
      logger.info(`🔁 AUTO_START_LOOP: ${result.ok ? '루프 자동 시작됨' : `실패 — ${result.error ?? ''}`}`, { component: 'BOOT' });
    }
  } catch (e: any) {
    logger.warn(`루프 자동재개 실패: ${e.message}`, { component: 'BOOT' });
  }

  // 6-1. AI 점수 시간대별 자동 갱신 — 재시작 후 스케줄 누락 자동 복구
  // 단순 "오늘 점수 있음" → 스킵이 아니라, 12:30 / 18:00 KST 세션 이후 재시작이면 재실행
  try {
    const { getActiveWatchlist, getLatestScores } = await import('./db/client.js');
    const wl = await getActiveWatchlist();
    const codes = wl.map((w: any) => w.stock_code).slice(0, 5);
    if (codes.length > 0) {
      const scores = await getLatestScores(codes);
      const kstNow = getKSTNow();
      const today = `${kstNow.getUTCFullYear()}-${String(kstNow.getUTCMonth() + 1).padStart(2, '0')}-${String(kstNow.getUTCDate()).padStart(2, '0')}`;
      const todayScores = scores.filter((s: any) => s.score_date === today && (s.composite_score ?? 0) > 0);

      if (todayScores.length === 0) {
        logger.info('🔄 오늘 AI 점수 없음 → Track A 자동 실행', { component: 'BOOT' });
        const { runTrackAJob } = await import('./scheduler/track-a-job.js');
        runTrackAJob().catch((e: Error) => logger.error(`부팅 Track A 실패: ${e.message}`, { component: 'BOOT' }));
      } else {
        // 마지막 점수 생성 시각 → KST 분(minute) 환산
        const latestCreatedMs = todayScores
          .map((s: any) => new Date(s.created_at).getTime())
          .reduce((max: number, t: number) => Math.max(max, t), 0);
        const latestKST = new Date(latestCreatedMs + 9 * 60 * 60 * 1000);
        const latestKSTMinutes = latestKST.getUTCHours() * 60 + latestKST.getUTCMinutes();
        const kstH = kstNow.getUTCHours();
        const kstM = kstNow.getUTCMinutes();
        const nowKSTMinutes = kstH * 60 + kstM;
        // Track A 정규 세션: 07:30(450), 12:30(750), 18:00(1080) KST
        const missedNoon = nowKSTMinutes >= 750 && latestKSTMinutes < 750;
        const missedEvening = nowKSTMinutes >= 1080 && latestKSTMinutes < 1080;
        if (missedNoon || missedEvening) {
          const session = missedEvening ? '18:00 KST' : '12:30 KST';
          logger.info(
            `🔄 ${session} 세션 이후 재시작 감지 (마지막 점수: ${latestKST.getUTCHours()}:${String(latestKST.getUTCMinutes()).padStart(2, '0')} KST) → Track A 재실행`,
            { component: 'BOOT' },
          );
          const { runTrackAJob } = await import('./scheduler/track-a-job.js');
          runTrackAJob().catch((e: Error) =>
            logger.error(`부팅 Track A 세션 재실행 실패: ${e.message}`, { component: 'BOOT' }),
          );
        } else {
          logger.info(
            `✅ 오늘 AI 점수 존재 (${latestKST.getUTCHours()}:${String(latestKST.getUTCMinutes()).padStart(2, '0')} KST 기준) — Track A 스킵`,
            { component: 'BOOT' },
          );
        }
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

  // 대시보드 캐시 선제 빌드 — 콜드 스타트 시 첫 로딩 개선 (1초 후 시작)
  setTimeout(() => {
    if (!isMemoryMode()) {
      import('./api/routes/dashboard.js').then(({ prewarmDashboard }) => prewarmDashboard()).catch(() => {});
      // 즐겨찾기/블랙리스트 초기 시딩 (최초 1회 — 이미 값 있으면 스킵)
      import('./scheduler/overseas/utils.js')
        .then(async ({ getOverseasState, setOverseasState }) => {
          if (!(await getOverseasState('user_favorites')))
            await setOverseasState('user_favorites', JSON.stringify(['VRT', 'SMCI', 'AMD']));
          if (!(await getOverseasState('user_blacklist')))
            await setOverseasState('user_blacklist', JSON.stringify(['TSLA', 'AAPL', 'META']));
        })
        .catch(() => {});

      // 감시종목 자동 정리 (부팅 시 1회 — 30일+ AUTO/KIS_SYNC 미보유·미거래 항목 비활성화)
      import('./db/client.js')
        .then(({ getPool }) =>
          getPool()
            .query(`
          UPDATE watchlist SET is_active = false
          WHERE is_active = true
            AND source IN ('AUTO', 'KIS_SYNC')
            AND stock_code NOT IN (SELECT DISTINCT stock_code FROM transaction_chains WHERE status != 'CLOSED' AND is_paper = $1)
            AND added_at < NOW() - INTERVAL '30 days'
            AND stock_code NOT IN (
              SELECT DISTINCT stock_code FROM orders WHERE status = 'FILLED' AND is_paper = $1 AND created_at > NOW() - INTERVAL '14 days'
            )
        `, [baseIsPaper])
            .then((r) => {
              if ((r.rowCount ?? 0) > 0)
                logger.info(`🧹 감시종목 부팅 정리: ${r.rowCount}개 비활성화`, { component: 'BOOT' });
            }),
        )
        .catch(() => {});
    }
  }, 1000);

  // AI Loop 오버라이드 만료 정리 (1시간마다)
  setInterval(() => {
    import('./ai/ai-overrides.js').then(({ cleanupExpired }) => cleanupExpired()).catch(() => {});
  }, 3_600_000);

  if (config.isPaper) {
    logger.info('📝 *** 모의투자(Paper Trading) 모드 ***', { component: 'BOOT' });
  }

  // Graceful Shutdown — Cloud Run SIGTERM 시 진행 중 거래 완료 후 종료
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} 수신 — graceful shutdown 시작`, { component: 'BOOT' });
    try {
      const { setShuttingDown, isOverseasJobRunning } = await import('./scheduler/overseas-job.js');
      setShuttingDown(true);
      // 진행 중 Job 완료 대기 (최대 8초, Cloud Run은 10초 제공)
      const start = Date.now();
      while (Date.now() - start < 8000 && isOverseasJobRunning()) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch {}
    // Auto Pilot 루프 정지 — DB 세션 종료 + advisory lock 해제
    try {
      const { stopLoop } = await import('./scheduler/loop-mode.js');
      await stopLoop('graceful shutdown');
    } catch {}
    stopIdleWatcher();
    try {
      (await import('./db/client.js')).getPool().end();
    } catch {}
    logger.info('Graceful shutdown 완료', { component: 'BOOT' });
    process.exit(0);
  };
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

// ── 미처리 Promise rejection 핸들러 — 프로세스 크래시 방지 ──
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`🚨 unhandledRejection: ${reason}`, {
    component: 'PROCESS',
    stack: reason instanceof Error ? reason.stack?.split('\n').slice(0, 5).join(' | ') : String(reason),
  });
  // 크래시 대신 로깅만 — Cloud Run 인스턴스 유지
});

process.on('uncaughtException', (err) => {
  logger.error(`🚨 uncaughtException: ${err.message}`, {
    component: 'PROCESS',
    stack: err.stack?.split('\n').slice(0, 5).join(' | '),
  });
  // 심각한 상태 오염 가능 → 30초 후 graceful exit (진행 중 매매 보호)
  setTimeout(() => process.exit(1), 30_000);
});

bootstrap().catch((err) => {
  logger.error(`치명적 오류: ${err}`, { component: 'BOOT' });
  process.exit(1);
});
