import { Hono } from 'hono';
import { OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { getOverseasBalance, getOverseasDailyChart, getOverseasPrice, placeOverseasOrder } from '../../kis/overseas.js';
import { config } from '../../config/index.js';
import { cacheGet, cacheSet } from '../../cache/memory.js';
import { logger } from '../../utils/logger.js';
import { getOverseasScores, setOverseasScores, type OverseasScoreEntry } from '../../cache/overseas-scores.js';
import { analyzeTechnicals, type OHLCV } from '../../analysis/indicators.js';
import { notifyOverseasSell } from '../../notifications/web-push.js';

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
  const viewModeParam = c.req.query('viewMode');
  const viewIsPaper = viewModeParam === 'paper' ? true : viewModeParam === 'live' ? false : config.isPaper;
  const cacheKey = `overseas:dashboard:${viewIsPaper ? 'paper' : 'live'}`;
  const cached = cacheGet<any>(cacheKey);
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

  const holdingsCacheKey = `overseas:holdings:${viewIsPaper ? 'paper' : 'live'}`;
  const holdingsPromise = (async () => {
    try {
      const { getPool } = await import('../../db/client.js');
      const { rows } = await getPool().query('SELECT * FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1', [viewIsPaper]);
      const holdings = rows.map((r: any) => ({ stock_code: r.stock_code, quantity: Number(r.quantity), avg_price: Number(r.avg_price), last_price: Number(r.last_price ?? 0) }));
      // DB 성공 시 holdings 백업 캐시 저장 (5분 TTL — DB 장애 시 폴백용)
      if (holdings.length > 0) cacheSet(holdingsCacheKey, holdings, 300);
      return holdings;
    } catch {
      // DB 실패 시 이전 캐시된 holdings 반환 (데이터 유실 방지)
      const fallback = cacheGet<any[]>(holdingsCacheKey);
      if (fallback && fallback.length > 0) {
        logger.warn(`해외 holdings DB 실패 → 캐시 폴백 (${fallback.length}종목)`, { component: 'OVERSEAS' });
        return fallback;
      }
      return [];
    }
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
          cacheSet('overseas:dashboard:paper', null as any, 0);
          cacheSet('overseas:dashboard:live', null as any, 0);
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

  const result = { watchlist: watchlistWithScores, positions: viewIsPaper ? [] : positions, holdings };
  cacheSet(cacheKey, result, 60);
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

    const qty = Math.max(1, Math.floor(safeAmount / (price.currentPrice * 1.0025)));
    const totalCost = qty * price.currentPrice * 1.0025; // 수수료 0.25% 포함

    // TP +2.5%, SL -1.5% (단타 파라미터)
    const tpPrice = +(price.currentPrice * 1.025).toFixed(2);
    const slPrice = +(price.currentPrice * 0.985).toFixed(2);
    const vsCashKey = config.isPaper ? 'cash_paper' : 'cash';

    let filledPrice = price.currentPrice;
    let orderNo = `VSP${Date.now().toString(36)}`;

    if (!config.isPaper) {
      // 실전 모드: KIS 실주문
      const result = await placeOverseasOrder({
        stockCode: sanitizedTicker, exchange, side: 'BUY', quantity: qty, price: price.currentPrice,
      });
      if (!result.success) {
        return c.json({ error: `KIS 매수 실패: ${result.message}` }, 502);
      }
      orderNo = result.orderNo ?? orderNo;
      logger.info(`[VisionScalp] LIVE 매수 주문 접수: ${sanitizedTicker} ${qty}주 (${orderNo})`, { component: 'OVERSEAS' });
    }

    // scalp 포지션 기록 + 주문 기록 + 현금 차감
    const { withTransaction } = await import('../../db/client.js');
    const { insertOrder } = await import('../../db/client.js');
    const { getCash: getOsCash } = await import('../../scheduler/overseas/state.js');

    // Paper: computed cash 확인 / Live: overseas_state 확인
    const currentCash = await getOsCash(config.isPaper);
    if (!Number.isFinite(currentCash) || currentCash < totalCost) {
      return c.json({ error: `해외 현금 부족 (보유: $${currentCash.toFixed(0)}, 필요: $${totalCost.toFixed(0)})` }, 400);
    }

    await withTransaction(async (tx) => {
      await tx.query(`
        INSERT INTO overseas_holdings (stock_code, exchange, quantity, avg_price, bought_at, scalp_tp, scalp_sl, is_scalp, is_paper)
        VALUES ($1, $2, $3, $4, NOW(), $5, $6, TRUE, $7)
        ON CONFLICT (exchange, stock_code, is_paper) DO UPDATE
          SET quantity = overseas_holdings.quantity + $3,
              avg_price = (overseas_holdings.avg_price * overseas_holdings.quantity + $4 * $3) / (overseas_holdings.quantity + $3),
              scalp_tp = $5, scalp_sl = $6, is_scalp = TRUE
      `, [sanitizedTicker, exchange, qty, filledPrice, tpPrice, slPrice, config.isPaper]);

      // 매수 주문 기록 (Paper computed cash에 필수 — 이전에 누락됐던 부분)
      await tx.query(
        `INSERT INTO orders (stock_code, side, order_type, quantity, price, filled_quantity, filled_price,
          kis_order_no, status, trading_mode, trigger_source, ai_reasoning)
         VALUES ($1, 'BUY', 'MARKET', $2, $3, $2, $3, $4, 'FILLED', $5, 'OVERSEAS', $6)`,
        [sanitizedTicker, qty, filledPrice, orderNo, config.isPaper ? 'paper' : 'live',
         `Vision단타 매수 $${safeAmount} (TP:$${tpPrice} SL:$${slPrice})`]);

      // Live만 overseas_state 현금 차감 (Paper는 computed)
      if (!config.isPaper) {
        await tx.query(
          `UPDATE overseas_state SET value = (CAST(value AS NUMERIC) - $2)::text WHERE key = $1`,
          [vsCashKey, totalCost.toFixed(2)],
        );
      }
    });

    logger.info(`[VisionScalp] 매수 ${sanitizedTicker} ${qty}주 @ $${filledPrice} (TP:$${tpPrice} SL:$${slPrice}) [${config.isPaper ? 'PAPER' : 'LIVE'}]`, { component: 'OVERSEAS' });

    return c.json({
      ok: true,
      ticker: sanitizedTicker,
      qty,
      price: filledPrice,
      totalCost,
      tpPrice,
      slPrice,
      reasoning,
      mode: config.isPaper ? 'paper' : 'live',
    });
  } catch (e: any) {
    logger.error(`[VisionScalp] 실행 실패: ${e.message}`, { component: 'OVERSEAS' });
    return c.json({ error: e.message }, 500);
  }
});

// Claude Code 야간 감시 루프 매도 엔드포인트 (CLAUDE.md /api/overseas/sell)
overseasRoutes.post('/overseas/sell', async (c) => {
  // requireAuth 미들웨어가 이미 인증 처리
  let body: { stock_code?: string; quantity?: number; reason?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: '요청 형식 오류' }, 400); }
  const { stock_code, quantity, reason = '야간 감시 매도' } = body;
  if (!stock_code) return c.json({ error: 'stock_code 필수' }, 400);

  try {
    const { getPool } = await import('../../db/client.js');
    const isPaper = config.isPaper;
    const { rows } = await getPool().query(
      'SELECT * FROM overseas_holdings WHERE stock_code = $1 AND quantity > 0 AND is_paper = $2', [stock_code, isPaper]);
    const holding = rows[0];
    if (!holding) return c.json({ error: '보유 종목 없음' }, 404);

    const totalQty = Number(holding.quantity);
    const qty = quantity && quantity > 0 ? Math.min(quantity, totalQty) : totalQty;
    const exchange = String(holding.exchange ?? 'NASDAQ');
    const avgPrice = Number(holding.avg_price ?? 0);
    const osCashKey = isPaper ? 'cash_paper' : 'cash';

    let fillPrice = Number(holding.last_price ?? 0);
    try {
      const px = await getOverseasPrice(stock_code, exchange);
      if ((px?.currentPrice ?? 0) > 0) fillPrice = px.currentPrice;
    } catch { /* 폴백 */ }
    if (fillPrice <= 0) fillPrice = avgPrice;

    if (isPaper) {
      const orderNo = `CLN${Date.now().toString(36)}`;
      const { withTransaction } = await import('../../db/client.js');
      await withTransaction(async (client) => {
        if (qty >= totalQty) {
          await client.query('DELETE FROM overseas_holdings WHERE stock_code = $1 AND exchange = $2 AND is_paper = true', [stock_code, exchange]);
          await client.query('DELETE FROM overseas_state WHERE key = $1', [`maxprice_${stock_code}`]);
        } else {
          await client.query('UPDATE overseas_holdings SET quantity = quantity - $3 WHERE stock_code = $1 AND exchange = $2 AND is_paper = true', [stock_code, exchange, qty]);
        }
        // Paper: cash는 computed (orders 기반) → overseas_state 업데이트 불필요
        await client.query(
          `INSERT INTO orders (stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning, avg_buy_price)
           VALUES ($1,'SELL','MARKET',$2,$3,$2,$3,$4,'FILLED','paper','OVERSEAS',$5,$6)`,
          [stock_code, qty, fillPrice, orderNo, reason, avgPrice]);
      });
      logger.info(`[OverseasSell] ${stock_code} ${qty}주 @$${fillPrice} (야간감시 모의)`, { component: 'OVERSEAS' });
      try {
        const stockName = GLOBAL_WATCHLIST.find(s => s.code === stock_code)?.name ?? stock_code;
        const pnlPct = avgPrice > 0 ? ((fillPrice - avgPrice) / avgPrice) * 100 : 0;
        await notifyOverseasSell(stock_code, stockName, qty, fillPrice, pnlPct, reason);
      } catch { /* 알림 실패 무시 */ }
      return c.json({ ok: true, orderNo, filledQty: qty, filledPrice: fillPrice });
    }

    const result = await placeOverseasOrder({ stockCode: stock_code, exchange, side: 'SELL', quantity: qty, price: 0 });
    if (!result.success) return c.json({ error: `KIS 매도 실패: ${result.message}` }, 502);
    const liveProceeds = fillPrice * qty * (1 - OVERSEAS_FEE_PCT); // 수수료 0.25% 차감
    const { withTransaction } = await import('../../db/client.js');
    await withTransaction(async (client) => {
      if (qty >= totalQty) {
        await client.query('DELETE FROM overseas_holdings WHERE stock_code = $1 AND exchange = $2 AND is_paper = $3', [stock_code, exchange, isPaper]);
        await client.query('DELETE FROM overseas_state WHERE key = $1', [`maxprice_${stock_code}`]);
      } else {
        await client.query('UPDATE overseas_holdings SET quantity = quantity - $3 WHERE stock_code = $1 AND exchange = $2 AND is_paper = $3', [stock_code, exchange, qty, isPaper]);
      }
      await client.query(
        `INSERT INTO overseas_state (key, value) VALUES ($2, $1::text)
         ON CONFLICT (key) DO UPDATE SET value = (CAST(overseas_state.value AS NUMERIC) + $1)::text`,
        [liveProceeds, osCashKey]);
      await client.query(
        `INSERT INTO orders (stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning, avg_buy_price)
         VALUES ($1,'SELL','MARKET',$2,$3,$2,$3,$4,'FILLED','live','OVERSEAS',$5,$6)`,
        [stock_code, qty, fillPrice, result.orderNo ?? '', reason, avgPrice]);
    });
    logger.info(`[OverseasSell] ${stock_code} ${qty}주 (야간감시 실거래 ${result.orderNo})`, { component: 'OVERSEAS' });
    try {
      const stockName = GLOBAL_WATCHLIST.find(s => s.code === stock_code)?.name ?? stock_code;
      const pnlPct = avgPrice > 0 ? ((fillPrice - avgPrice) / avgPrice) * 100 : 0;
      await notifyOverseasSell(stock_code, stockName, qty, fillPrice, pnlPct, reason);
    } catch { /* 알림 실패 무시 */ }
    return c.json({ ok: true, orderNo: result.orderNo, filledQty: qty, filledPrice: fillPrice });
  } catch (err: any) {
    logger.error(`[OverseasSell] 예외: ${err.message}`, { component: 'OVERSEAS' });
    return c.json({ error: err.message }, 500);
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
