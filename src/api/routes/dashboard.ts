import { Hono } from 'hono';
import { getPortfolioFlowStatus } from '../../automation/ceo-workflow.js';
import { getCachedScores, cachePrice, getLastKnownPrices } from '../../cache/redis.js';
import { cachePriceMemory, getLastKnownPricesMemory, getCachedPriceMemory } from '../../cache/memory.js';
import { config } from '../../config/index.js';
import { getActiveStrategy, getActiveWatchlist, getLatestScores, getOpenChains, getPool } from '../../db/client.js';
import { getAccountBalance } from '../../kis/account.js';
import { getCurrentPrice, getBatchPrices, isMarketOpen } from '../../kis/market.js';
import { getWithdrawConfig, getWithdrawals, getTotalReserved } from '../../automation/profit-withdraw.js';
import { getKillSwitchStatus } from '../../risk/kill-switch.js';
import { getPaperBalance } from '../../risk/engine.js';
import { placeOrder } from '../../kis/order.js';
import { getDailyChart } from '../../kis/market.js';
import { analyzeTechnicals } from '../../analysis/indicators.js';
import { getInvestorFlow } from '../../automation/investor-flow.js';
import { fetchShortSellingData } from '../../automation/short-selling.js';
import { fetchAnalystConsensus } from '../../automation/analyst-consensus.js';
import { getMacroSnapshot } from '../../automation/macro-data.js';
import { logger } from '../../utils/logger.js';

export const dashboardRoutes = new Hono();

// ── 환율 캐시 (1시간 TTL, 실패 시 1420 폴백) ──
let _fxCache = { rate: 1420, fetchedAt: 0 };
async function getFxRate(): Promise<number> {
  const now = Date.now();
  if (now - _fxCache.fetchedAt < 60 * 60 * 1000) return _fxCache.rate;
  try {
    const resp = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(4000) });
    const data = await resp.json() as any;
    const krw = data?.rates?.KRW;
    if (krw && krw > 1000 && krw < 2000) {
      _fxCache = { rate: Math.round(krw), fetchedAt: now };
    }
  } catch { /* 폴백 유지 */ }
  return _fxCache.rate;
}

// ── 대시보드 요약 ──
dashboardRoutes.get('/dashboard', async (c) => {
  // KIS API 실패 시에도 기본값으로 응답 (장 외 시간, API 제한 등)
  const defaultBalance = { totalDeposit: 10000000, totalEvalAmount: 0, orderableCash: 10000000, totalProfitLoss: 0, totalProfitLossPct: 0, positions: [] };

  const balanceFn = config.isPaper ? getPaperBalance : getAccountBalance;
  const [balanceResult, chains, strategy] = await Promise.all([
    balanceFn().catch(() => defaultBalance),
    getOpenChains().catch(() => []),
    getActiveStrategy().catch(() => null),
  ]);
  const balance = balanceResult ?? defaultBalance;

  const watchlist = await getActiveWatchlist().catch(() => []);
  const stockCodes = watchlist.map((w) => w.stock_code);

  let scores: any[] = [];
  try {
    scores = await getCachedScores(stockCodes);
    if (scores.length === 0) {
      scores = await getLatestScores(stockCodes);
    }
  } catch { /* scores unavailable */ }

  // chains에 현재가 매칭 — KIS API 우선 (신선한 가격), 실패 시 캐시 폴백
  const posMap = new Map((balance.positions ?? []).map((p: any) => [p.stockCode, p]));
  const chainCodes = [...new Set(chains.map((ch: any) => ch.stock_code))];
  const priceMap = new Map<string, number>();

  // 1차: KIS 잔고 positions (실계좌 모드에서 정확)
  for (const code of chainCodes) {
    const pos = posMap.get(code);
    if (pos?.currentPrice > 0) priceMap.set(code, pos.currentPrice);
  }

  // 2차: KIS 시세 API — 장중에만 호출 (장 마감 후엔 캐시 사용으로 속도 보장)
  const nameMap = new Map<string, string>();
  const watchlistNameMap = new Map(watchlist.map((w: any) => [w.stock_code, w.stock_name]));
  const chainNameMap = new Map(chains.map((ch: any) => [ch.stock_code, ch.stock_name ?? '']));
  // 이름이 없는 종목은 장 마감 후에도 1회 조회 (이름 보정 목적) — watchlist + chains 모두 확인
  const needNameCodes = chainCodes.filter(c => {
    const n = String(watchlistNameMap.get(c) ?? '') || String(chainNameMap.get(c) ?? '');
    return !n || n === c || /^\d{6}$/.test(n);
  });
  const codesToFetch = isMarketOpen() ? chainCodes : needNameCodes;

  // 병렬 배치 조회 (순차 → 동시 → 속도 대폭 개선)
  if (codesToFetch.length > 0) {
    try {
      const batchResult = await getBatchPrices(codesToFetch);
      for (const [code, quote] of batchResult) {
        if (quote.currentPrice > 0) priceMap.set(code, quote.currentPrice);
        if (quote.stockName && quote.stockName !== code) nameMap.set(code, quote.stockName);
      }
    } catch {
      // 배치 실패 시 개별 순차 폴백
      for (const code of codesToFetch) {
        try {
          const quote = await getCurrentPrice(code);
          if (quote.currentPrice > 0) priceMap.set(code, quote.currentPrice);
          if (quote.stockName && quote.stockName !== code) nameMap.set(code, quote.stockName);
        } catch { /* skip */ }
      }
    }
  }

  // 종목명 백그라운드 보정: watchlist + transaction_chains 모두 코드명 → 실제명으로 업데이트
  for (const [code, name] of nameMap) {
    const wName = String(watchlistNameMap.get(code) ?? '');
    if (!wName || wName === code || /^\d{6}$/.test(wName)) {
      getPool().query('UPDATE watchlist SET stock_name = $1 WHERE stock_code = $2', [name, code]).catch(() => {});
    }
    const cName = String(chainNameMap.get(code) ?? '');
    if (!cName || cName === code || /^\d{6}$/.test(cName)) {
      getPool().query(
        "UPDATE transaction_chains SET stock_name = $1 WHERE stock_code = $2 AND (stock_name IS NULL OR stock_name = $2 OR stock_name ~ '^[0-9]{6}$')",
        [name, code]
      ).catch(() => {});
    }
  }

  // 3차: API 실패 시 단기 캐시 폴백 (30초 TTL)
  for (const code of chainCodes) {
    if (!priceMap.has(code)) {
      const cached = getCachedPriceMemory(code);
      if (cached && cached > 0) priceMap.set(code, cached);
    }
  }

  // 4차: 마지막 수단 — 2시간 장기 캐시 (장 마감 후 등)
  const stillMissing = chainCodes.filter(code => !priceMap.has(code));
  if (stillMissing.length > 0) {
    const redisCached = await getLastKnownPrices(stillMissing).catch(() => new Map());
    redisCached.forEach((price, code) => priceMap.set(code, price));
    for (const code of stillMissing.filter(c => !priceMap.has(c))) {
      const last = getLastKnownPricesMemory([code]).get(code);
      if (last) priceMap.set(code, last);
    }
  }

  // 모든 가격 캐싱 (인메모리 + Redis)
  for (const [code, price] of priceMap) {
    cachePriceMemory(code, price);
    cachePrice(code, price).catch(() => {});
  }

  let totalChainInvested = 0;
  let totalChainPnl = 0;
  const enrichedChains = chains.map((ch: any) => {
    const currentPrice = priceMap.get(ch.stock_code) ?? 0;
    const avgPrice = Number(ch.avg_buy_price) || 0;
    const qty = Number(ch.total_quantity) || 0;
    const invested = avgPrice * qty;
    const unrealizedPnl = currentPrice > 0 ? (currentPrice - avgPrice) * qty : 0;
    const unrealizedPnlPct = currentPrice > 0 && avgPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : 0;
    totalChainInvested += invested;
    totalChainPnl += unrealizedPnl;
    // 종목명: KIS API에서 얻은 이름 > watchlist 이름 > 코드 순으로 사용
    const resolvedName = nameMap.get(ch.stock_code) || ch.stock_name || ch.stock_code;
    return { ...ch, stock_name: resolvedName, currentPrice, unrealizedPnl, unrealizedPnlPct, invested };
  });

  // 투자금/손익 계산 — 모드별 분기
  // Live: KIS 잔고가 source-of-truth (chains는 메타 정보)
  // Paper: KIS가 반영 안 하므로 chains 기반 계산
  const rawCash = balance.orderableCash ?? 10000000;

  let totalInvested: number;
  let totalPnl: number;
  let actualCash: number;

  if (config.isPaper) {
    // Paper: 가상 초기자본 1천만원 고정 — 초과 포지션은 1천만원 기준으로 캡
    const PAPER_CAP = 10_000_000;
    const cappedInvested = Math.min(totalChainInvested, PAPER_CAP);
    totalInvested = cappedInvested;
    totalPnl = totalChainPnl + (balance.totalProfitLoss ?? 0);
    actualCash = Math.max(0, PAPER_CAP - cappedInvested);
  } else {
    // Live: KIS 잔고가 정확 — chains 이중합산 하지 않음
    totalInvested = balance.totalEvalAmount ?? 0;
    totalPnl = balance.totalProfitLoss ?? 0;
    actualCash = rawCash;
  }

  const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
  const totalValue = actualCash + totalInvested + totalPnl;

  // ── 해외 보유종목 (별도 표시용, 국내 총자산에 합산하지 않음) ──
  let overseasHoldings: Array<{ stock_code: string; quantity: number; avg_price: number; bought_at: string }> = [];
  let overseasTotalInvested = 0;
  let overseasCash = 0;
  try {
    const { rows: osRows } = await getPool().query('SELECT * FROM overseas_holdings WHERE quantity > 0');
    const { rows: osCashRows } = await getPool().query("SELECT value FROM overseas_state WHERE key = 'cash'");
    overseasCash = osCashRows.length > 0 ? Number(osCashRows[0].value) : 0;

    for (const r of osRows) {
      const qty = Number(r.quantity);
      const avgP = Number(r.avg_price);
      overseasTotalInvested += avgP * qty;
      overseasHoldings.push({
        stock_code: r.stock_code,
        quantity: qty,
        avg_price: avgP,
        bought_at: r.bought_at,
      });
    }
  } catch { /* overseas table may not exist */ }

  // ── 국내 + 해외 합산 ──
  const FX_RATE = await getFxRate(); // 실시간 환율 (1시간 캐시, 실패 시 1420 폴백)
  const overseasInvestedKrw = (isNaN(overseasTotalInvested) ? 0 : overseasTotalInvested) * FX_RATE;
  const overseasCashKrw = (isNaN(overseasCash) ? 0 : overseasCash) * FX_RATE;
  const domesticInvested = (totalInvested || 0) + (config.isPaper ? (totalChainPnl || 0) : 0);
  const grandTotalValue = (actualCash || 0) + domesticInvested + overseasInvestedKrw + overseasCashKrw;
  const grandTotalInvested = domesticInvested + overseasInvestedKrw;

  return c.json({
    portfolio: {
      totalValue: Math.round(grandTotalValue),  // 국내 + 해외 합산
      cash: Math.round(actualCash),
      invested: Math.round(grandTotalInvested), // 국내 + 해외 투자금 합산
      domesticInvested: Math.round(domesticInvested),
      domesticCash: Math.round(actualCash),
      pnl: Math.round(totalPnl),
      pnlPct: Math.round(totalPnlPct * 100) / 100,
      positions: balance.positions ?? [],
    },
    overseas: {
      holdings: overseasHoldings,
      totalInvestedUsd: overseasTotalInvested,
      totalInvestedKrw: overseasInvestedKrw,
      cashUsd: overseasCash,
      cashKrw: overseasCashKrw,
      fxRate: FX_RATE,
    },
    activeChains: enrichedChains.length,
    chains: enrichedChains,
    scores,
    strategy: strategy ?? { mode: 'SWING' },
    killSwitch: getKillSwitchStatus(),
    tradingMode: config.tradingMode,
    riskLimits: { maxDailyDrawdownKrw: config.risk.maxDailyDrawdownKrw },
  });
});

// ── 종목명 검색 (KRX 공개 API + DB) ──
dashboardRoutes.get('/search/stock', async (c) => {
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
    } catch { /* fallback */ }
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
  } catch { /* ignore */ }

  // 2차: KRX 공개 API로 검색 (이름 → 코드 매핑)
  if (results.length < 5) {
    try {
      const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
      const resp = await fetch('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Referer': 'https://data.krx.co.kr/',
          'User-Agent': 'Mozilla/5.0',
        },
        body: new URLSearchParams({
          bld: 'dbms/MDC/STAT/standard/MDCSTAT01901',
          mktId: 'ALL',
          trdDd: today,
          searchText: q,
          lang: 'ko',
          pageNo: '1',
          rowSize: '10',
        }).toString(),
        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json() as any;
      if (Array.isArray(data.output)) {
        for (const item of data.output) {
          const code = String(item.ISU_SRT_CD ?? '');
          const name = String(item.ISU_ABBRV ?? '');
          const mkt = String(item.MKT_NM ?? 'KOSPI');
          if (code.length === 6 && !results.find(r => r.code === code)) {
            results.push({ code, name, market: mkt.includes('KOSDAQ') ? 'KOSDAQ' : 'KOSPI' });
          }
        }
      }
    } catch { /* KRX API 실패 시 DB 결과만 반환 */ }
  }

  return c.json(results.slice(0, 10));
});

// ── 감시 목록 CRUD ──
dashboardRoutes.get('/watchlist', async (c) => {
  try {
    const data = await getActiveWatchlist();
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'watchlist 조회 실패' }, 500);
  }
});

dashboardRoutes.post('/watchlist', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const stockCode = String(body.stock_code ?? '').trim().replace(/\D/g, '');
  let stockName = String(body.stock_name ?? '').trim();
  const marketRaw = String(body.market ?? 'KOSPI').trim().toUpperCase();
  const market = marketRaw === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';

  if (stockCode.length !== 6) {
    return c.json({ error: '종목코드는 숫자 6자리여야 합니다.' }, 400);
  }

  // 종목명이 비어 있으면 시세 API에서 자동 보완 시도
  if (!stockName) {
    try {
      const quote = await getCurrentPrice(stockCode);
      stockName = quote.stockName?.trim() || '';
    } catch {
      // no-op: fallback below
    }
  }
  if (!stockName) {
    stockName = stockCode;
  }

  try {
    await getPool().query(
      `INSERT INTO watchlist (stock_code, stock_name, market)
       VALUES ($1, $2, $3)
       ON CONFLICT (stock_code) DO UPDATE SET stock_name = $2, market = $3`,
      [stockCode, stockName, market],
    );
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }

  // CEO 워크플로우: 종목 추가 시 자동 알림
  const { onStockAdded } = await import('../../automation/ceo-workflow.js');
  onStockAdded(stockCode, stockName).catch((err: unknown) => {
    logger.warn(`CEO 워크플로우 알림 실패 (onStockAdded): ${err}`, { component: 'WATCHLIST' });
  });

  return c.json({ ok: true, stock_code: stockCode, stock_name: stockName, market });
});

// 자금 흐름 상태 조회
dashboardRoutes.get('/flow', async (c) => {
  try {
    const status = await getPortfolioFlowStatus();
    return c.json(status);
  } catch {
    return c.json({
      totalPortfolio: 10000000, cash: 10000000, cashRatio: 100,
      investedRatio: 0, flowStatus: 'FLOWING', flowMessage: '대기 중',
      mode: 'SWING', activePositions: 0, pendingStocks: 0,
      allocation: [], pendingStockCodes: [],
    });
  }
});

dashboardRoutes.delete('/watchlist/:stockCode', async (c) => {
  const stockCode = c.req.param('stockCode');
  try {
    await getPool().query('UPDATE watchlist SET is_active = false WHERE stock_code = $1', [stockCode]);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }

  // CEO 워크플로우: 종목 제거 시 보유분 자동 청산
  const { onStockRemoved } = await import('../../automation/ceo-workflow.js');
  onStockRemoved(stockCode).catch(() => {});

  return c.json({ ok: true });
});

// ── KIS 실계좌 잔고 (국내+해외) ──
dashboardRoutes.get('/kis-balance', async (c) => {
  try {
    const [domestic, overseas] = await Promise.all([
      getAccountBalance().catch(() => null),
      import('../../kis/overseas.js').then((m) => m.getOverseasBalance()).catch(() => []),
    ]);
    return c.json({ domestic, overseas });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'KIS 잔고 조회 실패' }, 500);
  }
});

// ── KIS 관심종목 동기화 ──
dashboardRoutes.post('/watchlist/sync', async (c) => {
  try {
    const { syncInterestGroups, syncHoldingsToWatchlist } = await import('../../kis/interest-group.js');
    // 관심종목은 모의투자에서 미지원일 수 있음 → 실패해도 보유종목은 계속 진행
    const interest = await syncInterestGroups().catch(() => ({ added: [] as string[], total: 0 }));
    const holdings = await syncHoldingsToWatchlist().catch(() => ({ added: [] as string[] }));
    const allAdded = [...interest.added, ...holdings.added];
    return c.json({ ok: true, added: allAdded, kisTotal: interest.total, message: allAdded.length > 0 ? `${allAdded.length}종목 동기화 완료` : '이미 최신 상태 (모의투자는 관심종목 API 미지원)' });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'KIS 동기화 실패' }, 500);
  }
});

// ── 종목명 깨짐 일괄 보정 (watchlist + transaction_chains 미등록 종목 포함) ──
dashboardRoutes.post('/watchlist/fix-names', async (c) => {
  try {
    const { fixWatchlistNames } = await import('../../kis/interest-group.js');
    const result = await fixWatchlistNames();
    return c.json({ ok: true, ...result });
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// ── 매매 기록 ──
dashboardRoutes.get('/trades', async (c) => {
  const limit = Math.min(Math.max(1, Number(c.req.query('limit') ?? 50)), 500);
  try {
    const { rows } = await getPool().query(
      `SELECT o.*,
         CASE WHEN w.stock_name IS NOT NULL AND w.stock_name != o.stock_code AND w.stock_name !~ '^[0-9]{6}$'
              THEN w.stock_name ELSE NULL END AS stock_name,
         json_build_object(
           'stock_code', tc.stock_code,
           'status', tc.status,
           'strategy_mode', tc.strategy_mode,
           'avg_buy_price', tc.avg_buy_price
         ) AS transaction_chains
       FROM orders o
       LEFT JOIN transaction_chains tc ON o.chain_id = tc.id
       LEFT JOIN watchlist w ON o.stock_code = w.stock_code
       ORDER BY o.created_at DESC
       LIMIT $1`,
      [limit],
    );
    return c.json(rows);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 시장 참고 소스 ──
dashboardRoutes.get('/sources', async (c) => {
  try {
    const { rows } = await getPool().query('SELECT * FROM market_sources ORDER BY is_pinned DESC, added_at DESC LIMIT 50');
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

dashboardRoutes.post('/sources', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const title = String(body.title ?? '').trim();
  const url = String(body.url ?? '').trim();
  const sourceType = String(body.source_type ?? 'article').trim();
  const memo = String(body.memo ?? '').trim() || null;

  if (!title || !url) return c.json({ error: '제목과 URL은 필수입니다.' }, 400);

  try {
    const { rows } = await getPool().query(
      `INSERT INTO market_sources (title, url, source_type, memo) VALUES ($1, $2, $3, $4) RETURNING *`,
      [title, url, sourceType, memo],
    );
    return c.json(rows[0]);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

dashboardRoutes.patch('/sources/:id/pin', async (c) => {
  const id = c.req.param('id');
  try {
    await getPool().query('UPDATE market_sources SET is_pinned = NOT is_pinned WHERE id = $1', [id]);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

dashboardRoutes.delete('/sources/:id', async (c) => {
  const id = c.req.param('id');
  try {
    await getPool().query('DELETE FROM market_sources WHERE id = $1', [id]);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 수익 인출 ──
dashboardRoutes.get('/withdraw/config', async (c) => {
  const config = await getWithdrawConfig();
  const reserved = await getTotalReserved();
  return c.json({ ...config, totalReserved: reserved });
});

dashboardRoutes.put('/withdraw/config', async (c) => {
  const body = await c.req.json();
  try {
    const { rows } = await getPool().query(
      `UPDATE profit_withdraw_config SET
         is_active = $1, target_profit_pct = $2, withdraw_ratio_pct = $3,
         min_withdraw_amount = $4, check_frequency = $5, updated_at = NOW()
       WHERE id = (SELECT id FROM profit_withdraw_config LIMIT 1)
       RETURNING *`,
      [
        body.is_active ?? false,
        body.target_profit_pct ?? 10,
        body.withdraw_ratio_pct ?? 50,
        body.min_withdraw_amount ?? 100000,
        body.check_frequency ?? 'daily',
      ],
    );
    return c.json(rows[0]);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

dashboardRoutes.get('/withdraw/history', async (c) => {
  const history = await getWithdrawals();
  return c.json(history);
});

dashboardRoutes.patch('/withdraw/:id/status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const status = body.status;
  if (!['withdrawn', 'cancelled'].includes(status)) return c.json({ error: '유효한 상태: withdrawn, cancelled' }, 400);
  try {
    await getPool().query('UPDATE profit_withdrawals SET status = $1 WHERE id = $2', [status, id]);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 수동 매도 (CEO 긴급 매도) ──
dashboardRoutes.post('/sell/:chainId', async (c) => {
  const chainId = c.req.param('chainId');
  try {
    const { rows } = await getPool().query('SELECT * FROM transaction_chains WHERE id = $1', [chainId]);
    const chain = rows[0];
    if (!chain) return c.json({ error: '체인을 찾을 수 없습니다' }, 404);
    if (chain.total_quantity <= 0) return c.json({ error: '매도할 수량이 없습니다' }, 400);

    const result = await placeOrder({
      stockCode: chain.stock_code,
      side: 'SELL',
      quantity: chain.total_quantity,
    });

    // 체인 상태 업데이트
    await getPool().query(
      `UPDATE transaction_chains SET status = 'CLOSED', closed_at = NOW(), close_reason = 'CEO 수동 매도' WHERE id = $1`,
      [chainId],
    );

    // 주문 기록 (filled_quantity/filled_price 포함 — Paper 복원 로직이 이 필드를 읽음)
    const avgPrice = Number(chain.avg_buy_price) || 0;
    await getPool().query(
      `INSERT INTO orders (chain_id, stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning)
       VALUES ($1, $2, 'SELL', 'MARKET', $3, $4, $3, $4, $5, 'FILLED', $6, 'MANUAL', 'CEO 수동 전량 매도')`,
      [chainId, chain.stock_code, chain.total_quantity, avgPrice, result.orderNo ?? '', config.tradingMode],
    );

    return c.json({ ok: true, orderNo: result.orderNo, message: `${chain.stock_code} ${chain.total_quantity}주 전량 매도 주문 완료` });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 종목 상세 분석 (기술적 지표 + 수급 + 공매도 + 목표가) ──
dashboardRoutes.get('/stock/:code/analysis', async (c) => {
  const stockCode = c.req.param('code');
  const defaultResult = { technicals: null, flow: null, shorts: null, consensus: null };

  const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  try {
    const [chart, flow, shorts, consensus] = await Promise.allSettled([
      withTimeout(getDailyChart(stockCode, 65), 6000),
      withTimeout(getInvestorFlow(stockCode, 5).catch(() => null), 4000),
      withTimeout(fetchShortSellingData(stockCode, 5).catch(() => null), 4000),
      withTimeout(fetchAnalystConsensus(stockCode).catch(() => null), 4000),
    ]);

    let technicals = null;
    if (chart.status === 'fulfilled' && chart.value.length >= 20) {
      const candles = chart.value.map((c: any) => ({
        date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      }));
      technicals = analyzeTechnicals(candles);
    }

    return c.json({
      stockCode,
      technicals,
      flow: flow.status === 'fulfilled' ? flow.value : null,
      shorts: shorts.status === 'fulfilled' ? shorts.value : null,
      consensus: consensus.status === 'fulfilled' ? consensus.value : null,
    });
  } catch {
    return c.json({ stockCode, ...defaultResult });
  }
});

// ── 매크로 환경 ──
dashboardRoutes.get('/macro', async (c) => {
  try {
    const macro = await getMacroSnapshot();
    return c.json(macro);
  } catch {
    return c.json({ regime: 'NEUTRAL', fearGreedIndex: 50 });
  }
});

// ── 시스템 로그 ──
dashboardRoutes.get('/logs', async (c) => {
  const limit = Number(c.req.query('limit') ?? 100);
  const component = c.req.query('component');

  try {
    let sql = 'SELECT * FROM system_log';
    const params: any[] = [];

    if (component) {
      sql += ' WHERE component = $1';
      params.push(component);
    }

    sql += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const { rows } = await getPool().query(sql, params);
    return c.json(rows);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
