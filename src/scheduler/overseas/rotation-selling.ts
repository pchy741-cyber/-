/**
 * 순환 매도 — 현금 부족 시 집중 포지션 일부 청산하여 신규 진입 재원 확보
 */
import { OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { updateTradeState, cleanupPositionState } from './state.js';
import { executeOverseasOrder } from './executor.js';
import { calcPositionSize } from './position-sizing.js';
import type { TechResult, Holding } from './sell-logic.js';
import type { BuyTarget } from './buy-filter.js';
import type { RegimeAdjustment } from './vix-regime.js';
import type { KellyResult, GradualCooldown } from './types.js';

export async function executeRotationSelling(params: {
  topTarget: BuyTarget;
  updatedHoldings: Map<string, Holding>;
  techResults: TechResult[];
  pendingOrderStocks: Set<string>;
  sellOrders: string[];
  cash: number;
  portfolioValue: number;
  kellyResult: KellyResult;
  vixRegime: RegimeAdjustment;
  gradualCooldown: GradualCooldown;
  isPaper: boolean;
}): Promise<{ cash: number }> {
  const { topTarget, updatedHoldings, techResults, sellOrders, isPaper,
          portfolioValue, kellyResult, vixRegime, gradualCooldown } = params;
  let { cash } = params;

  const neededCash = calcPositionSize({
    target: topTarget, portfolioValue, kellyResult, vixRegime, gradualCooldown,
    cash, isPaper, evMultiplier: 1.0, mtfBonus: 0,
  }).positionSize;

  if (cash >= neededCash) return { cash };

  const concKey = isPaper ? 'p_concentration_code' : 'l_concentration_code';
  const { rows: ccRows } = await getPool().query("SELECT value FROM overseas_state WHERE key = $1", [concKey]).catch(() => ({ rows: [] as { value: string }[] }));
  const concentrationCode = ccRows[0]?.value ?? null;
  if (!concentrationCode || concentrationCode === topTarget.code) return { cash };

  const concHolding = updatedHoldings.get(concentrationCode);
  const concTech = techResults.find(t => t.code === concentrationCode);
  if (!concHolding || !concTech || concTech.price.currentPrice <= 0 || concHolding.qty < 2) return { cash };

  const concPnlPct = concHolding.avgPrice > 0 ? ((concTech.price.currentPrice - concHolding.avgPrice) / concHolding.avgPrice) * 100 : 0;
  if (concPnlPct <= 0) return { cash };

  const shortfall = neededCash - cash;
  const maxSellQty = Math.floor(concHolding.qty / 2);
  const sellQty = Math.min(Math.ceil(shortfall / concTech.price.currentPrice), maxSellQty);
  if (sellQty < 1) return { cash };

  const rotateReason = `순환매도: ${topTarget.code} 진입 재원 (집중포지션 +${concPnlPct.toFixed(1)}% 일부 청산)`;
  const exec = await executeOverseasOrder(concentrationCode, 'SELL', sellQty, concTech.price.currentPrice, concTech.exchange, rotateReason, concHolding.qty, concHolding.avgPrice, { isPaper });
  if (exec.submitted && exec.filledQty > 0) {
    const proceeds = exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
    cash += proceeds;
    await updateTradeState({ code: concentrationCode, exchange: concTech.exchange, qty: exec.finalQty, avgPrice: exec.finalAvgPrice, newCash: cash, isPaper });
    if (exec.finalQty <= 0) { await cleanupPositionState(concentrationCode, isPaper); }
    sellOrders.push(`🔄 순환매도 ${concentrationCode} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (+${concPnlPct.toFixed(1)}%) → ${topTarget.code} 진입 재원 $${proceeds.toFixed(0)}`);
  }
  return { cash };
}
