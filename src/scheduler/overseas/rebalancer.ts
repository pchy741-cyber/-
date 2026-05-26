/**
 * 포트폴리오 비중 리밸런싱 추천/실행
 * 균등 비중 목표 대비 5%+ 초과 종목 → 매도 추천(Live) 또는 자동 매도(Paper)
 */
import { OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { fetchExchangeRate } from '../../automation/macro-data.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';
import { getCash, getHoldings, updateTradeState } from './state.js';
import { executeOverseasOrder } from './executor.js';
import type { TechResult } from './sell-logic.js';

export interface RebalanceContext {
  techResults: TechResult[];
  isPaper: boolean;
  sellOrders: string[];
  extendedAlertSentAt: Map<string, number>;
}

export interface RebalanceResult {
  rebalanceAlerts: string[];
  cash: number;
}

export async function rebalancePortfolio(ctx: RebalanceContext): Promise<RebalanceResult> {
  const { techResults, isPaper, sellOrders, extendedAlertSentAt } = ctx;
  const rebalanceAlerts: string[] = [];

  try {
    let cash = await getCash(isPaper);
    const rbHoldings = await getHoldings(isPaper);
    let rbTotal = cash;
    const positionWeights: { code: string; weight: number; value: number; qty: number; price: number; pnl: number; exchange: string }[] = [];

    for (const [code, h] of rbHoldings) {
      const tech = techResults.find(t => t.code === code);
      const curPrice = tech?.price.currentPrice ?? h.avgPrice;
      const posVal = curPrice * h.qty;
      rbTotal += posVal;
      const pnl = ((curPrice - h.avgPrice) / h.avgPrice) * 100;
      positionWeights.push({ code, weight: 0, value: posVal, qty: h.qty, price: curPrice, pnl, exchange: h.exchange });
    }
    for (const p of positionWeights) p.weight = rbTotal > 0 ? (p.value / rbTotal) * 100 : 0;

    const targetCashPct = 15;
    const holdingCount = positionWeights.length;
    const targetWeightPer = holdingCount > 0 ? (100 - targetCashPct) / holdingCount : 0;
    const actualCashPct = rbTotal > 0 ? (cash / rbTotal) * 100 : 100;
    const usdKrw = await fetchExchangeRate();

    const overweightThreshold = 5.0;
    const overweight = positionWeights.filter(p => p.weight > targetWeightPer + overweightThreshold);

    if (overweight.length > 0 || (actualCashPct < 5 && holdingCount >= 3)) {
      const rbLines: string[] = [`📊 *포트폴리오 비중 리밸런싱 추천*`, ''];
      rbLines.push(`총자산: $${rbTotal.toFixed(0)} (₩${(rbTotal * usdKrw / 10000).toFixed(0)}만) | 현금: ${actualCashPct.toFixed(1)}%`);
      rbLines.push(`목표 비중: 종목당 ${targetWeightPer.toFixed(1)}% | 현금 ${targetCashPct}%`);
      rbLines.push('');

      for (const p of positionWeights.sort((a, b) => b.weight - a.weight)) {
        const tag = p.weight > targetWeightPer + overweightThreshold ? '⚠️과다' : p.weight < targetWeightPer - overweightThreshold ? '⬇️부족' : '✅적정';
        rbLines.push(`  ${tag} *${p.code}* ${p.weight.toFixed(1)}% ($${p.value.toFixed(0)}) ${p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(1)}%`);
      }

      if (overweight.length > 0) {
        rbLines.push('', '📌 *조정 추천* (1% 단위)');
        for (const p of overweight) {
          const excessPct = p.weight - targetWeightPer;
          const adjustPct = Math.min(excessPct, Math.ceil(excessPct));
          const trimValue = rbTotal * (adjustPct / 100);
          const trimQty = Math.max(1, Math.floor(trimValue / p.price));
          const trimAmt = trimQty * p.price;

          if (!isPaper) {
            rbLines.push(`  매도 *${p.code}* ${trimQty}주 @$${p.price.toFixed(2)} → $${trimAmt.toFixed(0)}(₩${(trimAmt * usdKrw / 10000).toFixed(1)}만)`);
            rbLines.push(`  → 비중 ${p.weight.toFixed(1)}% → ~${(p.weight - adjustPct).toFixed(1)}%`);
          } else {
            const exec = await executeOverseasOrder(p.code, 'SELL', trimQty, p.price, p.exchange, `리밸런싱: 비중 ${p.weight.toFixed(1)}% → ${(p.weight - adjustPct).toFixed(1)}%`, p.qty, 0, { isPaper });
            if (exec.submitted && exec.filledQty > 0) {
              const proceeds = exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
              cash += proceeds;
              await updateTradeState({ code: p.code, exchange: p.exchange, qty: exec.finalQty, avgPrice: exec.finalAvgPrice, newCash: cash, isPaper });
              sellOrders.push(`📊 리밸런싱 ${p.code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (비중 ${p.weight.toFixed(1)}%→${(p.weight - adjustPct).toFixed(1)}%)`);
            }
          }
        }
      }

      if (!isPaper && overweight.length > 0) {
        rbLines.push('', '⚡ 실전모드 — 한투앱에서 직접 주문하세요');
        const rbAlertKey = 'rebalance_alert';
        const lastRb = extendedAlertSentAt.get(rbAlertKey) ?? 0;
        if (Date.now() - lastRb > 30 * 60_000) {
          await sendTelegramMessage(rbLines.join('\n'));
          extendedAlertSentAt.set(rbAlertKey, Date.now());
        }
      }
      rebalanceAlerts.push(...overweight.map(p => `📊 리밸런싱 추천: ${p.code} ${p.weight.toFixed(1)}%→${targetWeightPer.toFixed(1)}%`));
    }

    return { rebalanceAlerts, cash };
  } catch (rbErr) {
    logger.warn(`포트폴리오 리밸런싱 분석 실패: ${(rbErr as Error).message}`, { component: 'OVERSEAS' });
    return { rebalanceAlerts, cash: await getCash(isPaper) };
  }
}
