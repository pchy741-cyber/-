/**
 * 월배당 투자 API 라우트
 * - 감시목록 CRUD
 * - 배당 일정 조회 (KIS API)
 * - 배당금 수령 내역
 * - 배당 보유종목 관리
 */
import { Hono } from 'hono';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { baseIsPaper } from '../../config/index.js';

export const dividendRoutes = new Hono();

// ── 기능 플래그 체크 미들웨어 ──
async function checkDividendEnabled(): Promise<boolean> {
  try {
    const { rows } = await getPool().query("SELECT enabled FROM feature_flags WHERE key = 'dividend_investing'");
    return rows[0]?.enabled === true;
  } catch { return false; }
}

// ── 감시목록 조회 ──
dividendRoutes.get('/dividend/watchlist', async (c) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM dividend_watchlist ORDER BY dividend_yield DESC NULLS LAST, added_at`
    );
    const enabled = await checkDividendEnabled();
    return c.json({ enabled, watchlist: rows });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 감시목록 추가 ──
dividendRoutes.post('/dividend/watchlist', async (c) => {
  try {
    const body = await c.req.json<{ stock_code: string; exchange?: string; name?: string; sector?: string; payment_frequency?: string; notes?: string }>();
    const { stock_code, exchange = 'NASDAQ', name, sector, payment_frequency = 'monthly', notes } = body;
    if (!stock_code) return c.json({ error: '종목코드 필요' }, 400);

    await getPool().query(
      `INSERT INTO dividend_watchlist (stock_code, exchange, name, sector, payment_frequency, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (stock_code, exchange) DO UPDATE SET name = COALESCE($3, dividend_watchlist.name), notes = COALESCE($6, dividend_watchlist.notes)`,
      [stock_code.toUpperCase(), exchange, name, sector, payment_frequency, notes]
    );
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 감시목록 삭제 ──
dividendRoutes.delete('/dividend/watchlist/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await getPool().query('DELETE FROM dividend_watchlist WHERE id = $1', [id]);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 감시종목 배당수익률 업데이트 ──
dividendRoutes.patch('/dividend/watchlist/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ dividend_yield?: number; annual_dividend_per_share?: number; expense_ratio?: number; aum_billion?: number; notes?: string }>();
    const sets: string[] = [];
    const vals: any[] = [];
    let idx = 1;
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) { sets.push(`${k} = $${idx}`); vals.push(v); idx++; }
    }
    if (sets.length === 0) return c.json({ error: '업데이트 필드 없음' }, 400);
    vals.push(id);
    await getPool().query(`UPDATE dividend_watchlist SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 배당 보유종목 조회 ──
dividendRoutes.get('/dividend/holdings', async (c) => {
  try {
    const isPaper = c.req.query('viewMode') === 'paper' ? true : baseIsPaper;
    const { rows } = await getPool().query(
      `SELECT dh.*, dw.name, dw.dividend_yield, dw.payment_frequency, dw.sector
       FROM dividend_holdings dh
       LEFT JOIN dividend_watchlist dw ON dh.stock_code = dw.stock_code AND dh.exchange = dw.exchange
       WHERE dh.quantity > 0 AND dh.is_paper = $1
       ORDER BY dh.total_dividends_received DESC`,
      [isPaper]
    );
    return c.json({ holdings: rows });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 배당금 수령 내역 조회 ──
dividendRoutes.get('/dividend/history', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const { rows } = await getPool().query(
      `SELECT * FROM dividend_history ORDER BY pay_date DESC NULLS LAST, recorded_at DESC LIMIT $1`,
      [limit]
    );
    // 통계
    const { rows: stats } = await getPool().query(
      `SELECT
         COUNT(*) AS total_payments,
         COALESCE(SUM(net_amount_usd), 0) AS total_received_usd,
         COALESCE(SUM(tax_amount_usd), 0) AS total_tax_usd,
         COALESCE(AVG(net_amount_usd), 0) AS avg_per_payment
       FROM dividend_history`
    );
    return c.json({ history: rows, stats: stats[0] });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 배당금 수동 기록 ──
dividendRoutes.post('/dividend/history', async (c) => {
  try {
    const body = await c.req.json<{
      stock_code: string; exchange?: string; quantity: number;
      dividend_per_share: number; gross_amount_usd: number;
      tax_amount_usd?: number; ex_date?: string; pay_date?: string;
    }>();
    const net = body.gross_amount_usd - (body.tax_amount_usd || 0);
    await getPool().query(
      `INSERT INTO dividend_history (stock_code, exchange, quantity, dividend_per_share, gross_amount_usd, tax_amount_usd, net_amount_usd, ex_date, pay_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [body.stock_code, body.exchange || 'NASDAQ', body.quantity, body.dividend_per_share, body.gross_amount_usd, body.tax_amount_usd || 0, net, body.ex_date, body.pay_date]
    );
    // 보유종목 배당 누적 업데이트
    await getPool().query(
      `UPDATE dividend_holdings SET total_dividends_received = total_dividends_received + $1 WHERE stock_code = $2`,
      [net, body.stock_code]
    ).catch(() => {});
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── KIS 배당일정 조회 (프록시) ──
dividendRoutes.get('/dividend/schedule', async (c) => {
  try {
    const { getDividendSchedule } = await import('../../kis/dividend.js');
    const code = c.req.query('code');
    const events = await getDividendSchedule({ stockCode: code });
    return c.json({ events });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── KIS 배당금 수령내역 동기화 ──
dividendRoutes.post('/dividend/sync-receipts', async (c) => {
  try {
    const { getDividendReceipts } = await import('../../kis/dividend.js');
    const receipts = await getDividendReceipts();
    let synced = 0;
    for (const r of receipts) {
      try {
        await getPool().query(
          `INSERT INTO dividend_history (stock_code, gross_amount_usd, tax_amount_usd, net_amount_usd, pay_date)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [r.stockCode, r.amount, r.tax, r.netAmount, r.date || null]
        );
        synced++;
      } catch { /* skip duplicates */ }
    }
    return c.json({ ok: true, synced, total: receipts.length });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
