/**
 * 포트폴리오 비중 리밸런싱 추천/실행
 * 균등 비중 목표 대비 5%+ 초과 종목 → 매도 추천(Live) 또는 자동 매도(Paper)
 */

import { fetchExchangeRate } from '../../automation/macro-data.js';
import { OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';
import { executeOverseasOrder } from './executor.js';
import type { TechResult } from './sell-logic.js';
import { getHoldings, updateTradeState } from './state.js';

export interface RebalanceContext {
  techResults: TechResult[];
  isPaper: boolean;
  sellOrders: string[];
  extendedAlertSentAt: Map<string, number>;
  cash: number; // caller의 추적 중인 현금 (이중 재조회 방지)
}

export interface RebalanceResult {
  rebalanceAlerts: string[];
  cash: number;
}

export async function rebalancePortfolio(ctx: RebalanceContext): Promise<RebalanceResult> {
  const { techResults, isPaper, sellOrders, extendedAlertSentAt } = ctx;
  const rebalanceAlerts: string[] = [];

  try {
    let cash = ctx.cash;
    const rbHoldings = await getHoldings(isPaper);
    let rbTotal = cash;
    const positionWeights: {
      code: string;
      weight: number;
      value: number;
      qty: number;
      price: number;
      pnl: number;
      exchange: string;
      avgPrice: number;
    }[] = [];

    for (const [code, h] of rbHoldings) {
      const tech = techResults.find((t) => t.code === code);
      const curPrice = tech?.price.currentPrice ?? h.avgPrice;
      const posVal = curPrice * h.qty;
      rbTotal += posVal;
      const pnl = ((curPrice - h.avgPrice) / h.avgPrice) * 100;
      positionWeights.push({
        code,
        weight: 0,
        value: posVal,
        qty: h.qty,
        price: curPrice,
        pnl,
        exchange: h.exchange,
        avgPrice: h.avgPrice,
      });
    }
    for (const p of positionWeights) p.weight = rbTotal > 0 ? (p.value / rbTotal) * 100 : 0;

    const targetCashPct = 15;
    const holdingCount = positionWeights.length;
    const targetWeightPer = holdingCount > 0 ? (100 - targetCashPct) / holdingCount : 0;
    const actualCashPct = rbTotal > 0 ? (cash / rbTotal) * 100 : 100;
    const usdKrw = await fetchExchangeRate();

    // 소액 포트폴리오($5000 미만): 1주=큰 비중이므로 리밸런싱 문턱 완화
    const isSmallPortfolio = rbTotal < 5000;
    const overweightThreshold = isSmallPortfolio ? 15.0 : 5.0;
    // $3000 미만: 리밸런싱 자체가 무의미 (수수료 대비 효과 없음)
    if (rbTotal < 3000) return { rebalanceAlerts, cash };
    const overweight = positionWeights.filter((p) => p.weight > targetWeightPer + overweightThreshold);

    if (overweight.length > 0 || (actualCashPct < 5 && holdingCount >= 3)) {
      const rbLines: string[] = [`📊 *포트폴리오 비중 리밸런싱 추천*`, ''];
      rbLines.push(
        `총자산: $${rbTotal.toFixed(0)} (₩${((rbTotal * usdKrw) / 10000).toFixed(0)}만) | 현금: ${actualCashPct.toFixed(1)}%`,
      );
      rbLines.push(`목표 비중: 종목당 ${targetWeightPer.toFixed(1)}% | 현금 ${targetCashPct}%`);
      rbLines.push('');

      for (const p of positionWeights.sort((a, b) => b.weight - a.weight)) {
        const tag =
          p.weight > targetWeightPer + overweightThreshold
            ? '⚠️과다'
            : p.weight < targetWeightPer - overweightThreshold
              ? '⬇️부족'
              : '✅적정';
        rbLines.push(
          `  ${tag} *${p.code}* ${p.weight.toFixed(1)}% ($${p.value.toFixed(0)}) ${p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(1)}%`,
        );
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
            rbLines.push(
              `  매도 *${p.code}* ${trimQty}주 @$${p.price.toFixed(2)} → $${trimAmt.toFixed(0)}(₩${((trimAmt * usdKrw) / 10000).toFixed(1)}만)`,
            );
            rbLines.push(`  → 비중 ${p.weight.toFixed(1)}% → ~${(p.weight - adjustPct).toFixed(1)}%`);
          } else {
            // 수수료(왕복 ~0.7%) 커버 불가 시 리밸런싱 매도 금지
            const minPnlPct = OVERSEAS_FEE_PCT * 2 * 100 + 0.5; // ~1.2%
            if (p.pnl < minPnlPct) {
              rebalanceAlerts.push(
                `📊 리밸런싱 스킵 ${p.code}: PnL ${p.pnl.toFixed(1)}% < 최소 ${minPnlPct.toFixed(1)}% (수수료 미달)`,
              );
              continue;
            }
            const exec = await executeOverseasOrder(
              p.code,
              'SELL',
              trimQty,
              p.price,
              p.exchange,
              `리밸런싱: 비중 ${p.weight.toFixed(1)}% → ${(p.weight - adjustPct).toFixed(1)}%`,
              p.qty,
              p.avgPrice,
              { isPaper },
            );
            if (exec.submitted && exec.filledQty > 0) {
              const proceeds = exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
              cash += proceeds;
              await updateTradeState({
                code: p.code,
                exchange: p.exchange,
                qty: exec.finalQty,
                avgPrice: exec.finalAvgPrice,
                newCash: cash,
                isPaper,
              });
              sellOrders.push(
                `📊 리밸런싱 ${p.code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (비중 ${p.weight.toFixed(1)}%→${(p.weight - adjustPct).toFixed(1)}%)`,
              );
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
      rebalanceAlerts.push(
        ...overweight.map((p) => `📊 리밸런싱 추천: ${p.code} ${p.weight.toFixed(1)}%→${targetWeightPer.toFixed(1)}%`),
      );
    }

    // ── 패자→승자 로테이션 (Paper 자동 / Live 추천) ──
    // -3% 이하 패자 → 기술적 강세인 승자로 자금 이동
    const LOSER_THRESHOLD = -3.0; // 패자 기준: -3% 이하
    const WINNER_MIN_PNL = 1.0; // 승자 기준: +1% 이상
    const MIN_HOLD_DAYS_FOR_ROTATION = 1; // 최소 보유기간 1일 (당일 매수 즉시 로테이션 방지)

    const losers = positionWeights
      .filter((p) => {
        if (p.pnl >= LOSER_THRESHOLD) return false;
        // 보유기간 체크
        const holding = rbHoldings.get(p.code);
        if (!holding) return false;
        const holdDays = (Date.now() - new Date(holding.boughtAt).getTime()) / (1000 * 60 * 60 * 24);
        if (holdDays < MIN_HOLD_DAYS_FOR_ROTATION) return false;
        // 이미 매도 주문 나간 종목 제외
        if (sellOrders.some((o) => o.includes(p.code))) return false;
        return true;
      })
      .sort((a, b) => a.pnl - b.pnl); // 가장 나쁜 순

    const winners = positionWeights
      .filter((p) => {
        if (p.pnl < WINNER_MIN_PNL) return false;
        const tech = techResults.find((t) => t.code === p.code);
        if (!tech) return false;
        // 기술적 강세: score > 0 또는 MA20 위 또는 모멘텀
        return tech.score > 0 || tech.aboveMA20 || tech.isMomentum;
      })
      .sort((a, b) => b.pnl - a.pnl); // 가장 좋은 순

    if (losers.length > 0 && winners.length > 0) {
      for (let li = 0; li < Math.min(2, losers.length); li++) {
        const loser = losers[li];
        // v10.8: 각 loser를 다른 winner에 분산 로테이션 (집중 방지)
        const winner = winners[li % winners.length];
        const tech = techResults.find((t) => t.code === winner.code);
        if (!tech) continue;

        // 로테이션 수량: 패자 보유량의 절반 (점진적 이동)
        const rotateQty = Math.max(1, Math.floor(loser.qty / 2));
        const rotateValue = rotateQty * loser.price;

        if (isPaper) {
          // Paper: 자동 실행
          const sellExec = await executeOverseasOrder(
            loser.code,
            'SELL',
            rotateQty,
            loser.price,
            loser.exchange,
            `🔄 로테이션매도: ${loser.code}(${loser.pnl.toFixed(1)}%)→${winner.code}(+${winner.pnl.toFixed(1)}%)`,
            loser.qty,
            loser.avgPrice,
            { isPaper },
          );
          if (sellExec.submitted && sellExec.filledQty > 0) {
            const proceeds = sellExec.filledPrice * sellExec.filledQty * (1 - OVERSEAS_FEE_PCT);
            cash += proceeds;
            await updateTradeState({
              code: loser.code,
              exchange: loser.exchange,
              qty: sellExec.finalQty,
              avgPrice: sellExec.finalAvgPrice,
              newCash: cash,
              isPaper,
            });
            sellOrders.push(
              `🔄 로테이션 ${loser.code}(${loser.pnl.toFixed(1)}%) x${sellExec.filledQty} → ${winner.code} 매수 대기`,
            );

            // 승자 추가 매수
            const buyQty = Math.max(1, Math.floor((proceeds * 0.95) / winner.price)); // 5% 여유
            if (buyQty > 0) {
              const buyExec = await executeOverseasOrder(
                winner.code,
                'BUY',
                buyQty,
                winner.price,
                winner.exchange,
                `🔄 로테이션매수: ${loser.code}→${winner.code} (승자 집중)`,
                winner.qty,
                winner.avgPrice,
                { isPaper },
              );
              if (buyExec.submitted && buyExec.filledQty > 0) {
                cash -= buyExec.filledPrice * buyExec.filledQty * (1 + OVERSEAS_FEE_PCT);
                await updateTradeState({
                  code: winner.code,
                  exchange: winner.exchange,
                  qty: buyExec.finalQty,
                  avgPrice: buyExec.finalAvgPrice,
                  newCash: cash,
                  isPaper,
                });
                sellOrders.push(
                  `🔄 로테이션 매수 ${winner.code} x${buyExec.filledQty} @$${buyExec.filledPrice.toFixed(2)}`,
                );
              }
            }
          }
          logger.info(
            `🔄 패자→승자 로테이션: ${loser.code}(${loser.pnl.toFixed(1)}%) x${rotateQty} → ${winner.code}(+${winner.pnl.toFixed(1)}%) $${rotateValue.toFixed(0)}`,
            { component: 'REBALANCE' },
          );
        } else {
          // Live: 추천만
          rebalanceAlerts.push(
            `🔄 로테이션 추천: ${loser.code}(${loser.pnl.toFixed(1)}%) → ${winner.code}(+${winner.pnl.toFixed(1)}%) $${rotateValue.toFixed(0)}`,
          );
          const lastRotKey = `rotation_${loser.code}`;
          const lastRot = extendedAlertSentAt.get(lastRotKey) ?? 0;
          if (Date.now() - lastRot > 60 * 60_000) {
            // 1시간 쿨다운
            await sendTelegramMessage(
              `🔄 *패자→승자 로테이션 추천*\n매도: ${loser.code} x${rotateQty} (${loser.pnl.toFixed(1)}%)\n매수: ${winner.code} (${winner.pnl >= 0 ? '+' : ''}${winner.pnl.toFixed(1)}%, score=${tech.score})\n금액: $${rotateValue.toFixed(0)}`,
            ).catch(() => {});
            extendedAlertSentAt.set(lastRotKey, Date.now());
          }
        }
      }
    }

    return { rebalanceAlerts, cash };
  } catch (rbErr) {
    logger.warn(`포트폴리오 리밸런싱 분석 실패: ${(rbErr as Error).message}`, { component: 'OVERSEAS' });
    return { rebalanceAlerts, cash: ctx.cash };
  }
}
