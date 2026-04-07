import { Hono } from 'hono';
import { getPortfolioFlowStatus } from '../../automation/ceo-workflow.js';
import { getCachedScores } from '../../cache/redis.js';
import { config } from '../../config/index.js';
import { getActiveStrategy, getActiveWatchlist, getLatestScores, getOpenChains, getPool } from '../../db/client.js';
import { getAccountBalance } from '../../kis/account.js';
import { getCurrentPrice } from '../../kis/market.js';
import { getWithdrawConfig, getWithdrawals, getTotalReserved } from '../../automation/profit-withdraw.js';
import { getKillSwitchStatus } from '../../risk/kill-switch.js';
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

  const [balanceResult, chains, strategy] = await Promise.all([
    getAccountBalance().catch(() => defaultBalance),
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

  // chains에 현재가 매칭 — KIS positions 우선, 없으면 시세 API 직접 조회
  const posMap = new Map((balance.positions ?? []).map((p: any) => [p.stockCode, p]));
  const chainCodes = [...new Set(chains.map((ch: any) => ch.stock_code))];
  const priceMap = new Map<string, number>();

  // 1차: positions에서 매칭
  for (const code of chainCodes) {
    const pos = posMap.get(code);
    if (pos?.currentPrice > 0) priceMap.set(code, pos.currentPrice);
  }

  // 2차: 매칭 안 된 종목은 시세 API 직접 조회 (장중에만)
  const missingCodes = chainCodes.filter(code => !priceMap.has(code));
  if (missingCodes.length > 0) {
    const priceResults = await Promise.allSettled(
      missingCodes.map(code => getCurrentPrice(code).catch(() => null))
    );
    priceResults.forEach((result, idx) => {
      if (result.status === 'fulfilled' && result.value && (result.value as any).currentPrice > 0) {
        priceMap.set(missingCodes[idx], (result.value as any).currentPrice);
      }
    });
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

  // 투자금/손익 계산 — KIS 잔고 + chains 합산
  const kisInvested = balance.totalEvalAmount ?? 0;
  const kisPnl = balance.totalProfitLoss ?? 0;
  const totalInvested = kisInvested + totalChainInvested;
  const totalPnl = kisPnl + totalChainPnl;
  const totalPnlPct = totalInvested > 0 ? (totalChainPnl / totalChainInvested) * 100 : 0;

  return c.json({
    portfolio: {
      totalValue: (balance.orderableCash ?? 10000000) + totalInvested + totalChainPnl,
      cash: balance.orderableCash ?? 10000000,
      invested: totalInvested,
      pnl: totalPnl,
      pnlPct: totalPnlPct,
      positions: balance.positions ?? [],
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
