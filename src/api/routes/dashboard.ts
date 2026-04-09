import { Hono } from 'hono';
import { getPortfolioFlowStatus } from '../../automation/ceo-workflow.js';
import { getCachedScores, cachePrice, getLastKnownPrices } from '../../cache/redis.js';
import { cachePriceMemory, getLastKnownPricesMemory, getCachedPriceMemory } from '../../cache/memory.js';
import { config } from '../../config/index.js';
import { getActiveStrategy, getActiveWatchlist, getLatestScores, getOpenChains, getPool } from '../../db/client.js';
import { getAccountBalance } from '../../kis/account.js';
import { getCurrentPrice } from '../../kis/market.js';
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

export const dashboardRoutes = new Hono();

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

  // chains에 현재가 매칭 — 인메모리 캐시 우선 → KIS 잔고 → 시세 API
  const posMap = new Map((balance.positions ?? []).map((p: any) => [p.stockCode, p]));
  const chainCodes = [...new Set(chains.map((ch: any) => ch.stock_code))];
  const priceMap = new Map<string, number>();

  // 1차: 인메모리 캐시 (즉시, 0ms)
  for (const code of chainCodes) {
    const cached = getCachedPriceMemory(code);
    if (cached && cached > 0) priceMap.set(code, cached);
  }

  // 2차: KIS 잔고 positions (최신이면 덮어쓰기)
  for (const code of chainCodes) {
    const pos = posMap.get(code);
    if (pos?.currentPrice > 0) priceMap.set(code, pos.currentPrice);
  }

  // 3차: 가격 없는 종목만 시세 API 조회
  const missingCodes = chainCodes.filter(code => !priceMap.has(code));
  if (missingCodes.length > 0) {
    // Redis fallback 시도
    const redisCached = await getLastKnownPrices(missingCodes).catch(() => new Map());
    redisCached.forEach((price, code) => priceMap.set(code, price));

    // 인메모리 장기 캐시 시도
    const stillMissing = missingCodes.filter(code => !priceMap.has(code));
    for (const code of stillMissing) {
      const last = getLastKnownPricesMemory([code]).get(code);
      if (last) priceMap.set(code, last);
    }

    // 그래도 없으면 KIS API 직접 조회
    const finalMissing = chainCodes.filter(code => !priceMap.has(code));
    for (const code of finalMissing) {
      try {
        const quote = await getCurrentPrice(code);
        if (quote.currentPrice > 0) priceMap.set(code, quote.currentPrice);
      } catch { /* skip */ }
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
    return { ...ch, currentPrice, unrealizedPnl, unrealizedPnlPct, invested };
  });

  // 투자금/손익 계산 — 모드별 분기
  // Live: KIS 잔고가 source-of-truth (chains는 메타 정보)
  // Paper: KIS가 반영 안 하므로 chains 기반 계산
  const rawCash = balance.orderableCash ?? 10000000;

  let totalInvested: number;
  let totalPnl: number;
  let actualCash: number;

  if (config.isPaper) {
    // Paper: balance에서 이미 cash=현금, evalAmount=투자금으로 분리됨
    totalInvested = totalChainInvested;
    totalPnl = totalChainPnl + (balance.totalProfitLoss ?? 0);
    actualCash = rawCash;
  } else {
    // Live: KIS 잔고가 정확 — chains 이중합산 하지 않음
    totalInvested = balance.totalEvalAmount ?? 0;
    totalPnl = balance.totalProfitLoss ?? 0;
    actualCash = rawCash;
  }

  const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
  const totalValue = actualCash + totalInvested + totalPnl;

  // ── 해외 보유종목 합산 ──
  let overseasHoldings: Array<{ stock_code: string; quantity: number; avg_price: number; bought_at: string }> = [];
  let overseasTotalInvested = 0;
  let overseasTotalPnl = 0;
  let overseasCash = 0;
  try {
    const { rows: osRows } = await getPool().query('SELECT * FROM overseas_holdings WHERE quantity > 0');
    const { rows: osCashRows } = await getPool().query("SELECT value FROM overseas_state WHERE key = 'cash'");
    overseasCash = osCashRows.length > 0 ? Number(osCashRows[0].value) : 0;

    for (const r of osRows) {
      const qty = Number(r.quantity);
      const avgP = Number(r.avg_price);
      const invested = avgP * qty;
      overseasTotalInvested += invested;
      overseasHoldings.push({
        stock_code: r.stock_code,
        quantity: qty,
        avg_price: avgP,
        bought_at: r.bought_at,
      });
    }
  } catch { /* overseas table may not exist */ }

  // 환율 (간이: 1 USD ≈ 1,380 KRW)
  const FX_RATE = 1380;
  const overseasInvestedKrw = overseasTotalInvested * FX_RATE;
  const overseasCashKrw = overseasCash * FX_RATE;
  const grandTotalValue = totalValue + overseasInvestedKrw + overseasCashKrw;

  return c.json({
    portfolio: {
      totalValue: grandTotalValue,
      cash: actualCash,
      invested: totalInvested + (config.isPaper ? totalChainPnl : 0), // 국내 평가금
      pnl: totalPnl,
      pnlPct: totalPnlPct,
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
  });
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
  onStockAdded(stockCode, stockName).catch(() => {});

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

// ── 매매 기록 ──
dashboardRoutes.get('/trades', async (c) => {
  const limit = Number(c.req.query('limit') ?? 50);
  try {
    const { rows } = await getPool().query(
      `SELECT o.*, json_build_object(
         'stock_code', tc.stock_code,
         'status', tc.status,
         'strategy_mode', tc.strategy_mode,
         'avg_buy_price', tc.avg_buy_price
       ) AS transaction_chains
       FROM orders o
       LEFT JOIN transaction_chains tc ON o.chain_id = tc.id
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

  try {
    const [chart, flow, shorts, consensus] = await Promise.allSettled([
      getDailyChart(stockCode, 65),
      getInvestorFlow(stockCode, 5).catch(() => null),
      fetchShortSellingData(stockCode, 5).catch(() => null),
      fetchAnalystConsensus(stockCode).catch(() => null),
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
