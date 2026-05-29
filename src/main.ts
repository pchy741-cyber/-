import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { dashboardRoutes } from './api/routes/dashboard.js';
import { dashboardNewsRoutes } from './api/routes/dashboard-news.js';
import { dashboardAnalysisRoutes } from './api/routes/dashboard-analysis.js';
// API Routes
import { authRoutes } from './api/routes/auth.js';
import { healthRoutes } from './api/routes/health.js';
import { overseasRoutes } from './api/routes/overseas.js';
import { secretsRoutes } from './api/routes/secrets.js';
import { settingsRoutes } from './api/routes/settings.js';
import { sseRoutes } from './api/routes/sse.js';
import { journalRoutes } from './api/routes/journal.js';
import { backtestRoutes } from './backtest/api.js';
import reviewRoutes from './api/routes/review.js';
import { requireAuth } from './api/middleware/auth.js';
import { initBigQuery } from './automation/bigquery-pipeline.js';
import { setupMonitoring } from './automation/gcp-monitoring.js';
import { initRedisCache } from './cache/redis.js';
import { config, setTradingModeOverride, baseIsPaper } from './config/index.js';
import { runWithMode } from './config/context.js';
import { checkDb, disableMemoryMode, enableMemoryMode, isMemoryMode, logSystem } from './db/client.js';
import { injectDbLogger } from './utils/logger.js';
import { getAccessToken } from './kis/auth.js';
import { initTelegram } from './notifications/telegram.js';
import { initSlack } from './notifications/slack.js';
import { startScheduler } from './scheduler/runner.js';
import { logger } from './utils/logger.js';

// ── Hono App (Express 대비 4x 빠름, TypeScript-first) ──
const app = new Hono();

// ── 미들웨어 ──
app.use('*', secureHeaders());
app.use('*', cors({
  origin: ['https://quantops-807105550136.asia-northeast3.run.app', 'http://localhost:8080', 'http://localhost:3000'],
  credentials: true,
}));
app.use('*', honoLogger());

// ── API Rate Limiting (인메모리) ──
const rateMap = new Map<string, { count: number; resetAt: number }>();
function rateLimit(max: number, windowMs: number) {
  return async (c: any, next: any) => {
    // Cloud Run: x-forwarded-for 마지막 값이 진짜 클라이언트 IP
    const xff = c.req.header('x-forwarded-for') as string | undefined;
    const ip = xff?.split(',').pop()?.trim() ?? 'unknown';
    if (rateMap.size > 10_000) rateMap.clear(); // DoS 방어: 메모리 폭발 방지
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
// 5분마다 만료 엔트리 정리
setInterval(() => { const n = Date.now(); for (const [k, v] of rateMap) if (n > v.resetAt) rateMap.delete(k); }, 300_000);

// Rate limit 적용: 로그인 5회/분, 매매 엔드포인트 10회/분
app.use('/auth/login', rateLimit(5, 60_000));
app.use('/overseas/sell', rateLimit(10, 60_000));
app.use('/overseas/vision-scalp/*', rateLimit(5, 60_000));
app.use('/manual-buy', rateLimit(10, 60_000));
app.use('/sell-stock/*', rateLimit(5, 60_000));
app.use('/sell-overseas/*', rateLimit(5, 60_000));
app.use('/kill-switch/*', rateLimit(3, 60_000));

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
app.route('/', healthRoutes);          // GET  /api/health
app.route('/', authRoutes);            // POST /api/auth/login, GET /api/auth/me
// 🔒 이하 모든 라우트: x-api-key 헤더 필요
app.use('*', requireAuth);
app.route('/', reviewRoutes);          // POST /api/review/*, /api/capture/*
app.route('/', dashboardRoutes);       // GET  /api/dashboard, /api/sell/:id, /api/manual-buy ...
app.route('/', dashboardNewsRoutes);   // GET  /api/news/*
app.route('/', dashboardAnalysisRoutes); // GET /api/analysis/*, /api/sync-positions, /api/scores/*
app.route('/', secretsRoutes);         // GET/POST /api/secrets/*
app.route('/', settingsRoutes);        // GET/POST /api/strategy, /api/kill-switch, /api/overseas-holdings-fix ...
app.route('/', sseRoutes);             // GET  /api/sse (실시간 스트림)
app.route('/', backtestRoutes);        // GET  /api/backtest/*
app.route('/', journalRoutes);         // GET  /api/journal/*
app.route('/', overseasRoutes);        // GET  /api/overseas/dashboard, /api/overseas/scores ...

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
      const { rows: tmRows } = await gp().query('SELECT trading_mode_override FROM portfolio_allocation_config WHERE is_paper = $1 ORDER BY id DESC LIMIT 1', [config.isPaper]);
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
      await gp().query(
        `UPDATE strategy_config SET take_profit_pct=$1, stop_loss_pct=$2, buy_threshold=$3 WHERE is_active = true AND is_paper = $4`,
        [sp.takeProfitPct, sp.stopLossPct, sp.buyThreshold, baseIsPaper],
      );
      logger.info(`✅ 전략 파라미터 동기화 (${baseIsPaper ? 'paper' : 'live'}): buy_threshold=${sp.buyThreshold} take_profit=${sp.takeProfitPct}% stop_loss=${sp.stopLossPct}%`, { component: 'BOOT' });
      // is_paper 분리: 현재 모드 체인만 null값 보충 — live 체인에 paper SL 덮어쓰기 방지
      await gp().query(
        `UPDATE transaction_chains SET stop_loss_pct=$1 WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING') AND stop_loss_pct IS NULL AND is_paper = $2`,
        [sp.stopLossPct, baseIsPaper],
      );
      await gp().query(
        `UPDATE transaction_chains SET target_profit_pct=$1 WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING') AND target_profit_pct IS NULL AND is_paper = $2`,
        [sp.takeProfitPct, baseIsPaper],
      );
      logger.info(`✅ 기존 체인 null값 보충 (${baseIsPaper ? 'paper' : 'live'}): stop_loss=${sp.stopLossPct}% target=${sp.takeProfitPct}%`, { component: 'BOOT' });
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

    // DB 복구 감시 — 60초마다 재시도, 연결 성공 시 메모리 모드 해제
    const recoveryInterval = setInterval(async () => {
      if (!isMemoryMode()) { clearInterval(recoveryInterval); return; }
      try {
        const ok = await checkDb();
        if (ok) {
          disableMemoryMode();
          clearInterval(recoveryInterval);
          // 마이그레이션 + 모드 오버라이드 복원
          try {
            const { runMigrations } = await import('./db/migrate.js');
            await runMigrations();
          } catch { /* ignore */ }
          try {
            const { getPool: gp } = await import('./db/client.js');
            const { rows: tmRows } = await gp().query('SELECT trading_mode_override FROM portfolio_allocation_config WHERE is_paper = $1 ORDER BY id DESC LIMIT 1', [config.isPaper]);
            const dbMode = tmRows[0]?.trading_mode_override;
            if (dbMode === 'paper' || dbMode === 'live') {
              setTradingModeOverride(dbMode);
              logger.info(`✅ DB 복구 후 거래 모드 복원: ${dbMode.toUpperCase()}`, { component: 'BOOT' });
            }
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }, 60_000);
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

  // 3-1. KIS API로 연간 휴장일 캐시 갱신 (공휴일·대체공휴일 정확 판정)
  try {
    const { refreshMarketHolidayCache } = await import('./kis/market.js');
    await refreshMarketHolidayCache();
    // 매일 KST 00:05에 재갱신 (연말 특별 휴장 등 대응)
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
  } catch (err) {
    logger.warn(`⚠️ KIS 휴장일 캐시 갱신 실패 (하드코딩 fallback): ${err}`, { component: 'BOOT' });
  }

  // 4. 텔레그램 봇 시작
  try {
    initTelegram();
  } catch (err) {
    logger.warn(`⚠️ Telegram 초기화 실패: ${err}`, { component: 'BOOT' });
  }

  // 4-a. Slack Webhook 초기화
  const { config: cfg } = await import('./config/index.js');
  if (cfg.slack.webhookUrl) initSlack(cfg.slack.webhookUrl);

  // 4-b. VAPID 푸시 알림 초기화 (DB 준비 완료 후 — 구독 유효성 보장)
  try {
    const { initVapid } = await import('./notifications/web-push.js');
    await initVapid();
    logger.info('✅ VAPID 푸시 알림 초기화 완료', { component: 'BOOT' });
  } catch (err) {
    logger.warn(`⚠️ VAPID 초기화 실패 (알림 비활성): ${err}`, { component: 'BOOT' });
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
      '005930': '삼성전자', '000660': 'SK하이닉스', '373220': 'LG에너지솔루션',
      '005380': '현대자동차', '009540': 'HD한국조선해양', '035420': 'NAVER',
      '035720': '카카오', '006400': '삼성SDI', '051910': 'LG화학',
      '003670': '포스코퓨처엠', '336260': '두산로보틱스', '012450': '한화에어로스페이스',
      '267260': 'HD현대일렉트릭', '042700': '한미반도체', '068270': '셀트리온',
      '003535': '한화투자증권우', '009830': '한화솔루션',
      '352820': '하이브', '012610': '경인양행',
    };
    const wl = await getActiveWatchlist();
    for (const item of wl) {
      const known = NAME_MAP[item.stock_code];
      const needsFix = !item.stock_name || item.stock_name === item.stock_code
        || /^\d{6}$/.test(item.stock_name) || /[^\w\sㄱ-ㅎ가-힣().-]/.test(item.stock_name);
      if (needsFix) {
        let name = known;
        // KIS API (장중) → Naver Finance (24시간) 순으로 시도
        if (!name) {
          try { const q = await getCurrentPrice(item.stock_code); name = q.stockName?.trim(); } catch { /* skip */ }
        }
        if (!name) {
          try {
            const nr = await fetch(`https://finance.naver.com/item/main.naver?code=${item.stock_code}`,
              { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
            const html = await nr.text();
            const m = html.match(/<title>([^:<]+?)\s*:\s*Npay 증권<\/title>/);
            if (m?.[1]) name = m[1].trim();
          } catch { /* skip */ }
        }
        if (name) {
          await getPool().query('UPDATE watchlist SET stock_name = $1 WHERE stock_code = $2', [name, item.stock_code]);
          logger.info(`종목명 보정: ${item.stock_code} → ${name}`, { component: 'BOOT' });
        }
      }
    }
  } catch { /* skip */ }

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

  // 6. Kill Switch DB 복원 (재배포 후에도 수동 정지 상태 유지)
  try {
    const { initKillSwitchFromDB } = await import('./risk/kill-switch.js');
    await initKillSwitchFromDB();
  } catch (e: any) {
    logger.warn(`Kill Switch 복원 실패 (무시): ${e.message}`, { component: 'BOOT' });
  }

  // 6-b. 해외 세션 시작 포트폴리오값 복원 (재배포 시 일일 손실 추적 유지)
  try {
    const { restoreSessionStartValue } = await import('./scheduler/overseas-job.js');
    await restoreSessionStartValue();
  } catch (e: any) {
    logger.warn(`해외 세션 시작값 복원 실패 (무시): ${e.message}`, { component: 'BOOT' });
  }

  // 6-c2. 기준자본(Seed Capital) DB 로드 (손실한도 계산 기준점)
  try {
    const { initSeedCapital } = await import('./risk/seed-capital.js');
    await initSeedCapital();
  } catch (e: any) {
    logger.warn(`기준자본 로드 실패 (기본값 사용): ${e.message}`, { component: 'BOOT' });
  }

  // 6-c. 쿨다운 리셋 상태 복원 (대시보드에서 수동 리셋한 상태 유지)
  try {
    const { restoreCooldownResetAt } = await import('./risk/trade-gate.js');
    await restoreCooldownResetAt();
  } catch (e: any) {
    logger.warn(`쿨다운 리셋 복원 실패 (무시): ${e.message}`, { component: 'BOOT' });
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

  // 6-1. 오늘 AI 점수가 없으면 즉시 Track A 실행 (재배포 후 점수 공백 자동 복구)
  try {
    const { getActiveWatchlist, getLatestScores } = await import('./db/client.js');
    const wl = await getActiveWatchlist();
    const codes = wl.map((w: any) => w.stock_code).slice(0, 5);
    if (codes.length > 0) {
      const scores = await getLatestScores(codes);
      const kstNow = new Date(Date.now() + 9 * 3600_000);
      const today = `${kstNow.getUTCFullYear()}-${String(kstNow.getUTCMonth() + 1).padStart(2, '0')}-${String(kstNow.getUTCDate()).padStart(2, '0')}`;
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

  // 대시보드 캐시 선제 빌드 — 재시작 후 첫 접속 30초 대기 방지
  setTimeout(() => {
    import('./api/routes/dashboard.js').then(({ prewarmDashboard }) => prewarmDashboard()).catch(() => {});
  }, 3000);

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
        await new Promise(r => setTimeout(r, 500));
      }
    } catch {}
    try { (await import('./db/client.js')).getPool().end(); } catch {}
    logger.info('Graceful shutdown 완료', { component: 'BOOT' });
    process.exit(0);
  };
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.error(`치명적 오류: ${err}`);
  process.exit(1);
});
