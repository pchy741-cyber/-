import { Hono } from 'hono';
import { getOverseasBalance, getOverseasDailyChart, getOverseasPrice } from '../../kis/overseas.js';
import { cacheGet, cacheSet } from '../../cache/memory.js';
import { logger } from '../../utils/logger.js';
import { getOverseasScores, setOverseasScores, type OverseasScoreEntry } from '../../cache/overseas-scores.js';
import { analyzeTechnicals, type OHLCV } from '../../analysis/indicators.js';

export const overseasRoutes = new Hono();

// 글로벌 감시목록 (미국 NYSE/NASDAQ + 일본·대만 ADR)
const GLOBAL_WATCHLIST = [
  { code: 'NVDA',  name: 'NVIDIA',           exchange: 'NASDAQ' },
  { code: 'AMD',   name: 'AMD',              exchange: 'NASDAQ' },
  { code: 'ANET',  name: 'Arista Networks',  exchange: 'NYSE'   },
  { code: 'VRT',   name: 'Vertiv',           exchange: 'NYSE'   },
  { code: 'META',  name: 'Meta',             exchange: 'NASDAQ' },
  { code: 'AAPL',  name: 'Apple',            exchange: 'NASDAQ' },
  { code: 'MSFT',  name: 'Microsoft',        exchange: 'NASDAQ' },
  { code: 'RTX',   name: 'RTX Corp',         exchange: 'NYSE'   },
  { code: 'LMT',   name: 'Lockheed Martin',  exchange: 'NYSE'   },
  { code: 'GEV',   name: 'GE Vernova',       exchange: 'NYSE'   },
  { code: 'PLTR',  name: 'Palantir',         exchange: 'NYSE'   },
  { code: 'ETN',   name: 'Eaton Corp',       exchange: 'NYSE'   },
  { code: 'PWR',   name: 'Quanta Services',  exchange: 'NYSE'   },
  { code: 'AMZN',  name: 'Amazon',           exchange: 'NASDAQ' },
  { code: 'GOOGL', name: 'Alphabet',         exchange: 'NASDAQ' },
  { code: 'ORCL',  name: 'Oracle',           exchange: 'NYSE'   },
  { code: 'NOW',   name: 'ServiceNow',       exchange: 'NYSE'   },
  { code: 'MELI',  name: 'MercadoLibre',     exchange: 'NASDAQ' },
  { code: 'AVGO',  name: 'Broadcom',         exchange: 'NASDAQ' },
  { code: 'TM',    name: 'Toyota Motor',     exchange: 'NYSE'   },
  { code: 'SONY',  name: 'Sony Group',       exchange: 'NYSE'   },
  { code: 'MUFG',  name: 'Mitsubishi UFJ',   exchange: 'NYSE'   },
  { code: 'TSM',   name: 'TSMC',             exchange: 'NYSE'   },
  { code: 'UMC',   name: 'United Micro',     exchange: 'NYSE'   },
];

// 해외주식 대시보드 (60초 캐시)
overseasRoutes.get('/overseas/dashboard', async (c) => {
  const cached = cacheGet<any>('overseas:dashboard');
  if (cached) return c.json(cached);

  // 가격 조회: DB 일괄 로드(즉시) → 인메모리 캐시 채우기 → KIS 백그라운드 갱신
  const pricePromise = (async () => {
    // 1. DB에서 모든 종목 가격 일괄 로드 (단일 쿼리, ~50ms)
    const dbPrices: Record<string, { price: number; changePct: number; volume: number }> = {};
    try {
      const { getPool } = await import('../../db/client.js');
      const codes = GLOBAL_WATCHLIST.map(s => s.code);
      const { rows } = await getPool().query(
        `SELECT code, price, change_pct, volume FROM overseas_prices WHERE code = ANY($1)`,
        [codes],
      );
      for (const row of rows) {
        dbPrices[row.code] = { price: Number(row.price), changePct: Number(row.change_pct), volume: Number(row.volume) };
        // DB 데이터로 인메모리 캐시 채우기 (아직 KIS 갱신 없으면 재시작 후 빠른 폴백용)
        if (!cacheGet(`overseas:lastprice:${row.code}`)) {
          cacheSet(`overseas:lastprice:${row.code}`, dbPrices[row.code], 86400);
        }
      }
    } catch { /* DB 접근 실패 시 인메모리 캐시만 사용 */ }

    // 2. 즉시 응답용 가격 배열 (인메모리 캐시 우선, DB 폴백)
    const prices = GLOBAL_WATCHLIST.map(stock => {
      const mem = cacheGet<any>(`overseas:lastprice:${stock.code}`);
      const db = dbPrices[stock.code];
      const d = mem ?? db;
      return { code: stock.code, name: stock.name, exchange: stock.exchange, price: d?.price ?? 0, changePct: d?.changePct ?? 0, volume: d?.volume ?? 0 };
    });

    // 3. KIS API 백그라운드 갱신 (응답 블로킹 없음 — 다음 60초 캐시 만료 후 반영)
    (async () => {
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
            cacheSet(`overseas:lastprice:${stock.code}`, { price: p.currentPrice, changePct: p.changePct, volume: p.volume }, 86400);
          }
        }
        if (i + BATCH < GLOBAL_WATCHLIST.length) await new Promise(r => setTimeout(r, 150));
      }
    })().catch(() => {});

    return prices;
  })();

  const holdingsPromise = (async () => {
    try {
      const { getPool } = await import('../../db/client.js');
      const { rows } = await getPool().query('SELECT * FROM overseas_holdings WHERE quantity > 0');
      return rows.map((r: any) => ({ stock_code: r.stock_code, quantity: Number(r.quantity), avg_price: Number(r.avg_price), last_price: Number(r.last_price ?? 0) }));
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

  // AI 기술점수 병합 (overseas-job에서 계산된 최신 점수)
  let scores = getOverseasScores();

  // 점수 캐시가 비어있으면 백그라운드 on-demand 계산 트리거 (비동기, 응답은 블로킹 안 함)
  if (scores.length === 0 && !_scoringInProgress) {
    _scoringInProgress = true;
    (async () => {
      try {
        const usStocks = GLOBAL_WATCHLIST.filter(s => s.exchange === 'NASDAQ' || s.exchange === 'NYSE');
        const results: OverseasScoreEntry[] = [];
        const BATCH = 6;
        for (let i = 0; i < usStocks.length; i += BATCH) {
          const batch = usStocks.slice(i, i + BATCH);
          const settled = await Promise.allSettled(
            batch.map(async (stock) => {
              const [price, chart] = await Promise.all([
                getOverseasPrice(stock.code, stock.exchange).catch(() => null),
                getOverseasDailyChart(stock.code, stock.exchange, 40).catch(() => null),
              ]);
              return { stock, price, chart };
            })
          );
          for (const r of settled) {
            if (r.status !== 'fulfilled') continue;
            const { stock, price, chart } = r.value;
            if (!chart || chart.length < 30) continue;
            const candles: OHLCV[] = chart.map((c: any) => ({
              date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
            }));
            const tech = analyzeTechnicals(candles);
            if (!tech) continue;
            results.push({ code: stock.code, name: stock.name, exchange: stock.exchange, region: 'US', score: tech.score, signal: tech.overallSignal, price: price?.currentPrice ?? 0, changePct: price?.changePct ?? 0, rsi: tech.rsi14, cachedAt: Date.now() });
          }
          if (i + BATCH < usStocks.length) await new Promise(r => setTimeout(r, 100));
        }
        if (results.length > 0) {
          setOverseasScores(results);
          cacheSet('overseas:dashboard', null as any, 0); // 다음 요청 시 점수 포함
          logger.info(`대시보드 트리거 해외점수 계산: ${results.length}종목`, { component: 'OVERSEAS' });
        }
      } catch (e: any) {
        logger.warn(`대시보드 트리거 해외점수 실패: ${e.message}`, { component: 'OVERSEAS' });
      } finally {
        _scoringInProgress = false;
      }
    })();
    // 첫 요청은 점수 없이 빠르게 반환 (다음 요청부터 점수 포함)
    scores = [];
  }

  const scoreMap = new Map(scores.map(s => [s.code, s]));
  const watchlistWithScores = prices.map(p => {
    const sc = scoreMap.get(p.code);
    return sc ? { ...p, score: sc.score, signal: sc.signal, rsi: sc.rsi } : p;
  });

  const result = { watchlist: watchlistWithScores, positions, holdings };
  cacheSet('overseas:dashboard', result, 60);
  return c.json(result);
});

// 해외주식 감시목록 조회
overseasRoutes.get('/overseas/watchlist', (c) => {
  return c.json(GLOBAL_WATCHLIST);
});

// ── 온디맨드 기술점수 계산 (AI 없음, 순수 지표) ──
// 캐시가 30분 이내면 즉시 반환, 아니면 차트 fetch + analyzeTechnicals 실행
let _scoringInProgress = false;

overseasRoutes.get('/overseas/scores', async (c) => {
  const fresh = getOverseasScores();
  if (fresh.length > 0) return c.json(fresh);

  // 크론이 아직 돌지 않은 경우 — 온디맨드 계산 (US만)
  if (_scoringInProgress) return c.json([]); // 중복 방지
  _scoringInProgress = true;

  try {
    const usStocks = GLOBAL_WATCHLIST.filter(s => s.exchange === 'NASDAQ' || s.exchange === 'NYSE');
    const results: OverseasScoreEntry[] = [];

    // 병렬 fetch (최대 6개씩)
    const BATCH = 6;
    for (let i = 0; i < usStocks.length; i += BATCH) {
      const batch = usStocks.slice(i, i + BATCH);
      const settled = await Promise.allSettled(
        batch.map(async (stock) => {
          const [price, chart] = await Promise.all([
            getOverseasPrice(stock.code, stock.exchange).catch(() => null),
            getOverseasDailyChart(stock.code, stock.exchange, 40).catch(() => null),
          ]);
          return { stock, price, chart };
        })
      );
      for (const r of settled) {
        if (r.status !== 'fulfilled') continue;
        const { stock, price, chart } = r.value;
        if (!chart || chart.length < 30) continue;
        const candles: OHLCV[] = chart.map((c: any) => ({
          date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
        }));
        const tech = analyzeTechnicals(candles);
        if (!tech) continue;
        results.push({
          code: stock.code,
          name: stock.name,
          exchange: stock.exchange,
          region: 'US',
          score: tech.score,
          signal: tech.overallSignal,
          price: price?.currentPrice ?? candles[0]?.close ?? 0,
          changePct: price?.changePct ?? 0,
          rsi: tech.rsi14,
          cachedAt: Date.now(),
        });
      }
      if (i + BATCH < usStocks.length) await new Promise(r => setTimeout(r, 100));
    }

    if (results.length > 0) setOverseasScores(results);
    // 대시보드 캐시 무효화 (다음 요청 시 점수 포함해서 내려감)
    cacheSet('overseas:dashboard', null as any, 0);
    logger.info(`온디맨드 해외점수 계산 완료: ${results.length}종목`, { component: 'OVERSEAS' });
    return c.json(results);
  } catch (e: any) {
    logger.error(`온디맨드 해외점수 실패: ${e.message}`, { component: 'OVERSEAS' });
    return c.json([]);
  } finally {
    _scoringInProgress = false;
  }
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

// 운영자 인사이트 조회/저장
overseasRoutes.get('/overseas/insights', async (c) => {
  try {
    const { getUserInsights } = await import('../../scheduler/overseas-job.js');
    const text = await getUserInsights();
    return c.json({ insights: text });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

overseasRoutes.put('/overseas/insights', async (c) => {
  try {
    const body = await c.req.json();
    const text = String(body.insights ?? '').trim();
    const { setUserInsights } = await import('../../scheduler/overseas-job.js');
    await setUserInsights(text);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── Vision Scalp: 이미지 분석 ──
// POST /overseas/vision-scalp/analyze  body: { imageBase64, mimeType }
overseasRoutes.post('/overseas/vision-scalp/analyze', async (c) => {
  try {
    const body = await c.req.json<{ imageBase64: string; mimeType: string }>();
    if (!body.imageBase64 || !body.mimeType) return c.json({ error: '이미지 필요' }, 400);
    const { analyzeImageForScalp } = await import('../../ai/vision/image-analyzer.js');
    const signal = await analyzeImageForScalp(body.imageBase64, body.mimeType);
    return c.json(signal);
  } catch (e: any) {
    logger.error(`[VisionScalp] 분석 실패: ${e.message}`, { component: 'OVERSEAS' });
    return c.json({ error: e.message }, 500);
  }
});

// POST /overseas/vision-scalp/execute  body: { ticker, exchange, amountUsd, reasoning }
overseasRoutes.post('/overseas/vision-scalp/execute', async (c) => {
  try {
    const body = await c.req.json<{ ticker: string; exchange: string; amountUsd: number; reasoning: string }>();
    const { ticker, exchange = 'NASDAQ', amountUsd = 200, reasoning = '' } = body;
    if (!ticker) return c.json({ error: '티커 필요' }, 400);

    const sanitizedTicker = ticker.toUpperCase().replace(/[^A-Z0-9.]/g, '');
    const safeAmount = Math.max(50, Math.min(1000, Number(amountUsd)));

    // 현재가 조회
    const price = await getOverseasPrice(sanitizedTicker, exchange);
    if (!price.currentPrice || price.currentPrice <= 0) {
      return c.json({ error: `${sanitizedTicker} 시세 조회 실패` }, 400);
    }

    const qty = Math.max(1, Math.floor(safeAmount / price.currentPrice));
    const totalCost = qty * price.currentPrice;

    // 현금 차감
    const { getPool } = await import('../../db/client.js');
    const pool = getPool();
    const { rows: cashRows } = await pool.query("SELECT value FROM overseas_state WHERE key = 'cash'");
    const currentCash = cashRows.length > 0 ? Number(cashRows[0].value) : 10000;
    if (currentCash < totalCost) {
      return c.json({ error: `해외 현금 부족 (보유: $${currentCash.toFixed(0)}, 필요: $${totalCost.toFixed(0)})` }, 400);
    }

    // TP +2.5%, SL -1.5% (단타 파라미터)
    const tpPrice = +(price.currentPrice * 1.025).toFixed(2);
    const slPrice = +(price.currentPrice * 0.985).toFixed(2);

    // scalp 포지션 기록 (overseas_holdings + scalp_tp/sl 컬럼)
    await pool.query(`
      ALTER TABLE overseas_holdings
        ADD COLUMN IF NOT EXISTS scalp_tp NUMERIC DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS scalp_sl NUMERIC DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS is_scalp BOOLEAN DEFAULT FALSE
    `).catch(() => {});

    await pool.query(`
      INSERT INTO overseas_holdings (stock_code, exchange, quantity, avg_price, bought_at, scalp_tp, scalp_sl, is_scalp)
      VALUES ($1, $2, $3, $4, NOW(), $5, $6, TRUE)
      ON CONFLICT (exchange, stock_code) DO UPDATE
        SET quantity = overseas_holdings.quantity + $3,
            avg_price = (overseas_holdings.avg_price * overseas_holdings.quantity + $4 * $3) / (overseas_holdings.quantity + $3),
            scalp_tp = $5, scalp_sl = $6, is_scalp = TRUE
    `, [sanitizedTicker, exchange, qty, price.currentPrice, tpPrice, slPrice]);

    await pool.query(
      `INSERT INTO overseas_state (key, value) VALUES ('cash', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
      [(currentCash - totalCost).toFixed(2)],
    );

    logger.info(`[VisionScalp] 매수 ${sanitizedTicker} ${qty}주 @ $${price.currentPrice} (TP:$${tpPrice} SL:$${slPrice})`, { component: 'OVERSEAS' });

    return c.json({
      ok: true,
      ticker: sanitizedTicker,
      qty,
      price: price.currentPrice,
      totalCost,
      tpPrice,
      slPrice,
      reasoning,
    });
  } catch (e: any) {
    logger.error(`[VisionScalp] 실행 실패: ${e.message}`, { component: 'OVERSEAS' });
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
