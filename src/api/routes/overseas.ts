import { Hono } from 'hono';
import { getOverseasBalance, getOverseasDailyChart, getOverseasPrice } from '../../kis/overseas.js';
import { cacheGet, cacheSet } from '../../cache/memory.js';
import { logger } from '../../utils/logger.js';

export const overseasRoutes = new Hono();

// 미국주식 감시목록
const US_WATCHLIST = [
  { code: 'AAPL', name: 'Apple', exchange: 'NASDAQ' },
  { code: 'NVDA', name: 'NVIDIA', exchange: 'NASDAQ' },
  { code: 'MSFT', name: 'Microsoft', exchange: 'NASDAQ' },
  { code: 'GOOGL', name: 'Google', exchange: 'NASDAQ' },
  { code: 'AMZN', name: 'Amazon', exchange: 'NASDAQ' },
  { code: 'TSLA', name: 'Tesla', exchange: 'NASDAQ' },
  { code: 'META', name: 'Meta', exchange: 'NASDAQ' },
];

// 미국주식 대시보드 (60초 캐시)
overseasRoutes.get('/overseas/dashboard', async (c) => {
  const cached = cacheGet<any>('overseas:dashboard');
  if (cached) return c.json(cached);

  const prices: Array<{ code: string; name: string; exchange: string; price: number; changePct: number; volume: number }> = [];

  for (const stock of US_WATCHLIST) {
    try {
      const p = await getOverseasPrice(stock.code, stock.exchange);
      prices.push({ code: stock.code, name: stock.name, exchange: stock.exchange, price: p.currentPrice, changePct: p.changePct, volume: p.volume });
    } catch {
      prices.push({ code: stock.code, name: stock.name, exchange: stock.exchange, price: 0, changePct: 0, volume: 0 });
    }
  }

  let positions: any[] = [];
  try { positions = await getOverseasBalance(); } catch { /* no positions */ }

  const result = { watchlist: prices, positions };
  cacheSet('overseas:dashboard', result, 60); // 60초 캐시
  return c.json(result);
});

// 미국주식 감시목록 조회
overseasRoutes.get('/overseas/watchlist', (c) => {
  return c.json(US_WATCHLIST);
});

// 개별 종목 현재가
overseasRoutes.get('/overseas/price/:code', async (c) => {
  const code = c.req.param('code');
  const exchange = c.req.query('exchange') || 'NASDAQ';
  try {
    const price = await getOverseasPrice(code, exchange);
    return c.json(price);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// 개별 종목 일봉 차트
overseasRoutes.get('/overseas/chart/:code', async (c) => {
  const code = c.req.param('code');
  const exchange = c.req.query('exchange') || 'NASDAQ';
  try {
    const chart = await getOverseasDailyChart(code, exchange, 60);
    return c.json(chart);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
