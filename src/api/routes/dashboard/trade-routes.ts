/**
 * 매매 기록, 승률 분석, 시장 소스, 용돈 이관 라우트
 */
import { Hono } from 'hono';
import { KR_FEE } from '../../../config/constants.js';
import { config } from '../../../config/index.js';
import { getPool } from '../../../db/client.js';
import { getBatchPrices, type CurrentPrice } from '../../../kis/market.js';
import { getDinnerMoneyStats } from '../../../automation/profit-withdraw.js';
import { isInvalidStockName, getKnownStockName } from './helpers.js';

export const tradeRoutes = new Hono();

// ── 매매 기록 ──
tradeRoutes.get('/trades', async (c) => {
  const limit = Math.min(Math.max(1, Number(c.req.query('limit') ?? 50)), 500);
  const viewModeParam = c.req.query('viewMode');
  const viewIsPaper = viewModeParam === 'paper' ? true : viewModeParam === 'live' ? false : config.isPaper;
  const tradeMode = viewIsPaper ? 'paper' : 'live';
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
           'avg_buy_price', tc.avg_buy_price
         ) END AS transaction_chains
       FROM orders o
       LEFT JOIN transaction_chains tc ON o.chain_id = tc.id
       LEFT JOIN watchlist w ON o.stock_code = w.stock_code
       WHERE o.trading_mode = $2
       ORDER BY o.created_at DESC
       LIMIT $1`,
      [limit, tradeMode],
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
        tradePnlMap.set(String(o.id), { pnl, pct, isUsd });

        h.qty -= matchedQty;
        h.totalCost -= costBasis;
        if (h.qty <= 0) { h.qty = 0; h.totalCost = 0; }
        holdings.set(code, h);
      }
    };

    if (domesticCodes.length > 0) {
      const { rows: pnlRows } = await getPool().query(
        `SELECT id, stock_code, side, quantity, filled_quantity, filled_price
           FROM orders
          WHERE status = 'FILLED'
            AND stock_code = ANY($1::text[])
            AND trading_mode = $2
          ORDER BY created_at ASC, id ASC`,
        [domesticCodes, tradeMode],
      );
      calcFifoPnl(pnlRows, false);
    }

    if (overseasCodes.length > 0) {
      const { rows: osPnlRows } = await getPool().query(
        `SELECT id, stock_code, side, quantity, filled_quantity, filled_price
           FROM orders
          WHERE status = 'FILLED'
            AND stock_code = ANY($1::text[])
            AND trading_mode = $2
          ORDER BY created_at ASC, id ASC`,
        [overseasCodes, tradeMode],
      );
      calcFifoPnl(osPnlRows, true);
    }

    const rowsWithPnl = rows.map((r: any) => {
      const p = tradePnlMap.get(String(r.id ?? ''));
      if (p) {
        return { ...r, realized_pnl: p.pnl, realized_pnl_pct: p.pct, realized_pnl_usd: p.isUsd ? p.pnl : null };
      }
      const chainAvgBuy = r.transaction_chains?.avg_buy_price;
      if (String(r.side) === 'SELL' && chainAvgBuy) {
        const qty = Math.max(0, Number(r.filled_quantity ?? 0));
        const sellPx = Math.max(0, Number(r.filled_price ?? 0));
        const avgBuy = Number(chainAvgBuy);
        const isUsd = !/^[0-9]{6}$/.test(String(r.stock_code ?? ''));
        if (qty > 0 && sellPx > 0 && avgBuy > 0) {
          const costBasis = avgBuy * qty;
          const sellValue = sellPx * qty;
          const sellFee = isUsd ? 0 : Math.round(sellValue * 0.00245);
          const buyFee = isUsd ? 0 : Math.round(costBasis * 0.00015);
          const pnl = sellValue - sellFee - costBasis - buyFee;
          const pct = (pnl / costBasis) * 100;
          return { ...r, realized_pnl: pnl, realized_pnl_pct: pct, realized_pnl_usd: isUsd ? pnl : null };
        }
      }
      return { ...r, realized_pnl: null, realized_pnl_pct: null, realized_pnl_usd: null };
    });

    const unresolvedDomestic = [...new Set(
      rowsWithPnl
        .filter((r: any) => /^[0-9]{6}$/.test(String(r.stock_code)) && isInvalidStockName(r.stock_name, r.stock_code))
        .map((r: any) => String(r.stock_code))
    )];
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
        new Promise<Map<string, CurrentPrice>>(resolve => setTimeout(() => resolve(timeoutMap2), 3000)),
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
        getPool().query(
          `UPDATE watchlist SET stock_name = $1 WHERE stock_code = $2`,
          [name, code],
        )
      )
    );

    return c.json(patched);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 시장 참고 소스 ──
tradeRoutes.get('/sources', async (c) => {
  try {
    const { rows } = await getPool().query('SELECT * FROM market_sources ORDER BY is_pinned DESC, added_at DESC LIMIT 50');
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

tradeRoutes.post('/sources', async (c) => {
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

// ── 승률 분석: 점수 구간별 WIN/LOSS 집계 ──
tradeRoutes.get('/stats/win-rate-bands', async (c) => {
  const viewModeParam = c.req.query('viewMode');
  const viewIsPaper = viewModeParam === 'paper' ? true : viewModeParam === 'live' ? false : config.isPaper;
  try {
    const { rows } = await getPool().query<{
      band: string;
      total: string;
      wins: string;
      losses: string;
      break_evens: string;
      avg_pnl: string;
    }>(`
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
    `, [viewIsPaper]);

    const bands = rows.map(r => ({
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
