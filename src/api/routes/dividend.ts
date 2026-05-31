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
import { fetchExchangeRate } from '../../automation/macro-data.js';

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

// ═══════════════════════════════════════════════════════
// Money Printer: 배당 자동투자 + 통합 요약
// ═══════════════════════════════════════════════════════

/** ETF 최적 배분 비중 */
const ETF_WEIGHTS: Record<string, number> = {
  JEPQ: 0.25, JEPI: 0.25, SCHD: 0.20, QYLD: 0.15, XYLD: 0.10, O: 0.05,
};

// ── 배당 ETF 자동투자 (금액 입력 → 자동 배분) ──
dividendRoutes.post('/dividend/auto-invest', async (c) => {
  try {
    const { amount_krw } = await c.req.json<{ amount_krw: number }>();
    if (!amount_krw || amount_krw < 10000) return c.json({ error: '최소 1만원 이상' }, 400);
    if (amount_krw > 10000000) return c.json({ error: '최대 1000만원' }, 400);

    // 환율 → USD
    const fx = await fetchExchangeRate();
    const totalUsd = amount_krw / fx;

    // ETF 현재가 조회
    const { getOverseasPrice } = await import('../../kis/overseas.js');
    const etfCodes = Object.keys(ETF_WEIGHTS);
    const prices: Record<string, number> = {};
    for (const code of etfCodes) {
      try {
        const p = await getOverseasPrice(code, code === 'O' ? 'NYSE' : 'NASDAQ');
        prices[code] = Number(p.currentPrice) || 0;
      } catch { prices[code] = 0; }
    }

    // 배분 + 매수
    const results: Array<{ code: string; shares: number; invested: number; price: number }> = [];
    let totalInvested = 0;

    for (const [code, weight] of Object.entries(ETF_WEIGHTS)) {
      const price = prices[code];
      if (price <= 0) continue;
      const allocation = totalUsd * weight;
      const shares = Math.floor(allocation / price);
      if (shares <= 0) continue;
      const invested = shares * price;
      totalInvested += invested;

      const exchange = code === 'O' ? 'NYSE' : 'NASDAQ';
      await getPool().query(
        `INSERT INTO dividend_holdings (stock_code, exchange, quantity, avg_price, total_dividends_received, is_paper)
         VALUES ($1, $2, $3, $4, 0, TRUE)
         ON CONFLICT (stock_code, exchange, is_paper) DO UPDATE SET
           avg_price = (dividend_holdings.avg_price * dividend_holdings.quantity + $4 * $3) / (dividend_holdings.quantity + $3),
           quantity = dividend_holdings.quantity + $3`,
        [code, exchange, shares, price]
      );
      results.push({ code, shares, invested, price });
    }

    // 투자금 기록 (overseas_state KV)
    await getPool().query(
      `INSERT INTO overseas_state (key, value) VALUES ('dividend_invested_krw', $1::text)
       ON CONFLICT (key) DO UPDATE SET value = (COALESCE(overseas_state.value::numeric, 0) + $1)::text`,
      [amount_krw]
    );

    // feature flag 자동 ON
    await getPool().query(
      `UPDATE feature_flags SET enabled = TRUE WHERE key = 'dividend_investing' AND enabled = FALSE`
    );

    logger.info(`[MoneyPrinter] 배당 자동투자: ₩${amount_krw.toLocaleString()} → $${totalInvested.toFixed(0)} (${results.length} ETF)`, { component: 'DIVIDEND' });
    return c.json({ ok: true, fx, totalUsd: +totalUsd.toFixed(2), totalInvested: +totalInvested.toFixed(2), etfs: results });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── Money Printer 통합 요약 ──
dividendRoutes.get('/money-printer/summary', async (c) => {
  try {
    const fx = await fetchExchangeRate().catch(() => 1350);

    // 배당 현황
    const { rows: divHoldings } = await getPool().query(
      `SELECT dh.stock_code, dh.quantity, dh.avg_price, dh.total_dividends_received,
              dw.dividend_yield, dw.name
       FROM dividend_holdings dh
       LEFT JOIN dividend_watchlist dw ON dh.stock_code = dw.stock_code
       WHERE dh.is_paper = TRUE AND dh.quantity > 0`
    );
    const { rows: divInvestedRow } = await getPool().query(
      `SELECT COALESCE(value::numeric, 0) AS v FROM overseas_state WHERE key = 'dividend_invested_krw'`
    );
    const divInvestedKrw = Number(divInvestedRow[0]?.v ?? 0);
    let divCurrentUsd = 0;
    let divDividendsUsd = 0;
    let divMonthlyUsd = 0;
    const divList = divHoldings.map((h: any) => {
      const qty = Number(h.quantity);
      const avgPx = Number(h.avg_price);
      const divYield = Number(h.dividend_yield ?? 0) / 100;
      const value = qty * avgPx; // 매수가 기준 (실시간 시세는 비용 절감)
      const divReceived = Number(h.total_dividends_received ?? 0);
      const monthlyDiv = value * divYield * 0.846 / 12; // 세후 월배당
      divCurrentUsd += value;
      divDividendsUsd += divReceived;
      divMonthlyUsd += monthlyDiv;
      return { code: h.stock_code, name: h.name, shares: qty, avgPrice: avgPx, dividends: divReceived, monthlyDiv: +monthlyDiv.toFixed(2) };
    });
    const divReturnPct = divInvestedKrw > 0 ? (((divCurrentUsd * fx + divDividendsUsd * fx) / divInvestedKrw) - 1) * 100 : 0;

    // 선물 현황
    const { rows: fBudget } = await getPool().query('SELECT * FROM futures_budget WHERE id = 1');
    const fb = fBudget[0] || { allocated_krw: 0, total_pnl_usd: 0 };
    const fInvestedKrw = Number(fb.allocated_krw ?? 0);
    const fPnlUsd = Number(fb.total_pnl_usd ?? 0);
    const { rows: fStats } = await getPool().query(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE pnl_usd > 0) AS wins FROM futures_trades WHERE pnl_usd IS NOT NULL`
    );
    const { rows: fOpen } = await getPool().query(`SELECT COUNT(*) AS cnt FROM futures_positions WHERE status = 'open'`);
    const fTotal = Number(fStats[0]?.total ?? 0);
    const fWins = Number(fStats[0]?.wins ?? 0);
    const fCurrentKrw = fInvestedKrw + fPnlUsd * fx;

    // 통합
    const totalInvested = divInvestedKrw + fInvestedKrw;
    const totalCurrent = divCurrentUsd * fx + divDividendsUsd * fx + fCurrentKrw;
    const totalReturn = totalInvested > 0 ? ((totalCurrent / totalInvested) - 1) * 100 : 0;

    return c.json({
      dividend: {
        investedKrw: divInvestedKrw,
        currentValueUsd: +divCurrentUsd.toFixed(2),
        dividendsUsd: +divDividendsUsd.toFixed(2),
        monthlyDivUsd: +divMonthlyUsd.toFixed(2),
        returnPct: +divReturnPct.toFixed(1),
        holdings: divList,
      },
      futures: {
        investedKrw: fInvestedKrw,
        totalPnlUsd: +fPnlUsd.toFixed(2),
        trades: fTotal,
        winRate: fTotal > 0 ? +(fWins / fTotal * 100).toFixed(0) : 0,
        openPositions: Number(fOpen[0]?.cnt ?? 0),
        currentValueKrw: +fCurrentKrw.toFixed(0),
      },
      total: {
        investedKrw: totalInvested,
        currentValueKrw: +totalCurrent.toFixed(0),
        returnPct: +totalReturn.toFixed(1),
      },
      fx,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── Trade Tuner 결과 조회 + 수동 실행 ──

dividendRoutes.get('/trade-tuner/result', async (c) => {
  try {
    const { rows } = await getPool().query(
      `SELECT value FROM overseas_state WHERE key = 'trade_tuner_result'`
    );
    const result = rows.length > 0 ? JSON.parse(rows[0].value) : null;
    const { rows: ov } = await getPool().query(
      `SELECT value FROM overseas_state WHERE key = 'trade_tuner_overrides'`
    );
    const overrides = ov.length > 0 ? JSON.parse(ov[0].value) : {};
    return c.json({ result, overrides });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

dividendRoutes.post('/trade-tuner/run', async (c) => {
  try {
    const { runTradeTuner } = await import('../../scheduler/overseas/trade-tuner.js');
    const result = await runTradeTuner(true);
    return c.json({ ok: true, result });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
