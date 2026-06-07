/**
 * 대시보드 라우트 — 모듈화 완료, dashboard/ 디렉토리로 분할
 *
 * 구조:
 *   dashboard/helpers.ts       — 종목명, 환율, 캐시 관리 (~90줄)
 *   dashboard/builder.ts       — buildDashPayload, prewarmDashboard (~300줄)
 *   dashboard/watchlist-routes.ts — /search/stock, /watchlist/*, /flow, /kis-balance (~300줄)
 *   dashboard/trade-routes.ts  — /trades, /stats/*, /sources/*, /withdraw/* (~260줄)
 *   dashboard/sell-routes.ts   — /sell/*, /escape/*, /sell-overseas/*, /manual-buy (~330줄)
 *   dashboard/index.ts         — 라우터 조합 + 배럴 export
 */
export {
  dashboardRoutes,
  invalidateDashboardCache,
  hardInvalidateDashboardCache,
  invalidateModeCache,
  isInvalidStockName,
  getKnownStockName,
  prewarmDashboard,
} from './dashboard/index.js';
