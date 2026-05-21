import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getOpenChains, getPool } from '../../db/client.js';
import { getAccountBalance } from '../../kis/account.js';
import { isMarketOpen } from '../../kis/market.js';
import { getKillSwitchStatus } from '../../risk/kill-switch.js';

export const sseRoutes = new Hono();

// 최신 체결 거래 가져오기 (SSE 페이로드용 — 최근 10건)
async function getRecentTrades() {
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
       ORDER BY o.created_at DESC
       LIMIT 10`,
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
  return streamSSE(c, async (stream) => {
    let id = 0;

    while (true) {
      try {
        const [balance, chains, recentTrades] = await Promise.all([
          getAccountBalance(),
          getOpenChains(),
          getRecentTrades(),
        ]);

        const payload = {
          timestamp: new Date().toISOString(),
          portfolio: {
            totalValue: balance.totalDeposit + balance.totalEvalAmount,
            cash: balance.orderableCash,
            invested: balance.totalEvalAmount,
            pnl: balance.totalProfitLoss,
            pnlPct: balance.totalProfitLossPct,
            positionCount: balance.positions.length,
          },
          killSwitch: getKillSwitchStatus(),
          activeChains: chains.length,
          marketOpen: isMarketOpen(),
          recentTrades,
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

      // 장중: 10초, 장외: 60초
      const interval = isMarketOpen() ? 10000 : 60000;
      await stream.sleep(interval);
    }
  });
});
