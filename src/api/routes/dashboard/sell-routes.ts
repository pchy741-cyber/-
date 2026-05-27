/**
 * 매도/탈출/수동매수 라우트 — /sell/*, /escape/*, /sell-stock/*, /sell-overseas/*, /manual-buy
 */
import { Hono } from 'hono';
import { config } from '../../../config/index.js';
import { STRATEGY_PARAMS, getScoreBasedParams, OVERSEAS_FEE_PCT, KR_FEE } from '../../../config/constants.js';
import { createChain, getPool } from '../../../db/client.js';
import { getAccountBalance } from '../../../kis/account.js';
import { getCurrentPrice } from '../../../kis/market.js';
import { placeOrder } from '../../../kis/order.js';
import { getPaperBalance, riskEngine } from '../../../risk/engine.js';
import { notifyBuy, notifySell } from '../../../notifications/web-push.js';
import { logger } from '../../../utils/logger.js';
import { invalidateCurrentModeCache } from './helpers.js';

export const sellRoutes = new Hono();

// ── 탈출 모드 등록: +0.5% 돌파 순간 자동 전량 매도 ──
sellRoutes.post('/escape/:chainId', async (c) => {
  const chainId = c.req.param('chainId');
  try {
    const { rows } = await getPool().query('SELECT * FROM transaction_chains WHERE id = $1', [chainId]);
    const chain = rows[0];
    if (!chain) return c.json({ error: '체인을 찾을 수 없습니다' }, 404);
    if (chain.total_quantity <= 0) return c.json({ error: '매도할 수량이 없습니다' }, 400);

    const { getCurrentPrice } = await import('../../../kis/market.js');
    const priceData = await getCurrentPrice(chain.stock_code);
    const curPrice = priceData.currentPrice;
    if (!curPrice || curPrice <= 0) return c.json({ error: '현재가를 조회할 수 없습니다' }, 500);

    const escapeTarget = Math.ceil(curPrice * 1.005);
    await getPool().query(
      'UPDATE transaction_chains SET escape_target_price = $1 WHERE id = $2',
      [escapeTarget, chainId],
    );

    logger.info(
      `🚪 탈출 모드 등록: ${chain.stock_code} 목표가 ${escapeTarget.toLocaleString()}원 (현재 ${curPrice.toLocaleString()}원 → +0.5%)`,
      { component: 'ESCAPE' },
    );

    return c.json({ ok: true, escape_target_price: escapeTarget, current_price: curPrice });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 탈출 모드 취소 ──
sellRoutes.delete('/escape/:chainId', async (c) => {
  const chainId = c.req.param('chainId');
  try {
    await getPool().query('UPDATE transaction_chains SET escape_target_price = NULL WHERE id = $1', [chainId]);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 수동 매도 (CEO 긴급 매도) ──
sellRoutes.post('/sell/:chainId', async (c) => {
  const chainId = c.req.param('chainId');
  try {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const triggerSource: string = (body.source as string) || 'MANUAL';
    const sellReason: string = (body.reason as string) || 'CEO 수동 매도';

    const { rows } = await getPool().query('SELECT * FROM transaction_chains WHERE id = $1', [chainId]);
    const chain = rows[0];
    if (!chain) return c.json({ error: '체인을 찾을 수 없습니다' }, 404);
    if (chain.status === 'CLOSED') return c.json({ error: '이미 청산된 포지션입니다' }, 400);
    if (chain.total_quantity <= 0) return c.json({ error: '매도할 수량이 없습니다' }, 400);

    let fillPrice = 0;
    try {
      const px = await getCurrentPrice(chain.stock_code);
      fillPrice = px.currentPrice;
    } catch { /* 시세 조회 실패 시 0으로 기록 */ }

    // 모의투자 모드
    const chainTradingMode = chain.is_paper ? 'paper' : 'live';
    if (chain.is_paper) {
      const fakeOrderNo = `P${Date.now().toString(36)}`;
      await getPool().query(
        `UPDATE transaction_chains SET status = 'CLOSED', closed_at = NOW(), close_reason = $2, total_quantity = 0,
          realized_pnl = CASE WHEN $3 > 0 THEN realized_pnl + ($3 * (1 - 0.00195) - avg_buy_price) * total_quantity ELSE realized_pnl END
         WHERE id = $1`,
        [chainId, sellReason, fillPrice],
      );
      await getPool().query(
        `INSERT INTO orders (chain_id, stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning)
         VALUES ($1, $2, 'SELL', 'MARKET', $3, $4, $3, $4, $5, 'FILLED', $6, $7, $8)`,
        [chainId, chain.stock_code, chain.total_quantity, fillPrice, fakeOrderNo, chainTradingMode, triggerSource, sellReason],
      );
      logger.info(`✅ 매도 완료 (모의투자): ${chain.stock_code} ${chain.total_quantity}주 [${triggerSource}]`, { component: 'DASHBOARD' });
      try {
        const pnlPct = chain.avg_buy_price > 0 ? ((fillPrice - Number(chain.avg_buy_price)) / Number(chain.avg_buy_price)) * 100 : 0;
        await notifySell(chain.stock_code, chain.total_quantity, fillPrice, pnlPct, sellReason);
      } catch { /* 알림 실패 무시 */ }
      invalidateCurrentModeCache();
      return c.json({ ok: true, orderNo: fakeOrderNo, message: `${chain.stock_code} ${chain.total_quantity}주 전량 매도 완료 (모의투자)` });
    }

    // 실거래: KIS 주문 — 실패 시 1회 재시도
    let kisOrderNo = '';
    let isGhost = false;
    try {
      let result = await placeOrder({ stockCode: chain.stock_code, side: 'SELL', quantity: chain.total_quantity });
      if (!result.success) {
        logger.warn(`수동 매도 1차 실패 (${chain.stock_code}): ${result.message} — 2초 후 재시도`, { component: 'DASHBOARD' });
        await new Promise((r) => setTimeout(r, 2000));
        result = await placeOrder({ stockCode: chain.stock_code, side: 'SELL', quantity: chain.total_quantity });
      }
      if (!result.success) {
        logger.error(`수동 매도 최종 실패 (${chain.stock_code}): ${result.message}`, { component: 'DASHBOARD' });
        if (result.message?.includes('40240000') || result.message?.includes('잔고')) {
          logger.warn(`수동 매도: KIS 잔고 없음 (${chain.stock_code}) — DB 유령 체인 정리`, { component: 'DASHBOARD' });
          kisOrderNo = `GHOST_${Date.now().toString(36)}`;
          isGhost = true;
        } else {
          return c.json({ error: `KIS 매도 거부: ${result.message}` }, 502);
        }
      } else {
        kisOrderNo = result.orderNo ?? '';
      }
    } catch (kisErr: any) {
      const msg: string = kisErr?.message ?? '';
      if (msg.includes('40240000') || msg.includes('잔고')) {
        logger.warn(`수동 매도: KIS 잔고 없음 (${chain.stock_code}) — DB 유령 체인 정리`, { component: 'DASHBOARD' });
        kisOrderNo = `GHOST_${Date.now().toString(36)}`;
        isGhost = true;
      } else {
        throw kisErr;
      }
    }

    // 체결 확인: 잔고 조회로 매도 검증 (유령은 스킵)
    let fillConfirmed = isGhost;
    if (!isGhost) {
      try {
        await new Promise((r) => setTimeout(r, 2000));
        const bal = await getAccountBalance(true);
        const pos = bal.positions?.find((p: any) => p.stockCode === chain.stock_code);
        fillConfirmed = !pos || pos.quantity === 0;
      } catch { fillConfirmed = true; }
    }

    if (fillConfirmed) {
      await getPool().query(
        `UPDATE transaction_chains SET status = 'CLOSED', closed_at = NOW(), close_reason = $2, total_quantity = 0,
          realized_pnl = CASE WHEN $3 > 0 THEN realized_pnl + ($3 * (1 - 0.00195) - avg_buy_price) * total_quantity ELSE realized_pnl END
         WHERE id = $1`,
        [chainId, sellReason, fillPrice],
      );
    }

    await getPool().query(
      `INSERT INTO orders (chain_id, stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning)
       VALUES ($1, $2, 'SELL', 'MARKET', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [chainId, chain.stock_code, chain.total_quantity, fillPrice,
       fillConfirmed ? chain.total_quantity : 0, fillConfirmed ? fillPrice : 0,
       kisOrderNo, fillConfirmed ? 'FILLED' : 'PENDING', chainTradingMode, triggerSource, sellReason],
    );

    logger.info(`${fillConfirmed ? '✅' : '⏳'} 매도 ${fillConfirmed ? '완료' : '접수(체결대기)'}: ${chain.stock_code} ${chain.total_quantity}주 [${triggerSource}] (${kisOrderNo})`, { component: 'DASHBOARD' });
    try {
      const pnlPct = chain.avg_buy_price > 0 ? ((fillPrice - Number(chain.avg_buy_price)) / Number(chain.avg_buy_price)) * 100 : 0;
      await notifySell(chain.stock_code, chain.total_quantity, fillPrice, pnlPct, sellReason);
    } catch { /* 알림 실패 무시 */ }
    invalidateCurrentModeCache();
    return c.json({
      ok: true, orderNo: kisOrderNo, pending: !fillConfirmed,
      message: `${chain.stock_code} ${chain.total_quantity}주 ${fillConfirmed ? '매도 완료' : '매도 접수 (체결 대기)'}`,
    });
  } catch (err: any) {
    logger.error(`수동 매도 예외: ${err.message}`, { component: 'DASHBOARD' });
    return c.json({ error: err.message }, 500);
  }
});

// ── 종목코드 전량 매도 (복수 체인 일괄 청산) ──
sellRoutes.post('/sell-stock/:stockCode', async (c) => {
  const stockCode = c.req.param('stockCode');
  try {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const triggerSource: string = (body.source as string) || 'MANUAL';
    const sellReason: string = (body.reason as string) || 'CEO 수동 매도';
    // 대시보드 viewMode에서 is_paper를 전달받거나, 없으면 서버 모드로 폴백
    const isPaper: boolean = typeof body.is_paper === 'boolean' ? body.is_paper : config.isPaper;
    const stockTradingMode = isPaper ? 'paper' : 'live';

    const { rows: openChains } = await getPool().query(
      `SELECT * FROM transaction_chains WHERE stock_code = $1 AND status != 'CLOSED' AND is_paper = $2 ORDER BY created_at ASC`,
      [stockCode, isPaper],
    );
    if (openChains.length === 0) return c.json({ error: '보유 포지션이 없습니다' }, 404);

    const totalQty = openChains.reduce((s: number, ch: any) => s + Number(ch.total_quantity || 0), 0);
    if (totalQty <= 0) return c.json({ error: '매도할 수량이 없습니다' }, 400);

    let fillPrice = 0;
    try { const px = await getCurrentPrice(stockCode); fillPrice = px.currentPrice; } catch { /* skip */ }

    const { withTransaction } = await import('../../../db/client.js');

    if (isPaper) {
      const fakeOrderNo = `P${Date.now().toString(36)}`;
      await withTransaction(async (tx) => {
        for (const chain of openChains) {
          await tx.query(
            `UPDATE transaction_chains SET status='CLOSED', closed_at=NOW(), close_reason=$2, total_quantity=0,
              realized_pnl = CASE WHEN $3 > 0 THEN realized_pnl + ($3 * (1 - 0.00195) - avg_buy_price) * total_quantity ELSE realized_pnl END
             WHERE id=$1`,
            [chain.id, sellReason, fillPrice],
          );
          await tx.query(
            `INSERT INTO orders (chain_id,stock_code,side,order_type,quantity,price,filled_quantity,filled_price,kis_order_no,status,trading_mode,trigger_source,ai_reasoning)
             VALUES ($1,$2,'SELL','MARKET',$3,$4,$3,$4,$5,'FILLED',$6,$7,$8)`,
            [chain.id, stockCode, chain.total_quantity, fillPrice, fakeOrderNo, stockTradingMode, triggerSource, sellReason],
          );
        }
      });
      logger.info(`✅ 전량 매도 완료 (모의): ${stockCode} ${totalQty}주 [${triggerSource}] (${openChains.length}체인)`, { component: 'DASHBOARD' });
      invalidateCurrentModeCache();
      return c.json({ ok: true, message: `${stockCode} ${totalQty}주 전량 매도 완료 (모의투자)` });
    }

    let kisOrderNo = '';
    try {
      let result = await placeOrder({ stockCode, side: 'SELL', quantity: totalQty });
      if (!result.success) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const { getAccountBalance } = await import('../../../kis/account.js');
          const bal = await getAccountBalance(true);
          const kisPos = bal.positions?.find((p: any) => p.stockCode === stockCode);
          if (!kisPos || kisPos.quantity === 0) {
            kisOrderNo = `FILLED_RETRY_${Date.now().toString(36)}`;
            result = { success: true } as any;
          }
        } catch { /* 잔고 조회 실패 시 원래대로 retry */ }
        if (!result.success) {
          result = await placeOrder({ stockCode, side: 'SELL', quantity: totalQty });
        }
      }
      if (!result.success) {
        if (result.message?.includes('40240000') || result.message?.includes('잔고')) {
          kisOrderNo = `GHOST_${Date.now().toString(36)}`;
        } else {
          return c.json({ error: `KIS 매도 거부: ${result.message}` }, 502);
        }
      } else {
        kisOrderNo = kisOrderNo || (result.orderNo ?? '');
      }
    } catch (kisErr: any) {
      const msg: string = kisErr?.message ?? '';
      if (msg.includes('40240000') || msg.includes('잔고')) {
        kisOrderNo = `GHOST_${Date.now().toString(36)}`;
      } else { throw kisErr; }
    }

    // 체결 확인: 잔고 조회로 매도 검증
    const isGhostSell = kisOrderNo.startsWith('GHOST_');
    let fillConfirmed = isGhostSell;
    if (!isGhostSell) {
      try {
        await new Promise((r) => setTimeout(r, 2000));
        const bal2 = await getAccountBalance(true);
        const pos2 = bal2.positions?.find((p: any) => p.stockCode === stockCode);
        fillConfirmed = !pos2 || pos2.quantity === 0;
      } catch { fillConfirmed = true; }
    }

    await withTransaction(async (tx) => {
      for (const chain of openChains) {
        if (fillConfirmed) {
          await tx.query(
            `UPDATE transaction_chains SET status='CLOSED', closed_at=NOW(), close_reason=$2, total_quantity=0,
              realized_pnl = CASE WHEN $3 > 0 THEN realized_pnl + ($3 * (1 - 0.00195) - avg_buy_price) * total_quantity ELSE realized_pnl END
             WHERE id=$1`,
            [chain.id, sellReason, fillPrice],
          );
        }
        await tx.query(
          `INSERT INTO orders (chain_id,stock_code,side,order_type,quantity,price,filled_quantity,filled_price,kis_order_no,status,trading_mode,trigger_source,ai_reasoning)
           VALUES ($1,$2,'SELL','MARKET',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [chain.id, stockCode, chain.total_quantity, fillPrice,
           fillConfirmed ? chain.total_quantity : 0, fillConfirmed ? fillPrice : 0,
           kisOrderNo, fillConfirmed ? 'FILLED' : 'PENDING', stockTradingMode, triggerSource, sellReason],
        );
      }
    });

    logger.info(`${fillConfirmed ? '✅' : '⏳'} 전량 매도 ${fillConfirmed ? '완료' : '접수(체결대기)'}: ${stockCode} ${totalQty}주 [${triggerSource}] (${openChains.length}체인, ${kisOrderNo})`, { component: 'DASHBOARD' });
    try {
      const avgBuy = openChains.reduce((s: number, c: any) => s + Number(c.avg_buy_price || 0) * Number(c.total_quantity || 0), 0) / totalQty;
      const pnlPct = avgBuy > 0 ? ((fillPrice - avgBuy) / avgBuy) * 100 : 0;
      await notifySell(stockCode, totalQty, fillPrice, pnlPct, sellReason);
    } catch { /* 알림 실패 무시 */ }
    invalidateCurrentModeCache();
    return c.json({
      ok: true, orderNo: kisOrderNo, pending: !fillConfirmed,
      message: `${stockCode} ${totalQty}주 ${fillConfirmed ? '전량 매도 완료' : '매도 접수 (체결 대기)'}`,
    });
  } catch (err: any) {
    logger.error(`전량 매도 예외 (${stockCode}): ${err.message}`, { component: 'DASHBOARD' });
    return c.json({ error: err.message }, 500);
  }
});

// ── 해외주식 수동 매도 (CEO 긴급 탈출) ──
sellRoutes.post('/sell-overseas/:stockCode', async (c) => {
  const stockCode = c.req.param('stockCode');
  try {
    const body = await c.req.json().catch(() => ({}));
    const isPaper: boolean = typeof body.is_paper === 'boolean' ? body.is_paper : config.isPaper;
    const { rows } = await getPool().query(
      'SELECT * FROM overseas_holdings WHERE stock_code = $1 AND quantity > 0 AND is_paper = $2', [stockCode, isPaper]);
    const holding = rows[0];
    if (!holding) return c.json({ error: '보유 종목을 찾을 수 없습니다' }, 404);
    const qty = Number(holding.quantity);
    const exchange = String(holding.exchange ?? 'NASDAQ');
    const avgPrice = Number(holding.avg_price ?? 0);

    let fillPrice = Number(holding.last_price ?? 0);
    try {
      const { getOverseasPrice } = await import('../../../kis/overseas.js');
      const px = await getOverseasPrice(stockCode, exchange);
      if ((px?.currentPrice ?? 0) > 0) fillPrice = px.currentPrice;
    } catch { /* 시세 조회 실패 시 DB 저장가 사용 */ }
    if (fillPrice <= 0) fillPrice = avgPrice;

    const paperReasoning = 'CEO 해외주식 수동 전량 매도';
    const proceeds = fillPrice * qty * (1 - OVERSEAS_FEE_PCT);

    if (isPaper) {
      const fakeOrderNo = `POS${Date.now().toString(36)}`;
      const { withTransaction } = await import('../../../db/client.js');
      await withTransaction(async (tx) => {
        await tx.query('DELETE FROM overseas_holdings WHERE stock_code = $1 AND exchange = $2 AND is_paper = true', [stockCode, exchange]);
        await tx.query('DELETE FROM overseas_state WHERE key = $1', [`maxprice_${stockCode}`]);
        await tx.query(
          `INSERT INTO overseas_state (key, value) VALUES ('cash_paper', $1::text)
           ON CONFLICT (key) DO UPDATE SET value = (CAST(overseas_state.value AS NUMERIC) + $1)::text`,
          [proceeds]);
        await tx.query(
          `INSERT INTO orders (stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning, avg_buy_price)
           VALUES ($1,'SELL','MARKET',$2,$3,$2,$3,$4,'FILLED','paper','OVERSEAS',$5,$6)`,
          [stockCode, qty, fillPrice, fakeOrderNo, paperReasoning, avgPrice]);
      });
      logger.info(`✅ CEO 해외 수동 매도 완료 (모의투자): ${stockCode} ${qty}주 @$${fillPrice}`, { component: 'DASHBOARD' });
      return c.json({ ok: true, orderNo: fakeOrderNo, message: `${stockCode} ${qty}주 전량 매도 완료 (모의투자)` });
    }

    // 실거래: KIS 해외 주문
    const { placeOverseasOrder } = await import('../../../kis/overseas.js');
    let result = await placeOverseasOrder({ stockCode, exchange, side: 'SELL', quantity: qty, price: 0 });
    if (!result.success) {
      await new Promise((r) => setTimeout(r, 2000));
      result = await placeOverseasOrder({ stockCode, exchange, side: 'SELL', quantity: qty, price: 0 });
    }
    if (!result.success) {
      logger.error(`해외 수동 매도 최종 실패 (${stockCode}): ${result.message}`, { component: 'DASHBOARD' });
      return c.json({ error: `KIS 매도 거부: ${result.message}` }, 502);
    }

    // 체결 확인: 3초 후 KIS 잔고 조회하여 실제 체결 여부 판정
    await new Promise((r) => setTimeout(r, 3000));
    let confirmed = false;
    try {
      const { getOverseasBalance } = await import('../../../kis/overseas.js');
      const bal = await getOverseasBalance(exchange);
      const pos = bal?.find((p: any) => p.stockCode === stockCode);
      confirmed = !pos || pos.quantity === 0;
    } catch {
      logger.warn(`해외 수동 매도 체결 확인 실패 (${stockCode}) — 주문 접수 상태로 기록`, { component: 'DASHBOARD' });
    }

    const orderStatus = confirmed ? 'FILLED' : 'PENDING';
    const { withTransaction: withTx } = await import('../../../db/client.js');

    if (confirmed) {
      await withTx(async (tx) => {
        await tx.query('DELETE FROM overseas_holdings WHERE stock_code = $1 AND exchange = $2 AND is_paper = false', [stockCode, exchange]);
        await tx.query('DELETE FROM overseas_state WHERE key = $1', [`maxprice_${stockCode}`]);
        await tx.query(
          `INSERT INTO overseas_state (key, value) VALUES ('cash', $1::text)
           ON CONFLICT (key) DO UPDATE SET value = (CAST(overseas_state.value AS NUMERIC) + $1)::text`,
          [proceeds]);
        await tx.query(
          `INSERT INTO orders (stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning, avg_buy_price)
           VALUES ($1,'SELL','MARKET',$2,$3,$2,$3,$4,'FILLED','live','OVERSEAS',$5,$6)`,
          [stockCode, qty, fillPrice, result.orderNo ?? '', paperReasoning, avgPrice]);
      });
      logger.info(`✅ CEO 해외 수동 매도 체결 확인: ${stockCode} ${qty}주 (주문번호 ${result.orderNo})`, { component: 'DASHBOARD' });
    } else {
      // 미체결: 주문만 기록, 보유종목 유지 (다음 overseas-job sync에서 처리)
      await getPool().query(
        `INSERT INTO orders (stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning, avg_buy_price)
         VALUES ($1,'SELL','MARKET',$2,$3, 0, 0, $4,'PENDING','live','OVERSEAS',$5,$6)`,
        [stockCode, qty, fillPrice, result.orderNo ?? '', paperReasoning, avgPrice]);
      logger.warn(`⏳ CEO 해외 수동 매도 접수 (미체결): ${stockCode} ${qty}주 — 다음 sync에서 확인`, { component: 'DASHBOARD' });
    }
    return c.json({ ok: true, orderNo: result.orderNo, status: orderStatus, message: `${stockCode} ${qty}주 매도 ${confirmed ? '체결 완료' : '주문 접수 (체결 대기)'}` });
  } catch (err: any) {
    logger.error(`해외 수동 매도 예외: ${err.message}`, { component: 'DASHBOARD' });
    return c.json({ error: err.message }, 500);
  }
});

// ── 해외주식 강제 DB 청산 (장마감 시/KIS 거부 시 DB만 정리) ──
sellRoutes.post('/sell-overseas-force/:stockCode', async (c) => {
  const stockCode = c.req.param('stockCode');
  try {
    const body = await c.req.json().catch(() => ({}));
    const isPaper: boolean = typeof body.is_paper === 'boolean' ? body.is_paper : config.isPaper;
    const pfx = isPaper ? 'p_' : 'l_';
    const cashKey = isPaper ? 'cash_paper' : 'cash';

    const { rows } = await getPool().query(
      'SELECT * FROM overseas_holdings WHERE stock_code = $1 AND quantity > 0 AND is_paper = $2', [stockCode, isPaper]);
    const holding = rows[0];
    if (!holding) return c.json({ error: '보유 종목을 찾을 수 없습니다' }, 404);

    const qty = Number(holding.quantity);
    const avgPrice = Number(holding.avg_price ?? 0);
    const lastPrice = Number(holding.last_price ?? avgPrice);
    const fillPrice = lastPrice > 0 ? lastPrice : avgPrice;
    const proceeds = fillPrice * qty * (1 - OVERSEAS_FEE_PCT);
    const pnlPct = avgPrice > 0 ? ((fillPrice - avgPrice) / avgPrice) * 100 : 0;
    const exchange = String(holding.exchange ?? 'NASDAQ');
    const reason = `강제 DB 청산 (장마감/KIS미연동): ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;

    const { withTransaction } = await import('../../../db/client.js');
    await withTransaction(async (tx) => {
      await tx.query('DELETE FROM overseas_holdings WHERE stock_code = $1 AND exchange = $2 AND is_paper = $3', [stockCode, exchange, isPaper]);
      // state 정리: maxprice, partial_tp_stage, scale_in
      await tx.query("DELETE FROM overseas_state WHERE key LIKE $1", [`${pfx}%_${stockCode}`]);
      await tx.query("DELETE FROM overseas_state WHERE key = $1", [`maxprice_${stockCode}`]);
      // 현금 복원
      await tx.query(
        `INSERT INTO overseas_state (key, value) VALUES ($1, $2::text)
         ON CONFLICT (key) DO UPDATE SET value = (CAST(overseas_state.value AS NUMERIC) + $2)::text`,
        [cashKey, proceeds]);
      // 주문 기록
      await tx.query(
        `INSERT INTO orders (stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning, avg_buy_price)
         VALUES ($1,'SELL','MARKET',$2,$3,$2,$3,$4,'FILLED',$5,'OVERSEAS',$6,$7)`,
        [stockCode, qty, fillPrice, `FORCE_${Date.now().toString(36)}`, isPaper ? 'paper' : 'live', reason, avgPrice]);
    });

    logger.info(`🔨 강제 DB 청산: ${stockCode} ${qty}주 @$${fillPrice.toFixed(2)} (${reason})`, { component: 'DASHBOARD' });
    invalidateCurrentModeCache();
    return c.json({ ok: true, message: `${stockCode} ${qty}주 강제 청산 완료 ($${proceeds.toFixed(2)} 반환)` });
  } catch (err: any) {
    logger.error(`강제 DB 청산 예외: ${err.message}`, { component: 'DASHBOARD' });
    return c.json({ error: err.message }, 500);
  }
});

// ── 해외주식 전종목 일괄 탈출 (긴급) ──
sellRoutes.post('/sell-overseas-all', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const isPaper: boolean = typeof body.is_paper === 'boolean' ? body.is_paper : config.isPaper;
    const forceDb: boolean = !!body.force_db; // true면 KIS 안거치고 DB만 청산
    const pfx = isPaper ? 'p_' : 'l_';
    const cashKey = isPaper ? 'cash_paper' : 'cash';

    const { rows: allHoldings } = await getPool().query(
      'SELECT * FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1', [isPaper]);
    if (allHoldings.length === 0) return c.json({ error: '보유 종목이 없습니다' }, 404);

    const results: string[] = [];
    let totalProceeds = 0;

    for (const holding of allHoldings) {
      const code = String(holding.stock_code);
      const qty = Number(holding.quantity);
      const avgPrice = Number(holding.avg_price ?? 0);
      const lastPrice = Number(holding.last_price ?? avgPrice);
      const fillPrice = lastPrice > 0 ? lastPrice : avgPrice;
      const exchange = String(holding.exchange ?? 'NASDAQ');
      const proceeds = fillPrice * qty * (1 - OVERSEAS_FEE_PCT);
      const pnlPct = avgPrice > 0 ? ((fillPrice - avgPrice) / avgPrice) * 100 : 0;

      let sold = false;
      let kisOrderNo = '';

      // KIS 매도 시도 (forceDb가 아닌 경우)
      if (!forceDb && !isPaper) {
        try {
          const { placeOverseasOrder } = await import('../../../kis/overseas.js');
          const result = await placeOverseasOrder({ stockCode: code, exchange, side: 'SELL', quantity: qty, price: 0 });
          if (result.success) {
            kisOrderNo = result.orderNo ?? '';
            sold = true;
          }
        } catch { /* KIS 실패 → DB 청산으로 폴백 */ }
      }

      // DB 청산 (paper이거나, forceDb이거나, KIS 실패한 경우)
      const reason = sold
        ? `긴급 일괄 청산 (KIS 체결): ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`
        : `긴급 일괄 강제청산 (DB): ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;

      const { withTransaction } = await import('../../../db/client.js');
      await withTransaction(async (tx) => {
        await tx.query('DELETE FROM overseas_holdings WHERE stock_code = $1 AND exchange = $2 AND is_paper = $3', [code, exchange, isPaper]);
        await tx.query("DELETE FROM overseas_state WHERE key LIKE $1", [`${pfx}%_${code}`]);
        await tx.query("DELETE FROM overseas_state WHERE key = $1", [`maxprice_${code}`]);
        await tx.query(
          `INSERT INTO overseas_state (key, value) VALUES ($1, $2::text)
           ON CONFLICT (key) DO UPDATE SET value = (CAST(overseas_state.value AS NUMERIC) + $2)::text`,
          [cashKey, proceeds]);
        await tx.query(
          `INSERT INTO orders (stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning, avg_buy_price)
           VALUES ($1,'SELL','MARKET',$2,$3,$2,$3,$4,'FILLED',$5,'OVERSEAS',$6,$7)`,
          [code, qty, fillPrice, kisOrderNo || `FORCE_${Date.now().toString(36)}`, isPaper ? 'paper' : 'live', reason, avgPrice]);
      });

      totalProceeds += proceeds;
      results.push(`${code} ${qty}주 @$${fillPrice.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`);
    }

    logger.info(`🚨 전종목 긴급 청산 완료: ${allHoldings.length}종목 $${totalProceeds.toFixed(2)} 반환`, { component: 'DASHBOARD' });
    invalidateCurrentModeCache();
    return c.json({
      ok: true,
      count: allHoldings.length,
      totalProceeds: totalProceeds.toFixed(2),
      details: results,
      message: `${allHoldings.length}종목 전량 청산 완료 ($${totalProceeds.toFixed(2)} 반환)`,
    });
  } catch (err: any) {
    logger.error(`전종목 긴급 청산 예외: ${err.message}`, { component: 'DASHBOARD' });
    return c.json({ error: err.message }, 500);
  }
});

// ── Claude Code 수동 매수 (복리 동적 사이징) ──
sellRoutes.post('/manual-buy', async (c) => {
  let body: { stock_code?: string; amount_krw?: number; ai_score?: number; reasoning?: string; is_paper?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '요청 형식 오류' }, 400);
  }

  const stock_code = String(body.stock_code ?? '').trim().replace(/\D/g, '');
  const { reasoning } = body;
  const aiScore = body.ai_score ?? 0;
  const isPaper: boolean = typeof body.is_paper === 'boolean' ? body.is_paper : config.isPaper;
  const tradingMode = isPaper ? 'paper' : 'live';
  if (!stock_code || stock_code.length !== 6) {
    return c.json({ error: 'stock_code는 숫자 6자리여야 합니다' }, 400);
  }

  const { takeProfitPct, stopLossPct } = aiScore >= 70
    ? getScoreBasedParams(aiScore)
    : { takeProfitPct: STRATEGY_PARAMS.SWING.takeProfitPct, stopLossPct: STRATEGY_PARAMS.SWING.stopLossPct };

  try {
    const MAX_ALLOC_PCT = 0.20;
    let amount_krw = body.amount_krw ?? 0;
    if (amount_krw < 10000) {
      try {
        const balance = isPaper ? await getPaperBalance() : await getAccountBalance(true);
        const totalCapital = balance.totalEvalAmount + balance.orderableCash;
        const availCash = balance.orderableCash;
        const slFraction = Math.abs(stopLossPct) / 100;
        const riskBudget = totalCapital * 0.015;
        const computed = Math.round(riskBudget / slFraction);
        const capByAlloc = Math.round(totalCapital * MAX_ALLOC_PCT);
        // 가용현금 초과 방지 + 최소 10,000원 (1주 살 수 있는지는 이후 체크)
        const capByCash = Math.round(availCash * 0.95);
        amount_krw = Math.max(Math.min(computed, capByAlloc, capByCash), 10000);
        logger.info(
          `💰 동적 사이징: 총자본 ${(totalCapital / 10000).toFixed(0)}만원 가용현금 ${(availCash / 10000).toFixed(1)}만원 × 1.5% / ${Math.abs(stopLossPct)}%SL = ${(computed / 10000).toFixed(1)}만원 → ${(amount_krw / 10000).toFixed(1)}만원`,
          { component: 'CLAUDE_BUY' },
        );
      } catch (e) {
        logger.error(`잔고 조회 실패 — 주문 중단: ${e}`, { component: 'CLAUDE_BUY' });
        return c.json({ error: `잔고 조회 실패로 주문 중단: ${e instanceof Error ? e.message : e}` }, 503);
      }
    }

    const priceData = await getCurrentPrice(stock_code);
    const curPrice = priceData.currentPrice;
    if (!curPrice || curPrice <= 0) return c.json({ error: '현재가 조회 실패' }, 500);

    const quantity = Math.floor(amount_krw / curPrice);
    if (quantity < 1) return c.json({ error: `수량 부족: ${curPrice.toLocaleString()}원 × 1주 > ${amount_krw.toLocaleString()}원` }, 400);

    // 실전 모드만 리스크 엔진 검증 — 모의투자는 실전 자금 제약 없이 자유롭게 테스트
    if (!isPaper) {
      try {
        const riskResult = await riskEngine.validateOrder({
          stockCode: stock_code,
          side: 'BUY',
          quantity,
          estimatedPrice: curPrice,
          isPaper: false,
        });
        if (!riskResult.approved) {
          logger.warn(`🚫 수동매수 리스크 거부: ${stock_code} — ${riskResult.reason}`, { component: 'CLAUDE_BUY' });
          return c.json({ error: `리스크 체크 거부: ${riskResult.reason}` }, 403);
        }
      } catch (e) {
        logger.warn(`리스크 엔진 조회 실패 — 매수 진행 차단: ${e}`, { component: 'CLAUDE_BUY' });
        return c.json({ error: '리스크 엔진 조회 실패 — 안전을 위해 매수 차단' }, 500);
      }
    }

    const totalInvested = quantity * curPrice;
    const rrStr = `TP+${takeProfitPct}%/SL${stopLossPct}%(${(takeProfitPct / Math.abs(stopLossPct)).toFixed(2)}:1)`;

    // 중복 OPEN 체인 방지
    const dupCheck = await getPool().query(
      `SELECT id FROM chains WHERE stock_code = $1 AND is_paper = $2 AND status = 'OPEN' LIMIT 1`,
      [stock_code, isPaper],
    );
    if (dupCheck.rows.length > 0) {
      return c.json({ error: `이미 OPEN 포지션 있음: ${stock_code} — 중복 매수 불가` }, 409);
    }

    if (isPaper) {
      const fakeOrderNo = `CLD${Date.now().toString(36).toUpperCase()}`;
      const chainId = await createChain({
        stock_code,
        status: 'OPEN',
        strategy_mode: 'SWING',
        avg_buy_price: curPrice,
        total_quantity: quantity,
        total_invested: totalInvested,
        realized_pnl: 0,
        target_profit_pct: takeProfitPct,
        stop_loss_pct: stopLossPct,
        max_averaging_count: STRATEGY_PARAMS.SWING.maxAveragingCount,
        current_averaging_count: 0,
        is_paper: true,
      });
      await getPool().query(
        `INSERT INTO orders (chain_id, stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning)
         VALUES ($1, $2, 'BUY', 'MARKET', $3, $4, $3, $4, $5, 'FILLED', $6, 'CLAUDE', $7)`,
        [chainId, stock_code, quantity, curPrice, fakeOrderNo, tradingMode, reasoning ?? 'Claude Code 눌림매매'],
      );
      logger.info(`🤖 Claude 매수 (모의): ${stock_code} ${quantity}주 @${curPrice.toLocaleString()}원 ${rrStr} — ${reasoning}`, { component: 'CLAUDE_BUY' });
      try { await notifyBuy(stock_code, quantity, curPrice, reasoning ?? 'Claude Code 스캘핑'); } catch { /* 알림 실패 무시 */ }
      return c.json({ ok: true, orderNo: fakeOrderNo, stock_code, quantity, price: curPrice, totalInvested, takeProfitPct, stopLossPct });
    }

    const result = await placeOrder({ stockCode: stock_code, side: 'BUY', quantity });
    if (!result.success) return c.json({ error: `KIS 매수 거부: ${result.message}` }, 502);
    const kisOrderNo = result.orderNo ?? '';

    // 체결 확인: 3초 대기 후 잔고 조회
    await new Promise((r) => setTimeout(r, 3000));
    let confirmed = false;
    try {
      const bal = await getAccountBalance(true);
      confirmed = bal.positions.some((p: any) => String(p.stockCode) === stock_code);
    } catch {
      logger.warn(`매수 체결 확인 실패 (${stock_code}) — PENDING으로 기록`, { component: 'CLAUDE_BUY' });
    }

    const orderStatus = confirmed ? 'FILLED' : 'PENDING';
    const chainId = await createChain({
      stock_code,
      status: 'OPEN',
      strategy_mode: 'SWING',
      avg_buy_price: curPrice,
      total_quantity: confirmed ? quantity : 0,
      total_invested: confirmed ? totalInvested : 0,
      realized_pnl: 0,
      target_profit_pct: takeProfitPct,
      stop_loss_pct: stopLossPct,
      max_averaging_count: STRATEGY_PARAMS.SWING.maxAveragingCount,
      current_averaging_count: 0,
      is_paper: false,
    });
    await getPool().query(
      `INSERT INTO orders (chain_id, stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning)
       VALUES ($1, $2, 'BUY', 'MARKET', $3, $4, $5, $6, $7, $8, $9, 'CLAUDE', $10)`,
      [chainId, stock_code, quantity, curPrice,
       confirmed ? quantity : 0, confirmed ? curPrice : 0,
       kisOrderNo, orderStatus, tradingMode, reasoning ?? 'Claude Code 눌림매매'],
    );
    logger.info(`🤖 Claude 매수 ${confirmed ? '체결' : '접수'}: ${stock_code} ${quantity}주 @${curPrice.toLocaleString()}원 (${kisOrderNo}) ${rrStr} — ${reasoning}`, { component: 'CLAUDE_BUY' });
    try { await notifyBuy(stock_code, quantity, curPrice, reasoning ?? 'Claude Code 스캘핑'); } catch { /* 알림 실패 무시 */ }
    return c.json({ ok: true, orderNo: kisOrderNo, status: orderStatus, stock_code, quantity, price: curPrice, totalInvested, takeProfitPct, stopLossPct });
  } catch (err: any) {
    logger.error(`Claude 매수 예외: ${err.message}`, { component: 'CLAUDE_BUY' });
    return c.json({ error: err.message }, 500);
  }
});
