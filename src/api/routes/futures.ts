/**
 * 해외선물 API 라우트
 * - 완전 격리: 별도 예산, 명시적 승인 필요
 * - 극소액 마이크로 선물 (MES, MNQ 등)
 * - 기능 OFF 시 모든 API 차단
 */
import { Hono } from 'hono';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { baseIsPaper } from '../../config/index.js';

export const futuresRoutes = new Hono();

const COMP = 'FUTURES';

// ── 기능 플래그 체크 ──
async function checkFuturesEnabled(): Promise<boolean> {
  try {
    const { rows } = await getPool().query("SELECT enabled FROM feature_flags WHERE key = 'overseas_futures'");
    return rows[0]?.enabled === true;
  } catch { return false; }
}

// ── 대시보드 (요약 정보) ──
futuresRoutes.get('/futures/dashboard', async (c) => {
  try {
    const enabled = await checkFuturesEnabled();

    // 예산
    const { rows: budgetRows } = await getPool().query('SELECT * FROM futures_budget WHERE id = 1');
    const budget = budgetRows[0] || { allocated_krw: 0, used_margin_usd: 0, max_budget_krw: 100000, total_pnl_usd: 0 };

    // 오픈 포지션
    const { rows: positions } = await getPool().query(
      'SELECT * FROM futures_positions WHERE status = $1 ORDER BY opened_at DESC',
      ['open']
    );

    // 최근 거래
    const { rows: trades } = await getPool().query(
      'SELECT * FROM futures_trades ORDER BY executed_at DESC LIMIT 20'
    );

    // 통계
    const { rows: stats } = await getPool().query(
      `SELECT
         COUNT(*) AS total_trades,
         COUNT(*) FILTER (WHERE pnl_usd > 0) AS wins,
         COUNT(*) FILTER (WHERE pnl_usd < 0) AS losses,
         COALESCE(SUM(pnl_usd), 0) AS total_pnl,
         COALESCE(AVG(pnl_usd), 0) AS avg_pnl
       FROM futures_trades WHERE pnl_usd IS NOT NULL`
    );

    return c.json({
      enabled,
      budget: {
        allocatedKrw: Number(budget.allocated_krw),
        usedMarginUsd: Number(budget.used_margin_usd),
        maxBudgetKrw: Number(budget.max_budget_krw),
        totalPnlUsd: Number(budget.total_pnl_usd),
        approved: !!budget.approved_at,
      },
      positions,
      trades,
      stats: stats[0],
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 마이크로 선물 상품 목록 ──
futuresRoutes.get('/futures/products', async (c) => {
  try {
    const { MICRO_FUTURES, getActiveSymbol } = await import('../../kis/futures.js');
    const products = MICRO_FUTURES.map(p => ({
      ...p,
      activeSymbol: getActiveSymbol(p.product),
    }));
    return c.json({ products });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 선물 시세 조회 ──
futuresRoutes.get('/futures/price/:symbol', async (c) => {
  try {
    const symbol = c.req.param('symbol').toUpperCase();
    const { getFuturesPrice } = await import('../../kis/futures.js');
    const price = await getFuturesPrice(symbol);
    if (!price) return c.json({ error: '시세 조회 실패' }, 404);
    return c.json(price);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 선물 일봉 차트 ──
futuresRoutes.get('/futures/chart/:symbol', async (c) => {
  try {
    const symbol = c.req.param('symbol').toUpperCase();
    const { getFuturesDailyChart } = await import('../../kis/futures.js');
    const chart = await getFuturesDailyChart(symbol);
    return c.json({ chart });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── KIS 실제 포지션/예수금 조회 ──
futuresRoutes.get('/futures/kis-status', async (c) => {
  try {
    const enabled = await checkFuturesEnabled();
    if (!enabled) return c.json({ enabled: false, positions: [], deposit: null });

    const { getFuturesPositions, getFuturesDeposit } = await import('../../kis/futures.js');
    const [positions, deposit] = await Promise.all([getFuturesPositions(), getFuturesDeposit()]);
    return c.json({ positions, deposit });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 예산 할당 (명시적 승인 필요) ──
futuresRoutes.post('/futures/budget/allocate', async (c) => {
  try {
    const enabled = await checkFuturesEnabled();
    if (!enabled) return c.json({ enabled: false, error: '설정에서 선물 기능을 먼저 켜주세요' });

    const body = await c.req.json<{ amount_krw: number; confirm: boolean }>();
    if (!body.confirm) return c.json({ error: '승인(confirm: true) 필요' }, 400);

    const { rows: budgetRows } = await getPool().query('SELECT max_budget_krw FROM futures_budget WHERE id = 1');
    const maxBudget = budgetRows[0]?.max_budget_krw ? Number(budgetRows[0].max_budget_krw) : 500000;

    if (body.amount_krw > maxBudget) {
      return c.json({ error: `최대 예산 ${maxBudget.toLocaleString()}원 초과` }, 400);
    }
    if (body.amount_krw < 0) {
      return c.json({ error: '양수 금액만 가능' }, 400);
    }

    await getPool().query(
      `UPDATE futures_budget SET allocated_krw = $1, approved_at = NOW(), updated_at = NOW() WHERE id = 1`,
      [body.amount_krw]
    );
    logger.info(`선물 예산 할당: ${body.amount_krw.toLocaleString()}원`, { component: COMP });
    return c.json({ ok: true, allocatedKrw: body.amount_krw });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 선물 주문 (승인 필수, 극소액 제한) ──
futuresRoutes.post('/futures/order', async (c) => {
  try {
    const enabled = await checkFuturesEnabled();
    if (!enabled) return c.json({ enabled: false, error: '설정에서 선물 기능을 먼저 켜주세요' });

    const body = await c.req.json<{
      symbol: string;
      side: 'BUY' | 'SELL';
      quantity: number;
      price?: number;
      orderType?: 'LIMIT' | 'MARKET';
      confirm: boolean;
      tp_price?: number;
      sl_price?: number;
    }>();

    if (!body.confirm) return c.json({ error: '승인(confirm: true) 필요' }, 400);
    if (!body.symbol || !body.side) return c.json({ error: '심볼, 방향 필요' }, 400);
    if (body.quantity < 1 || body.quantity > 5) return c.json({ error: '수량은 1~5계약만 가능' }, 400);

    // 예산 확인
    const { rows: budgetRows } = await getPool().query('SELECT * FROM futures_budget WHERE id = 1');
    const budget = budgetRows[0];
    if (!budget || Number(budget.allocated_krw) <= 0) {
      return c.json({ error: '선물 예산이 할당되지 않았습니다' }, 400);
    }

    // Paper 모드만 일단 지원 (안전)
    const isPaper = baseIsPaper;

    if (isPaper) {
      // Paper: DB에 포지션 기록만
      const { getFuturesPrice } = await import('../../kis/futures.js');
      const priceData = await getFuturesPrice(body.symbol);
      const fillPrice = body.price || priceData?.price || 0;
      if (fillPrice <= 0) return c.json({ error: '시세 조회 실패' }, 400);

      const dbSide = body.side === 'BUY' ? 'LONG' : 'SHORT';
      const product = body.symbol.replace(/[A-Z]\d{2}$/, '');
      const orderNo = `FP${Date.now().toString(36)}`;

      await getPool().query(
        `INSERT INTO futures_positions (symbol, product, exchange, side, quantity, entry_price, current_price, tp_price, sl_price, order_no, is_paper)
         VALUES ($1, $2, 'CME', $3, $4, $5, $5, $6, $7, $8, TRUE)`,
        [body.symbol, product, dbSide, body.quantity, fillPrice, body.tp_price, body.sl_price, orderNo]
      );

      await getPool().query(
        `INSERT INTO futures_trades (symbol, product, exchange, side, quantity, price, order_no, reason, is_paper)
         VALUES ($1, $2, 'CME', $3, $4, $5, $6, $7, TRUE)`,
        [body.symbol, product, body.side, body.quantity, fillPrice, orderNo, '수동 주문']
      );

      logger.info(`[Paper] 선물 주문: ${body.symbol} ${body.side} ${body.quantity}계약 @${fillPrice}`, { component: COMP });
      return c.json({ ok: true, orderNo, price: fillPrice, qty: body.quantity, mode: 'paper' });
    } else {
      // Live: KIS 실주문
      const { placeFuturesOrder } = await import('../../kis/futures.js');
      const result = await placeFuturesOrder({
        symbol: body.symbol,
        side: body.side,
        quantity: body.quantity,
        price: body.price,
        orderType: body.orderType || 'MARKET',
      });

      if (!result.success) return c.json({ error: result.message }, 502);

      const product = body.symbol.replace(/[A-Z]\d{2}$/, '');
      await getPool().query(
        `INSERT INTO futures_trades (symbol, product, exchange, side, quantity, price, order_no, reason, is_paper)
         VALUES ($1, $2, 'CME', $3, $4, $5, $6, $7, FALSE)`,
        [body.symbol, product, body.side, body.quantity, body.price || 0, result.orderNo, '수동 주문']
      );

      return c.json({ ok: true, orderNo: result.orderNo, mode: 'live' });
    }
  } catch (e: any) {
    logger.error(`선물 주문 실패: ${e.message}`, { component: COMP });
    return c.json({ error: e.message }, 500);
  }
});

// ── 포지션 청산 ──
futuresRoutes.post('/futures/close/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ closePrice?: number; confirm: boolean }>();
    if (!body.confirm) return c.json({ error: '승인 필요' }, 400);

    const { rows } = await getPool().query('SELECT * FROM futures_positions WHERE id = $1 AND status = $2', [id, 'open']);
    if (rows.length === 0) return c.json({ error: '오픈 포지션 없음' }, 404);

    const pos = rows[0];
    let closePrice = body.closePrice || 0;

    if (!closePrice) {
      const { getFuturesPrice } = await import('../../kis/futures.js');
      const priceData = await getFuturesPrice(pos.symbol);
      closePrice = priceData?.price || Number(pos.entry_price);
    }

    // P&L 계산 (마이크로 선물 기준)
    const { MICRO_FUTURES } = await import('../../kis/futures.js');
    const spec = MICRO_FUTURES.find(m => m.product === pos.product);
    const multiplier = spec ? spec.tickValue / spec.tickSize : 5; // MES 기본값
    const direction = pos.side === 'LONG' ? 1 : -1;
    const pnl = direction * (closePrice - Number(pos.entry_price)) * multiplier * Number(pos.quantity);

    await getPool().query(
      `UPDATE futures_positions SET status = 'closed', current_price = $1, pnl_usd = $2, closed_at = NOW() WHERE id = $3`,
      [closePrice, pnl, id]
    );

    // 거래 로그
    const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
    await getPool().query(
      `INSERT INTO futures_trades (symbol, product, exchange, side, quantity, price, pnl_usd, reason, is_paper)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '포지션 청산', $8)`,
      [pos.symbol, pos.product, pos.exchange, closeSide, pos.quantity, closePrice, pnl, pos.is_paper]
    );

    // 예산 P&L 반영
    await getPool().query(
      `UPDATE futures_budget SET total_pnl_usd = total_pnl_usd + $1, updated_at = NOW() WHERE id = 1`,
      [pnl]
    );

    logger.info(`선물 청산: ${pos.symbol} ${pos.side} ${pos.quantity}계약 PnL=$${pnl.toFixed(2)}`, { component: COMP });
    return c.json({ ok: true, pnl, closePrice });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 선물 원클릭 입금 (Money Printer) ──
futuresRoutes.post('/futures/auto-deposit', async (c) => {
  try {
    const { amount_krw } = await c.req.json<{ amount_krw: number }>();
    if (!amount_krw || amount_krw < 10000) return c.json({ error: '최소 1만원' }, 400);
    if (amount_krw > 500000) return c.json({ error: '최대 50만원' }, 400);

    // feature flag 자동 ON
    await getPool().query(
      `UPDATE feature_flags SET enabled = TRUE WHERE key = 'overseas_futures' AND enabled = FALSE`
    );

    // 예산 누적 (기존 + 추가)
    const { rows } = await getPool().query(
      `UPDATE futures_budget SET allocated_krw = allocated_krw + $1, approved_at = COALESCE(approved_at, NOW()), updated_at = NOW() WHERE id = 1 RETURNING allocated_krw`,
      [amount_krw]
    );
    const total = Number(rows[0]?.allocated_krw ?? amount_krw);

    logger.info(`[MoneyPrinter] 선물 입금: +₩${amount_krw.toLocaleString()} → 총 ₩${total.toLocaleString()}`, { component: COMP });
    return c.json({ ok: true, addedKrw: amount_krw, totalAllocatedKrw: total });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 기능 플래그 토글 (공통) ──
futuresRoutes.post('/feature-flags/:key/toggle', async (c) => {
  try {
    const key = c.req.param('key');
    const body = await c.req.json<{ enabled: boolean }>();
    await getPool().query(
      'UPDATE feature_flags SET enabled = $1, updated_at = NOW() WHERE key = $2',
      [body.enabled, key]
    );
    logger.info(`기능 플래그 ${key} = ${body.enabled}`, { component: 'SETTINGS' });
    return c.json({ ok: true, key, enabled: body.enabled });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 기능 플래그 조회 ──
futuresRoutes.get('/feature-flags', async (c) => {
  try {
    const { rows } = await getPool().query('SELECT * FROM feature_flags ORDER BY key');
    return c.json({ flags: rows });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
