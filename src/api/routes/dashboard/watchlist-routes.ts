/**
 * 워치리스트 관련 라우트 — /search/stock, /watchlist/*, /flow, /kis-balance
 */
import { Hono } from 'hono';
import { getPortfolioFlowStatus } from '../../../automation/ceo-workflow.js';
import { cachePriceMemory, getLastKnownPricesMemory } from '../../../cache/memory.js';
import { getLastKnownPrices } from '../../../cache/redis.js';
import { baseIsPaper } from '../../../config/index.js';
import { getActiveWatchlist, getPool } from '../../../db/client.js';
import { getAccountBalance } from '../../../kis/account.js';
import {
  type CurrentPrice,
  getBatchPrices,
  getChangeRankingStocks,
  getCurrentPrice,
  getVolumeRankingStocks,
  isMarketOpen,
} from '../../../kis/market.js';
import { logger } from '../../../utils/logger.js';
import { resolveRequestMode } from '../../guards/live-pin.js';
import { getKnownStockName, isInvalidStockName } from './helpers.js';

export const watchlistRoutes = new Hono();

// ── 종목명 검색 (KRX 공개 API + DB) ──
watchlistRoutes.get('/search/stock', async (c) => {
  const q = String(c.req.query('q') ?? '').trim();
  if (q.length < 1) return c.json([]);

  // 6자리 숫자면 시세 API로 직접 조회
  if (/^\d{6}$/.test(q)) {
    try {
      const price = await getCurrentPrice(q);
      if (price.stockName) {
        const market = price.stockName ? 'KOSPI' : 'KOSPI';
        return c.json([{ code: q, name: price.stockName, market }]);
      }
    } catch {
      /* fallback */
    }
    return c.json([{ code: q, name: q, market: 'KOSPI' }]);
  }

  const results: Array<{ code: string; name: string; market: string }> = [];

  // 1차: DB watchlist에서 부분 이름 검색
  try {
    const { rows } = await getPool().query(
      `SELECT stock_code, stock_name FROM watchlist WHERE stock_name ILIKE $1 LIMIT 5`,
      [`%${q}%`],
    );
    for (const r of rows) results.push({ code: r.stock_code, name: r.stock_name, market: 'KOSPI' });
  } catch {
    /* ignore */
  }

  // 2차: NAVER 자동완성 API (이름 → 코드 매핑 — 검색어 필터 정확)
  if (results.length < 5) {
    try {
      const resp = await fetch(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock,etf&lang=ko`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(4000),
      });
      const data = (await resp.json()) as any;
      const items: any[] = data?.items?.[0] ?? [];
      for (const item of items) {
        const code = String(item[0] ?? '');
        const name = String(item[1] ?? '');
        const typeInfo = String(item[2] ?? '');
        if (code.length === 6 && name && !results.find((r) => r.code === code)) {
          const market = typeInfo.includes('KOSDAQ') ? 'KOSDAQ' : 'KOSPI';
          results.push({ code, name, market });
        }
      }
    } catch {
      /* NAVER API 실패 시 DB 결과만 반환 */
    }
  }

  // 3차: KRX 전체 종목 리스트에서 이름 필터 (NAVER 실패 폴백)
  if (results.length === 0) {
    try {
      const d = new Date();
      const day = d.getUTCDay();
      if (day === 0) d.setUTCDate(d.getUTCDate() - 2);
      else if (day === 6) d.setUTCDate(d.getUTCDate() - 1);
      const trdDd = d.toISOString().split('T')[0].replace(/-/g, '');

      const resp = await fetch('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: 'https://data.krx.co.kr/',
          'User-Agent': 'Mozilla/5.0',
        },
        body: new URLSearchParams({
          bld: 'dbms/MDC/STAT/standard/MDCSTAT01501',
          mktId: 'ALL',
          trdDd,
          lang: 'ko',
          pageNo: '1',
          rowSize: '5000',
        }).toString(),
        signal: AbortSignal.timeout(6000),
      });
      const data = (await resp.json()) as any;
      const qLower = q.toLowerCase();
      if (Array.isArray(data.output)) {
        for (const item of data.output) {
          const code = String(item.ISU_SRT_CD ?? '');
          const name = String(item.ISU_ABBRV ?? item.ISU_KOR_ABBRV ?? '');
          const mkt = String(item.MKT_NM ?? 'KOSPI');
          if (code.length === 6 && name.toLowerCase().includes(qLower) && !results.find((r) => r.code === code)) {
            results.push({ code, name, market: mkt.includes('KOSDAQ') ? 'KOSDAQ' : 'KOSPI' });
            if (results.length >= 10) break;
          }
        }
      }
    } catch {
      /* KRX API 실패 */
    }
  }

  return c.json(results.slice(0, 10));
});

// ── 감시 목록 CRUD ──
watchlistRoutes.get('/watchlist', async (c) => {
  try {
    const viewIsPaper = resolveRequestMode(c);
    const data = await getActiveWatchlist();
    const unresolvedDomestic = [
      ...new Set(
        data
          .filter((w: any) => /^[0-9]{6}$/.test(String(w.stock_code)) && isInvalidStockName(w.stock_name, w.stock_code))
          .map((w: any) => String(w.stock_code)),
      ),
    ];

    const nameMap = new Map<string, string>();
    for (const w of data) {
      const code = String(w.stock_code ?? '');
      const knownName = getKnownStockName(code);
      if (isInvalidStockName(w.stock_name, code) && knownName) {
        nameMap.set(code, knownName);
      }
    }

    if (unresolvedDomestic.length > 0) {
      const timeoutMap = new Map<string, CurrentPrice>();
      const quotes = await Promise.race([
        getBatchPrices(unresolvedDomestic.slice(0, 20)),
        new Promise<Map<string, CurrentPrice>>((resolve) => setTimeout(() => resolve(timeoutMap), 3000)),
      ]).catch(() => new Map<string, CurrentPrice>());
      for (const [code, q] of quotes) {
        if (!isInvalidStockName(q.stockName, code)) {
          nameMap.set(code, q.stockName.trim());
        }
      }
    }

    // 최근 매도 수익률 조회
    const sellPctMap = new Map<string, { pct: number; closedAt: string; sellPrice: number }>();
    try {
      const codes = data.map((w: any) => String(w.stock_code));
      if (codes.length > 0) {
        const { rows: sellRows } = await getPool().query(
          `
          SELECT DISTINCT ON (tc.stock_code)
            tc.stock_code,
            tc.avg_buy_price,
            tc.closed_at,
            (SELECT o.filled_price FROM orders o
             WHERE o.chain_id = tc.id AND o.side = 'SELL'
             ORDER BY o.created_at DESC LIMIT 1) AS last_sell_price
          FROM transaction_chains tc
          WHERE tc.status = 'CLOSED'
            AND tc.stock_code = ANY($1)
            AND tc.is_paper = $2
          ORDER BY tc.stock_code, tc.closed_at DESC
        `,
          [codes, viewIsPaper],
        );
        for (const r of sellRows) {
          const buy = Number(r.avg_buy_price ?? 0);
          const sell = Number(r.last_sell_price ?? 0);
          if (buy > 0 && sell > 0) {
            sellPctMap.set(r.stock_code, {
              pct: ((sell - buy) / buy) * 100,
              closedAt: r.closed_at,
              sellPrice: sell,
            });
          }
        }
      }
    } catch {
      /* skip — non-critical */
    }

    const base = data.map((w: any) => {
      const code = String(w.stock_code ?? '');
      const resolved = nameMap.get(code);
      const sellInfo = sellPctMap.get(code);
      return {
        ...(resolved ? { ...w, stock_name: resolved } : w),
        ...(sellInfo
          ? { last_sell_pct: sellInfo.pct, last_sell_at: sellInfo.closedAt, last_sell_price: sellInfo.sellPrice }
          : {}),
      };
    });

    if (nameMap.size > 0) {
      await Promise.allSettled(
        [...nameMap.entries()].map(([code, name]) =>
          getPool().query(`UPDATE watchlist SET stock_name = $1 WHERE stock_code = $2 AND is_active = true`, [
            name,
            code,
          ]),
        ),
      );
    }

    return c.json(base);
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'watchlist 조회 실패' }, 500);
  }
});

watchlistRoutes.post('/watchlist', async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const stockCode = String(body.stock_code ?? '')
    .trim()
    .replace(/\D/g, '');
  let stockName = String(body.stock_name ?? '').trim();
  const marketRaw = String(body.market ?? 'KOSPI')
    .trim()
    .toUpperCase();
  const market = marketRaw === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';

  if (stockCode.length !== 6) {
    return c.json({ error: '종목코드는 숫자 6자리여야 합니다.' }, 400);
  }

  if (!stockName) {
    try {
      const quote = await getCurrentPrice(stockCode);
      stockName = quote.stockName?.trim() || '';
    } catch {
      /* no-op */
    }
  }
  if (!stockName) stockName = stockCode;

  try {
    await getPool().query(
      `INSERT INTO watchlist (stock_code, stock_name, market, source)
       VALUES ($1, $2, $3, 'MANUAL')
       ON CONFLICT (stock_code) DO UPDATE SET stock_name = $2, market = $3, is_active = true, source = 'MANUAL'`,
      [stockCode, stockName, market],
    );
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }

  const { onStockAdded } = await import('../../../automation/ceo-workflow.js');
  onStockAdded(stockCode, stockName).catch((err: unknown) => {
    logger.warn(`CEO 워크플로우 알림 실패 (onStockAdded): ${err}`, { component: 'WATCHLIST' });
  });

  return c.json({ ok: true, stock_code: stockCode, stock_name: stockName, market });
});

// 자금 흐름 상태 조회
watchlistRoutes.get('/flow', async (c) => {
  try {
    const status = await getPortfolioFlowStatus();
    return c.json(status);
  } catch {
    return c.json({
      totalPortfolio: baseIsPaper ? 10000000 : 0,
      cash: baseIsPaper ? 10000000 : 0,
      cashRatio: 100,
      investedRatio: 0,
      flowStatus: 'FLOWING',
      flowMessage: '대기 중',
      mode: 'SWING',
      activePositions: 0,
      pendingStocks: 0,
      allocation: [],
      pendingStockCodes: [],
    });
  }
});

watchlistRoutes.delete('/watchlist/:stockCode', async (c) => {
  const stockCode = c.req.param('stockCode');
  try {
    await getPool().query('UPDATE watchlist SET is_active = false WHERE stock_code = $1', [stockCode]);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }

  const { onStockRemoved } = await import('../../../automation/ceo-workflow.js');
  onStockRemoved(stockCode).catch(() => {});

  return c.json({ ok: true });
});

// ── KIS 실계좌 잔고 (국내+해외) ──
watchlistRoutes.get('/kis-balance', async (c) => {
  try {
    const [domestic, overseas] = await Promise.all([
      getAccountBalance(true).catch(() => null),
      import('../../../kis/overseas.js').then((m) => m.getOverseasBalance()).catch(() => []),
    ]);
    return c.json({ domestic, overseas });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'KIS 잔고 조회 실패' }, 500);
  }
});

// ── KIS 관심종목 동기화 ──
watchlistRoutes.post('/watchlist/sync', async (c) => {
  try {
    const { syncInterestGroups, syncHoldingsToWatchlist } = await import('../../../kis/interest-group.js');
    const interest = await syncInterestGroups().catch(() => ({ added: [] as string[], total: 0 }));
    const holdings = await syncHoldingsToWatchlist().catch(() => ({ added: [] as string[] }));
    const allAdded = [...interest.added, ...holdings.added];
    return c.json({
      ok: true,
      added: allAdded,
      kisTotal: interest.total,
      message:
        allAdded.length > 0 ? `${allAdded.length}종목 동기화 완료` : '이미 최신 상태 (모의투자는 관심종목 API 미지원)',
    });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'KIS 동기화 실패' }, 500);
  }
});

// ── 매도 후 추적 — 최근 매도 종목의 현재가 변동 ──
watchlistRoutes.get('/watchlist/sold-tracking', async (c) => {
  try {
    const viewIsPaper = resolveRequestMode(c);
    const { rows } = await getPool().query(
      `
      SELECT DISTINCT ON (tc.stock_code)
        tc.stock_code,
        COALESCE(w.stock_name, tc.stock_code) AS stock_name,
        tc.avg_buy_price,
        tc.realized_pnl,
        tc.closed_at,
        tc.close_reason,
        (SELECT o.filled_price FROM orders o
         WHERE o.chain_id = tc.id AND o.side = 'SELL'
         ORDER BY o.created_at DESC LIMIT 1) AS sell_price
      FROM transaction_chains tc
      LEFT JOIN watchlist w ON tc.stock_code = w.stock_code
      WHERE tc.status = 'CLOSED'
        AND tc.is_paper = $1
        AND tc.closed_at > NOW() - INTERVAL '30 days'
      ORDER BY tc.stock_code, tc.closed_at DESC
    `,
      [viewIsPaper],
    );

    if (rows.length === 0) return c.json([]);

    const sorted = rows
      .filter((r: any) => Number(r.sell_price ?? 0) > 0)
      .sort((a: any, b: any) => new Date(b.closed_at).getTime() - new Date(a.closed_at).getTime())
      .slice(0, 20);

    const codes = sorted.map((r: any) => String(r.stock_code));

    const priceMap = getLastKnownPricesMemory(codes);
    if (priceMap.size < codes.length) {
      const redisPrices = await getLastKnownPrices(codes).catch(() => new Map<string, number>());
      for (const [code, price] of redisPrices) {
        if (!priceMap.has(code)) priceMap.set(code, price);
      }
    }
    const uncachedCodes = codes.filter((c) => !priceMap.has(c));
    if (uncachedCodes.length > 0 && isMarketOpen()) {
      const livePrices = await getBatchPrices(uncachedCodes).catch(() => new Map());
      for (const [code, p] of livePrices) {
        if (p.currentPrice > 0) {
          priceMap.set(code, p.currentPrice);
          cachePriceMemory(code, p.currentPrice);
        }
      }
    }

    const result = sorted.map((r: any) => {
      const sellPrice = Number(r.sell_price);
      const buyPrice = Number(r.avg_buy_price);
      const currentPrice = priceMap.get(r.stock_code) ?? 0;
      const sellPnlPct = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;
      const realizedPnl = Number(r.realized_pnl ?? 0);
      const postSellPct = sellPrice > 0 && currentPrice > 0 ? ((currentPrice - sellPrice) / sellPrice) * 100 : null;
      return {
        stock_code: r.stock_code,
        stock_name: r.stock_name,
        buy_price: buyPrice,
        sell_price: sellPrice,
        sell_date: r.closed_at,
        sell_pnl_pct: Math.round(sellPnlPct * 10) / 10,
        realized_pnl: Math.round(realizedPnl),
        current_price: currentPrice,
        post_sell_pct: postSellPct != null ? Math.round(postSellPct * 10) / 10 : null,
        close_reason: r.close_reason,
      };
    });

    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err?.message ?? '매도 추적 조회 실패' }, 500);
  }
});

// ── 시장 자동 스캔 — 거래량/급등 상위 신규 종목 발굴 ──
watchlistRoutes.post('/watchlist/scan', async (c) => {
  try {
    const pool = getPool();
    const { rows: existing } = await pool.query(`SELECT stock_code FROM watchlist`);
    const existingSet = new Set(existing.map((r: any) => String(r.stock_code)));

    const [volumeStocks, changeStocks] = await Promise.all([
      getVolumeRankingStocks('J', 30).catch(() => [] as { stock_code: string; stock_name: string }[]),
      getChangeRankingStocks(20).catch(() => [] as { stock_code: string; stock_name: string }[]),
    ]);

    const seen = new Set<string>();
    const candidates: { stock_code: string; stock_name: string; source: string }[] = [];
    for (const s of volumeStocks) {
      if (!s.stock_code || seen.has(s.stock_code) || existingSet.has(s.stock_code)) continue;
      seen.add(s.stock_code);
      candidates.push({ ...s, source: '거래량상위' });
    }
    for (const s of changeStocks) {
      if (!s.stock_code || seen.has(s.stock_code) || existingSet.has(s.stock_code)) continue;
      seen.add(s.stock_code);
      candidates.push({ ...s, source: '급등상위' });
    }

    const toAdd = candidates.slice(0, 15);
    const added: string[] = [];

    for (const stock of toAdd) {
      const stockName = stock.stock_name || stock.stock_code;
      await pool.query(
        `INSERT INTO watchlist (stock_code, stock_name, market, is_active)
         VALUES ($1, $2, 'KOSPI', true)
         ON CONFLICT (stock_code) DO UPDATE SET is_active = true, stock_name = EXCLUDED.stock_name`,
        [stock.stock_code, stockName],
      );
      added.push(`${stock.stock_code}(${stockName},${stock.source})`);
      logger.info(`🔍 시장스캔 신규 발굴: ${stock.stock_code}(${stockName}) [${stock.source}]`, {
        component: 'WATCHLIST_SCAN',
      });
    }

    const msg =
      added.length > 0 ? `${added.length}개 신규 종목 발굴 추가 완료` : '신규 발굴 종목 없음 (이미 모두 감시 중)';
    return c.json({ ok: true, added, scanned: candidates.length, message: msg });
  } catch (err: any) {
    return c.json({ error: err?.message ?? '시장 스캔 실패' }, 500);
  }
});

// ── 감시종목 자동 정리 (오래된/저점수 AUTO 항목 비활성화) ──
watchlistRoutes.post('/watchlist/cleanup', async (c) => {
  try {
    const pool = getPool();
    const isPaper = baseIsPaper;
    const tradingMode = isPaper ? 'paper' : 'live';

    // 현재 보유 중인 종목은 제외 (현재 모드만)
    const { rows: openChains } = await pool.query(
      `SELECT DISTINCT stock_code FROM transaction_chains WHERE status != 'CLOSED' AND is_paper = $1`,
      [isPaper],
    );
    const _heldCodes = new Set(openChains.map((r: any) => String(r.stock_code)));

    // AUTO/KIS_SYNC 소스 중 30일 이상 된 항목 비활성화 (MANUAL 제외, 보유종목 제외)
    const { rowCount } = await pool.query(
      `
      UPDATE watchlist SET is_active = false
      WHERE is_active = true
        AND source IN ('AUTO', 'KIS_SYNC')
        AND stock_code NOT IN (SELECT DISTINCT stock_code FROM transaction_chains WHERE status != 'CLOSED' AND is_paper = $1)
        AND added_at < NOW() - INTERVAL '30 days'
        AND stock_code NOT IN (
          SELECT DISTINCT stock_code FROM orders
          WHERE status = 'FILLED' AND trading_mode = $2 AND created_at > NOW() - INTERVAL '14 days'
        )
    `,
      [isPaper, tradingMode],
    );

    logger.info(`🧹 감시종목 정리: ${rowCount ?? 0}개 비활성화 (30일+ AUTO/KIS_SYNC, 미보유, 14일내 미거래)`, {
      component: 'WATCHLIST',
    });
    return c.json({ ok: true, deactivated: rowCount ?? 0 });
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// ── 종목명 깨짐 일괄 보정 ──
watchlistRoutes.post('/watchlist/fix-names', async (c) => {
  try {
    const { fixWatchlistNames } = await import('../../../kis/interest-group.js');
    const result = await fixWatchlistNames();
    return c.json({ ok: true, ...result });
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});
