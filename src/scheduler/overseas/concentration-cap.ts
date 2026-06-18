/**
 * 집중도 캡 — 단일 종목 비중 25% 초과 시 강제 분산 매도
 */
import { OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { logger } from '../../utils/logger.js';
import { executeOverseasOrder } from './executor.js';
import type { TechResult } from './sell-logic.js';
import { cleanupPositionState, getHoldings, updateTradeState } from './state.js';

export async function enforceConcentrationCap(params: {
  portfolioValue: number;
  pendingOrderStocks: Set<string>;
  techResults: TechResult[];
  sellOrders: string[];
  cash: number;
  isPaper: boolean;
}): Promise<{ cash: number }> {
  const { portfolioValue, pendingOrderStocks, techResults, sellOrders, isPaper } = params;
  let { cash } = params;

  if (portfolioValue < 500) return { cash };

  const CONC_CAP = 0.25;
  const CONC_TARGET = 0.2;
  const capHoldings = await getHoldings(isPaper);

  for (const [capCode, capHolding] of capHoldings) {
    if (pendingOrderStocks.has(capCode)) continue;
    const capTech = techResults.find((t) => t.code === capCode);
    if (!capTech || capTech.price.currentPrice <= 0) continue;
    const posValue = capTech.price.currentPrice * capHolding.qty;
    const posWeight = posValue / portfolioValue;
    if (posWeight <= CONC_CAP) continue;
    // 🛡️ 강화: 손실 중이면 집중도 캡 보류 (손실 확정 방지 — VRT -0.22% 강제매도 사례)
    //   손실 규모 무관하게 회복 대기 → 수익 구간 진입 후 정상 분산
    const pnlPctAtSell = ((capTech.price.currentPrice - capHolding.avgPrice) / capHolding.avgPrice) * 100;
    if (pnlPctAtSell < 0) {
      logger.info(
        `⏸️ 집중도 캡 보류: ${capCode} 비중 ${(posWeight * 100).toFixed(0)}% > 25%이나 PnL ${pnlPctAtSell.toFixed(1)}% (손실 중) → 수익 전환 후 재평가`,
        { component: 'OVERSEAS' },
      );
      continue;
    }
    const targetQty = Math.floor((portfolioValue * CONC_TARGET) / capTech.price.currentPrice);
    const sellQty = capHolding.qty - targetQty;
    if (sellQty < 1) continue;
    logger.warn(`⚠️ 집중도 캡 발동: ${capCode} 비중 ${(posWeight * 100).toFixed(0)}% > 25% → ${sellQty}주 매도`, {
      component: 'OVERSEAS',
    });
    const exec = await executeOverseasOrder(
      capCode,
      'SELL',
      sellQty,
      capTech.price.currentPrice,
      capTech.exchange,
      `집중도 캡(${(posWeight * 100).toFixed(0)}% > 25%) — 20%로 강제 분산 매도`,
      capHolding.qty,
      capHolding.avgPrice,
      { isPaper },
    );
    if (exec.submitted && exec.filledQty > 0) {
      const proceeds = exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
      cash += proceeds;
      await updateTradeState({
        code: capCode,
        exchange: capTech.exchange,
        qty: exec.finalQty,
        avgPrice: exec.finalAvgPrice,
        newCash: cash,
        isPaper,
      });
      if (exec.finalQty <= 0) {
        await cleanupPositionState(capCode, isPaper);
      }
      sellOrders.push(
        `⚠️ 집중캡 매도 ${capCode} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (비중 ${(posWeight * 100).toFixed(0)}% → 20%, +$${proceeds.toFixed(0)} 회수)`,
      );
    }
  }
  return { cash };
}
