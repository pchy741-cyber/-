/**
 * 월배당 투자 API 라우트
 * - 감시목록 CRUD
 * - 배당 일정 조회 (KIS API)
 * - 배당금 수령 내역
 * - 배당 보유종목 관리
 */
import { Hono } from 'hono';
import { fetchExchangeRate } from '../../automation/macro-data.js';
import { FALLBACK_FX_RATE } from '../../config/constants.js';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { resolveIsPaper, resolveRequestMode, validateLivePin } from '../guards/live-pin.js';

export const dividendRoutes = new Hono();

// ── TTL 캐시: feature flag (30초) ──
let _divFlagCache: { value: boolean; ts: number } | null = null;
const FLAG_TTL = 30_000;

async function checkDividendEnabled(isPaper?: boolean): Promise<boolean> {
  if (isPaper) return true; // Paper 모드: 실험 기능 항상 허용
  const now = Date.now();
  if (_divFlagCache && now - _divFlagCache.ts < FLAG_TTL) return _divFlagCache.value;
  try {
    const { rows } = await getPool().query("SELECT enabled FROM feature_flags WHERE key = 'dividend_investing'");
    const v = rows[0]?.enabled === true;
    _divFlagCache = { value: v, ts: now };
    return v;
  } catch {
    return false;
  }
}

// ── 감시목록 조회 ──
dividendRoutes.get('/dividend/watchlist', async (c) => {
  try {
    const isPaper = resolveRequestMode(c);
    const { rows } = await getPool().query(
      `SELECT * FROM dividend_watchlist ORDER BY dividend_yield DESC NULLS LAST, added_at`,
    );
    const enabled = await checkDividendEnabled(isPaper);
    return c.json({ enabled, watchlist: rows });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 감시목록 추가 ──
dividendRoutes.post('/dividend/watchlist', async (c) => {
  try {
    const body = await c.req.json<{
      stock_code: string;
      exchange?: string;
      name?: string;
      sector?: string;
      payment_frequency?: string;
      notes?: string;
    }>();
    const { stock_code, exchange = 'NASDAQ', name, sector, payment_frequency = 'monthly', notes } = body;
    if (!stock_code) return c.json({ error: '종목코드 필요' }, 400);

    await getPool().query(
      `INSERT INTO dividend_watchlist (stock_code, exchange, name, sector, payment_frequency, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (stock_code, exchange) DO UPDATE SET name = COALESCE($3, dividend_watchlist.name), notes = COALESCE($6, dividend_watchlist.notes)`,
      [stock_code.toUpperCase(), exchange, name, sector, payment_frequency, notes],
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
    const body = await c.req.json<{
      dividend_yield?: number;
      annual_dividend_per_share?: number;
      expense_ratio?: number;
      aum_billion?: number;
      notes?: string;
    }>();
    const ALLOWED_COLS = new Set([
      'dividend_yield',
      'annual_dividend_per_share',
      'expense_ratio',
      'aum_billion',
      'notes',
    ]);
    const sets: string[] = [];
    const vals: any[] = [];
    let idx = 1;
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined && ALLOWED_COLS.has(k)) {
        sets.push(`${k} = $${idx}`);
        vals.push(v);
        idx++;
      }
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
    const isPaper = resolveRequestMode(c);
    const { rows } = await getPool().query(
      `SELECT dh.*, dw.name, dw.dividend_yield, dw.payment_frequency, dw.sector
       FROM dividend_holdings dh
       LEFT JOIN dividend_watchlist dw ON dh.stock_code = dw.stock_code AND dh.exchange = dw.exchange
       WHERE dh.quantity > 0 AND dh.is_paper = $1
       ORDER BY dh.total_dividends_received DESC`,
      [isPaper],
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
    const pool = getPool();
    const [{ rows }, { rows: stats }] = await Promise.all([
      pool.query(`SELECT * FROM dividend_history ORDER BY pay_date DESC NULLS LAST, recorded_at DESC LIMIT $1`, [
        limit,
      ]),
      pool.query(
        `SELECT COUNT(*) AS total_payments, COALESCE(SUM(net_amount_usd), 0) AS total_received_usd,
           COALESCE(SUM(tax_amount_usd), 0) AS total_tax_usd, COALESCE(AVG(net_amount_usd), 0) AS avg_per_payment
         FROM dividend_history`,
      ),
    ]);
    return c.json({ history: rows, stats: stats[0] });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 배당금 수동 기록 ──
dividendRoutes.post('/dividend/history', async (c) => {
  try {
    const body = await c.req.json<{
      stock_code: string;
      exchange?: string;
      quantity: number;
      dividend_per_share: number;
      gross_amount_usd: number;
      tax_amount_usd?: number;
      ex_date?: string;
      pay_date?: string;
    }>();
    const net = body.gross_amount_usd - (body.tax_amount_usd || 0);
    await getPool().query(
      `INSERT INTO dividend_history (stock_code, exchange, quantity, dividend_per_share, gross_amount_usd, tax_amount_usd, net_amount_usd, ex_date, pay_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        body.stock_code,
        body.exchange || 'NASDAQ',
        body.quantity,
        body.dividend_per_share,
        body.gross_amount_usd,
        body.tax_amount_usd || 0,
        net,
        body.ex_date,
        body.pay_date,
      ],
    );
    // 보유종목 배당 누적 업데이트
    await getPool()
      .query(
        `UPDATE dividend_holdings SET total_dividends_received = total_dividends_received + $1 WHERE stock_code = $2`,
        [net, body.stock_code],
      )
      .catch(() => {});
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
          [r.stockCode, r.amount, r.tax, r.netAmount, r.date || null],
        );
        synced++;
      } catch {
        /* skip duplicates */
      }
    }
    return c.json({ ok: true, synced, total: receipts.length });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ═══════════════════════════════════════════════════════
// Money Printer: 배당 자동투자 + 통합 요약
// ═══════════════════════════════════════════════════════

/** ETF 최적 배분 비중 (고배당 집중 — 가중수익률 9.73%, 세후 8.23%) */
const ETF_WEIGHTS: Record<string, number> = {
  QYLD: 0.30,  // 12.0% yield → 3.60%
  JEPQ: 0.25,  // 10.0% yield → 2.50%
  XYLD: 0.20,  // 10.0% yield → 2.00%
  JEPI: 0.15,  //  8.0% yield → 1.20%
  SCHD: 0.05,  //  3.5% yield → 0.18%
  O: 0.05,     //  5.0% yield → 0.25%
};

/** ETF 거래소 매핑 — watchlist JOIN 정합성 보장 */
const ETF_EXCHANGE: Record<string, string> = {
  JEPQ: 'NASDAQ',
  JEPI: 'NYSE',
  SCHD: 'NYSE',
  QYLD: 'NASDAQ',
  XYLD: 'NYSE',
  O: 'NYSE',
  MAIN: 'NYSE',
  STAG: 'NYSE',
  DIVO: 'NYSE',
  PFF: 'NASDAQ',
};
function getEtfExchange(code: string): string {
  return ETF_EXCHANGE[code] ?? 'NASDAQ';
}

// ── 배당 ETF 자동투자 (금액 입력 → 자동 배분, live=PIN 필수) ──
dividendRoutes.post('/dividend/auto-invest', async (c) => {
  try {
    const body = await c.req.json<{ amount_krw: number; mode?: 'paper' | 'live'; pin?: string }>();
    const { amount_krw } = body;
    if (!amount_krw || amount_krw < 10000) return c.json({ error: '최소 1만원 이상' }, 400);
    if (amount_krw > 500_000_000) return c.json({ error: '1회 최대 5억원' }, 400); // 비상 안전 상한 (실제 한도는 계좌 잔고)

    const isPaper = resolveIsPaper(body.mode);
    const pinCheck = validateLivePin(isPaper, body.pin);
    if (!pinCheck.ok) return c.json({ error: pinCheck.error }, 403);

    // 환율 → USD
    const fx = await fetchExchangeRate();
    const totalUsd = amount_krw / fx;

    // ETF 현재가 병렬 조회 (개별 8초 타임아웃)
    const { getOverseasPrice } = await import('../../kis/overseas.js');
    const etfCodes = Object.keys(ETF_WEIGHTS);
    const priceResults = await Promise.allSettled(
      etfCodes.map(async (code) => {
        const p = await Promise.race([
          getOverseasPrice(code, getEtfExchange(code)),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
        ]);
        return { code, price: Number((p as any).currentPrice) || 0 };
      }),
    );
    const prices: Record<string, number> = {};
    for (const r of priceResults) {
      if (r.status === 'fulfilled' && r.value.price > 0) prices[r.value.code] = r.value.price;
    }
    if (Object.keys(prices).length === 0) {
      return c.json({ error: 'ETF 시세 전부 조회 실패 (장 마감 또는 API 오류)' }, 502);
    }

    // 배분 + 매수
    const pool = getPool();
    const { placeOverseasOrder } = await import('../../kis/overseas.js');
    const results: Array<{ code: string; shares: number; invested: number; price: number; ordered: boolean }> = [];
    let totalInvested = 0;

    // 튜닝된 배분 비중이 있으면 우선 사용
    const { getOverseasState } = await import('../../scheduler/overseas/utils.js');
    let weights = ETF_WEIGHTS;
    try {
      const tunedRaw = await getOverseasState(`dividend_alloc_tuned_${isPaper ? 'paper' : 'live'}`);
      if (tunedRaw) {
        const tuned = JSON.parse(tunedRaw);
        if (tuned.weights && Object.keys(tuned.weights).length > 0) weights = tuned.weights;
      }
    } catch {
      /* use defaults */
    }

    for (const [code, weight] of Object.entries(weights)) {
      const price = prices[code];
      if (!price || price <= 0) continue;
      const allocation = totalUsd * weight;
      const shares = Math.floor(allocation / price);
      if (shares <= 0) continue;
      const invested = shares * price;
      totalInvested += invested;

      const exchange = getEtfExchange(code);

      // Live 모드: 실제 KIS 해외주문 실행
      let ordered = false;
      if (!isPaper) {
        try {
          await placeOverseasOrder({ stockCode: code, exchange, side: 'BUY', quantity: shares });
          ordered = true;
        } catch (e: any) {
          logger.warn(`[MoneyPrinter] ${code} 실주문 실패: ${e.message}`, { component: 'DIVIDEND' });
        }
      }

      await pool.query(
        `INSERT INTO dividend_holdings (stock_code, exchange, quantity, avg_price, total_dividends_received, is_paper)
         VALUES ($1, $2, $3, $4, 0, $5)
         ON CONFLICT (stock_code, exchange, is_paper) DO UPDATE SET
           avg_price = (dividend_holdings.avg_price * dividend_holdings.quantity + $4 * $3) / (dividend_holdings.quantity + $3),
           quantity = dividend_holdings.quantity + $3`,
        [code, exchange, shares, price, isPaper],
      );
      results.push({ code, shares, invested, price, ordered });
    }

    // 투자금 기록 (모드별 키: dividend_invested_krw_paper / dividend_invested_krw_live)
    const investKey = isPaper ? 'dividend_invested_krw_paper' : 'dividend_invested_krw_live';
    await Promise.all([
      pool.query(
        `INSERT INTO overseas_state (key, value) VALUES ($1, $2::text)
         ON CONFLICT (key) DO UPDATE SET value = (COALESCE(overseas_state.value::numeric, 0) + $2::numeric)::text`,
        [investKey, amount_krw],
      ),
      pool.query(`UPDATE feature_flags SET enabled = TRUE WHERE key = 'dividend_investing' AND enabled = FALSE`),
    ]);

    logger.info(
      `[MoneyPrinter] 배당 자동투자: ₩${amount_krw.toLocaleString()} → $${totalInvested.toFixed(0)} (${results.length} ETF)`,
      { component: 'DIVIDEND' },
    );
    return c.json({
      ok: true,
      fx,
      totalUsd: +totalUsd.toFixed(2),
      totalInvested: +totalInvested.toFixed(2),
      etfs: results,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── Money Printer 통합 요약 ──
dividendRoutes.get('/money-printer/summary', async (c) => {
  try {
    const pool = getPool();
    const isPaper = resolveRequestMode(c);
    const investKey = isPaper ? 'dividend_invested_krw_paper' : 'dividend_invested_krw_live';

    // 모든 독립 쿼리 병렬 실행
    const [fx, { rows: divHoldings }, { rows: divInvestedRow }] =
      await Promise.all([
        fetchExchangeRate().catch(() => FALLBACK_FX_RATE),
        pool.query(
          `SELECT dh.stock_code, dh.quantity, dh.avg_price, dh.total_dividends_received,
                dw.dividend_yield, dw.name
         FROM dividend_holdings dh
         LEFT JOIN dividend_watchlist dw ON dh.stock_code = dw.stock_code
         WHERE dh.is_paper = $1 AND dh.quantity > 0`,
          [isPaper],
        ),
        pool.query(`SELECT COALESCE(value::numeric, 0) AS v FROM overseas_state WHERE key = $1`, [investKey]),
      ]);

    // 배당 현황
    const divInvestedKrw = Number(divInvestedRow[0]?.v ?? 0);
    let divCurrentUsd = 0;
    let divDividendsUsd = 0;
    let divMonthlyUsd = 0;
    const divList = divHoldings.map((h: any) => {
      const qty = Number(h.quantity);
      const avgPx = Number(h.avg_price);
      const divYield = Number(h.dividend_yield ?? 0) / 100;
      const value = qty * avgPx;
      const divReceived = Number(h.total_dividends_received ?? 0);
      const monthlyDiv = (value * divYield * 0.846) / 12;
      divCurrentUsd += value;
      divDividendsUsd += divReceived;
      divMonthlyUsd += monthlyDiv;
      return {
        code: h.stock_code,
        name: h.name,
        shares: qty,
        avgPrice: avgPx,
        dividends: divReceived,
        monthlyDiv: +monthlyDiv.toFixed(2),
      };
    });
    const divReturnPct =
      divInvestedKrw > 0 ? ((divCurrentUsd * fx + divDividendsUsd * fx) / divInvestedKrw - 1) * 100 : 0;

    const totalCurrent = divCurrentUsd * fx + divDividendsUsd * fx;
    const totalReturn = divInvestedKrw > 0 ? (totalCurrent / divInvestedKrw - 1) * 100 : 0;

    return c.json({
      dividend: {
        investedKrw: divInvestedKrw,
        currentValueUsd: +divCurrentUsd.toFixed(2),
        dividendsUsd: +divDividendsUsd.toFixed(2),
        monthlyDivUsd: +divMonthlyUsd.toFixed(2),
        returnPct: +divReturnPct.toFixed(1),
        holdings: divList,
      },
      total: {
        investedKrw: divInvestedKrw,
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
      `SELECT key, value FROM overseas_state WHERE key IN ('trade_tuner_result', 'trade_tuner_overrides')`,
    );
    const byKey = Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    const result = byKey.trade_tuner_result ? JSON.parse(byKey.trade_tuner_result) : null;
    const overrides = byKey.trade_tuner_overrides ? JSON.parse(byKey.trade_tuner_overrides) : {};
    return c.json({ result, overrides });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

dividendRoutes.post('/trade-tuner/run', async (c) => {
  try {
    const { runTradeTuner } = await import('../../scheduler/overseas/trade-tuner.js');
    const paperResult = await runTradeTuner(true);
    const liveResult = await runTradeTuner(false);
    return c.json({ ok: true, paper: paperResult, live: liveResult });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 배당 배분 자동 튜닝 결과 조회 ──
dividendRoutes.get('/dividend/allocation-tuned', async (c) => {
  try {
    const mode = resolveRequestMode(c) ? 'paper' : 'live';
    const { rows } = await getPool().query(`SELECT value FROM overseas_state WHERE key = $1`, [
      `dividend_alloc_tuned_${mode}`,
    ]);
    if (rows[0]?.value) return c.json(JSON.parse(rows[0].value));
    return c.json({ weights: null });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 배당 보유종목 exchange 일괄 수정 (watchlist 기준 정합성 맞춤) ──
dividendRoutes.post('/dividend/fix-exchange', async (c) => {
  try {
    const pool = getPool();
    let fixed = 0;
    for (const [code, exchange] of Object.entries(ETF_EXCHANGE)) {
      const { rowCount } = await pool.query(
        `UPDATE dividend_holdings SET exchange = $1 WHERE stock_code = $2 AND exchange != $1`,
        [exchange, code],
      );
      if (rowCount && rowCount > 0) fixed += rowCount;
    }
    return c.json({ ok: true, fixed });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ═══════════════════════════════════════════════════════
// v4: 배당 Paper 자동 셋업 — 월 목표 배당금 기준 최소 자본 계산 + 투자
// ═══════════════════════════════════════════════════════

/** ETF별 예상 배당 수익률 (연간, %) — watchlist에서 업데이트되면 DB값 우선 */
const DEFAULT_YIELDS: Record<string, number> = {
  JEPQ: 10.0,
  JEPI: 8.0,
  SCHD: 3.5,
  QYLD: 12.0,
  XYLD: 10.0,
  O: 5.0,
};

dividendRoutes.post('/dividend/auto-setup-paper', async (c) => {
  try {
    const body = await c.req.json<{ target_monthly_krw?: number }>();
    const targetMonthly = body.target_monthly_krw ?? 1_000_000; // 기본: 월100만원
    if (targetMonthly < 10000) return c.json({ error: '최소 월 1만원 이상' }, 400);

    const fx = await fetchExchangeRate().catch(() => FALLBACK_FX_RATE);
    const pool = getPool();

    // DB에서 실제 배당수익률 가져오기 (없으면 기본값)
    const { rows: watchlist } = await pool.query(
      `SELECT stock_code, dividend_yield FROM dividend_watchlist WHERE stock_code = ANY($1)`,
      [Object.keys(ETF_WEIGHTS)],
    );
    const dbYields: Record<string, number> = {};
    for (const w of watchlist) {
      if (w.dividend_yield) dbYields[w.stock_code] = Number(w.dividend_yield);
    }

    // 가중 평균 수익률 계산
    let weightedYield = 0;
    for (const [code, weight] of Object.entries(ETF_WEIGHTS)) {
      const yieldPct = (dbYields[code] ?? DEFAULT_YIELDS[code] ?? 5) / 100;
      weightedYield += weight * yieldPct;
    }

    // 최소 자본 계산: target = investedUsd * weightedYield * 0.846 / 12 * fxRate
    // → investedUsd = target * 12 / (weightedYield * 0.846 * fxRate)
    const targetMonthlyUsd = targetMonthly / fx;
    const minInvestedUsd = (targetMonthlyUsd * 12) / (weightedYield * 0.846);
    const minInvestedKrw = Math.ceil(minInvestedUsd * fx);

    // 기존 Paper 투자금 확인
    const { rows: existingRows } = await pool.query(
      `SELECT COALESCE(value::numeric, 0) AS v FROM overseas_state WHERE key = 'dividend_invested_krw_paper'`,
    );
    const existingKrw = Number(existingRows[0]?.v ?? 0);

    // 이미 충분하면 스킵
    if (existingKrw >= minInvestedKrw) {
      return c.json({
        ok: true,
        message: '이미 목표 달성 가능한 자본 보유',
        targetMonthlyKrw: targetMonthly,
        minCapitalKrw: minInvestedKrw,
        existingKrw,
        weightedYieldPct: +(weightedYield * 100).toFixed(2),
        fx,
      });
    }

    // 추가 필요 금액 계산
    const additionalKrw = minInvestedKrw - existingKrw;
    const additionalUsd = additionalKrw / fx;

    // ETF 현재가 조회 (가격 기반 주수 계산용)
    const { getOverseasPrice } = await import('../../kis/overseas.js');
    const etfCodes = Object.keys(ETF_WEIGHTS);
    const priceResults = await Promise.allSettled(
      etfCodes.map(async (code) => {
        const p = await Promise.race([
          getOverseasPrice(code, getEtfExchange(code)),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
        ]);
        return { code, price: Number((p as any).currentPrice) || 0 };
      }),
    );
    const prices: Record<string, number> = {};
    for (const r of priceResults) {
      if (r.status === 'fulfilled' && r.value.price > 0) prices[r.value.code] = r.value.price;
    }

    // 가격 없으면 평균 추정가 사용
    const avgEstPrice =
      Object.values(prices).length > 0
        ? Object.values(prices).reduce((a, b) => a + b, 0) / Object.values(prices).length
        : 50; // 폴백 추정가

    // Paper 매수 실행
    const results: Array<{ code: string; shares: number; invested: number }> = [];
    let totalInvested = 0;

    for (const [code, weight] of Object.entries(ETF_WEIGHTS)) {
      const price = prices[code] || avgEstPrice;
      const allocation = additionalUsd * weight;
      const shares = Math.floor(allocation / price);
      if (shares <= 0) continue;
      const invested = shares * price;
      totalInvested += invested;

      const exchange = getEtfExchange(code);
      await pool.query(
        `INSERT INTO dividend_holdings (stock_code, exchange, quantity, avg_price, total_dividends_received, is_paper)
         VALUES ($1, $2, $3, $4, 0, true)
         ON CONFLICT (stock_code, exchange, is_paper) DO UPDATE SET
           avg_price = (dividend_holdings.avg_price * dividend_holdings.quantity + $4 * $3) / (dividend_holdings.quantity + $3),
           quantity = dividend_holdings.quantity + $3`,
        [code, exchange, shares, price],
      );
      results.push({ code, shares, invested: +invested.toFixed(2) });
    }

    // 투자금 기록
    await Promise.all([
      pool.query(
        `INSERT INTO overseas_state (key, value) VALUES ('dividend_invested_krw_paper', $1::text)
         ON CONFLICT (key) DO UPDATE SET value = (COALESCE(overseas_state.value::numeric, 0) + $1::numeric)::text`,
        [additionalKrw],
      ),
      pool.query(`UPDATE feature_flags SET enabled = TRUE WHERE key = 'dividend_investing' AND enabled = FALSE`),
    ]);

    // 예상 월 배당금 계산
    const _estMonthlyUsd = (totalInvested * weightedYield * 0.846) / 12;
    const totalMonthlyUsd = ((existingKrw / fx + totalInvested) * weightedYield * 0.846) / 12;

    logger.info(
      `[MoneyPrinter] Paper 자동셋업: 목표 월₩${targetMonthly.toLocaleString()} → 투자 ₩${additionalKrw.toLocaleString()} ($${totalInvested.toFixed(0)})`,
      { component: 'DIVIDEND' },
    );

    return c.json({
      ok: true,
      targetMonthlyKrw: targetMonthly,
      minCapitalKrw: minInvestedKrw,
      investedKrw: additionalKrw,
      investedUsd: +totalInvested.toFixed(2),
      existingKrw,
      totalKrw: existingKrw + additionalKrw,
      weightedYieldPct: +(weightedYield * 100).toFixed(2),
      estMonthlyDivUsd: +totalMonthlyUsd.toFixed(2),
      estMonthlyDivKrw: +Math.floor(totalMonthlyUsd * fx),
      fx,
      etfs: results,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
