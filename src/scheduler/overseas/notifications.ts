/**
 * 장외시간 텔레그램 알림 — 매수/매도 추천
 * overseas-job.ts에서 추출
 */

import { fetchExchangeRate } from '../../automation/macro-data.js';
import { getOverseasDynamic } from '../../config/constants.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import type { BuyTarget } from './buy-filter.js';
import type { Holding, TechResult } from './sell-logic.js';

import type { AIDecision, KellyResult } from './types.js';

export interface ExtendedAlertContext {
  buyTargets: BuyTarget[];
  aiMap: Map<string, AIDecision>;
  kellyResult: KellyResult;
  portfolioValue: number;
  cash: number;
  extendedAlertSentAt: Map<string, number>;
  updatedHoldings: Map<string, Holding>;
  techResults: TechResult[];
  usdKrw?: number;
}

/**
 * 장외시간 매수 추천 알림 (상위 3종목 + 보유종목 현황)
 */
export async function sendBuyRecommendations(ctx: ExtendedAlertContext): Promise<void> {
  const { buyTargets, aiMap, kellyResult, portfolioValue, cash, extendedAlertSentAt, updatedHoldings, techResults } =
    ctx;

  if (buyTargets.length === 0) return;

  const now = Date.now();
  const usdKrw = ctx.usdKrw ?? (await fetchExchangeRate());
  const alertTargets = buyTargets
    .filter((t) => !extendedAlertSentAt.has(t.code) || now - (extendedAlertSentAt.get(t.code) ?? 0) > 60 * 60_000)
    .slice(0, 3);

  const holdingSells: string[] = [];
  for (const [code, h] of updatedHoldings) {
    const tech = techResults.find((t) => t.code === code);
    if (!tech) continue;
    const pnl = ((tech.price.currentPrice - h.avgPrice) / h.avgPrice) * 100;
    const posVal = tech.price.currentPrice * h.qty;
    const weightPct = portfolioValue > 0 ? ((posVal / portfolioValue) * 100).toFixed(1) : '0';
    if (pnl >= 3.0)
      holdingSells.push(
        `  🟢 *${code}* +${pnl.toFixed(1)}% @$${tech.price.currentPrice.toFixed(2)} | ${h.qty}주 $${posVal.toFixed(0)}(₩${((posVal * usdKrw) / 10000).toFixed(1)}만) 비중${weightPct}%`,
      );
    else if (pnl <= -5.0)
      holdingSells.push(
        `  🔴 *${code}* ${pnl.toFixed(1)}% @$${tech.price.currentPrice.toFixed(2)} | ${h.qty}주 손실$${(Math.abs(tech.price.currentPrice - h.avgPrice) * h.qty).toFixed(0)} → 손절검토`,
      );
  }

  const alertLines = [
    `🌙 *장외시간 매매 추천*`,
    '',
    `📌 *매수 추천* (한국투자증권 앱에서 지정가 주문)`,
    ...alertTargets.map((t, i) => {
      const ai = aiMap.get(t.code);
      const conf = ai?.confidence ? `${(ai.confidence * 100).toFixed(0)}%` : '-';
      const chg = t.price.changePct >= 0 ? `+${t.price.changePct.toFixed(1)}%` : `${t.price.changePct.toFixed(1)}%`;
      const reason = t.isBigMover ? '갭업 모멘텀' : t.price.changePct <= -3 ? '급락 줍줍' : '기술적 매수';
      const kPct = kellyResult.sampleCount >= 10 ? kellyResult.halfKelly : 0.2;
      const recSize = Math.min(portfolioValue * Math.min(kPct, 0.25), cash * 0.7);
      const recQty = Math.max(1, Math.floor(recSize / (t.price.currentPrice * 1.0025)));
      const recCost = recQty * t.price.currentPrice;
      const limitPrice = (t.price.currentPrice * (t.price.changePct <= -3 ? 1.005 : 0.995)).toFixed(2);
      return [
        `  ${i + 1}. *${t.code}* AI:${conf} — ${reason}`,
        `     현재가: $${t.price.currentPrice.toFixed(2)} (${chg})`,
        `     추천: *${recQty}주* 지정가 *$${limitPrice}*`,
        `     금액: $${recCost.toFixed(0)} (₩${((recCost * usdKrw) / 10000).toFixed(1)}만)`,
      ].join('\n');
    }),
  ];
  if (holdingSells.length > 0) alertLines.push('', '📋 *보유종목 현황*', ...holdingSells);
  const holdVal = Array.from(updatedHoldings.values()).reduce((s, h) => s + h.qty * h.avgPrice, 0);
  const dynMaxPos = getOverseasDynamic(cash + holdVal).maxPositions;
  alertLines.push(
    '',
    `💰 현금: $${cash.toFixed(0)}(₩${((cash * usdKrw) / 10000).toFixed(0)}만) | 보유: ${updatedHoldings.size}/${dynMaxPos}`,
  );
  alertLines.push('', '⏰ 정규장 KST 22:30 — 그 전에 한투앱 지정가 예약 가능');
  if (alertTargets.length > 0 || holdingSells.length > 0) {
    await sendTelegramMessage(alertLines.join('\n'));
    alertTargets.forEach((t) => {
      extendedAlertSentAt.set(t.code, Date.now());
    });
  }
}

/**
 * 장외시간 보유종목 급변 알림 (익절/손절 추천)
 */
export async function sendHoldingAlerts(ctx: {
  extendedAlertSentAt: Map<string, number>;
  updatedHoldings: Map<string, Holding>;
  techResults: TechResult[];
  usdKrw?: number;
}): Promise<void> {
  const { extendedAlertSentAt, updatedHoldings, techResults } = ctx;
  const now = Date.now();
  const usdKrwSell = ctx.usdKrw ?? (await fetchExchangeRate());

  for (const [code, h] of updatedHoldings) {
    if (extendedAlertSentAt.has(`sell_${code}`) && now - (extendedAlertSentAt.get(`sell_${code}`) ?? 0) < 60 * 60_000)
      continue;
    const tech = techResults.find((t) => t.code === code);
    if (!tech || tech.price.currentPrice <= 0) continue;
    const pnl = ((tech.price.currentPrice - h.avgPrice) / h.avgPrice) * 100;
    const profitUsd = (tech.price.currentPrice - h.avgPrice) * h.qty;
    const profitKrw = profitUsd * usdKrwSell;

    if (pnl >= 5.0) {
      const sellQty = pnl >= 20 ? h.qty : Math.max(1, Math.ceil(h.qty * 0.5));
      const sellAmt = sellQty * tech.price.currentPrice;
      await sendTelegramMessage(
        [
          `🌙💰 *장외 익절 추천!*`,
          ``,
          `*${code}* +${pnl.toFixed(1)}%`,
          `현재가: $${tech.price.currentPrice.toFixed(2)} (매수가: $${h.avgPrice.toFixed(2)})`,
          `수익: $${profitUsd.toFixed(0)} (₩${(profitKrw / 10000).toFixed(1)}만)`,
          ``,
          `📌 추천: *${sellQty}주 매도* 지정가 $${(tech.price.currentPrice * 0.998).toFixed(2)}`,
          `금액: $${sellAmt.toFixed(0)} (₩${((sellAmt * usdKrwSell) / 10000).toFixed(1)}만)`,
          ``,
          `한투앱 → 해외주식 → ${code} → 매도`,
        ].join('\n'),
      );
      extendedAlertSentAt.set(`sell_${code}`, now);
    }
    if (pnl <= -8.0) {
      await sendTelegramMessage(
        [
          `🌙🚨 *장외 손절 경고!*`,
          ``,
          `*${code}* ${pnl.toFixed(1)}%`,
          `현재가: $${tech.price.currentPrice.toFixed(2)} (매수가: $${h.avgPrice.toFixed(2)})`,
          `손실: $${Math.abs(profitUsd).toFixed(0)} (₩${(Math.abs(profitKrw) / 10000).toFixed(1)}만)`,
          ``,
          `📌 추천: *전량 ${h.qty}주 손절* 시장가`,
          ``,
          `한투앱 → 해외주식 → ${code} → 매도`,
        ].join('\n'),
      );
      extendedAlertSentAt.set(`sell_${code}`, now);
    }
  }
}
