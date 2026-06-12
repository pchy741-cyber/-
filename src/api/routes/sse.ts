import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getLastAutoPilotResult } from '../../ai/auto-pilot.js';
import { cacheGet, cachePriceMemory, getCachedPriceMemory } from '../../cache/memory.js';
import { config } from '../../config/index.js';
import { getActiveStrategy, getOpenChains, getPool } from '../../db/client.js';
import { getAccountBalance } from '../../kis/account.js';
import { getCurrentPrice, isMarketOpen } from '../../kis/market.js';
import { getPaperBalance } from '../../risk/engine.js';
import { getKillSwitchStatusAll } from '../../risk/kill-switch.js';
import { getLoopStatus } from '../../scheduler/loop-mode.js';
import { logger } from '../../utils/logger.js';
import { resolveRequestMode } from '../guards/live-pin.js';
import { getRecentEvents } from './health.js';
import { getCopilotLiteScore } from './review/copilot-lite.js';

// ── 보유종목 가격 티커 (10초 간격, 추가 비용 $0) ──
// 전역 dedup: 여러 SSE 연결이 동시에 있어도 10초에 1회만 호출
let _lastPriceRefreshAt = 0;
const PRICE_REFRESH_MS = 10_000;

async function refreshHeldPrices(chains: Array<{ stock_code: string }>): Promise<void> {
  if (!isMarketOpen()) return;
  const now = Date.now();
  if (now - _lastPriceRefreshAt < PRICE_REFRESH_MS) return;
  _lastPriceRefreshAt = now;

  // 국내 보유종목만 (6자리 숫자 코드)
  const krCodes = chains.map((ch) => ch.stock_code).filter((code) => /^\d{6}$/.test(code));
  if (krCodes.length === 0) return;

  // 캐시 stale인 종목만 갱신 (이미 fresh면 skip)
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
    const cached = getCachedPriceMemory(ch.stock_code);
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

// 오늘 매매 통계 (KST 기준 — 클라이언트 TZ 의존 제거)
export async function getTodayTradeStats(isPaper?: boolean) {
  const tradingMode = isPaper !== undefined ? (isPaper ? 'paper' : 'live') : config.tradingMode;
  try {
    const { rows } = await getPool().query(
      `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE o.side = 'SELL' AND o.stock_code ~ '^[0-9]{6}$') AS kr_sells,
        COALESCE(SUM(
          CASE WHEN o.side = 'SELL' AND o.stock_code ~ '^[0-9]{6}$'
            AND COALESCE(tc.avg_buy_price, o.avg_buy_price, 0) > 0 AND o.filled_price > 0 THEN
            (o.filled_price - COALESCE(tc.avg_buy_price, o.avg_buy_price)) * COALESCE(o.filled_quantity, o.quantity, 0)
          END
        ), 0) AS kr_realized_pnl,
        COUNT(*) FILTER (WHERE o.stock_code !~ '^[0-9]{6}$' AND o.side = 'SELL') AS us_sells,
        COALESCE(SUM(
          CASE WHEN o.side = 'SELL' AND o.stock_code !~ '^[0-9]{6}$'
            AND COALESCE(o.avg_buy_price, tc.avg_buy_price, 0) > 0 AND o.filled_price > 0 THEN
            (o.filled_price - COALESCE(o.avg_buy_price, tc.avg_buy_price)) * COALESCE(o.filled_quantity, o.quantity, 0)
          END
        ), 0) AS us_realized_pnl_usd
      FROM orders o
      LEFT JOIN transaction_chains tc ON o.chain_id = tc.id
      WHERE o.status = 'FILLED'
        AND o.trading_mode = $1
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
  const tradingMode = isPaper !== undefined ? (isPaper ? 'paper' : 'live') : config.tradingMode;
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
         AND o.trading_mode = $1
       ORDER BY o.created_at DESC
       LIMIT 30`,
      [tradingMode],
    );
    return rows;
  } catch {
    return [];
  }
}

/**
 * SSE (Server-Sent Events) 실시간 대시보드 스트림 v2
 *
 * 2채널 분리:
 * - 'prices' 이벤트: 3초마다, chainPrices만 (~200바이트)
 * - 'meta' 이벤트: 30초마다, 전체 페이로드 (포트폴리오, 거래, 건강 등)
 * - 장외: 120초마다 meta만
 */
sseRoutes.get('/stream', (c) => {
  // ?viewMode=paper|live — 보기 모드 (서버 거래 모드와 독립)
  const viewIsPaper = resolveRequestMode(c);

  return streamSSE(c, async (stream) => {
    let id = 0;
    let lastMetaAt = 0;

    // 메타 틱 사이 가격 틱에서 재사용할 캐시
    let cachedChains: any[] = [];
    let cachedTotalPortfolio = 0;

    const PRICE_INTERVAL = 3_000; // 장중 가격 틱
    const META_INTERVAL = 30_000; // 장중 메타 틱
    const CLOSED_INTERVAL = 120_000; // 장외

    while (true) {
      const { getOpenMarketRegions } = await import('../../scheduler/overseas/session.js');
      const anyMarketOpen = isMarketOpen() || getOpenMarketRegions().size > 0;
      const now = Date.now();
      const needMeta = now - lastMetaAt >= (anyMarketOpen ? META_INTERVAL : CLOSED_INTERVAL);

      try {
        if (needMeta) {
          // ── 전체 메타 페이로드 빌드 ──
          lastMetaAt = now;
          const balanceFn = viewIsPaper ? getPaperBalance : () => getAccountBalance(true);
          const [balance, chains, recentTrades, strategy, healthLite, todayStats] = await Promise.all([
            balanceFn(),
            getOpenChains(viewIsPaper),
            getRecentTrades(viewIsPaper),
            getActiveStrategy().catch(() => null),
            getCopilotLiteScore(viewIsPaper).catch(() => ({ score: 0, issues: [] })),
            getTodayTradeStats(viewIsPaper).catch(() => ({
              totalTrades: 0,
              krSellCount: 0,
              krRealizedPnl: 0,
              usSellCount: 0,
              usRealizedPnlUsd: 0,
            })),
          ]);

          // 캐시 갱신 (가격 틱에서 재사용)
          cachedChains = chains;
          cachedTotalPortfolio = (balance.orderableCash ?? 0) + (balance.totalEvalAmount ?? 0);

          // 해외 포트폴리오 요약 (DB 기반)
          const holdingsLiveKey = `overseas:holdings:${viewIsPaper ? 'paper' : 'live'}`;
          const overseasHoldings = cacheGet<any[]>(holdingsLiveKey);
          const overseasHoldingCount = overseasHoldings?.length ?? 0;
          let overseasSummary: {
            cashUsd: number;
            cashKrw: number;
            seedKrw: number;
            evalUsd: number;
            totalUsd: number;
            holdings: { code: string; qty: number; pnlPct: number }[];
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
            if (viewIsPaper) {
              const { computePaperCash, getPaperSeedKrw } = await import('../../scheduler/overseas/state.js');
              const { fetchExchangeRate } = await import('../../automation/macro-data.js');
              const fxRate = await fetchExchangeRate();
              cashUsd = await computePaperCash(fxRate);
              cashKrw = cashUsd * fxRate;
              seedKrw = getPaperSeedKrw();
            } else {
              const [usdR, krwR] = await Promise.all([
                p.query("SELECT value FROM overseas_state WHERE key = 'cash_live_usd'"),
                p.query("SELECT value FROM overseas_state WHERE key = 'cash'"),
              ]);
              cashUsd = Number(usdR.rows[0]?.value ?? 0);
              cashKrw = Number(krwR.rows[0]?.value ?? 0);
            }
            let evalUsd = 0;
            const holdings = holdRes.rows.map((h: any) => {
              const qty = Number(h.quantity);
              const avg = Number(h.avg_price ?? 0);
              const last = Number(h.last_price ?? avg);
              evalUsd += last * qty;
              return { code: h.stock_code, qty, pnlPct: avg > 0 ? ((last - avg) / avg) * 100 : 0 };
            });
            overseasSummary = { cashUsd, cashKrw, seedKrw, evalUsd, totalUsd: cashUsd + evalUsd, holdings };
          } catch {
            /* 해외 데이터 조회 실패 시 null 유지 */
          }

          // 보유종목 가격 갱신
          await refreshHeldPrices(chains).catch(() => {});

          const chainPrices = buildChainPrices(chains, cachedTotalPortfolio);

          const payload = {
            timestamp: new Date().toISOString(),
            portfolio: {
              totalValue: balance.totalDeposit + balance.totalEvalAmount,
              cash: balance.orderableCash,
              invested: balance.totalEvalAmount,
              pnl: balance.totalProfitLoss,
              pnlPct: balance.totalProfitLossPct,
              positionCount: balance.positions.length,
              unrealizedPnl: chainPrices.reduce((s: number, c: any) => s + c.unrealizedPnl, 0),
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
                  active: ls.active,
                  phase: ls.phase,
                  totalRuns: ls.totalRuns,
                  lastRunAt: ls.lastRunAt,
                  lastRunResult: ls.lastRunResult,
                  startedAt: ls.startedAt,
                  adaptiveIntervalMs: ls.adaptiveIntervalMs,
                  consecutiveErrors: ls.consecutiveErrors,
                  marketPhase: ls.marketPhase,
                  openMarkets: ls.openMarkets,
                  anyMarketOpen: ls.anyMarketOpen,
                  brief: ls.sessionBrief
                    ? {
                        regime: ls.sessionBrief.marketRegime,
                        risk: ls.sessionBrief.riskLevel,
                        narrative: ls.sessionBrief.narrative,
                      }
                    : null,
                };
              } catch {
                return null;
              }
            })(),
            autoPilot: (() => {
              try {
                const ap = getLastAutoPilotResult();
                const r = viewIsPaper ? ap.paper : ap.live;
                return r
                  ? { overridesSet: r.overridesSet, decisions: r.decisions.slice(0, 5), lastRunAt: ap.lastRunAt }
                  : null;
              } catch {
                return null;
              }
            })(),
            recentEvents: getRecentEvents(10),
            todayStats,
          };

          await stream.writeSSE({
            data: JSON.stringify(payload),
            event: 'meta',
            id: String(++id),
          });
        } else if (anyMarketOpen && cachedChains.length > 0) {
          // ── 경량 가격 틱 (DB 호출 없음, 캐시 기반) ──
          await refreshHeldPrices(cachedChains).catch(() => {});
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
        await stream.writeSSE({
          data: JSON.stringify({ error: 'data fetch failed' }),
          event: 'error',
          id: String(++id),
        });
      }

      const sleepMs = anyMarketOpen ? PRICE_INTERVAL : CLOSED_INTERVAL;
      await stream.sleep(sleepMs);
    }
  });
});
