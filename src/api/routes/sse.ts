import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getLastAutoPilotResult } from '../../ai/auto-pilot.js';
import { cacheGet, cachePriceMemory, getCachedPriceMemory, getLastKnownPriceMemory } from '../../cache/memory.js';
import { baseIsPaper } from '../../config/index.js';
import { getActiveStrategy, getOpenChains, getPool } from '../../db/client.js';
import { getAccountBalance } from '../../kis/account.js';
import { getCurrentPrice, isMarketOpen } from '../../kis/market.js';
import { getPaperBalance } from '../../risk/engine.js';
import { getKillSwitchStatusAll } from '../../risk/kill-switch.js';
import { getLastRiskSizing } from '../../risk/risk-engine.js';
import { getLoopStatus } from '../../scheduler/loop-mode.js';
import { getOpenMarketRegions } from '../../scheduler/overseas/session.js';
import { KR_FEE, FALLBACK_FX_RATE, OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { logger } from '../../utils/logger.js';
import { PAPER_INITIAL_CAPITAL } from '../../risk/paper-balance.js';
import { resolveRequestMode } from '../guards/live-pin.js';
import { calcTotalAssets } from './dashboard/calc.js';
import { getFxRate } from './dashboard/helpers.js';
import { getRecentEvents } from './health.js';
import { getCopilotLiteScore } from './review/copilot-lite.js';

// ── 전역 메타 페이로드 캐시 (연결 수 무관, DB 쿼리 30초에 2회 — paper/live 각 1회) ──
// Promise coalescing: N개 연결이 동시에 깨어나도 DB 쿼리는 1번만 실행
const _metaCache = new Map<boolean, { payload: string; ts: number }>();
const _metaInFlight = new Map<boolean, Promise<string>>();
const META_CACHE_TTL = 28_000; // 28s — 30s 메타 인터벌보다 짧게 설정

/** SSE 메타 캐시 무효화 — 매매 후 대시보드 캐시와 함께 호출 */
export function invalidateSseMetaCache(): void {
  _metaCache.clear();
}

// ── 보유종목 가격 티커 (10초 간격, 추가 비용 $0) ──
// paper/live 별 분리 — 모드 간 갱신 누락 방지
const _lastPriceRefreshAt: Record<string, number> = { paper: 0, live: 0 };
const PRICE_REFRESH_MS = 10_000;

// ── SSE 동시 연결 수 제한 ──
let _sseConnectionCount = 0;
const MAX_SSE_CONNECTIONS = 10;

async function refreshHeldPrices(chains: Array<{ stock_code: string }>, isPaper: boolean): Promise<void> {
  if (!isMarketOpen()) return;
  const now = Date.now();
  const modeKey = isPaper ? 'paper' : 'live';
  if (now - (_lastPriceRefreshAt[modeKey] ?? 0) < PRICE_REFRESH_MS) return;
  _lastPriceRefreshAt[modeKey] = now;

  const krCodes = chains.map((ch) => ch.stock_code).filter((code) => /^\d{6}$/.test(code));
  if (krCodes.length === 0) return;

  // v17 fix: 15s 캐시만 체크 — 기존: 2h lastKnown도 체크 → 한번 fetch 후 2시간 동결 버그
  // lastKnown(2h)은 buildChainPrices에서 폴백용으로만 사용 (KIS API 장애 시)
  const staleCodes = krCodes.filter((code) => getCachedPriceMemory(code) == null);
  if (staleCodes.length === 0) return;

  const results = await Promise.allSettled(
    staleCodes.map((code) =>
      getCurrentPrice(code).then((p) => {
        if (p.currentPrice > 0) cachePriceMemory(code, p.currentPrice);
      }),
    ),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  if (ok > 0) {
    logger.info(`[PRICE_TICKER] 보유종목 시세 갱신: ${ok}/${staleCodes.length}종목`, { component: 'SSE' });
  }
}

// 체인별 가격 빌드 (캐시 기반, DB 호출 없음)
function buildChainPrices(chains: any[], totalPortfolioValue: number) {
  return chains.reduce((acc: any[], ch: any) => {
    const cached = getCachedPriceMemory(ch.stock_code) ?? getLastKnownPriceMemory(ch.stock_code);
    if (cached == null || cached <= 0) return acc;
    const avgPrice = Number(ch.avg_buy_price ?? 0);
    const qty = Number(ch.total_quantity ?? 0);
    const unrealizedPnl = avgPrice > 0 ? (cached - avgPrice) * qty : 0;
    const unrealizedPnlPct = avgPrice > 0 ? ((cached - avgPrice) / avgPrice) * 100 : 0;
    const marketValue = cached * qty;
    const weight = totalPortfolioValue > 0 ? Math.round((marketValue / totalPortfolioValue) * 1000) / 10 : 0;
    acc.push({ stock_code: ch.stock_code, currentPrice: cached, unrealizedPnl, unrealizedPnlPct, weight });
    return acc;
  }, []);
}

export const sseRoutes = new Hono();

// SSE 메타 캐시 무효화 등록 — hardInvalidateDashboardCache() 시 자동 동기 무효화
import { registerSseMetaInvalidator } from '../../cache/dashboard-cache.js';
registerSseMetaInvalidator(invalidateSseMetaCache);

// 오늘 매매 통계 (KST 기준 — 클라이언트 TZ 의존 제거)
export async function getTodayTradeStats(isPaper?: boolean) {
  const tradingMode = isPaper !== undefined ? (isPaper ? 'paper' : 'live') : (baseIsPaper ? 'paper' : 'live');
  try {
    const { rows } = await getPool().query(
      `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE o.side = 'SELL' AND o.stock_code ~ '^[0-9]{6}$') AS kr_sells,
        -- v14-fix: 주문 단위 PnL (chain realized_pnl은 체인 전체값이라 중복 집계됨)
        COALESCE(SUM(
          CASE WHEN o.side = 'SELL' AND o.stock_code ~ '^[0-9]{6}$'
               AND COALESCE(tc.avg_buy_price, o.avg_buy_price, 0) > 0 AND o.filled_price > 0 THEN
            (o.filled_price * COALESCE(o.filled_quantity, o.quantity, 0)
             - ROUND(o.filled_price * COALESCE(o.filled_quantity, o.quantity, 0) * ${KR_FEE.SELL_FEE_PCT}))
            - (COALESCE(tc.avg_buy_price, o.avg_buy_price) * COALESCE(o.filled_quantity, o.quantity, 0))
          END
        ), 0) AS kr_realized_pnl,
        COUNT(*) FILTER (WHERE o.stock_code !~ '^[0-9]{6}$' AND o.side = 'SELL') AS us_sells,
        COALESCE(SUM(
          CASE WHEN o.side = 'SELL' AND o.stock_code !~ '^[0-9]{6}$'
               AND COALESCE(o.avg_buy_price, tc.avg_buy_price, 0) > 0 AND o.filled_price > 0 THEN
            (o.filled_price * (1 - ${OVERSEAS_FEE_PCT}) - COALESCE(o.avg_buy_price, tc.avg_buy_price) * (1 + ${OVERSEAS_FEE_PCT}))
            * COALESCE(o.filled_quantity, o.quantity, 0)
          END
        ), 0) AS us_realized_pnl_usd
      FROM orders o
      LEFT JOIN transaction_chains tc ON o.chain_id = tc.id
      WHERE o.status = 'FILLED'
        AND (o.trading_mode = $1::text OR ($1::text = 'paper' AND o.trading_mode = 'p_arch'))
        AND (o.created_at AT TIME ZONE 'Asia/Seoul')::DATE = (NOW() AT TIME ZONE 'Asia/Seoul')::DATE
    `,
      [tradingMode],
    );
    const r = rows[0] ?? {};
    const result = {
      totalTrades: Number(r.total ?? 0),
      krSellCount: Number(r.kr_sells ?? 0),
      krRealizedPnl: Math.round(Number(r.kr_realized_pnl ?? 0)),
      usSellCount: Number(r.us_sells ?? 0),
      usRealizedPnlUsd: Math.round(Number(r.us_realized_pnl_usd ?? 0) * 100) / 100,
    };
    if (result.totalTrades > 0) {
      logger.info(
        `todayStats: mode=${tradingMode} total=${result.totalTrades} krPnl=${result.krRealizedPnl} usPnl=$${result.usRealizedPnlUsd}`,
        { component: 'SSE' },
      );
    }
    return result;
  } catch (err) {
    logger.error(`getTodayTradeStats 에러: ${err}`, { component: 'SSE' });
    return { totalTrades: 0, krSellCount: 0, krRealizedPnl: 0, usSellCount: 0, usRealizedPnlUsd: 0 };
  }
}

// 최신 체결 거래 가져오기 (SSE 페이로드용 — 최근 10건)
async function getRecentTrades(isPaper?: boolean) {
  const tradingMode = isPaper !== undefined ? (isPaper ? 'paper' : 'live') : (baseIsPaper ? 'paper' : 'live');
  try {
    const { rows } = await getPool().query(
      `SELECT o.id, o.stock_code, o.side, o.status,
              o.quantity, o.filled_quantity, o.filled_price,
              o.trading_mode, o.trigger_source, o.ai_reasoning,
              o.created_at, o.chain_id,
              COALESCE(w.stock_name, o.stock_code) AS stock_name,
              CASE WHEN tc.id IS NOT NULL THEN json_build_object(
                'stock_code', tc.stock_code,
                'status', tc.status,
                'strategy_mode', tc.strategy_mode,
                'avg_buy_price', tc.avg_buy_price
              ) END AS transaction_chains
       FROM orders o
       LEFT JOIN watchlist w ON o.stock_code = w.stock_code
       LEFT JOIN transaction_chains tc ON o.chain_id = tc.id
       WHERE o.status IN ('FILLED', 'PENDING')
         AND (o.trading_mode = $1::text OR ($1::text = 'paper' AND o.trading_mode = 'p_arch'))
       ORDER BY o.created_at DESC
       LIMIT 30`,
      [tradingMode],
    );
    return rows;
  } catch {
    return [];
  }
}

// ── 메타 페이로드 빌더 (Promise coalescing 대상) ──
async function buildMetaPayload(viewIsPaper: boolean): Promise<string> {
  const balanceFn = viewIsPaper ? getPaperBalance : () => getAccountBalance(true);
  const [balance, chains, recentTrades, strategy, healthLite, todayStats, newInsightRes] = await Promise.all([
    balanceFn(),
    getOpenChains(viewIsPaper),
    getRecentTrades(viewIsPaper),
    getActiveStrategy().catch(() => null),
    getCopilotLiteScore(viewIsPaper).catch(() => ({ score: 0, issues: [] })),
    getTodayTradeStats(viewIsPaper).catch(() => ({
      totalTrades: 0, krSellCount: 0, krRealizedPnl: 0, usSellCount: 0, usRealizedPnlUsd: 0,
    })),
    // newInsightCount를 Promise.all에 포함 (직렬→병렬)
    getPool().query(
      `SELECT COUNT(*)::int AS cnt FROM learned_insights
       WHERE last_updated >= NOW() - INTERVAL '24 hours' AND is_paper = $1`,
      [viewIsPaper],
    ).then((r) => Number(r.rows[0]?.cnt ?? 0)).catch(() => 0),
  ]);

  // 해외 포트폴리오 요약 (DB 기반)
  const holdingsLiveKey = `overseas:holdings:${viewIsPaper ? 'paper' : 'live'}`;
  const overseasHoldings = cacheGet<any[]>(holdingsLiveKey);
  const overseasHoldingCount = overseasHoldings?.length ?? 0;
  let overseasSummary: {
    cashUsd: number; cashKrw: number; seedKrw: number; evalUsd: number;
    investedUsd: number; totalUsd: number;
    holdings: { code: string; qty: number; pnlPct: number }[];
    investedKrw: number; evalKrw: number; fxRate: number;
  } | null = null;
  try {
    const p = getPool();
    const holdRes = await p.query(
      'SELECT stock_code, quantity, avg_price, last_price FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1',
      [viewIsPaper],
    );
    let cashUsd = 0;
    let cashKrw = 0;
    let seedKrw = 0;
    let osFxRate = 0;
    if (viewIsPaper) {
      const { computePaperCash, getPaperSeedKrw } = await import('../../scheduler/overseas/state.js');
      osFxRate = await getFxRate().catch(() => 0) || FALLBACK_FX_RATE;
      cashUsd = await computePaperCash(osFxRate);
      cashKrw = cashUsd * osFxRate;
      seedKrw = getPaperSeedKrw();
    } else {
      const [usdR, krwR] = await Promise.all([
        p.query("SELECT value FROM overseas_state WHERE key = 'cash_live_usd'"),
        p.query("SELECT value FROM overseas_state WHERE key = 'cash'"),
      ]);
      cashUsd = Number(usdR.rows[0]?.value ?? 0);
      cashKrw = Number(krwR.rows[0]?.value ?? 0);
      osFxRate = cashUsd > 0 ? cashKrw / cashUsd : FALLBACK_FX_RATE;
    }
    let evalUsd = 0;
    let investedUsd = 0;
    const holdings = holdRes.rows.map((h: any) => {
      const qty = Number(h.quantity);
      const avg = Number(h.avg_price ?? 0);
      // 인메모리 가격 캐시 우선 → DB last_price → avg_price (주가 반영 보장)
      const cachedEntry = cacheGet<{ price: number }>(`overseas:lastprice:${h.stock_code}`);
      const last = (cachedEntry?.price ?? 0) > 0 ? cachedEntry!.price : Number(h.last_price || avg);
      evalUsd += last * qty;
      investedUsd += avg * qty;
      return { code: h.stock_code, qty, pnlPct: avg > 0 ? ((last - avg) / avg) * 100 : 0 };
    });
    overseasSummary = { cashUsd, cashKrw, seedKrw, evalUsd, investedUsd, totalUsd: cashUsd + evalUsd, holdings, investedKrw: Math.round(investedUsd * osFxRate), evalKrw: Math.round(evalUsd * osFxRate), fxRate: osFxRate };
  } catch {
    /* 해외 데이터 조회 실패 시 null 유지 */
  }

  // 보유종목 가격 갱신
  await refreshHeldPrices(chains, viewIsPaper).catch(() => {});

  // ── calcTotalAssets — FX는 FALLBACK_FX_RATE 통일 ──
  const fxRate = await getFxRate().catch(() => 0) || FALLBACK_FX_RATE;

  // v10.11: 전일 스냅샷 + 실현손익 조회 (기존: 하드코딩 0 → 전일대비 수익률 항상 0%)
  let ssePrevDayTotalValue = 0;
  let ssePrevDayUnrealizedPnl = 0;
  let sseLiveRealizedPnl = 0;
  try {
    const p = getPool();
    const [snapRes, realizedRes] = await Promise.all([
      p.query<{ total_value: string; unrealized_pnl: string }>(
        `SELECT total_value, unrealized_pnl FROM portfolio_snapshots
         WHERE is_paper = $1 AND total_value > 0
           AND snapshot_at < (NOW() AT TIME ZONE 'Asia/Seoul')::DATE
         ORDER BY snapshot_at DESC LIMIT 1`,
        [viewIsPaper],
      ),
      viewIsPaper ? Promise.resolve({ rows: [] as any[] }) :
        p.query<{ total: string }>(
          `SELECT COALESCE(SUM(realized_pnl),0) AS total FROM transaction_chains
           WHERE is_paper = $1 AND status = 'CLOSED'`,
          [viewIsPaper],
        ),
    ]);
    if (snapRes.rows[0]) {
      ssePrevDayTotalValue = Number(snapRes.rows[0].total_value);
      ssePrevDayUnrealizedPnl = Number(snapRes.rows[0].unrealized_pnl ?? 0);
    }
    sseLiveRealizedPnl = Number(realizedRes.rows[0]?.total ?? 0);
  } catch { /* 스냅샷 조회 실패 → 0 유지 (기존 동작) */ }

  // 체인 집계: 국내 투자원가 + 미실현PnL
  let totalChainInvested = 0;
  let totalChainPnl = 0;
  for (const ch of chains as any[]) {
    const avg = Number(ch.avg_buy_price ?? 0);
    const qty = Number(ch.total_quantity ?? 0);
    totalChainInvested += avg * qty;
    const cached = getCachedPriceMemory(ch.stock_code) ?? getLastKnownPriceMemory(ch.stock_code);
    if (cached && cached > 0 && avg > 0) {
      totalChainPnl += (cached - avg) * qty;
    }
  }

  const assets = calcTotalAssets({
    viewIsPaper,
    rawCash: balance.orderableCash ?? 0,
    netAsset: balance.netAsset ?? 0,
    kisDomEval: balance.totalEvalAmount ?? 0,
    kisPurchaseCost: (balance as any).purchaseCost ?? 0,
    kisTotalProfitLoss: balance.totalProfitLoss ?? 0,
    kisTotalProfitLossPct: balance.totalProfitLossPct ?? 0,
    cashSource: (balance as any).cashSource ?? 'unknown',
    totalChainInvested,
    totalChainPnl,
    overseasTotalInvestedUsd: overseasSummary?.investedUsd ?? 0,
    overseasMarketValueUsd: overseasSummary?.evalUsd ?? 0,
    overseasCashRaw: viewIsPaper ? (overseasSummary?.cashUsd ?? 0) : (overseasSummary?.cashKrw ?? 0),
    overseasMaxUsd: 0,
    overseasLiveUsd: 0,
    fxRate,
    paperInitialCapital: PAPER_INITIAL_CAPITAL,
    liveRealizedPnl: sseLiveRealizedPnl,
    prevDayTotalValue: ssePrevDayTotalValue,
    prevDayUnrealizedPnl: ssePrevDayUnrealizedPnl,
  });

  const chainPrices = buildChainPrices(chains, assets.grandTotalValue);
  const sseUnrealizedPnl = Math.round(
    viewIsPaper ? totalChainPnl : (balance.totalProfitLoss || totalChainPnl),
  );

  const payload = {
    timestamp: new Date().toISOString(),
    portfolio: {
      totalValue: assets.grandTotalValue,
      cash: assets.totalCash,
      invested: assets.totalInvested,
      domesticInvested: assets.domesticInvested,
      domesticEval: assets.domesticMarketValue,
      domesticCash: assets.unifiedCash,
      unrealizedPnl: sseUnrealizedPnl,
      pnl: Math.round(assets.totalPnl), // totalPnl already includes overseasUnrealizedPnlKrw (calc.ts:185)
      pnlPct: assets.totalPnlPct,
      positionCount: balance.positions.length,
    },
    chainPrices,
    overseasHoldingCount,
    overseasSummary,
    killSwitch: getKillSwitchStatusAll(),
    activeChains: chains.length,
    marketOpen: isMarketOpen(),
    recentTrades,
    strategy: strategy
      ? {
          mode: strategy.mode,
          buy_threshold: strategy.buy_threshold,
          take_profit_pct: strategy.take_profit_pct,
          stop_loss_pct: strategy.stop_loss_pct,
        }
      : null,
    healthScore: healthLite.score,
    healthIssues: healthLite.issues,
    loopMode: (() => {
      try {
        const ls = getLoopStatus();
        return {
          active: ls.active, phase: ls.phase, totalRuns: ls.totalRuns,
          lastRunAt: ls.lastRunAt, lastRunResult: ls.lastRunResult,
          startedAt: ls.startedAt, adaptiveIntervalMs: ls.adaptiveIntervalMs,
          consecutiveErrors: ls.consecutiveErrors, marketPhase: ls.marketPhase,
          openMarkets: ls.openMarkets, anyMarketOpen: ls.anyMarketOpen,
          brief: ls.sessionBrief
            ? { regime: ls.sessionBrief.marketRegime, risk: ls.sessionBrief.riskLevel, narrative: ls.sessionBrief.narrative }
            : null,
        };
      } catch { return null; }
    })(),
    autoPilot: (() => {
      try {
        const ap = getLastAutoPilotResult();
        const r = viewIsPaper ? ap.paper : ap.live;
        return r
          ? { overridesSet: r.overridesSet, decisions: r.decisions.slice(0, 5), lastRunAt: ap.lastRunAt }
          : null;
      } catch { return null; }
    })(),
    recentEvents: getRecentEvents(10, viewIsPaper ? 'paper' : 'live'),
    todayStats,
    newInsightCount: newInsightRes,
    riskSizing: (() => {
      const rs = getLastRiskSizing();
      return rs.updatedAt > 0 ? { multiplier: rs.multiplier, factors: rs.factors } : null;
    })(),
  };

  return JSON.stringify(payload);
}

/**
 * SSE (Server-Sent Events) 실시간 대시보드 스트림 v3
 *
 * 2채널 분리:
 * - 'prices' 이벤트: 3초마다, chainPrices만 (~200바이트)
 * - 'meta' 이벤트: 30초마다, 전체 페이로드 (포트폴리오, 거래, 건강 등)
 * - 장외: 120초마다 meta만, 30초마다 keepalive ping
 *
 * v3 개선:
 * - stream.aborted 체크 → 좀비 루프 방지
 * - Promise coalescing → N연결이어도 DB 1회
 * - retry 10s → thundering herd 방지
 * - keepalive ping → 프록시 타임아웃 방지
 * - 연결 수 제한 (MAX_SSE_CONNECTIONS)
 * - FX rate 통일 (FALLBACK_FX_RATE)
 * - paper/live 별 가격 갱신 분리
 */
sseRoutes.get('/stream', (c) => {
  const viewIsPaper = resolveRequestMode(c);

  if (_sseConnectionCount >= MAX_SSE_CONNECTIONS) {
    return c.json({ error: 'SSE 연결 한도 초과' }, 429);
  }

  return streamSSE(c, async (stream) => {
    _sseConnectionCount++;
    let id = 0;
    let lastMetaAt = 0;
    let lastKeepaliveAt = 0;
    let cachedChains: any[] = [];
    let cachedTotalPortfolio = 0;

    const PRICE_INTERVAL = 3_000;
    const META_INTERVAL = 30_000;
    const CLOSED_INTERVAL = 120_000;
    const KEEPALIVE_MS = 30_000;

    // 첫 이벤트: retry 설정 (재접속 간격 10초 — thundering herd 방지)
    await stream.writeSSE({ data: '', event: 'ping', id: '0', retry: 10000 });

    try {
      while (!stream.aborted) {
        const anyMarketOpen = isMarketOpen() || getOpenMarketRegions().size > 0;
        const now = Date.now();
        const needMeta = now - lastMetaAt >= (anyMarketOpen ? META_INTERVAL : CLOSED_INTERVAL);

        try {
          // keepalive ping (장외 시 30초마다 — 프록시/Cloud Run 타임아웃 방지)
          if (!anyMarketOpen && now - lastKeepaliveAt >= KEEPALIVE_MS && !needMeta) {
            lastKeepaliveAt = now;
            await stream.writeSSE({ data: '', event: 'ping', id: String(++id) });
          }

          if (needMeta) {
            lastMetaAt = now;
            lastKeepaliveAt = now; // meta도 keepalive 역할

            // Promise coalescing: 캐시 → 인플라이트 → 새 빌드
            const metaCached = _metaCache.get(viewIsPaper);
            let metaPayload: string;
            if (metaCached && now - metaCached.ts < META_CACHE_TTL) {
              metaPayload = metaCached.payload;
            } else {
              let metaPromise = _metaInFlight.get(viewIsPaper);
              if (!metaPromise) {
                metaPromise = buildMetaPayload(viewIsPaper);
                _metaInFlight.set(viewIsPaper, metaPromise);
                metaPromise.finally(() => _metaInFlight.delete(viewIsPaper));
              }
              metaPayload = await metaPromise;
              _metaCache.set(viewIsPaper, { payload: metaPayload, ts: Date.now() });
            }

            await stream.writeSSE({ data: metaPayload, event: 'meta', id: String(++id) });

            // cachedChains/cachedTotalPortfolio 갱신 (가격 틱에서 재사용)
            try {
              const parsed = JSON.parse(metaPayload);
              cachedTotalPortfolio = parsed.portfolio?.totalValue ?? cachedTotalPortfolio;
              cachedChains = await getOpenChains(viewIsPaper);
            } catch {}
          } else if (anyMarketOpen && cachedChains.length > 0) {
            // ── 경량 가격 틱 (DB 호출 없음, 캐시 기반) ──
            await refreshHeldPrices(cachedChains, viewIsPaper).catch(() => {});
            const chainPrices = buildChainPrices(cachedChains, cachedTotalPortfolio);

            if (chainPrices.length > 0) {
              await stream.writeSSE({
                data: JSON.stringify({ timestamp: new Date().toISOString(), chainPrices }),
                event: 'prices',
                id: String(++id),
              });
            }
          }
        } catch {
          try {
            await stream.writeSSE({
              data: JSON.stringify({ error: 'data fetch failed' }),
              event: 'stream_error',
              id: String(++id),
            });
          } catch {
            break; // 연결 끊김 — 루프 탈출
          }
        }

        // 장외 시 KEEPALIVE_MS(30s) 간격으로 루프 — 120s에 1회 meta + 중간에 ping 전송 가능
        const sleepMs = anyMarketOpen ? PRICE_INTERVAL : KEEPALIVE_MS;
        await stream.sleep(sleepMs);
      }
    } finally {
      _sseConnectionCount--;
    }
  });
});
