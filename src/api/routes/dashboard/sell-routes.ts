/**
 * 매도/탈출 라우트 — /sell/*, /escape/*, /sell-stock/*
 * 해외매도(/sell-overseas/*) → overseas-sell.ts, 수동매수(/manual-buy) → manual-buy.ts
 */
import { Hono } from 'hono';
import { invalidateStockCache } from '../../../cache/redis.js';
import { KR_FEE } from '../../../config/constants.js';
import { getCtxIsPaper, runWithMode } from '../../../config/context.js';
import { config } from '../../../config/index.js';
import { getPool } from '../../../db/client.js';
import { resolveRequestMode } from '../../guards/live-pin.js';
import { getAccountBalance, invalidateBalanceCache } from '../../../kis/account.js';
import { getCurrentPrice } from '../../../kis/market.js';
import { placeOrder } from '../../../kis/order.js';
import { notifySell } from '../../../notifications/web-push.js';
import { logger } from '../../../utils/logger.js';
import { sleep } from '../../../utils/sleep.js';
import { hardInvalidateMode } from './helpers.js';
import { registerManualBuyRoutes } from './manual-buy.js';
import { registerOverseasSellRoutes } from './overseas-sell.js';

// trigger_source 화이트리스트 — 허용되지 않은 값은 MANUAL로 강제 전환
const VALID_TRIGGER_SOURCES = new Set([
  'MANUAL', 'AI', 'FORCE_CLOSE', 'TRAILING_STOP', 'HOLDING_CHECK', 'ESCAPE',
  'CLAUDE', 'EXTERNAL', 'OVERSEAS', 'SCALPING', 'KILL_SWITCH', 'CEO',
]);
function sanitizeTriggerSource(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return VALID_TRIGGER_SOURCES.has(s) ? s : 'MANUAL';
}

export const sellRoutes = new Hono();
registerManualBuyRoutes(sellRoutes);
registerOverseasSellRoutes(sellRoutes);

// ── 탈출 모드 등록: +0.5% 돌파 순간 자동 전량 매도 ──
sellRoutes.post('/escape/:chainId', async (c) => {
  const chainId = c.req.param('chainId');
  try {
    const { rows } = await getPool().query('SELECT * FROM transaction_chains WHERE id = $1 AND is_paper = $2', [
      chainId,
      getCtxIsPaper(),
    ]);
    const chain = rows[0];
    if (!chain) return c.json({ error: '체인을 찾을 수 없습니다' }, 404);
    if (chain.total_quantity <= 0) return c.json({ error: '매도할 수량이 없습니다' }, 400);

    const { getCurrentPrice } = await import('../../../kis/market.js');
    const priceData = await getCurrentPrice(chain.stock_code);
    const curPrice = priceData.currentPrice;
    if (!curPrice || curPrice <= 0) return c.json({ error: '현재가를 조회할 수 없습니다' }, 500);

    const escapeTarget = Math.ceil(curPrice * 1.005);
    await getPool().query('UPDATE transaction_chains SET escape_target_price = $1 WHERE id = $2 AND is_paper = $3', [
      escapeTarget,
      chainId,
      getCtxIsPaper(),
    ]);

    logger.info(
      `🚪 탈출 모드 등록: ${chain.stock_code} 목표가 ${escapeTarget.toLocaleString()}원 (현재 ${curPrice.toLocaleString()}원 → +0.5%)`,
      { component: 'ESCAPE' },
    );

    return c.json({ ok: true, escape_target_price: escapeTarget, current_price: curPrice });
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── 탈출 모드 취소 ──
sellRoutes.delete('/escape/:chainId', async (c) => {
  const chainId = c.req.param('chainId');
  try {
    await getPool().query('UPDATE transaction_chains SET escape_target_price = NULL WHERE id = $1 AND is_paper = $2', [
      chainId,
      getCtxIsPaper(),
    ]);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── 수동 매도 (CEO 긴급 매도) ──
sellRoutes.post('/sell/:chainId', async (c) => {
  const chainId = c.req.param('chainId');
  try {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const triggerSource: string = sanitizeTriggerSource(body.source);
    const sellReason: string = (body.reason as string) || 'CEO 수동 매도';

    const { rows } = await getPool().query('SELECT * FROM transaction_chains WHERE id = $1 AND is_paper = $2', [
      chainId,
      getCtxIsPaper(),
    ]);
    const chain = rows[0];
    if (!chain) return c.json({ error: '체인을 찾을 수 없습니다' }, 404);
    if (chain.status === 'CLOSED') return c.json({ error: '이미 청산된 포지션입니다' }, 400);
    if (chain.total_quantity <= 0) return c.json({ error: '매도할 수량이 없습니다' }, 400);

    let fillPrice = 0;
    try {
      const px = await getCurrentPrice(chain.stock_code);
      fillPrice = px.currentPrice;
    } catch {
      /* 시세 조회 실패 — 평단가 폴백 (PnL ≈ -수수료로 기록, 0보다 정확) */
    }
    if (fillPrice <= 0) fillPrice = Number(chain.avg_buy_price ?? 0);

    // 모의투자 모드
    const chainTradingMode = chain.is_paper ? 'paper' : 'live';
    if (chain.is_paper) {
      const fakeOrderNo = `P${Date.now().toString(36)}`;
      const _qty1 = Number(chain.total_quantity);
      const _avg1 = Number(chain.avg_buy_price ?? 0);
      const _profit1 = fillPrice > 0 ? Math.round(fillPrice * _qty1 * (1 - KR_FEE.SELL_FEE_PCT)) - Math.round(_avg1 * _qty1) : 0;
      const _pnlPct1 = _avg1 > 0 && fillPrice > 0 ? Math.round(((fillPrice - _avg1) / _avg1) * 10000) / 100 : null;
      await getPool().query(
        `UPDATE transaction_chains SET status = 'CLOSED', closed_at = NOW(), close_reason = $2, total_quantity = 0,
          realized_pnl = realized_pnl + $3, pnl_pct = COALESCE($5, pnl_pct)
         WHERE id = $1 AND is_paper = $4`,
        [chainId, sellReason, _profit1, true, _pnlPct1],
      );
      await getPool().query(
        `INSERT INTO orders (chain_id, stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning)
         VALUES ($1, $2, 'SELL', 'MARKET', $3, $4, $3, $4, $5, 'FILLED', $6, $7, $8)`,
        [
          chainId,
          chain.stock_code,
          chain.total_quantity,
          fillPrice,
          fakeOrderNo,
          chainTradingMode,
          triggerSource,
          sellReason,
        ],
      );
      logger.info(`✅ 매도 완료 (모의투자): ${chain.stock_code} ${chain.total_quantity}주 [${triggerSource}]`, {
        component: 'DASHBOARD',
      });
      try {
        const pnlPct =
          chain.avg_buy_price > 0 ? ((fillPrice - Number(chain.avg_buy_price)) / Number(chain.avg_buy_price)) * 100 : 0;
        await notifySell(chain.stock_code, chain.total_quantity, fillPrice, pnlPct, sellReason, undefined, true);
      } catch {
        /* 알림 실패 무시 */
      }
      invalidateBalanceCache();
      hardInvalidateMode(chain.is_paper);
      invalidateStockCache(chain.stock_code).catch(() => {});
      return c.json({
        ok: true,
        orderNo: fakeOrderNo,
        message: `${chain.stock_code} ${chain.total_quantity}주 전량 매도 완료 (모의투자)`,
      });
    }

    // 실거래: KIS 주문 — 실패 시 1회 재시도 (live 컨텍스트 명시)
    let kisOrderNo = '';
    let isGhost = false;
    try {
      let result = await runWithMode(false, () =>
        placeOrder({ stockCode: chain.stock_code, side: 'SELL', quantity: chain.total_quantity }),
      );
      if (!result.success) {
        logger.warn(`수동 매도 1차 실패 (${chain.stock_code}): ${result.message} — 2초 후 재시도`, {
          component: 'DASHBOARD',
        });
        await sleep(2000);
        result = await runWithMode(false, () =>
          placeOrder({ stockCode: chain.stock_code, side: 'SELL', quantity: chain.total_quantity }),
        );
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
        await sleep(2000);
        const bal = await getAccountBalance(true);
        const pos = bal.positions?.find((p: any) => p.stockCode === chain.stock_code);
        fillConfirmed = !pos || pos.quantity === 0;
      } catch {
        // KIS 잔고 조회 실패 시 fail-closed: 체인을 OPEN으로 유지 (reconcileExternalSells가 다음 사이클에 정리)
        // fillConfirmed = true이면 실제 미체결임에도 DB에서 포지션 강제 종료 → 실계좌 불일치 위험
        fillConfirmed = false;
      }
    }

    if (fillConfirmed) {
      const _qty2 = Number(chain.total_quantity);
      const _avg2 = Number(chain.avg_buy_price ?? 0);
      const _profit2 = fillPrice > 0 ? Math.round(fillPrice * _qty2 * (1 - KR_FEE.SELL_FEE_PCT)) - Math.round(_avg2 * _qty2) : 0;
      const _pnlPct2 = _avg2 > 0 && fillPrice > 0 ? Math.round(((fillPrice - _avg2) / _avg2) * 10000) / 100 : null;
      await getPool().query(
        `UPDATE transaction_chains SET status = 'CLOSED', closed_at = NOW(), close_reason = $2, total_quantity = 0,
          realized_pnl = realized_pnl + $3, pnl_pct = COALESCE($5, pnl_pct)
         WHERE id = $1 AND is_paper = $4`,
        [chainId, sellReason, _profit2, false, _pnlPct2],
      );
    }

    await getPool().query(
      `INSERT INTO orders (chain_id, stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning)
       VALUES ($1, $2, 'SELL', 'MARKET', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        chainId,
        chain.stock_code,
        chain.total_quantity,
        fillPrice,
        fillConfirmed ? chain.total_quantity : 0,
        fillConfirmed ? fillPrice : 0,
        kisOrderNo,
        fillConfirmed ? 'FILLED' : 'PENDING',
        chainTradingMode,
        triggerSource,
        sellReason,
      ],
    );

    logger.info(
      `${fillConfirmed ? '✅' : '⏳'} 매도 ${fillConfirmed ? '완료' : '접수(체결대기)'}: ${chain.stock_code} ${chain.total_quantity}주 [${triggerSource}] (${kisOrderNo})`,
      { component: 'DASHBOARD' },
    );
    try {
      const pnlPct =
        chain.avg_buy_price > 0 ? ((fillPrice - Number(chain.avg_buy_price)) / Number(chain.avg_buy_price)) * 100 : 0;
      await notifySell(chain.stock_code, chain.total_quantity, fillPrice, pnlPct, sellReason, undefined, chain.is_paper);
    } catch {
      /* 알림 실패 무시 */
    }
    invalidateBalanceCache();
    hardInvalidateMode(chain.is_paper);
    invalidateStockCache(chain.stock_code).catch(() => {});
    return c.json({
      ok: true,
      orderNo: kisOrderNo,
      pending: !fillConfirmed,
      message: `${chain.stock_code} ${chain.total_quantity}주 ${fillConfirmed ? '매도 완료' : '매도 접수 (체결 대기)'}`,
    });
  } catch (err: any) {
    logger.error(`수동 매도 예외: ${err.message}`, { component: 'DASHBOARD' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── 종목코드 전량 매도 (복수 체인 일괄 청산) ──
sellRoutes.post('/sell-stock/:stockCode', async (c) => {
  const stockCode = c.req.param('stockCode');
  try {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const triggerSource: string = sanitizeTriggerSource(body.source);
    const sellReason: string = (body.reason as string) || 'CEO 수동 매도';
    // 서버 세션에서 모드 결정 (클라이언트 is_paper는 신뢰하지 않음)
    const isPaper: boolean = resolveRequestMode(c);
    const stockTradingMode = isPaper ? 'paper' : 'live';

    const { rows: openChains } = await getPool().query(
      `SELECT * FROM transaction_chains WHERE stock_code = $1 AND status != 'CLOSED' AND is_paper = $2 ORDER BY created_at ASC`,
      [stockCode, isPaper],
    );
    if (openChains.length === 0) {
      // DB에 체인 없음 — KIS 잔고 직접 확인 후 매도 (수동 매수 포지션 대응)
      if (!isPaper) {
        try {
          const balDirect = await getAccountBalance(true);
          const kisPos = balDirect.positions?.find((p: any) => p.stockCode === stockCode);
          if (kisPos && Number(kisPos.quantity) > 0) {
            const kisQty = Number(kisPos.quantity);
            let directResult = await runWithMode(false, () =>
              placeOrder({ stockCode, side: 'SELL', quantity: kisQty }),
            );
            if (!directResult.success) {
              await sleep(2000);
              directResult = await runWithMode(false, () => placeOrder({ stockCode, side: 'SELL', quantity: kisQty }));
            }
            if (!directResult.success) return c.json({ error: `KIS 매도 거부: ${directResult.message}` }, 502);
            invalidateBalanceCache();
            logger.info(`✅ KIS직접매도 완료 (수동보유): ${stockCode} ${kisQty}주`, { component: 'DASHBOARD' });
            return c.json({
              ok: true,
              orderNo: directResult.orderNo,
              message: `${stockCode} ${kisQty}주 매도 완료 (수동보유 직접매도)`,
            });
          }
        } catch (e: any) {
          logger.error(`KIS직접매도 실패 (${stockCode}): ${e.message}`, { component: 'DASHBOARD' });
        }
      }
      return c.json({ error: '보유 포지션이 없습니다' }, 404);
    }

    const totalQty = openChains.reduce((s: number, ch: any) => s + Number(ch.total_quantity || 0), 0);
    if (totalQty <= 0) return c.json({ error: '매도할 수량이 없습니다' }, 400);

    let fillPrice = 0;
    try {
      const px = await getCurrentPrice(stockCode);
      fillPrice = px.currentPrice;
    } catch {
      /* 시세 조회 실패 — 평단 폴백 */
    }
    if (fillPrice <= 0) {
      const firstAvg = openChains[0] ? Number(openChains[0].avg_buy_price ?? 0) : 0;
      if (firstAvg > 0) fillPrice = firstAvg;
    }

    const { withTransaction } = await import('../../../db/client.js');

    if (isPaper) {
      const fakeOrderNo = `P${Date.now().toString(36)}`;
      await withTransaction(async (tx) => {
        for (const chain of openChains) {
          const _bqty = Number(chain.total_quantity);
          const _bavg = Number(chain.avg_buy_price ?? 0);
          const _bprofit = fillPrice > 0 ? Math.round(fillPrice * _bqty * (1 - KR_FEE.SELL_FEE_PCT)) - Math.round(_bavg * _bqty) : 0;
          await tx.query(
            `UPDATE transaction_chains SET status='CLOSED', closed_at=NOW(), close_reason=$2, total_quantity=0,
              realized_pnl = realized_pnl + $3,
              pnl_pct = CASE WHEN $4 > 0 AND avg_buy_price > 0 THEN ROUND(((($4 - avg_buy_price) / avg_buy_price) * 100)::numeric, 2) ELSE pnl_pct END
             WHERE id=$1`,
            [chain.id, sellReason, _bprofit, fillPrice],
          );
          await tx.query(
            `INSERT INTO orders (chain_id,stock_code,side,order_type,quantity,price,filled_quantity,filled_price,kis_order_no,status,trading_mode,trigger_source,ai_reasoning)
             VALUES ($1,$2,'SELL','MARKET',$3,$4,$3,$4,$5,'FILLED',$6,$7,$8)`,
            [
              chain.id,
              stockCode,
              chain.total_quantity,
              fillPrice,
              fakeOrderNo,
              stockTradingMode,
              triggerSource,
              sellReason,
            ],
          );
        }
      });
      logger.info(
        `✅ 전량 매도 완료 (모의): ${stockCode} ${totalQty}주 [${triggerSource}] (${openChains.length}체인)`,
        { component: 'DASHBOARD' },
      );
      invalidateBalanceCache();
      hardInvalidateMode(isPaper);
      invalidateStockCache(stockCode).catch(() => {});
      return c.json({ ok: true, message: `${stockCode} ${totalQty}주 전량 매도 완료 (모의투자)` });
    }

    let kisOrderNo = '';
    try {
      let result = await runWithMode(isPaper, () => placeOrder({ stockCode, side: 'SELL', quantity: totalQty }));
      if (!result.success) {
        await sleep(2000);
        try {
          const { getAccountBalance } = await import('../../../kis/account.js');
          const bal = await getAccountBalance(true);
          const kisPos = bal.positions?.find((p: any) => p.stockCode === stockCode);
          if (!kisPos || kisPos.quantity === 0) {
            kisOrderNo = `FILLED_RETRY_${Date.now().toString(36)}`;
            result = { success: true } as any;
          }
        } catch {
          /* 잔고 조회 실패 시 원래대로 retry */
        }
        if (!result.success) {
          result = await runWithMode(isPaper, () => placeOrder({ stockCode, side: 'SELL', quantity: totalQty }));
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
      } else {
        throw kisErr;
      }
    }

    // 체결 확인: 잔고 조회로 매도 검증
    const isGhostSell = kisOrderNo.startsWith('GHOST_');
    let fillConfirmed = isGhostSell;
    if (!isGhostSell) {
      try {
        await sleep(2000);
        const bal2 = await getAccountBalance(true);
        const pos2 = bal2.positions?.find((p: any) => p.stockCode === stockCode);
        fillConfirmed = !pos2 || pos2.quantity === 0;
      } catch {
        fillConfirmed = true;
      }
    }

    await withTransaction(async (tx) => {
      for (const chain of openChains) {
        if (fillConfirmed) {
          const _lqty = Number(chain.total_quantity);
          const _lavg = Number(chain.avg_buy_price ?? 0);
          const _lprofit = fillPrice > 0 ? Math.round(fillPrice * _lqty * (1 - KR_FEE.SELL_FEE_PCT)) - Math.round(_lavg * _lqty) : 0;
          await tx.query(
            `UPDATE transaction_chains SET status='CLOSED', closed_at=NOW(), close_reason=$2, total_quantity=0,
              realized_pnl = realized_pnl + $3,
              pnl_pct = CASE WHEN $4 > 0 AND avg_buy_price > 0 THEN ROUND(((($4 - avg_buy_price) / avg_buy_price) * 100)::numeric, 2) ELSE pnl_pct END
             WHERE id=$1`,
            [chain.id, sellReason, _lprofit, fillPrice],
          );
        }
        await tx.query(
          `INSERT INTO orders (chain_id,stock_code,side,order_type,quantity,price,filled_quantity,filled_price,kis_order_no,status,trading_mode,trigger_source,ai_reasoning)
           VALUES ($1,$2,'SELL','MARKET',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            chain.id,
            stockCode,
            chain.total_quantity,
            fillPrice,
            fillConfirmed ? chain.total_quantity : 0,
            fillConfirmed ? fillPrice : 0,
            kisOrderNo,
            fillConfirmed ? 'FILLED' : 'PENDING',
            stockTradingMode,
            triggerSource,
            sellReason,
          ],
        );
      }
    });

    logger.info(
      `${fillConfirmed ? '✅' : '⏳'} 전량 매도 ${fillConfirmed ? '완료' : '접수(체결대기)'}: ${stockCode} ${totalQty}주 [${triggerSource}] (${openChains.length}체인, ${kisOrderNo})`,
      { component: 'DASHBOARD' },
    );
    try {
      const avgBuy =
        openChains.reduce((s: number, c: any) => s + Number(c.avg_buy_price || 0) * Number(c.total_quantity || 0), 0) /
        totalQty;
      const pnlPct = avgBuy > 0 ? ((fillPrice - avgBuy) / avgBuy) * 100 : 0;
      await notifySell(stockCode, totalQty, fillPrice, pnlPct, sellReason, undefined, isPaper);
    } catch {
      /* 알림 실패 무시 */
    }
    invalidateBalanceCache();
    hardInvalidateMode(isPaper);
    invalidateStockCache(stockCode).catch(() => {});
    return c.json({
      ok: true,
      orderNo: kisOrderNo,
      pending: !fillConfirmed,
      message: `${stockCode} ${totalQty}주 ${fillConfirmed ? '전량 매도 완료' : '매도 접수 (체결 대기)'}`,
    });
  } catch (err: any) {
    logger.error(`전량 매도 예외 (${stockCode}): ${err.message}`, { component: 'DASHBOARD' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// 해외매도(/sell-overseas/*) → overseas-sell.ts
// 수동매수(/manual-buy) → manual-buy.ts
