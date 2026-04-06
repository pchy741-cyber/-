import { Hono } from 'hono';
import type { StrategyMode } from '../config/constants.js';
import { getActiveWatchlist } from '../db/client.js';
import { getDailyChart } from '../kis/market.js';
import { type BacktestConfig, runBacktest } from './engine.js';

/**
 * 백테스트 API
 * 대시보드에서 "이 전략이면 과거에 얼마 벌었을까?" 검증
 */
export const backtestRoutes = new Hono();

// 단일 종목 백테스트
backtestRoutes.post('/backtest/single', async (c) => {
  const { stockCode, mode, capital, days, buyThreshold } = await c.req.json();

  const chart = await getDailyChart(stockCode, days ?? 120);
  if (chart.length < 60) {
    return c.json({ error: '차트 데이터 부족 (최소 60일 필요)' }, 400);
  }

  const config: BacktestConfig = {
    mode: (mode ?? 'SWING') as StrategyMode,
    initialCapital: capital ?? 1000000,
    buyThreshold,
  };

  const candles = chart.map((c) => ({
    date: c.date,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));

  const result = runBacktest(candles, stockCode, config);

  return c.json({
    stockCode,
    period: `${chart[chart.length - 1]?.date} ~ ${chart[0]?.date}`,
    ...result,
    trades: result.trades.slice(0, 50), // 최근 50건만
  });
});

// 전 종목 일괄 백테스트
backtestRoutes.post('/backtest/all', async (c) => {
  const { mode, capital, days } = await c.req.json();
  const watchlist = await getActiveWatchlist();

  const results = [];
  for (const stock of watchlist) {
    try {
      const chart = await getDailyChart(stock.stock_code, days ?? 120);
      if (chart.length < 60) continue;

      const candles = chart.map((c) => ({
        date: c.date,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));

      const result = runBacktest(candles, stock.stock_code, {
        mode: (mode ?? 'SWING') as StrategyMode,
        initialCapital: capital ?? 1000000,
      });

      results.push({
        stockCode: stock.stock_code,
        stockName: stock.stock_name,
        returnPct: result.totalReturnPct,
        winRate: result.winRate,
        sharpe: result.sharpeRatio,
        maxDD: result.maxDrawdownPct,
        trades: result.totalTrades,
      });

      await new Promise((r) => setTimeout(r, 200));
    } catch {
      /* skip */
    }
  }

  // 수익률 순 정렬
  results.sort((a, b) => b.returnPct - a.returnPct);

  return c.json({
    totalStocks: results.length,
    avgReturn: results.length > 0 ? (results.reduce((s, r) => s + r.returnPct, 0) / results.length).toFixed(2) : 0,
    results,
  });
});
