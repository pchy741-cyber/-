/**
 * dashboard 모듈 배럴 — 모든 대시보드 라우트를 단일 진입점으로 조합
 */
import { Hono } from 'hono';
import { config, baseIsPaper } from '../../../config/index.js';
import { runWithMode } from '../../../config/context.js';
import { watchlistRoutes } from './watchlist-routes.js';
import { tradeRoutes } from './trade-routes.js';
import { sellRoutes } from './sell-routes.js';
import {
  getDashCache, setDashCache, getDashBuildingByMode, getDashCacheTTL,
} from './helpers.js';
import { getOrBuildDashPayload } from './builder.js';

export const dashboardRoutes = new Hono();

// ── 대시보드 요약 ──
dashboardRoutes.get('/dashboard', async (c) => {
  const viewModeParam = c.req.query('viewMode');
  const viewIsPaper = viewModeParam === 'paper' ? true : viewModeParam === 'live' ? false : baseIsPaper;
  const cacheKey = viewIsPaper ? 'paper' : 'live';

  const cached = getDashCache(cacheKey);
  if (cached) {
    const age = Date.now() - cached.ts;
    const stale = age >= getDashCacheTTL();
    if (!stale) return c.json(cached.data);
    // 2분 미만 stale → SWR (stale 반환 + 백그라운드 빌드)
    // 2분 이상 stale → fresh 빌드 대기 (오래된 숫자 표시 방지)
    if (age < 120_000) {
      if (!getDashBuildingByMode().has(cacheKey)) {
        runWithMode(viewIsPaper, () => getOrBuildDashPayload(viewIsPaper))
          .then(p => setDashCache(cacheKey, p))
          .catch(() => {});
      }
      return c.json(cached.data);
    }
    // 2분+ stale → fall through to fresh build below
  }
  const timeoutMs = 25_000;
  const timeoutPromise = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error('dashboard timeout')), timeoutMs));
  try {
    const payload = await Promise.race([getOrBuildDashPayload(viewIsPaper), timeoutPromise]);
    setDashCache(cacheKey, payload);
    return c.json(payload);
  } catch (e: any) {
    if (e.message === 'dashboard timeout') {
      // 빌드 타임아웃 — 백그라운드에서 계속 빌드 (dedup이 관리), 다음 요청에서 캐시 히트
      return c.json({ error: 'timeout', message: '대시보드 로딩 시간 초과 — 잠시 후 재시도' }, 503);
    }
    throw e;
  }
});

// 서브 라우터 마운트
dashboardRoutes.route('/', watchlistRoutes);
dashboardRoutes.route('/', tradeRoutes);
dashboardRoutes.route('/', sellRoutes);

// 하위 호환 re-export
export { invalidateDashboardCache, invalidateModeCache, isInvalidStockName, getKnownStockName } from './helpers.js';
export { prewarmDashboard } from './builder.js';
