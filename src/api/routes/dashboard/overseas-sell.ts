/**
 * 해외주식 매도 라우트 — /sell-overseas/*, /sell-overseas-force/*, /sell-overseas-all
 */
import type { Hono } from 'hono';
import { OVERSEAS_FEE_PCT } from '../../../config/constants.js';
import { runWithMode } from '../../../config/context.js';
import { config } from '../../../config/index.js';
import { getPool } from '../../../db/client.js';
import { resolveRequestMode } from '../../guards/live-pin.js';
import { invalidateBalanceCache } from '../../../kis/account.js';
import { positionStateKeys } from '../../../scheduler/overseas/utils.js';
import { logger } from '../../../utils/logger.js';
import { sleep } from '../../../utils/sleep.js';
import { hardInvalidateMode } from './helpers.js';

export function registerOverseasSellRoutes(app: Hono) {
  // ── 해외주식 수동 매도 ──
  app.post('/sell-overseas/:stockCode', async (c) => {
    const stockCode = c.req.param('stockCode');
    try {
      const body = await c.req.json().catch(() => ({}));
      const isPaper: boolean = typeof body.is_paper === 'boolean' ? body.is_paper : resolveRequestMode(c);
      const { rows } = await getPool().query(
        'SELECT * FROM overseas_holdings WHERE stock_code = $1 AND quantity > 0 AND is_paper = $2',
        [stockCode, isPaper],
      );
      const holding = rows[0];
      if (!holding) return c.json({ error: '보유 종목을 찾을 수 없습니다' }, 404);
      const totalQty = Number(holding.quantity);
      const reqQty =
        body.quantity != null ? Math.min(Math.max(1, Math.floor(Number(body.quantity))), totalQty) : totalQty;
      const qty = reqQty;
      const isPartial = qty < totalQty;
      const exchange = String(holding.exchange ?? 'NASDAQ');
      const avgPrice = Number(holding.avg_price ?? 0);

      let fillPrice = Number(holding.last_price ?? 0);
      try {
        const { getOverseasPrice } = await import('../../../kis/overseas.js');
        const px = await getOverseasPrice(stockCode, exchange);
        if ((px?.currentPrice ?? 0) > 0) fillPrice = px.currentPrice;
      } catch {
        /* 시세 조회 실패 시 DB 저장가 사용 */
      }
      if (fillPrice <= 0) fillPrice = avgPrice;

      const paperReasoning = isPartial
        ? `CEO 해외주식 수동 부분매도 (${qty}/${totalQty}주)`
        : 'CEO 해외주식 수동 전량 매도';
      const proceeds = fillPrice * qty * (1 - OVERSEAS_FEE_PCT);

      if (isPaper) {
        const fakeOrderNo = `POS${Date.now().toString(36)}`;
        const { withTransaction } = await import('../../../db/client.js');
        await withTransaction(async (tx) => {
          if (isPartial) {
            await tx.query(
              'UPDATE overseas_holdings SET quantity = quantity - $1 WHERE stock_code = $2 AND exchange = $3 AND is_paper = true',
              [qty, stockCode, exchange],
            );
          } else {
            await tx.query(
              'DELETE FROM overseas_holdings WHERE stock_code = $1 AND exchange = $2 AND is_paper = true',
              [stockCode, exchange],
            );
            await tx.query('DELETE FROM overseas_state WHERE key = ANY($1)', [positionStateKeys(stockCode, true)]);
          }
          await tx.query(
            `INSERT INTO overseas_state (key, value) VALUES ('cash_paper', $1::text)
             ON CONFLICT (key) DO UPDATE SET value = (CAST(overseas_state.value AS NUMERIC) + $1::numeric)::text`,
            [proceeds],
          );
          await tx.query(
            `INSERT INTO orders (stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning, avg_buy_price)
             VALUES ($1,'SELL','MARKET',$2,$3,$2,$3,$4,'FILLED','paper','OVERSEAS',$5,$6)`,
            [stockCode, qty, fillPrice, fakeOrderNo, paperReasoning, avgPrice],
          );
        });
        logger.info(`✅ CEO 해외 수동 매도 완료 (모의투자): ${stockCode} ${qty}주 @$${fillPrice}`, {
          component: 'DASHBOARD',
        });
        invalidateBalanceCache();
        hardInvalidateMode(isPaper);
        return c.json({
          ok: true,
          orderNo: fakeOrderNo,
          message: `${stockCode} ${qty}주 ${isPartial ? '부분' : '전량'} 매도 완료 (모의투자)`,
        });
      }

      // 실거래: KIS 해외 주문
      const { placeOverseasOrder } = await import('../../../kis/overseas.js');
      let result = await runWithMode(isPaper, () =>
        placeOverseasOrder({ stockCode, exchange, side: 'SELL', quantity: qty, price: 0 }),
      );
      if (!result.success) {
        await sleep(2000);
        result = await runWithMode(isPaper, () =>
          placeOverseasOrder({ stockCode, exchange, side: 'SELL', quantity: qty, price: 0 }),
        );
      }
      if (!result.success) {
        logger.error(`해외 수동 매도 최종 실패 (${stockCode}): ${result.message}`, { component: 'DASHBOARD' });
        return c.json({ error: `KIS 매도 거부: ${result.message}` }, 502);
      }

      await sleep(3000);
      let confirmed = false;
      try {
        const { getOverseasBalance } = await import('../../../kis/overseas.js');
        const bal = await runWithMode(isPaper, () => getOverseasBalance(exchange));
        const pos = bal?.find((p: any) => p.stockCode === stockCode);
        confirmed = isPartial ? !pos || pos.quantity <= totalQty - qty : !pos || pos.quantity === 0;
      } catch {
        logger.warn(`해외 수동 매도 체결 확인 실패 (${stockCode}) — 주문 접수 상태로 기록`, { component: 'DASHBOARD' });
      }

      const orderStatus = confirmed ? 'FILLED' : 'PENDING';
      const { withTransaction: withTx } = await import('../../../db/client.js');

      if (confirmed) {
        await withTx(async (tx) => {
          if (isPartial) {
            await tx.query(
              'UPDATE overseas_holdings SET quantity = quantity - $1 WHERE stock_code = $2 AND exchange = $3 AND is_paper = false',
              [qty, stockCode, exchange],
            );
          } else {
            await tx.query(
              'DELETE FROM overseas_holdings WHERE stock_code = $1 AND exchange = $2 AND is_paper = false',
              [stockCode, exchange],
            );
            await tx.query('DELETE FROM overseas_state WHERE key = ANY($1)', [positionStateKeys(stockCode, false)]);
          }
          await tx.query(
            `INSERT INTO orders (stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning, avg_buy_price)
             VALUES ($1,'SELL','MARKET',$2,$3,$2,$3,$4,'FILLED','live','OVERSEAS',$5,$6)`,
            [stockCode, qty, fillPrice, result.orderNo ?? '', paperReasoning, avgPrice],
          );
        });
        const { reconcileCashWithKIS } = await import('../../../scheduler/overseas/kis-sync.js');
        await runWithMode(false, () => reconcileCashWithKIS()).catch((e: any) =>
          logger.warn(`매도 후 현금 동기화 실패 (무시): ${e.message}`, { component: 'DASHBOARD' }),
        );
        logger.info(`✅ CEO 해외 수동 매도 체결 확인: ${stockCode} ${qty}주 (주문번호 ${result.orderNo})`, {
          component: 'DASHBOARD',
        });
      } else {
        await getPool().query(
          `INSERT INTO orders (stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning, avg_buy_price)
           VALUES ($1,'SELL','MARKET',$2,$3, 0, 0, $4,'PENDING','live','OVERSEAS',$5,$6)`,
          [stockCode, qty, fillPrice, result.orderNo ?? '', paperReasoning, avgPrice],
        );
        logger.warn(`⏳ CEO 해외 수동 매도 접수 (미체결): ${stockCode} ${qty}주 — 다음 sync에서 확인`, {
          component: 'DASHBOARD',
        });
      }
      invalidateBalanceCache();
      hardInvalidateMode(isPaper);
      return c.json({
        ok: true,
        orderNo: result.orderNo,
        status: orderStatus,
        message: `${stockCode} ${qty}주 ${isPartial ? '부분' : '전량'} 매도 ${confirmed ? '체결 완료' : '주문 접수 (체결 대기)'}`,
      });
    } catch (err: any) {
      logger.error(`해외 수동 매도 예외: ${err.message}`, { component: 'DASHBOARD' });
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── 해외주식 강제 DB 청산 ──
  app.post('/sell-overseas-force/:stockCode', async (c) => {
    const stockCode = c.req.param('stockCode');
    try {
      const body = await c.req.json().catch(() => ({}));
      const isPaper: boolean = typeof body.is_paper === 'boolean' ? body.is_paper : resolveRequestMode(c);
      const _pfx = isPaper ? 'p_' : 'l_';
      const cashKey = isPaper ? 'cash_paper' : 'cash';

      const { rows } = await getPool().query(
        'SELECT * FROM overseas_holdings WHERE stock_code = $1 AND quantity > 0 AND is_paper = $2',
        [stockCode, isPaper],
      );
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
        await tx.query('DELETE FROM overseas_holdings WHERE stock_code = $1 AND exchange = $2 AND is_paper = $3', [
          stockCode,
          exchange,
          isPaper,
        ]);
        await tx.query('DELETE FROM overseas_state WHERE key = ANY($1)', [positionStateKeys(stockCode, isPaper)]);
        if (isPaper) {
          await tx.query(
            `INSERT INTO overseas_state (key, value) VALUES ($1, $2::text)
             ON CONFLICT (key) DO UPDATE SET value = (CAST(overseas_state.value AS NUMERIC) + $2::numeric)::text`,
            [cashKey, proceeds],
          );
        }
        await tx.query(
          `INSERT INTO orders (stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning, avg_buy_price)
           VALUES ($1,'SELL','MARKET',$2,$3,$2,$3,$4,'FILLED',$5,'OVERSEAS',$6,$7)`,
          [stockCode, qty, fillPrice, `FORCE_${Date.now().toString(36)}`, isPaper ? 'paper' : 'live', reason, avgPrice],
        );
      });

      if (!isPaper) {
        const { reconcileCashWithKIS } = await import('../../../scheduler/overseas/kis-sync.js');
        await runWithMode(false, () => reconcileCashWithKIS()).catch((e: any) =>
          logger.warn(`강제청산 후 현금 동기화 실패 (무시): ${e.message}`, { component: 'DASHBOARD' }),
        );
      }

      logger.info(`🔨 강제 DB 청산: ${stockCode} ${qty}주 @$${fillPrice.toFixed(2)} (${reason})`, {
        component: 'DASHBOARD',
      });
      invalidateBalanceCache();
      hardInvalidateMode(isPaper);
      return c.json({ ok: true, message: `${stockCode} ${qty}주 강제 청산 완료 ($${proceeds.toFixed(2)} 반환)` });
    } catch (err: any) {
      logger.error(`강제 DB 청산 예외: ${err.message}`, { component: 'DASHBOARD' });
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── 해외주식 전종목 일괄 탈출 ──
  app.post('/sell-overseas-all', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const isPaper: boolean = typeof body.is_paper === 'boolean' ? body.is_paper : resolveRequestMode(c);
      const forceDb: boolean = !!body.force_db;
      const _pfx = isPaper ? 'p_' : 'l_';
      const cashKey = isPaper ? 'cash_paper' : 'cash';

      const { rows: allHoldings } = await getPool().query(
        'SELECT * FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1',
        [isPaper],
      );
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

        if (!forceDb && !isPaper) {
          try {
            const { placeOverseasOrder } = await import('../../../kis/overseas.js');
            const result = await runWithMode(false, () =>
              placeOverseasOrder({ stockCode: code, exchange, side: 'SELL', quantity: qty, price: 0 }),
            );
            if (result.success) {
              kisOrderNo = result.orderNo ?? '';
              sold = true;
            }
          } catch {
            /* KIS 실패 → DB 청산 폴백 */
          }
        }

        const reason = sold
          ? `긴급 일괄 청산 (KIS 체결): ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`
          : `긴급 일괄 강제청산 (DB): ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;

        const { withTransaction } = await import('../../../db/client.js');
        await withTransaction(async (tx) => {
          await tx.query('DELETE FROM overseas_holdings WHERE stock_code = $1 AND exchange = $2 AND is_paper = $3', [
            code,
            exchange,
            isPaper,
          ]);
          await tx.query('DELETE FROM overseas_state WHERE key = ANY($1)', [positionStateKeys(code, isPaper)]);
          if (isPaper) {
            await tx.query(
              `INSERT INTO overseas_state (key, value) VALUES ($1, $2::text)
               ON CONFLICT (key) DO UPDATE SET value = (CAST(overseas_state.value AS NUMERIC) + $2::numeric)::text`,
              [cashKey, proceeds],
            );
          }
          await tx.query(
            `INSERT INTO orders (stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning, avg_buy_price)
             VALUES ($1,'SELL','MARKET',$2,$3,$2,$3,$4,'FILLED',$5,'OVERSEAS',$6,$7)`,
            [
              code,
              qty,
              fillPrice,
              kisOrderNo || `FORCE_${Date.now().toString(36)}`,
              isPaper ? 'paper' : 'live',
              reason,
              avgPrice,
            ],
          );
        });

        totalProceeds += proceeds;
        results.push(`${code} ${qty}주 @$${fillPrice.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`);
      }

      if (!isPaper) {
        const { reconcileCashWithKIS } = await import('../../../scheduler/overseas/kis-sync.js');
        await runWithMode(false, () => reconcileCashWithKIS()).catch((e: any) =>
          logger.warn(`긴급청산 후 현금 동기화 실패 (무시): ${e.message}`, { component: 'DASHBOARD' }),
        );
      }

      logger.info(`🚨 전종목 긴급 청산 완료: ${allHoldings.length}종목 $${totalProceeds.toFixed(2)} 반환`, {
        component: 'DASHBOARD',
      });
      invalidateBalanceCache();
      hardInvalidateMode(isPaper);
      return c.json({
        ok: true,
        count: allHoldings.length,
        totalProceeds: totalProceeds.toFixed(2),
        details: results,
        message: `${allHoldings.length}종목 전량 청산 완료 ($${totalProceeds.toFixed(2)} 반환)`,
      });
    } catch (err: any) {
      logger.error(`전종목 긴급 청산 예외: ${err.message}`, { component: 'DASHBOARD' });
      return c.json({ error: 'Internal server error' }, 500);
    }
  });
}
