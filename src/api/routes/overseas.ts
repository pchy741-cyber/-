import { Hono } from 'hono';
import { getOverseasBalance, getOverseasDailyChart, getOverseasPrice } from '../../kis/overseas.js';
import { cacheGet, cacheSet } from '../../cache/memory.js';
import { logger } from '../../utils/logger.js';

export const overseasRoutes = new Hono();

// 글로벌 감시목록 (미국 + 일본 + 대만)
const GLOBAL_WATCHLIST = [
  { code: 'AAPL', name: 'Apple', exchange: 'NASDAQ' },
  { code: 'NVDA', name: 'NVIDIA', exchange: 'NASDAQ' },
  { code: 'MSFT', name: 'Microsoft', exchange: 'NASDAQ' },
  { code: 'GOOGL', name: 'Google', exchange: 'NASDAQ' },
  { code: 'AMZN', name: 'Amazon', exchange: 'NASDAQ' },
  { code: 'TSLA', name: 'Tesla', exchange: 'NASDAQ' },
  { code: 'META', name: 'Meta', exchange: 'NASDAQ' },
  { code: '7203', name: 'Toyota', exchange: 'TSE' },
  { code: '6758', name: 'Sony', exchange: 'TSE' },
  { code: '6861', name: 'Keyence', exchange: 'TSE' },
  { code: '2330', name: 'TSMC', exchange: 'TPE' },
  { code: '2317', name: 'Foxconn', exchange: 'TPE' },
  { code: '2454', name: 'MediaTek', exchange: 'TPE' },
];

// 해외주식 대시보드 (60초 캐시)
overseasRoutes.get('/overseas/dashboard', async (c) => {
  const cached = cacheGet<any>('overseas:dashboard');
  if (cached) return c.json(cached);

  // 가격 조회 + DB 보유종목 + KIS 잔고를 모두 병렬 시작
  const pricePromise = (async () => {
    const prices: Array<{ code: string; name: string; exchange: string; price: number; changePct: number; volume: number }> = [];
    const BATCH = 5;
    for (let i = 0; i < GLOBAL_WATCHLIST.length; i += BATCH) {
      const batch = GLOBAL_WATCHLIST.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(stock => getOverseasPrice(stock.code, stock.exchange))
      );
      for (let j = 0; j < batch.length; j++) {
        const stock = batch[j];
        const result = results[j];
        if (result.status === 'fulfilled' && result.value.currentPrice > 0) {
          const p = result.value;
          prices.push({ code: stock.code, name: stock.name, exchange: stock.exchange, price: p.currentPrice, changePct: p.changePct, volume: p.volume });
          cacheSet(`overseas:lastprice:${stock.code}`, { price: p.currentPrice, changePct: p.changePct, volume: p.volume }, 86400);
        } else {
          const last = cacheGet<any>(`overseas:lastprice:${stock.code}`);
          prices.push({
            code: stock.code, name: stock.name, exchange: stock.exchange,
            price: last?.price ?? 0, changePct: last?.changePct ?? 0, volume: last?.volume ?? 0,
          });
        }
      }
      if (i + BATCH < GLOBAL_WATCHLIST.length) {
        await new Promise(r => setTimeout(r, 150));
      }
    }
    return prices;
  })();

  const holdingsPromise = (async () => {
    try {
      const { getPool } = await import('../../db/client.js');
      const { rows } = await getPool().query('SELECT * FROM overseas_holdings WHERE quantity > 0');
      return rows.map((r: any) => ({ stock_code: r.stock_code, quantity: Number(r.quantity), avg_price: Number(r.avg_price) }));
    } catch { return []; }
  })();

  // KIS 잔고: 5분 캐시 적용 (느린 API, 자주 바뀌지 않음)
  const positionsPromise = (async () => {
    const cachedPos = cacheGet<any[]>('overseas:balance');
    if (cachedPos) return cachedPos;
    try {
      const pos = await getOverseasBalance();
      cacheSet('overseas:balance', pos, 300); // 5분 캐시
      return pos;
    } catch { return []; }
  })();

  const [prices, holdings, positions] = await Promise.all([pricePromise, holdingsPromise, positionsPromise]);

  const result = { watchlist: prices, positions, holdings };
  cacheSet('overseas:dashboard', result, 60);
  return c.json(result);
});

// 해외주식 감시목록 조회
overseasRoutes.get('/overseas/watchlist', (c) => {
  return c.json(GLOBAL_WATCHLIST);
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
