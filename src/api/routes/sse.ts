import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { config, baseIsPaper } from '../../config/index.js';
import { getActiveStrategy, getOpenChains, getPool } from '../../db/client.js';
import { getAccountBalance } from '../../kis/account.js';
import { isMarketOpen } from '../../kis/market.js';
import { getKillSwitchStatusAll } from '../../risk/kill-switch.js';
import { getPaperBalance } from '../../risk/engine.js';
import { getLoopStatus } from '../../scheduler/loop-mode.js';
import { cacheGet, getCachedPriceMemory } from '../../cache/memory.js';
import { getCopilotLiteScore } from './review/copilot-lite.js';
import { getLastAutoPilotResult } from '../../ai/auto-pilot.js';

export const sseRoutes = new Hono();

// 최신 체결 거래 가져오기 (SSE 페이로드용 — 최근 10건)
async function getRecentTrades(isPaper?: boolean) {
  const tradingMode = isPaper !== undefined
    ? (isPaper ? 'paper' : 'live')
    : config.tradingMode;
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
       LIMIT 10`,
      [tradingMode],
    );
    return rows;
  } catch {
    return [];
  }
}

/**
 * SSE (Server-Sent Events) 실시간 대시보드 스트림
 *
 * 프론트엔드에서 EventSource로 연결하면:
 * - 5초마다 포트폴리오 실시간 업데이트
 * - 최신 거래내역 10건 포함 (체결 즉시 반영)
 * - Kill Switch 상태 변경 즉시 전송
 * - 장중에만 활성 (장외에는 30초 간격)
 */
sseRoutes.get('/stream', (c) => {
  // ?viewMode=paper|live — 보기 모드 (서버 거래 모드와 독립)
  const viewModeParam = c.req.query('viewMode');
  const viewIsPaper = viewModeParam === 'paper' ? true : viewModeParam === 'live' ? false : baseIsPaper;

  return streamSSE(c, async (stream) => {
    let id = 0;

    while (true) {
      try {
        const balanceFn = viewIsPaper ? getPaperBalance : () => getAccountBalance(true);
        const [balance, chains, recentTrades, strategy, healthLite] = await Promise.all([
          balanceFn(),
          getOpenChains(viewIsPaper),
          getRecentTrades(viewIsPaper),
          getActiveStrategy().catch(() => null),
          getCopilotLiteScore(viewIsPaper).catch(() => ({ score: 0, issues: [] })),
        ]);

        // 해외 holdings 수 (캐시에서 빠르게 조회 — DB 호출 없음)
        const holdingsLiveKey = `overseas:holdings:${viewIsPaper ? 'paper' : 'live'}`;
        const overseasHoldings = cacheGet<any[]>(holdingsLiveKey);
        const overseasHoldingCount = overseasHoldings?.length ?? 0;

        // 체인별 실시간 가격 (캐시 기반 — 추가 KIS 호출 없음)
        // 캐시 미스 시 avg_buy_price 폴백 → PnL=0% 깜빡임 방지: 캐시 있는 종목만 전송
        const chainPrices = chains.reduce((acc: any[], ch: any) => {
          const cached = getCachedPriceMemory(ch.stock_code);
          if (cached == null || cached <= 0) return acc; // 캐시 없으면 스킵 — 기존 값 유지
          const avgPrice = Number(ch.avg_buy_price ?? 0);
          const qty = Number(ch.total_quantity ?? 0);
          const unrealizedPnl = avgPrice > 0 ? (cached - avgPrice) * qty : 0;
          const unrealizedPnlPct = avgPrice > 0 ? ((cached - avgPrice) / avgPrice) * 100 : 0;
          acc.push({ stock_code: ch.stock_code, currentPrice: cached, unrealizedPnl, unrealizedPnlPct });
          return acc;
        }, []);

        const payload = {
          timestamp: new Date().toISOString(),
          portfolio: {
            totalValue: balance.totalDeposit + balance.totalEvalAmount,
            cash: balance.orderableCash,
            invested: balance.totalEvalAmount,
            pnl: balance.totalProfitLoss,
            pnlPct: balance.totalProfitLossPct,
            positionCount: balance.positions.length,
            unrealizedPnl: chainPrices.reduce((s, c) => s + c.unrealizedPnl, 0),
          },
          chainPrices, // 체인별 실시간 가격/PnL
          overseasHoldingCount,
          killSwitch: getKillSwitchStatusAll(),
          activeChains: chains.length,
          marketOpen: isMarketOpen(),
          recentTrades,
          strategy: strategy ? { mode: strategy.mode, buy_threshold: strategy.buy_threshold, take_profit_pct: strategy.take_profit_pct, stop_loss_pct: strategy.stop_loss_pct } : null,
          healthScore: healthLite.score,
          healthIssues: healthLite.issues,
          loopMode: (() => { try { const ls = getLoopStatus(); return { active: ls.active, phase: ls.phase, totalRuns: ls.totalRuns, lastRunAt: ls.lastRunAt, lastRunResult: ls.lastRunResult, startedAt: ls.startedAt, adaptiveIntervalMs: ls.adaptiveIntervalMs, consecutiveErrors: ls.consecutiveErrors, marketPhase: ls.marketPhase, openMarkets: ls.openMarkets, anyMarketOpen: ls.anyMarketOpen, brief: ls.sessionBrief ? { regime: ls.sessionBrief.marketRegime, risk: ls.sessionBrief.riskLevel, narrative: ls.sessionBrief.narrative } : null }; } catch { return null; } })(),
          autoPilot: (() => { try { const ap = getLastAutoPilotResult(); const r = viewIsPaper ? ap.paper : ap.live; return r ? { overridesSet: r.overridesSet, decisions: r.decisions.slice(0, 5), lastRunAt: ap.lastRunAt } : null; } catch { return null; } })(),
        };

        await stream.writeSSE({
          data: JSON.stringify(payload),
          event: 'update',
          id: String(++id),
        });
      } catch {
        await stream.writeSSE({
          data: JSON.stringify({ error: 'data fetch failed' }),
          event: 'error',
          id: String(++id),
        });
      }

      // 장중: 10초 (KIS API 부하 + 카톡 알림 최소화), 장외: 120초
      const interval = isMarketOpen() ? 10_000 : 120_000;
      await stream.sleep(interval);
    }
  });
});
