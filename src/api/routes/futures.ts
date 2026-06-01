/**
 * 해외선물 API 라우트
 * - 완전 격리: 별도 예산, 명시적 승인 필요
 * - 극소액 마이크로 선물 (MES, MNQ 등)
 * - 기능 OFF 시 모든 API 차단
 * - paper/live 예산 완전 분리 (크로스 오염 방지)
 * - live 모드 금액 입력 시 PIN 필수
 */
import { Hono } from 'hono';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { baseIsPaper } from '../../config/index.js';
import { validateLivePin, resolveIsPaper, budgetCol, getFuturesPnlByMode } from '../guards/live-pin.js';
import {
  MICRO_FUTURES, FUTURES_BY_PRODUCT, getActiveSymbol, getFuturesPrice,
  getFuturesDailyChart, getFuturesPositions, getFuturesDeposit,
  placeFuturesOrder,
} from '../../kis/futures.js';

export const futuresRoutes = new Hono();

const COMP = 'FUTURES';

// ── TTL 캐시: feature flag (30초) ──
let _flagCache: { value: boolean; ts: number } | null = null;
const FLAG_TTL = 30_000;

async function checkFuturesEnabled(): Promise<boolean> {
  const now = Date.now();
  if (_flagCache && now - _flagCache.ts < FLAG_TTL) return _flagCache.value;
  try {
    const { rows } = await getPool().query("SELECT enabled FROM feature_flags WHERE key = 'overseas_futures'");
    const v = rows[0]?.enabled === true;
    _flagCache = { value: v, ts: now };
    return v;
  } catch { return false; }
}

// ── 대시보드 (요약 정보) — 모드별 분리 ──
futuresRoutes.get('/futures/dashboard', async (c) => {
  try {
    const isPaper = resolveIsPaper(c.req.query('mode') as 'paper' | 'live' | undefined);
    const cols = budgetCol(isPaper);
    const pool = getPool();

    const [enabled, { rows: budgetRows }, { rows: positions }, { rows: trades }, { rows: stats }] = await Promise.all([
      checkFuturesEnabled(),
      pool.query('SELECT * FROM futures_budget WHERE id = 1'),
      pool.query('SELECT * FROM futures_positions WHERE status = $1 AND is_paper = $2 ORDER BY opened_at DESC', ['open', isPaper]),
      pool.query('SELECT * FROM futures_trades WHERE is_paper = $1 ORDER BY executed_at DESC LIMIT 20', [isPaper]),
      pool.query(
        `SELECT COUNT(*) AS total_trades, COUNT(*) FILTER (WHERE pnl_usd > 0) AS wins,
           COUNT(*) FILTER (WHERE pnl_usd < 0) AS losses, COALESCE(SUM(pnl_usd), 0) AS total_pnl,
           COALESCE(AVG(pnl_usd), 0) AS avg_pnl
         FROM futures_trades WHERE pnl_usd IS NOT NULL AND is_paper = $1`, [isPaper]),
    ]);
    const budget = budgetRows[0] || {};

    return c.json({
      enabled,
      mode: isPaper ? 'paper' : 'live',
      budget: {
        allocatedKrw: Number(budget[cols.allocated] ?? 0),
        usedMarginUsd: Number(budget[cols.margin] ?? 0),
        maxBudgetKrw: Number(budget.max_budget_krw ?? 100000),
        totalPnlUsd: Number(budget[cols.pnl] ?? 0),
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

    const [positions, deposit] = await Promise.all([getFuturesPositions(), getFuturesDeposit()]);
    return c.json({ positions, deposit });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 예산 할당 (명시적 승인 필요, 모드 분리, live=PIN 필수) ──
futuresRoutes.post('/futures/budget/allocate', async (c) => {
  try {
    const enabled = await checkFuturesEnabled();
    if (!enabled) return c.json({ enabled: false, error: '설정에서 선물 기능을 먼저 켜주세요' });

    const body = await c.req.json<{ amount_krw: number; confirm: boolean; mode?: 'paper' | 'live'; pin?: string }>();
    if (!body.confirm) return c.json({ error: '승인(confirm: true) 필요' }, 400);

    const isPaper = resolveIsPaper(body.mode);
    const pinCheck = validateLivePin(isPaper, body.pin);
    if (!pinCheck.ok) return c.json({ error: pinCheck.error }, 403);

    const pool = getPool();
    const cols = budgetCol(isPaper);
    const { rows: budgetRows } = await pool.query('SELECT max_budget_krw FROM futures_budget WHERE id = 1');
    const maxBudget = budgetRows[0]?.max_budget_krw ? Number(budgetRows[0].max_budget_krw) : 500000;

    if (body.amount_krw > maxBudget) {
      return c.json({ error: `최대 예산 ${maxBudget.toLocaleString()}원 초과` }, 400);
    }
    if (body.amount_krw < 0) {
      return c.json({ error: '양수 금액만 가능' }, 400);
    }

    await pool.query(
      `UPDATE futures_budget SET ${cols.allocated} = $1, approved_at = NOW(), updated_at = NOW() WHERE id = 1`,
      [body.amount_krw]
    );
    const modeLabel = isPaper ? 'paper' : 'LIVE';
    logger.info(`선물 예산 할당 [${modeLabel}]: ${body.amount_krw.toLocaleString()}원`, { component: COMP });
    return c.json({ ok: true, allocatedKrw: body.amount_krw, mode: modeLabel });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 선물 주문 (승인 필수, 극소액 제한, live=PIN 필수) ──
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
      mode?: 'paper' | 'live';
      pin?: string;
    }>();

    if (!body.confirm) return c.json({ error: '승인(confirm: true) 필요' }, 400);
    if (!body.symbol || !body.side) return c.json({ error: '심볼, 방향 필요' }, 400);
    if (body.quantity < 1 || body.quantity > 5) return c.json({ error: '수량은 1~5계약만 가능' }, 400);

    const isPaper = resolveIsPaper(body.mode);
    const pinCheck = validateLivePin(isPaper, body.pin);
    if (!pinCheck.ok) return c.json({ error: pinCheck.error }, 403);

    // 예산 확인 (모드별)
    const pool = getPool();
    const cols = budgetCol(isPaper);
    const { rows: budgetRows } = await pool.query('SELECT * FROM futures_budget WHERE id = 1');
    const budget = budgetRows[0];
    if (!budget || Number(budget[cols.allocated] ?? 0) <= 0) {
      return c.json({ error: `선물 예산이 할당되지 않았습니다 (${isPaper ? 'paper' : 'live'})` }, 400);
    }

    if (isPaper) {
      // Paper: DB에 포지션 기록만
      const priceData = await getFuturesPrice(body.symbol);
      const fillPrice = body.price || priceData?.price || 0;
      if (fillPrice <= 0) return c.json({ error: '시세 조회 실패' }, 400);

      const dbSide = body.side === 'BUY' ? 'LONG' : 'SHORT';
      const product = body.symbol.replace(/[A-Z]\d{2}$/, '');
      const orderNo = `FP${Date.now().toString(36)}`;

      await pool.query(
        `INSERT INTO futures_positions (symbol, product, exchange, side, quantity, entry_price, current_price, tp_price, sl_price, order_no, is_paper)
         VALUES ($1, $2, 'CME', $3, $4, $5, $5, $6, $7, $8, TRUE)`,
        [body.symbol, product, dbSide, body.quantity, fillPrice, body.tp_price, body.sl_price, orderNo]
      );

      await pool.query(
        `INSERT INTO futures_trades (symbol, product, exchange, side, quantity, price, order_no, reason, is_paper)
         VALUES ($1, $2, 'CME', $3, $4, $5, $6, $7, TRUE)`,
        [body.symbol, product, body.side, body.quantity, fillPrice, orderNo, '수동 주문']
      );

      logger.info(`[Paper] 선물 주문: ${body.symbol} ${body.side} ${body.quantity}계약 @${fillPrice}`, { component: COMP });
      return c.json({ ok: true, orderNo, price: fillPrice, qty: body.quantity, mode: 'paper' });
    } else {
      // Live: KIS 실주문
      const result = await placeFuturesOrder({
        symbol: body.symbol,
        side: body.side,
        quantity: body.quantity,
        price: body.price,
        orderType: body.orderType || 'MARKET',
      });

      if (!result.success) return c.json({ error: result.message }, 502);

      const product = body.symbol.replace(/[A-Z]\d{2}$/, '');
      await pool.query(
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

// ── 포지션 청산 (PnL → 모드별 예산에 반영) ──
futuresRoutes.post('/futures/close/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ closePrice?: number; confirm: boolean; pin?: string }>();
    if (!body.confirm) return c.json({ error: '승인 필요' }, 400);

    const pool = getPool();
    const { rows } = await pool.query('SELECT * FROM futures_positions WHERE id = $1 AND status = $2', [id, 'open']);
    if (rows.length === 0) return c.json({ error: '오픈 포지션 없음' }, 404);

    const pos = rows[0];
    const isPaper = pos.is_paper;

    // live 청산 시 PIN 필수
    const pinCheck = validateLivePin(isPaper, body.pin);
    if (!pinCheck.ok) return c.json({ error: pinCheck.error }, 403);

    let closePrice = body.closePrice || 0;
    if (!closePrice) {
      const priceData = await getFuturesPrice(pos.symbol);
      closePrice = priceData?.price || Number(pos.entry_price);
    }

    // P&L 계산 (마이크로 선물 기준)
    const spec = FUTURES_BY_PRODUCT.get(pos.product);
    const multiplier = spec ? spec.tickValue / spec.tickSize : 5;
    const direction = pos.side === 'LONG' ? 1 : -1;
    const pnl = direction * (closePrice - Number(pos.entry_price)) * multiplier * Number(pos.quantity);

    // 포지션 닫기 + 거래 로그 + 예산 반영 병렬
    const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
    const cols = budgetCol(isPaper);
    await Promise.all([
      pool.query(`UPDATE futures_positions SET status = 'closed', current_price = $1, pnl_usd = $2, closed_at = NOW() WHERE id = $3`, [closePrice, pnl, id]),
      pool.query(
        `INSERT INTO futures_trades (symbol, product, exchange, side, quantity, price, pnl_usd, reason, is_paper)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '포지션 청산', $8)`,
        [pos.symbol, pos.product, pos.exchange, closeSide, pos.quantity, closePrice, pnl, pos.is_paper]
      ),
      pool.query(`UPDATE futures_budget SET ${cols.pnl} = ${cols.pnl} + $1, updated_at = NOW() WHERE id = 1`, [pnl]),
    ]);

    const modeLabel = isPaper ? 'paper' : 'LIVE';
    logger.info(`선물 청산 [${modeLabel}]: ${pos.symbol} ${pos.side} ${pos.quantity}계약 PnL=$${pnl.toFixed(2)}`, { component: COMP });
    return c.json({ ok: true, pnl, closePrice, mode: modeLabel });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 선물 원클릭 입금 (Money Printer, 모드 분리, live=PIN 필수) ──
futuresRoutes.post('/futures/auto-deposit', async (c) => {
  try {
    const body = await c.req.json<{ amount_krw: number; mode?: 'paper' | 'live'; pin?: string }>();
    const { amount_krw } = body;
    if (!amount_krw || amount_krw < 10000) return c.json({ error: '최소 1만원' }, 400);
    if (amount_krw > 500000) return c.json({ error: '최대 50만원' }, 400);

    const isPaper = resolveIsPaper(body.mode);
    const pinCheck = validateLivePin(isPaper, body.pin);
    if (!pinCheck.ok) return c.json({ error: pinCheck.error }, 403);

    const pool = getPool();
    const cols = budgetCol(isPaper);

    // feature flag 자동 ON + 예산 누적 병렬
    const [, { rows }] = await Promise.all([
      pool.query(`UPDATE feature_flags SET enabled = TRUE WHERE key = 'overseas_futures' AND enabled = FALSE`),
      pool.query(
        `UPDATE futures_budget SET ${cols.allocated} = ${cols.allocated} + $1, approved_at = COALESCE(approved_at, NOW()), updated_at = NOW() WHERE id = 1 RETURNING ${cols.allocated} AS total`,
        [amount_krw]
      ),
    ]);
    const total = Number(rows[0]?.total ?? amount_krw);
    const modeLabel = isPaper ? 'paper' : 'LIVE';

    logger.info(`[MoneyPrinter] 선물 입금 [${modeLabel}]: +₩${amount_krw.toLocaleString()} → 총 ₩${total.toLocaleString()}`, { component: COMP });
    return c.json({ ok: true, addedKrw: amount_krw, totalAllocatedKrw: total, mode: modeLabel });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 선물 예산 출금 (잘못 넣은 금액 회수, live=PIN 필수) ──
futuresRoutes.post('/futures/budget/withdraw', async (c) => {
  try {
    const body = await c.req.json<{ amount_krw: number; confirm: boolean; mode?: 'paper' | 'live'; pin?: string }>();
    if (!body.confirm) return c.json({ error: '승인(confirm: true) 필요' }, 400);
    if (!body.amount_krw || body.amount_krw <= 0) return c.json({ error: '양수 금액 필요' }, 400);

    const isPaper = resolveIsPaper(body.mode);
    const pinCheck = validateLivePin(isPaper, body.pin);
    if (!pinCheck.ok) return c.json({ error: pinCheck.error }, 403);

    const pool = getPool();
    const cols = budgetCol(isPaper);
    const { rows: budgetRows } = await pool.query('SELECT * FROM futures_budget WHERE id = 1');
    const current = Number(budgetRows[0]?.[cols.allocated] ?? 0);

    if (body.amount_krw > current) {
      return c.json({ error: `현재 잔액 ₩${current.toLocaleString()} 초과 출금 불가` }, 400);
    }

    const { rows } = await pool.query(
      `UPDATE futures_budget SET ${cols.allocated} = ${cols.allocated} - $1, updated_at = NOW() WHERE id = 1 RETURNING ${cols.allocated} AS remaining`,
      [body.amount_krw]
    );
    const remaining = Number(rows[0]?.remaining ?? 0);
    const modeLabel = isPaper ? 'paper' : 'LIVE';

    logger.info(`선물 예산 출금 [${modeLabel}]: -₩${body.amount_krw.toLocaleString()} → 잔액 ₩${remaining.toLocaleString()}`, { component: COMP });
    return c.json({ ok: true, withdrawnKrw: body.amount_krw, remainingKrw: remaining, mode: modeLabel });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ══════════════════════════════════════════════════════════════════
// KIS 동기화 & 정합성 검수
// ══════════════════════════════════════════════════════════════════

/** 선물 정합성 검수 — KIS 실잔고 vs DB 비교 */
futuresRoutes.get('/futures/integrity-check', async (c) => {
  try {
    const pool = getPool();
    const issues: Array<{ severity: 'danger' | 'warn' | 'info'; msg: string }> = [];

    // 병렬 조회: KIS + DB 포지션 + 예산 + PnL 합산
    const [
      kisPositions, kisDeposit,
      { rows: dbLivePositions }, { rows: dbPaperPositions },
      { rows: budgetRows }, tradesPnl,
    ] = await Promise.all([
      getFuturesPositions(), getFuturesDeposit(),
      pool.query(`SELECT * FROM futures_positions WHERE status = 'open' AND is_paper = FALSE`),
      pool.query(`SELECT * FROM futures_positions WHERE status = 'open' AND is_paper = TRUE`),
      pool.query('SELECT * FROM futures_budget WHERE id = 1'),
      getFuturesPnlByMode(),
    ]);
    const fb = budgetRows[0] || {};

    // 크로스 체크: KIS 포지션 vs DB live 포지션
    if (kisPositions.length > 0 && dbLivePositions.length === 0) {
      issues.push({ severity: 'danger', msg: `KIS에 실포지션 ${kisPositions.length}개 있으나 DB live 기록 없음 → 크로스오염 또는 미동기화` });
    }
    if (kisPositions.length === 0 && dbLivePositions.length > 0) {
      issues.push({ severity: 'warn', msg: `DB에 live 오픈포지션 ${dbLivePositions.length}개 있으나 KIS 실포지션 0 → 이미 청산됨, DB 업데이트 필요` });
    }

    for (const kp of kisPositions) {
      const dbMatch = dbLivePositions.find((d: any) => d.symbol === kp.symbol);
      if (!dbMatch) {
        issues.push({ severity: 'danger', msg: `KIS 포지션 ${kp.symbol} ${kp.side} ${kp.quantity}계약 — DB에 미기록!` });
      } else if (Number(dbMatch.quantity) !== kp.quantity) {
        issues.push({ severity: 'warn', msg: `${kp.symbol} 수량 불일치: KIS=${kp.quantity} vs DB=${dbMatch.quantity}` });
      }
    }

    // 예산 정합성: trades 합산 vs budget PnL
    const budgetPaperPnl = Number(fb.total_pnl_usd_paper ?? 0);
    const budgetLivePnl = Number(fb.total_pnl_usd_live ?? 0);
    const legacyPnl = Number(fb.total_pnl_usd ?? 0);

    if (Math.abs(budgetPaperPnl - tradesPnl.paper) > 0.01) {
      issues.push({ severity: 'warn', msg: `Paper PnL 불일치: budget=${budgetPaperPnl.toFixed(2)} trades합=${tradesPnl.paper.toFixed(2)}` });
    }
    if (Math.abs(budgetLivePnl - tradesPnl.live) > 0.01) {
      issues.push({ severity: 'warn', msg: `Live PnL 불일치: budget=${budgetLivePnl.toFixed(2)} trades합=${tradesPnl.live.toFixed(2)}` });
    }
    if (legacyPnl !== 0 && budgetPaperPnl === 0 && budgetLivePnl === 0) {
      issues.push({ severity: 'danger', msg: `레거시 total_pnl_usd=$${legacyPnl.toFixed(2)} 잔존 — 마이그레이션 049 미적용` });
    }

    // 6. KIS 예수금 vs DB 실전 예산
    const liveAllocatedKrw = Number(fb.allocated_krw_live ?? 0);
    if (kisDeposit.totalDeposit > 0) {
      issues.push({ severity: 'info', msg: `KIS 선물예수금: $${kisDeposit.totalDeposit.toFixed(0)} (가용 $${kisDeposit.availableMargin.toFixed(0)}, 사용 $${kisDeposit.usedMargin.toFixed(0)})` });
    }

    const allOk = issues.filter(i => i.severity === 'danger').length === 0;
    return c.json({
      ok: allOk,
      ts: new Date().toISOString(),
      kis: { positions: kisPositions, deposit: kisDeposit },
      db: {
        livePositions: dbLivePositions.length,
        paperPositions: dbPaperPositions.length,
        budget: {
          paperAllocated: Number(fb.allocated_krw_paper ?? 0),
          liveAllocated: liveAllocatedKrw,
          paperPnl: budgetPaperPnl,
          livePnl: budgetLivePnl,
          legacyAllocated: Number(fb.allocated_krw ?? 0),
          legacyPnl,
        },
      },
      issues,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/** 정합성 보정 — 오염된 레거시 값 정리, trades 기반 PnL 재계산 */
futuresRoutes.post('/futures/integrity-fix', async (c) => {
  try {
    const body = await c.req.json<{ confirm: boolean; pin?: string }>();
    if (!body.confirm) return c.json({ error: '승인(confirm: true) 필요' }, 400);

    // live 계좌 보정이므로 PIN 필수
    const pinCheck = validateLivePin(false, body.pin);
    if (!pinCheck.ok) return c.json({ error: pinCheck.error }, 403);

    const pool = getPool();
    const fixes: string[] = [];

    // 1. trades 합산 기반 PnL 재계산 + KIS 포지션 + 예산 동시 조회
    const [tradesPnl, kisPositions, { rows: dbLiveOpen }, { rows: budgetRows }] = await Promise.all([
      getFuturesPnlByMode(),
      getFuturesPositions(),
      pool.query(`SELECT * FROM futures_positions WHERE status = 'open' AND is_paper = FALSE`),
      pool.query('SELECT * FROM futures_budget WHERE id = 1'),
    ]);

    await pool.query(
      `UPDATE futures_budget SET
        total_pnl_usd_paper = $1, total_pnl_usd_live = $2,
        total_pnl_usd = 0, updated_at = NOW()
      WHERE id = 1`,
      [tradesPnl.paper, tradesPnl.live]
    );
    fixes.push(`PnL 재계산: paper=$${tradesPnl.paper.toFixed(2)}, live=$${tradesPnl.live.toFixed(2)}`);

    // 2. DB live open인데 KIS에 없는 것 → 이미 청산됨
    const kisSymbols = new Set(kisPositions.map(p => p.symbol));
    for (const pos of dbLiveOpen) {
      if (!kisSymbols.has(pos.symbol)) {
        await pool.query(
          `UPDATE futures_positions SET status = 'closed', closed_at = NOW() WHERE id = $1`,
          [pos.id]
        );
        fixes.push(`DB live 포지션 ${pos.symbol} → closed (KIS에 없음)`);
      }
    }

    // 3. live 예산이 paper 서버에서 오염됐다면 0으로 리셋
    const fb = budgetRows[0] || {};
    if (baseIsPaper && Number(fb.allocated_krw_live ?? 0) > 0) {
      await pool.query(`UPDATE futures_budget SET allocated_krw_live = 0 WHERE id = 1`);
      fixes.push(`live 예산 ${Number(fb.allocated_krw_live).toLocaleString()}원 → 0 (paper 서버 오염 정리)`);
    }

    // 4. 레거시 allocated_krw 잔여값 정리 (분리 컬럼 존재 시 legacy 무효화)
    const legacyAlloc = Number(fb.allocated_krw ?? 0);
    if (legacyAlloc > 0) {
      await pool.query(`UPDATE futures_budget SET allocated_krw = 0 WHERE id = 1`);
      fixes.push(`레거시 allocated_krw=${legacyAlloc.toLocaleString()}원 → 0 (분리 완료)`);
    }

    logger.info(`[IntegrityFix] 보정 완료: ${fixes.join(' | ')}`, { component: COMP });
    return c.json({ ok: true, fixes });
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
    _flagCache = null; // 캐시 무효화
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
