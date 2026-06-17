/**
 * 매매 기록, 승률 분석, 시장 소스, 용돈 이관 라우트
 */
import { Hono } from 'hono';
import { getDinnerMoneyStats } from '../../../automation/profit-withdraw.js';
import { KR_FEE } from '../../../config/constants.js';
import { getPool } from '../../../db/client.js';
import { type CurrentPrice, getBatchPrices } from '../../../kis/market.js';
import { resolveRequestMode } from '../../guards/live-pin.js';
import { getTodayTradeStats } from '../sse.js';
import { getKnownStockName, isInvalidStockName } from './helpers.js';

export const tradeRoutes = new Hono();

// ── 매매 기록 ──
tradeRoutes.get('/trades', async (c) => {
  const market = c.req.query('market'); // 'KR' | 'OVERSEAS' | undefined
  const isOverseasFilter = market === 'OVERSEAS';
  const defaultLimit = isOverseasFilter ? 2000 : 100;
  const maxLimit = isOverseasFilter ? 5000 : 500;
  const limit = Math.min(Math.max(1, Number(c.req.query('limit') ?? defaultLimit)), maxLimit);
  const viewIsPaper = resolveRequestMode(c);
  const tradeMode = viewIsPaper ? 'paper' : 'live';
  const marketClause = isOverseasFilter
    ? `AND o.trigger_source = 'OVERSEAS' AND o.stock_code !~ '^[0-9]{6}$'`
    : market === 'KR'
      ? `AND (o.trigger_source != 'OVERSEAS' OR o.trigger_source IS NULL)`
      : '';
  try {
    const { rows } = await getPool().query(
      `SELECT o.*,
         COALESCE(
           CASE
             WHEN w.stock_name IS NOT NULL
               AND w.stock_name != o.stock_code
               AND w.stock_name !~ '^[0-9]{6}$'
             THEN w.stock_name
             ELSE NULL
           END,
           o.stock_code
         ) AS stock_name,
         CASE WHEN tc.id IS NOT NULL THEN json_build_object(
           'stock_code', tc.stock_code,
           'status', tc.status,
           'strategy_mode', tc.strategy_mode,
           'avg_buy_price', tc.avg_buy_price,
           'realized_pnl', tc.realized_pnl,
           'closed_at', tc.closed_at,
           'pnl_pct', tc.pnl_pct,
           'close_reason', tc.close_reason,
           'is_paper', tc.is_paper
         ) END AS transaction_chains
       FROM orders o
       LEFT JOIN transaction_chains tc ON o.chain_id = tc.id
       LEFT JOIN watchlist w ON o.stock_code = w.stock_code
       WHERE o.is_paper = $2
         AND (o.trading_mode = $3::text OR ($3::text = 'paper' AND o.trading_mode = 'p_arch'))
       ${marketClause}
       ORDER BY o.created_at DESC
       LIMIT $1`,
      [limit, viewIsPaper, tradeMode],
    );
    const tradePnlMap = new Map<string, { pnl: number; pct: number | null; isUsd?: boolean }>();
    const allCodes = [...new Set(rows.map((r: any) => String(r.stock_code ?? '')).filter(Boolean))];
    const domesticCodes = allCodes.filter((code: string) => /^[0-9]{6}$/.test(code));
    const overseasCodes = allCodes.filter((code: string) => !/^[0-9]{6}$/.test(code));

    const calcFifoPnl = (pnlRows: any[], isUsd: boolean) => {
      const BUY_FEE_PCT = isUsd ? 0 : KR_FEE.BUY_FEE_PCT;
      const SELL_FEE_PCT = isUsd ? 0 : KR_FEE.SELL_FEE_PCT;
      const holdings = new Map<string, { qty: number; totalCost: number }>();
      for (const o of pnlRows as Array<any>) {
        const code = String(o.stock_code ?? '');
        const side = String(o.side ?? '');
        const qty = Math.max(0, Number(o.filled_quantity || o.quantity || 0));
        const price = Math.max(0, Number(o.filled_price ?? 0));
        if (!code || qty <= 0 || price <= 0) continue;

        const h = holdings.get(code) ?? { qty: 0, totalCost: 0 };
        if (side === 'BUY') {
          const buyValue = qty * price;
          h.qty += qty;
          h.totalCost += buyValue + (isUsd ? 0 : Math.round(buyValue * BUY_FEE_PCT));
          holdings.set(code, h);
          continue;
        }

        if (side !== 'SELL' || h.qty <= 0) continue;
        const matchedQty = Math.min(qty, h.qty);
        if (matchedQty <= 0) continue;

        const avgCost = h.totalCost / h.qty;
        const costBasis = avgCost * matchedQty;
        const sellValue = matchedQty * price;
        const sellFee = isUsd ? 0 : Math.round(sellValue * SELL_FEE_PCT);
        const pnl = sellValue - sellFee - costBasis;
        const pct = costBasis > 0 ? (pnl / costBasis) * 100 : null;
        // 수익률 100% 초과 = 입금으로 왜곡된 평단가 → 제외 (해외만)
        if (isUsd && pct != null && Math.abs(pct) > 100) continue;
        tradePnlMap.set(String(o.id), { pnl, pct, isUsd });

        h.qty -= matchedQty;
        h.totalCost -= costBasis;
        if (h.qty <= 0) {
          h.qty = 0;
          h.totalCost = 0;
        }
        holdings.set(code, h);
      }
    };

    if (domesticCodes.length > 0) {
      const { rows: pnlRows } = await getPool().query(
        `SELECT id, stock_code, side, quantity, filled_quantity, filled_price
           FROM orders
          WHERE status = 'FILLED'
            AND is_paper = $3
            AND stock_code = ANY($1::text[])
            AND (trading_mode = $2::text OR ($2::text = 'paper' AND trading_mode = 'p_arch'))
          ORDER BY created_at ASC, id ASC`,
        [domesticCodes, tradeMode, viewIsPaper],
      );
      calcFifoPnl(pnlRows, false);
    }

    if (overseasCodes.length > 0) {
      const { rows: osPnlRows } = await getPool().query(
        `SELECT id, stock_code, side, quantity, filled_quantity, filled_price
           FROM orders
          WHERE status = 'FILLED'
            AND is_paper = $3
            AND stock_code = ANY($1::text[])
            AND (trading_mode = $2::text OR ($2::text = 'paper' AND trading_mode = 'p_arch'))
          ORDER BY created_at ASC, id ASC`,
        [overseasCodes, tradeMode, viewIsPaper],
      );
      calcFifoPnl(osPnlRows, true);
    }

    const rowsWithPnl = rows.map((r: any) => {
      const p = tradePnlMap.get(String(r.id ?? ''));
      if (p) {
        return { ...r, realized_pnl: p.pnl, realized_pnl_pct: p.pct, realized_pnl_usd: p.isUsd ? p.pnl : null };
      }
      // 폴백: chain avg_buy_price → order-level avg_buy_price (해외주식은 chain 없이 order에 직접 저장)
      const chainAvgBuy = r.transaction_chains?.avg_buy_price;
      const orderAvgBuy = r.avg_buy_price;
      const avgBuy = Number(chainAvgBuy || orderAvgBuy || 0);
      if (String(r.side) === 'SELL' && avgBuy > 0) {
        const qty = Math.max(0, Number(r.filled_quantity ?? 0));
        const sellPx = Math.max(0, Number(r.filled_price ?? 0));
        const isUsd = !/^[0-9]{6}$/.test(String(r.stock_code ?? ''));
        if (qty > 0 && sellPx > 0) {
          const costBasis = avgBuy * qty;
          const sellValue = sellPx * qty;
          const sellFee = isUsd ? 0 : Math.round(sellValue * 0.00195); // KR_FEE.SELL_FEE_PCT (수수료0.015%+거래세0.18%)
          const buyFee = isUsd ? 0 : Math.round(costBasis * 0.00015); // KR_FEE.BUY_FEE_PCT
          const pnl = sellValue - sellFee - costBasis - buyFee;
          const pct = (pnl / costBasis) * 100;
          return { ...r, realized_pnl: pnl, realized_pnl_pct: pct, realized_pnl_usd: isUsd ? pnl : null };
        }
      }
      return { ...r, realized_pnl: null, realized_pnl_pct: null, realized_pnl_usd: null };
    });

    const unresolvedDomestic = [
      ...new Set(
        rowsWithPnl
          .filter((r: any) => /^[0-9]{6}$/.test(String(r.stock_code)) && isInvalidStockName(r.stock_name, r.stock_code))
          .map((r: any) => String(r.stock_code)),
      ),
    ];
    const nameMap = new Map<string, string>();

    for (const r of rowsWithPnl) {
      const code = String(r.stock_code ?? '');
      const knownName = getKnownStockName(code);
      if (isInvalidStockName(r.stock_name, code) && knownName) {
        nameMap.set(code, knownName);
      }
    }

    if (unresolvedDomestic.length > 0) {
      const timeoutMap2 = new Map<string, CurrentPrice>();
      const quotes = await Promise.race([
        getBatchPrices(unresolvedDomestic.slice(0, 20)),
        new Promise<Map<string, CurrentPrice>>((resolve) => setTimeout(() => resolve(timeoutMap2), 3000)),
      ]).catch(() => new Map<string, CurrentPrice>());
      for (const [code, q] of quotes) {
        if (!isInvalidStockName(q.stockName, code)) {
          nameMap.set(code, q.stockName.trim());
        }
      }
    }

    if (nameMap.size === 0) return c.json(rowsWithPnl);

    const patched = rowsWithPnl.map((r: any) => {
      const code = String(r.stock_code ?? '');
      const resolved = nameMap.get(code);
      return resolved ? { ...r, stock_name: resolved } : r;
    });

    await Promise.allSettled(
      [...nameMap.entries()].map(([code, name]) =>
        getPool().query(`UPDATE watchlist SET stock_name = $1 WHERE stock_code = $2`, [name, code]),
      ),
    );

    return c.json(patched);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 오늘 매매 통계 (서버 KST 기준) ──
tradeRoutes.get('/trades/today-stats', async (c) => {
  const viewIsPaper = resolveRequestMode(c);
  const stats = await getTodayTradeStats(viewIsPaper);
  return c.json(stats);
});

// ── 시장 참고 소스 ──
tradeRoutes.get('/sources', async (c) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM market_sources ORDER BY is_pinned DESC, added_at DESC LIMIT 50',
    );
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

tradeRoutes.post('/sources', async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
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

tradeRoutes.patch('/sources/:id/pin', async (c) => {
  const id = c.req.param('id');
  try {
    await getPool().query('UPDATE market_sources SET is_pinned = NOT is_pinned WHERE id = $1', [id]);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

tradeRoutes.delete('/sources/:id', async (c) => {
  const id = c.req.param('id');
  try {
    await getPool().query('DELETE FROM market_sources WHERE id = $1', [id]);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 용돈 이관 현황 ──
tradeRoutes.get('/withdraw/config', async (c) => {
  const stats = await getDinnerMoneyStats();
  return c.json({ is_active: true, withdraw_ratio_pct: 10, min_profit: 100000, ...stats });
});

tradeRoutes.put('/withdraw/config', async (_c) => {
  return _c.json({ ok: true });
});

tradeRoutes.get('/withdraw/history', async (c) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, amount, memo, status, created_at FROM profit_withdrawals ORDER BY created_at DESC LIMIT 50`,
    );
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

tradeRoutes.patch('/withdraw/:id/status', async (c) => {
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

// ── 일자별 손익 요약 ──
tradeRoutes.get('/trades/daily-summary', async (c) => {
  const viewIsPaper = resolveRequestMode(c);
  const tradeMode = viewIsPaper ? 'paper' : 'live';
  const days = Math.min(Math.max(1, Number(c.req.query('days') ?? 30)), 365);

  try {
    // 일자별 매도 실현손익 집계 (FIFO 기반 — 체인 realized_pnl 사용)
    const { rows } = await getPool().query(
      `
      SELECT
        (o.created_at AT TIME ZONE 'Asia/Seoul')::DATE AS trade_date,
        COUNT(*) FILTER (WHERE o.side = 'BUY') AS buy_count,
        COUNT(*) FILTER (WHERE o.side = 'SELL') AS sell_count,
        COUNT(*) AS total_count,
        -- 국내 실현손익 KRW (체인 또는 주문 avg_buy_price 폴백)
        COALESCE(SUM(
          CASE WHEN o.side = 'SELL' AND o.stock_code ~ '^[0-9]{6}$'
               AND COALESCE(tc.avg_buy_price, o.avg_buy_price) > 0 THEN
            (COALESCE(o.filled_price, 0) * COALESCE(o.filled_quantity, o.quantity, 0)
             - ROUND(COALESCE(o.filled_price, 0) * COALESCE(o.filled_quantity, o.quantity, 0) * ${KR_FEE.SELL_FEE_PCT}))
            - (COALESCE(tc.avg_buy_price, o.avg_buy_price) * COALESCE(o.filled_quantity, o.quantity, 0))
          END
        ), 0) AS realized_pnl,
        -- 해외 실현손익 USD (체인 없으므로 o.avg_buy_price 사용)
        COALESCE(SUM(
          CASE WHEN o.side = 'SELL' AND o.stock_code !~ '^[0-9]{6}$'
               AND COALESCE(tc.avg_buy_price, o.avg_buy_price) > 0 THEN
            (COALESCE(o.filled_price, 0) - COALESCE(tc.avg_buy_price, o.avg_buy_price))
            * COALESCE(o.filled_quantity, o.quantity, 0)
          END
        ), 0) AS realized_pnl_usd,
        -- 해외/국내 구분
        COUNT(*) FILTER (WHERE o.stock_code ~ '^[0-9]{6}$') AS domestic_count,
        COUNT(*) FILTER (WHERE o.stock_code !~ '^[0-9]{6}$') AS overseas_count,
        -- v10.2: 승패 판정도 수수료 차감 후 (수수료 빼면 패인 거래를 승으로 세지 않도록)
        COUNT(*) FILTER (WHERE o.side = 'SELL'
          AND COALESCE(tc.avg_buy_price, o.avg_buy_price) > 0
          AND (COALESCE(o.filled_price, 0) * (1 - ${KR_FEE.SELL_FEE_PCT})) > COALESCE(tc.avg_buy_price, o.avg_buy_price)) AS win_count,
        COUNT(*) FILTER (WHERE o.side = 'SELL'
          AND COALESCE(tc.avg_buy_price, o.avg_buy_price) > 0
          AND (COALESCE(o.filled_price, 0) * (1 - ${KR_FEE.SELL_FEE_PCT})) <= COALESCE(tc.avg_buy_price, o.avg_buy_price)) AS loss_count
      FROM orders o
      LEFT JOIN transaction_chains tc ON o.chain_id = tc.id
      WHERE o.is_paper = $1
        AND o.trading_mode IN ($2, CASE WHEN $2 = 'paper' THEN 'p_arch' ELSE $2 END)
        AND o.status = 'FILLED'
        AND o.created_at >= (DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Seoul') - ($3 * INTERVAL '1 day')) AT TIME ZONE 'Asia/Seoul'
      GROUP BY trade_date
      ORDER BY trade_date DESC
    `,
      [viewIsPaper, tradeMode, days],
    );

    const dailySummary = rows.map((r: any) => ({
      date: String(r.trade_date).slice(0, 10),
      totalTrades: Number(r.total_count),
      buys: Number(r.buy_count),
      sells: Number(r.sell_count),
      domesticCount: Number(r.domestic_count),
      overseasCount: Number(r.overseas_count),
      realizedPnl: Math.round(Number(r.realized_pnl) * 100) / 100,
      realizedPnlUsd: Math.round(Number(r.realized_pnl_usd || 0) * 100) / 100,
      winCount: Number(r.win_count),
      lossCount: Number(r.loss_count),
      winRate:
        Number(r.win_count) + Number(r.loss_count) > 0
          ? Math.round((Number(r.win_count) / (Number(r.win_count) + Number(r.loss_count))) * 100)
          : 0,
    }));

    const totalPnl = dailySummary.reduce((sum, d) => sum + d.realizedPnl, 0);
    const totalPnlUsd = dailySummary.reduce((sum, d) => sum + d.realizedPnlUsd, 0);
    const totalWins = dailySummary.reduce((sum, d) => sum + d.winCount, 0);
    const totalLosses = dailySummary.reduce((sum, d) => sum + d.lossCount, 0);

    return c.json({
      days: dailySummary,
      summary: {
        totalDays: dailySummary.length,
        totalPnl: Math.round(totalPnl * 100) / 100,
        totalPnlUsd: Math.round(totalPnlUsd * 100) / 100,
        totalTrades: dailySummary.reduce((sum, d) => sum + d.totalTrades, 0),
        totalWins,
        totalLosses,
        overallWinRate: totalWins + totalLosses > 0 ? Math.round((totalWins / (totalWins + totalLosses)) * 100) : 0,
        profitDays: dailySummary.filter((d) => d.realizedPnl > 0).length,
        lossDays: dailySummary.filter((d) => d.realizedPnl < 0).length,
      },
      mode: tradeMode,
      period: `${days}days`,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 특정일 매매 상세 ──
tradeRoutes.get('/trades/by-date/:date', async (c) => {
  const dateParam = c.req.param('date'); // YYYY-MM-DD
  const viewIsPaper = resolveRequestMode(c);
  const tradeMode = viewIsPaper ? 'paper' : 'live';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return c.json({ error: 'Invalid date format. Use YYYY-MM-DD' }, 400);
  }

  try {
    const { rows } = await getPool().query(
      `SELECT o.*,
         COALESCE(w.stock_name, o.stock_code) AS stock_name,
         tc.avg_buy_price,
         tc.status AS chain_status,
         tc.strategy_mode
       FROM orders o
       LEFT JOIN transaction_chains tc ON o.chain_id = tc.id
       LEFT JOIN watchlist w ON o.stock_code = w.stock_code
       WHERE o.is_paper = $1
         AND o.trading_mode IN ($2, CASE WHEN $2 = 'paper' THEN 'p_arch' ELSE $2 END)
         AND o.status = 'FILLED'
         AND (o.created_at AT TIME ZONE 'Asia/Seoul')::DATE = $3::DATE
       ORDER BY o.created_at ASC`,
      [viewIsPaper, tradeMode, dateParam],
    );

    // v10.2: 수수료 포함 PnL 계산 (대시보드/매매내역 통일)
    const trades = rows.map((r: any) => {
      const avgBuy = Number(r.avg_buy_price ?? 0);
      const fillPrice = Number(r.filled_price ?? 0);
      const qty = Number(r.filled_quantity ?? r.quantity ?? 0);
      const isSell = r.side === 'SELL';
      const isKr = /^[0-9]{6}$/.test(r.stock_code ?? '');
      const sellValue = fillPrice * qty;
      const sellFee = isSell && isKr ? Math.round(sellValue * KR_FEE.SELL_FEE_PCT) : 0;
      const pnl = isSell && avgBuy > 0 ? sellValue - sellFee - avgBuy * qty : null;
      const pnlPct = isSell && avgBuy > 0 ? ((sellValue - sellFee - avgBuy * qty) / (avgBuy * qty)) * 100 : null;
      return {
        ...r,
        realized_pnl: pnl != null ? Math.round(pnl * 100) / 100 : null,
        realized_pnl_pct: pnlPct != null ? Math.round(pnlPct * 100) / 100 : null,
      };
    });

    const totalPnl = trades.reduce((sum: number, t: any) => sum + (t.realized_pnl ?? 0), 0);

    return c.json({
      date: dateParam,
      trades,
      summary: {
        totalTrades: trades.length,
        buys: trades.filter((t: any) => t.side === 'BUY').length,
        sells: trades.filter((t: any) => t.side === 'SELL').length,
        realizedPnl: Math.round(totalPnl * 100) / 100,
      },
      mode: tradeMode,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 승률 분석: 점수 구간별 WIN/LOSS 집계 ──
tradeRoutes.get('/stats/win-rate-bands', async (c) => {
  const viewIsPaper = resolveRequestMode(c);
  try {
    const { rows } = await getPool().query<{
      band: string;
      total: string;
      wins: string;
      losses: string;
      break_evens: string;
      avg_pnl: string;
    }>(
      `
      SELECT
        CASE
          WHEN entry_score >= 90 THEN '90+'
          WHEN entry_score >= 85 THEN '85-89'
          WHEN entry_score >= 80 THEN '80-84'
          WHEN entry_score >= 75 THEN '75-79'
          ELSE '<75'
        END AS band,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE outcome = 'WIN')        AS wins,
        COUNT(*) FILTER (WHERE outcome = 'LOSS')       AS losses,
        COUNT(*) FILTER (WHERE outcome = 'BREAK_EVEN') AS break_evens,
        ROUND(AVG(realized_pnl_pct)::NUMERIC, 2)       AS avg_pnl
      FROM score_accuracy
      WHERE recorded_at >= NOW() - INTERVAL '30 days'
        AND entry_score IS NOT NULL
        AND is_paper = $1
      GROUP BY band
      ORDER BY MIN(entry_score) DESC NULLS LAST
    `,
      [viewIsPaper],
    );

    const bands = rows.map((r) => ({
      band: r.band,
      total: Number(r.total),
      wins: Number(r.wins),
      losses: Number(r.losses),
      breakEvens: Number(r.break_evens),
      winRate: Number(r.total) > 0 ? Math.round((Number(r.wins) / Number(r.total)) * 100) : 0,
      avgPnlPct: Number(r.avg_pnl),
    }));

    return c.json({ ok: true, bands, period: '30days' });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
