/**
 * 선물 자동 실행 — 진입/청산/TP-SL 모니터링
 * 완전 격리: 별도 budget 테이블, feature flag 필수
 */
import { getPool } from '../../db/client.js';
import { getCtxIsPaper } from '../../config/context.js';
import { getFuturesPrice, placeFuturesOrder, MICRO_FUTURES } from '../../kis/futures.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';
import { scanFuturesSignals, calcFuturesTPSL, calcFuturesQty } from './signal-generator.js';
import type { FuturesAutoConfig } from './types.js';

const COMP = 'FUTURES';

/** 선물 설정 로드 (feature flag + budget) */
export async function loadFuturesConfig(): Promise<FuturesAutoConfig> {
  const { rows: flagRows } = await getPool().query(
    "SELECT enabled FROM feature_flags WHERE key = 'overseas_futures'",
  );
  const { rows: budgetRows } = await getPool().query(
    'SELECT * FROM futures_budget WHERE id = 1',
  );
  const budget = budgetRows[0];
  return {
    enabled: flagRows[0]?.enabled === true,
    maxContracts: 5,
    maxBudgetKrw: Number(budget?.max_budget_krw ?? 100000),
    allocatedKrw: Number(budget?.allocated_krw ?? 0),
    totalPnlUsd: Number(budget?.total_pnl_usd ?? 0),
  };
}

/** 오픈 포지션 TP/SL 모니터링 → 자동 청산 */
export async function monitorFuturesTPSL(): Promise<void> {
  const isPaper = getCtxIsPaper();
  const { rows: openPositions } = await getPool().query(
    'SELECT * FROM futures_positions WHERE status = $1 AND is_paper = $2',
    ['open', isPaper],
  );

  for (const pos of openPositions) {
    try {
      const price = await getFuturesPrice(pos.symbol);
      if (!price) continue;

      const current = price.price;
      const spec = MICRO_FUTURES.find(m => m.product === pos.product);
      const multiplier = spec ? spec.tickValue / spec.tickSize : 5;
      const direction = pos.side === 'LONG' ? 1 : -1;
      const pnl = direction * (current - Number(pos.entry_price)) * multiplier * Number(pos.quantity);

      // TP/SL 체크
      let shouldClose = false;
      let closeReason = '';
      const tp = pos.tp_price ? Number(pos.tp_price) : null;
      const sl = pos.sl_price ? Number(pos.sl_price) : null;

      if (tp && pos.side === 'LONG' && current >= tp) {
        shouldClose = true; closeReason = `TP($${current}>=$${tp})`;
      } else if (tp && pos.side === 'SHORT' && current <= tp) {
        shouldClose = true; closeReason = `TP($${current}<=$${tp})`;
      } else if (sl && pos.side === 'LONG' && current <= sl) {
        shouldClose = true; closeReason = `SL($${current}<=$${sl})`;
      } else if (sl && pos.side === 'SHORT' && current >= sl) {
        shouldClose = true; closeReason = `SL($${current}>=$${sl})`;
      }

      if (shouldClose) {
        await closeFuturesPosition(pos, current, pnl, closeReason, isPaper);
      } else {
        await getPool().query(
          'UPDATE futures_positions SET current_price = $1, pnl_usd = $2 WHERE id = $3',
          [current, pnl, pos.id],
        );
      }
    } catch (e: any) {
      logger.warn(`선물 모니터 실패 ${pos.symbol}: ${e.message}`, { component: COMP });
    }
  }
}

/** 포지션 청산 실행 */
async function closeFuturesPosition(
  pos: any, closePrice: number, pnl: number, reason: string, isPaper: boolean,
): Promise<void> {
  logger.info(`선물 자동청산: ${pos.symbol} ${pos.side} PnL=$${pnl.toFixed(2)} — ${reason}`, { component: COMP });

  if (!isPaper) {
    const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
    await placeFuturesOrder({
      symbol: pos.symbol, side: closeSide as 'BUY' | 'SELL',
      quantity: Number(pos.quantity), orderType: 'MARKET',
    });
  }

  await getPool().query(
    `UPDATE futures_positions SET status = 'closed', current_price = $1, pnl_usd = $2, closed_at = NOW() WHERE id = $3`,
    [closePrice, pnl, pos.id],
  );

  const closeSideLabel = pos.side === 'LONG' ? 'SELL' : 'BUY';
  await getPool().query(
    `INSERT INTO futures_trades (symbol, product, exchange, side, quantity, price, pnl_usd, reason, is_paper)
     VALUES ($1, $2, 'CME', $3, $4, $5, $6, $7, $8)`,
    [pos.symbol, pos.product, closeSideLabel, pos.quantity, closePrice, pnl, reason, isPaper],
  );

  await getPool().query(
    'UPDATE futures_budget SET total_pnl_usd = total_pnl_usd + $1 WHERE id = 1',
    [pnl],
  );

  const emoji = pnl >= 0 ? '🟢' : '🔴';
  await sendTelegramMessage(
    `${emoji} *선물 자동청산*\n${pos.symbol} ${pos.side} ${pos.quantity}계약\nPnL: $${pnl.toFixed(2)}\n사유: ${reason}`,
  );
}

/** 신규 진입 실행 (최고 confidence 신호) */
export async function executeFuturesEntry(config: FuturesAutoConfig): Promise<void> {
  const isPaper = getCtxIsPaper();
  // 최대 2 오픈 포지션
  const { rows: openCount } = await getPool().query(
    'SELECT COUNT(*) AS cnt FROM futures_positions WHERE status = $1 AND is_paper = $2',
    ['open', isPaper],
  );
  if (Number(openCount[0].cnt) >= 2) return;

  const signals = await scanFuturesSignals();
  if (signals.length === 0) return;

  const best = signals.sort((a, b) => b.confidence - a.confidence)[0];
  const spec = MICRO_FUTURES.find(m => m.product === best.product);
  if (!spec) return;

  const qty = await calcFuturesQty({
    allocatedKrw: config.allocatedKrw,
    marginPerContract: spec.marginApprox,
  });
  if (qty <= 0) return;

  const price = await getFuturesPrice(best.symbol);
  if (!price) return;

  const tpsl = calcFuturesTPSL({
    entryPrice: price.price,
    direction: best.direction,
    atrPct: best.atrPct,
  });

  const side = best.direction === 'LONG' ? 'BUY' : 'SELL';
  let orderNo = `FA${Date.now().toString(36)}`;

  if (!isPaper) {
    const result = await placeFuturesOrder({
      symbol: best.symbol, side: side as 'BUY' | 'SELL',
      quantity: qty, orderType: 'MARKET',
    });
    if (!result.success) {
      logger.warn(`선물 자동진입 실패: ${result.message}`, { component: COMP });
      return;
    }
    orderNo = result.orderNo || orderNo;
  }

  await getPool().query(
    `INSERT INTO futures_positions (symbol, product, exchange, side, quantity, entry_price, current_price, tp_price, sl_price, order_no, is_paper)
     VALUES ($1, $2, 'CME', $3, $4, $5, $5, $6, $7, $8, $9)`,
    [best.symbol, best.product, best.direction, qty, price.price, tpsl.tpPrice, tpsl.slPrice, orderNo, isPaper],
  );

  await sendTelegramMessage(
    `📈 *선물 자동진입*\n${best.symbol} ${best.direction} ${qty}계약 @$${price.price}\n` +
    `TP: $${tpsl.tpPrice}(+${tpsl.tpPct.toFixed(1)}%) | SL: $${tpsl.slPrice}(-${tpsl.slPct.toFixed(1)}%)\n` +
    `사유: ${best.reason} (conf=${best.confidence}%)`,
  );
}
