/**
 * 수동 매수 라우트 — /manual-buy (Claude Code 복리 동적 사이징)
 */
import type { Hono } from 'hono';
import { sleep } from '../../../utils/sleep.js';
import { config } from '../../../config/index.js';
import { STRATEGY_PARAMS, getScoreBasedParams } from '../../../config/constants.js';
import { createChain, getPool, getActiveStrategy } from '../../../db/client.js';
import { getAccountBalance } from '../../../kis/account.js';
import { getCurrentPrice } from '../../../kis/market.js';
import { placeOrder } from '../../../kis/order.js';
import { getPaperBalance, riskEngine } from '../../../risk/engine.js';
import { notifyBuy } from '../../../notifications/web-push.js';
import { logger } from '../../../utils/logger.js';
import { runWithMode } from '../../../config/context.js';
import { invalidateCurrentModeCache } from './helpers.js';
import { invalidateStockCache } from '../../../cache/redis.js';
import { invalidateBalanceCache } from '../../../kis/account.js';

export function registerManualBuyRoutes(app: Hono) {
  app.post('/manual-buy', async (c) => {
    let body: { stock_code?: string; amount_krw?: number; ai_score?: number; reasoning?: string; is_paper?: boolean; rsi?: number; volume_ratio?: number; pullback_signal?: boolean; envelope_pos?: string; confidence?: number };
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

    // 동적 TP/SL
    const dbStrategy = await getActiveStrategy().catch(() => null);
    const useDynamic = (dbStrategy as any)?.use_dynamic_tpsl === true;
    let takeProfitPct: number;
    let stopLossPct: number;
    let tpSlLabel = '';
    if (aiScore >= 70) {
      if (useDynamic) {
        const { getDynamicDomesticTpSl } = await import('../../../config/constants.js');
        const dyn = getDynamicDomesticTpSl({
          score: aiScore,
          confidence: body.confidence,
          rsi: body.rsi,
          volumeRatio: body.volume_ratio,
          pullbackSignal: body.pullback_signal,
          envelopePos: body.envelope_pos,
        });
        takeProfitPct = dyn.takeProfitPct;
        stopLossPct = dyn.stopLossPct;
        tpSlLabel = dyn.label;
      } else {
        ({ takeProfitPct, stopLossPct } = getScoreBasedParams(aiScore));
      }
    } else {
      takeProfitPct = STRATEGY_PARAMS.SWING.takeProfitPct;
      stopLossPct = STRATEGY_PARAMS.SWING.stopLossPct;
    }

    try {
      let amount_krw = body.amount_krw ?? 0;
      if (amount_krw < 10000) {
        try {
          const balance = isPaper ? await getPaperBalance() : await getAccountBalance(true);
          const totalCapital = balance.totalEvalAmount + balance.orderableCash;
          const availCash = balance.orderableCash;
          const slFraction = Math.abs(stopLossPct) / 100;
          const riskBudget = totalCapital * 0.015;
          const computed = Math.round(riskBudget / slFraction);

          const { getDynamicPositionSizePct } = await import('../../../config/constants.js');
          const { MEGA_CAP_PRIORITY_CODES } = await import('../.././../ai/track-b/trading-rules.js');
          const dynPct = getDynamicPositionSizePct({
            score: aiScore,
            confidence: body.confidence,
            isMegaCap: MEGA_CAP_PRIORITY_CODES.has(stock_code),
            pullbackSignal: body.pullback_signal,
          }) / 100;
          const capByAlloc = Math.round(totalCapital * dynPct);
          const capByCash = Math.round(availCash * 0.95);
          amount_krw = Math.max(Math.min(computed, capByAlloc, capByCash), 10000);
          logger.info(
            `💰 동적 사이징: score=${aiScore} megacap=${MEGA_CAP_PRIORITY_CODES.has(stock_code)} → 비중${(dynPct * 100).toFixed(0)}% | 총자본 ${(totalCapital / 10000).toFixed(0)}만원 → ${(amount_krw / 10000).toFixed(1)}만원`,
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

      // 기술지표 안전 게이트
      const warnings: string[] = [];
      try {
        const { getDailyChart } = await import('../../../kis/market.js');
        const { analyzeTechnicals } = await import('../../../analysis/indicators.js');
        const chart = await getDailyChart(stock_code, 60);
        if (chart && chart.length >= 20) {
          const tech = analyzeTechnicals(chart);
          if (tech) {
            const techScore = tech.score;
            if (techScore < 45) {
              warnings.push(`기술점수=${techScore} (기준 55 미달 — 매수 부적합)`);
            } else if (techScore < 55) {
              warnings.push(`기술점수=${techScore} (양호하나 기준 55 미달)`);
            }
            if (tech.macdCrossover === 'BEARISH') {
              warnings.push(`MACD=BEARISH (하락 모멘텀)`);
            }
            if (tech.rsi14 > 70) {
              warnings.push(`RSI=${tech.rsi14.toFixed(0)} (과매수 위험구간)`);
            }
            if (tech.trendStrength === 'STRONG' && tech.sma5 < tech.sma20) {
              warnings.push(`강한 하락추세 (ADX=${tech.adx14.toFixed(0)}, SMA5<SMA20)`);
            }
            if (tech.sma5 < tech.sma20 && tech.sma20 < tech.sma60) {
              warnings.push(`SMA 역배열 (5<20<60) — 하락 추세`);
            }
            if (tech.trendStrength === 'WEAK' && tech.volumeRatio < 0.8) {
              warnings.push(`약한 추세 + 저유동성 (vol=${tech.volumeRatio.toFixed(1)}x)`);
            }

            if (warnings.length >= 2) {
              logger.warn(`🚫 수동매수 기술 차단: ${stock_code} — ${warnings.join(' | ')}`, { component: 'CLAUDE_BUY' });
              return c.json({
                error: `기술지표 안전 차단 (${warnings.length}건 경고)`,
                warnings,
                techScore,
                rsi: tech.rsi14,
                macd: tech.macdCrossover,
                hint: '기술적 조건 불리 — 진입 재고 필요',
              }, 422);
            }

            if (warnings.length > 0) {
              logger.warn(`⚠️ 수동매수 경고(진행): ${stock_code} — ${warnings.join(' | ')}`, { component: 'CLAUDE_BUY' });
            }
          }
        }
      } catch (e) {
        logger.warn(`수동매수 기술지표 조회 실패 (진행): ${e}`, { component: 'CLAUDE_BUY' });
      }

      const quantity = Math.floor(amount_krw / curPrice);
      if (quantity < 1) return c.json({ error: `수량 부족: ${curPrice.toLocaleString()}원 × 1주 > ${amount_krw.toLocaleString()}원` }, 400);

      // 포지션 비중 제한: 최대 25%
      try {
        const balance = isPaper ? await getPaperBalance() : await getAccountBalance(true);
        const totalCapital = balance.totalEvalAmount + balance.orderableCash;
        const positionPct = (quantity * curPrice) / totalCapital * 100;
        if (positionPct > 25) {
          const maxQty = Math.floor(totalCapital * 0.25 / curPrice);
          logger.warn(`⚠️ 수동매수 비중 초과: ${stock_code} ${positionPct.toFixed(0)}% > 25% → ${maxQty}주로 축소`, { component: 'CLAUDE_BUY' });
          return c.json({
            error: `비중 ${positionPct.toFixed(0)}% 초과 (한도 25%). 최대 ${maxQty}주 (${(maxQty * curPrice).toLocaleString()}원)`,
            maxQuantity: maxQty,
            maxAmount: maxQty * curPrice,
            warnings,
          }, 422);
        }
      } catch { /* 잔고 조회 실패 시 패스 */ }

      // 리스크 엔진 검증 (실전만)
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
      const rrStr = `TP+${takeProfitPct}%/SL${stopLossPct}%(${(takeProfitPct / Math.abs(stopLossPct)).toFixed(2)}:1)${tpSlLabel ? ` [${tpSlLabel}]` : ''}`;

      // 중복 OPEN 체인 방지
      const dupCheck = await getPool().query(
        `SELECT id FROM transaction_chains WHERE stock_code = $1 AND is_paper = $2 AND status = 'OPEN' LIMIT 1`,
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
        invalidateBalanceCache();
        invalidateCurrentModeCache();
        invalidateStockCache(stock_code).catch(() => {});
        return c.json({ ok: true, orderNo: fakeOrderNo, stock_code, quantity, price: curPrice, totalInvested, takeProfitPct, stopLossPct });
      }

      const result = await runWithMode(isPaper, () => placeOrder({ stockCode: stock_code, side: 'BUY', quantity }));
      if (!result.success) return c.json({ error: `KIS 매수 거부: ${result.message}` }, 502);
      const kisOrderNo = result.orderNo ?? '';

      await sleep(3000);
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
      invalidateBalanceCache();
      invalidateCurrentModeCache();
      invalidateStockCache(stock_code).catch(() => {});
      return c.json({ ok: true, orderNo: kisOrderNo, status: orderStatus, stock_code, quantity, price: curPrice, totalInvested, takeProfitPct, stopLossPct });
    } catch (err: any) {
      logger.error(`Claude 매수 예외: ${err.message}`, { component: 'CLAUDE_BUY' });
      return c.json({ error: err.message }, 500);
    }
  });
}
