/**
 * 수동 매수 라우트 — /manual-buy (Claude Code 복리 동적 사이징)
 */
import type { Hono } from 'hono';
import { invalidateStockCache } from '../../../cache/redis.js';
import { getScoreBasedParams, STRATEGY_PARAMS } from '../../../config/constants.js';
import { runWithMode } from '../../../config/context.js';
import { config } from '../../../config/index.js';
import { createChain, getActiveStrategy, getPool } from '../../../db/client.js';
import { resolveRequestMode } from '../../guards/live-pin.js';
import { getAccountBalance, invalidateBalanceCache } from '../../../kis/account.js';
import { getCurrentPrice } from '../../../kis/market.js';
import { placeOrder } from '../../../kis/order.js';
import { notifyBuy } from '../../../notifications/web-push.js';
import { addPaperInvestment, getPaperBalance, riskEngine } from '../../../risk/engine.js';
import { logger } from '../../../utils/logger.js';
import { getFxRate, hardInvalidateMode } from './helpers.js';

async function getOverseasValueKrw(isPaper: boolean): Promise<number> {
  try {
    const { rows } = await getPool().query(
      'SELECT SUM(last_price * quantity) AS total_usd FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1',
      [isPaper],
    );
    const usd = Number(rows[0]?.total_usd ?? 0);
    if (usd <= 0) return 0;
    const { FALLBACK_FX_RATE } = await import('../../../config/constants.js');
    const fx = await getFxRate();
    return usd * (fx > 0 ? fx : FALLBACK_FX_RATE);
  } catch {
    return 0;
  }
}

export function registerManualBuyRoutes(app: Hono) {
  // GET /manual-buy/estimate — 매수 전 예상 금액 조회 (confirm 다이얼로그에 표시용)
  app.get('/manual-buy/estimate', async (c) => {
    const stockCode = String(c.req.query('stock_code') ?? '')
      .trim()
      .replace(/\D/g, '');
    const aiScore = Number(c.req.query('ai_score') ?? 70);
    const isPaper = c.req.query('is_paper') === 'true';
    const pullbackSignal = c.req.query('pullback_signal') === 'true';
    const confidence = c.req.query('confidence') ? Number(c.req.query('confidence')) : undefined;

    if (!stockCode || stockCode.length !== 6) return c.json({ error: 'stock_code 6자리 필요' }, 400);

    const { getDynamicPositionSizePct } = await import('../../../config/constants.js');
    const { MEGA_CAP_PRIORITY_CODES } = await import('../.././../ai/track-b/trading-rules.js');

    const dbStrategy = await getActiveStrategy().catch(() => null);
    const useDynamic = dbStrategy?.use_dynamic_tpsl === true;
    let stopLossPct: number;
    if (aiScore >= 70 && useDynamic) {
      const { getDynamicDomesticTpSl } = await import('../../../config/constants.js');
      stopLossPct = getDynamicDomesticTpSl({ score: aiScore, confidence, pullbackSignal }).stopLossPct;
    } else {
      ({ stopLossPct } = getScoreBasedParams(aiScore));
    }
    const slFraction = Math.abs(stopLossPct) / 100;
    const isMegaCap = MEGA_CAP_PRIORITY_CODES.has(stockCode);

    async function calcAmt(paper: boolean) {
      const balance = paper ? await getPaperBalance() : await getAccountBalance(true);
      const overseasKrw = paper ? await getOverseasValueKrw(true) : 0;
      const totalCapital = balance.totalEvalAmount + balance.orderableCash + overseasKrw;
      // Paper: 현금 집계 지연 대응 → 총자산 기준 캡 적용 (availCash 고갈 시 소액매수 방지)
      const cashCap = paper ? totalCapital * 0.95 : balance.orderableCash * 0.95;
      const dynPct = getDynamicPositionSizePct({ score: aiScore, confidence, isMegaCap, pullbackSignal }) / 100;
      const computed = Math.round((totalCapital * 0.015) / slFraction);
      const amount_krw = Math.max(Math.min(computed, Math.round(totalCapital * dynPct), Math.round(cashCap)), 10000);
      return { amount_krw, dynPctInt: Math.round(dynPct * 100), totalCapital };
    }

    try {
      const main = await calcAmt(isPaper);
      const isElite = aiScore >= 90;
      const live = isPaper && isElite ? await calcAmt(false).catch(() => null) : null;
      return c.json({
        amount_krw: main.amount_krw,
        dynPct: main.dynPctInt,
        totalCapital: main.totalCapital,
        stopLossPct,
        isElite,
        liveAmount: live?.amount_krw ?? null,
        liveTotalCapital: live?.totalCapital ?? null,
      });
    } catch (e) {
      return c.json({ error: '잔고 조회 실패' }, 503);
    }
  });

  app.post('/manual-buy', async (c) => {
    let body: {
      stock_code?: string;
      amount_krw?: number;
      ai_score?: number;
      reasoning?: string;
      is_paper?: boolean;
      rsi?: number;
      volume_ratio?: number;
      pullback_signal?: boolean;
      envelope_pos?: string;
      confidence?: number;
      ceo_override?: boolean; // CEO 책임 — 시스템 cap 초과 매수 허용
      override_reason?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '요청 형식 오류' }, 400);
    }

    const stock_code = String(body.stock_code ?? '')
      .trim()
      .replace(/\D/g, '');
    const { reasoning } = body;
    const aiScore = body.ai_score ?? 0;
    // 서버 세션에서 모드 결정 (클라이언트 is_paper는 힌트, resolveRequestMode가 최종 권한)
    // 주의: 이 함수는 쿼리스트링(viewMode/mode)만 읽는다 — 호출 프론트엔드가 POST body에만
    // is_paper를 담아 보내면 쿼리스트링이 비어 매번 서버 기본값(baseIsPaper)으로 고정되는
    // 크로스오염 버그가 재발한다. 프론트엔드는 반드시 `?viewMode=` 쿼리를 붙여 호출할 것
    // (다른 매수/매도 라우트와 동일한 컨벤션 — overseas ManualBuyModal.tsx 참고)
    const isPaper: boolean = resolveRequestMode(c);
    const tradingMode = isPaper ? 'paper' : 'live';
    if (!stock_code || stock_code.length !== 6) {
      return c.json({ error: 'stock_code는 숫자 6자리여야 합니다' }, 400);
    }

    // ===== HARD SAFETY GATES (Track B 동일 기준 — 실전 손실 방지) =====
    // CEO 블랙리스트 — Paper/Live 공통
    const { BUY_BLOCKED_CODES } = await import('../.././../ai/track-b/trading-rules.js');
    if (BUY_BLOCKED_CODES.has(stock_code)) {
      logger.warn(`🚫 HARD BLOCK: ${stock_code} — CEO 블랙리스트`, { component: 'CLAUDE_BUY' });
      return c.json({ error: '매수 차단: CEO 블랙리스트 종목' }, 403);
    }

    // 커뮤니티 펌프 감지 — Paper/Live 공통
    const { isCommunityPumpBlocked } = await import('../../../automation/community-sentinel.js');
    if (isCommunityPumpBlocked(stock_code)) {
      logger.warn(`🚫 HARD BLOCK: ${stock_code} — 커뮤니티 펌프 리스크`, { component: 'CLAUDE_BUY' });
      return c.json({ error: '매수 차단: 커뮤니티 펌프/작전주 리스크 감지' }, 403);
    }

    // 매도 후 4시간 쿨다운 — Live만 (Paper는 실험 허용)
    if (!isPaper) {
      const { getMemoryCooldownCodes } = await import('../../../ai/track-b/sell-cooldown.js');
      const cooldownCodes = getMemoryCooldownCodes();
      if (cooldownCodes.has(stock_code)) {
        logger.warn(`🚫 HARD BLOCK: ${stock_code} — 매도 후 4h 쿨다운`, { component: 'CLAUDE_BUY' });
        return c.json({ error: '매수 차단: 4시간 이내 매도 종목 (반복매매=적자 주범)' }, 403);
      }
    }

    // 저가주 필터 + 상폐리스크 — 현재가 조기 조회 (아래에서 재사용)
    const priceData = await getCurrentPrice(stock_code);
    const curPrice = priceData.currentPrice;
    if (!curPrice || curPrice <= 0) return c.json({ error: '현재가 조회 실패' }, 500);

    const junkPriceThreshold = isPaper ? 1000 : 5000;
    const ETF_BRANDS = ['KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'HANARO', 'SOL', 'ACE', 'KOSEF'];
    const isETF = ETF_BRANDS.some((b) => (priceData.stockName ?? '').toUpperCase().includes(b));
    if (curPrice < junkPriceThreshold && !isETF) {
      logger.warn(
        `🚫 HARD BLOCK: ${stock_code}(${priceData.stockName}) ${curPrice}원 < ${junkPriceThreshold}원 — 저가주 필터`,
        { component: 'CLAUDE_BUY' },
      );
      return c.json(
        { error: `매수 차단: 저가주 ${curPrice.toLocaleString()}원 (최소 ${junkPriceThreshold.toLocaleString()}원)` },
        403,
      );
    }

    // 상폐리스크 종목 차단
    const { isDelistingRisk } = await import('../../../kis/market.js');
    if (isDelistingRisk(priceData)) {
      logger.warn(`🚫 HARD BLOCK: ${stock_code} — 상폐리스크/관리종목`, { component: 'CLAUDE_BUY' });
      return c.json({ error: '매수 차단: 관리종목/거래정지/투자경고' }, 403);
    }

    // Kelly 음수 → 실전 매수 차단 (수학적으로 "배팅하지 마라")
    if (!isPaper) {
      try {
        const { rows: kellyRows } = await getPool().query(`
          SELECT realized_pnl, total_invested
          FROM transaction_chains
          WHERE status = 'CLOSED' AND closed_at >= NOW() - INTERVAL '30 days'
            AND total_invested > 0 AND is_paper = false
        `);
        if (kellyRows.length >= 10) {
          let wins = 0, losses = 0, totalWinPct = 0, totalLossPct = 0;
          for (const r of kellyRows) {
            const pnlPct = (Number(r.realized_pnl) / Number(r.total_invested)) * 100;
            if (pnlPct > 0) { wins++; totalWinPct += pnlPct; }
            else { losses++; totalLossPct += Math.abs(pnlPct); }
          }
          const total = wins + losses;
          if (total >= 10) {
            const winRate = wins / total;
            const avgWin = wins > 0 ? totalWinPct / wins : 3.0;
            const avgLoss = losses > 0 ? totalLossPct / losses : 3.0;
            const b = avgLoss > 0 ? avgWin / avgLoss : 1.0;
            const fullKelly = (b * winRate - (1 - winRate)) / b;
            if (fullKelly <= 0) {
              logger.warn(
                `🚫 HARD BLOCK: Kelly 음수 (승률 ${(winRate * 100).toFixed(0)}%, Kelly=${(fullKelly * 100).toFixed(1)}%) — 실전 매수 차단`,
                { component: 'CLAUDE_BUY' },
              );
              return c.json({
                error: `매수 차단: Kelly 기준 음수 (30일 승률 ${(winRate * 100).toFixed(0)}%, 수학적으로 배팅 부적합)`,
              }, 403);
            }
          }
        }
      } catch (e) {
        logger.warn(`Kelly 계산 실패 (진행): ${e}`, { component: 'CLAUDE_BUY' });
      }
    }
    // ===== END HARD SAFETY GATES =====

    // 동적 TP/SL
    const dbStrategy = await getActiveStrategy().catch(() => null);
    const useDynamic = dbStrategy?.use_dynamic_tpsl === true;
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

    // ===== 수동매수 경고 수집 (CEO 책임 모드 — 경고만 표시, 차단 없음) =====
    const advisoryWarnings: string[] = [];

    // 🎯 진입 타이밍 가드 — 경고만 (차단 X)
    const { checkEntryTiming } = await import('../../../risk/entry-timing-guard.js');
    const entryCheck = checkEntryTiming({
      tech: { rsi: body.rsi, volumeRatio: body.volume_ratio },
      aiScore,
      marketCode: 'KR',
      isClaudeManual: true,
      strategyMode: 'SWING',
    });
    if (!entryCheck.allowed) {
      advisoryWarnings.push(`진입타이밍: ${entryCheck.reason}`);
      logger.warn(`⚠️ 진입타이밍 경고(진행): ${stock_code} — ${entryCheck.reason}`, { component: 'CLAUDE_BUY' });
    }

    // 🏆 수익 가드 5종 — 경고만 (차단 X)
    const { checkBuyGate } = await import('../../../risk/profit-guards.js');
    const buyGate = await checkBuyGate({
      stockCode: stock_code,
      takeProfitPct,
      stopLossPct,
      isPaper,
      minRr: 1.5,
    });
    if (!buyGate.allowed) {
      advisoryWarnings.push(`수익가드: ${buyGate.reason}`);
      logger.warn(`⚠️ 수익가드 경고(진행): ${stock_code} — ${buyGate.reason}`, { component: 'CLAUDE_BUY' });
    }
    const sizingMultiplier = buyGate.amountMultiplier;

    try {
      let amount_krw = body.amount_krw ?? 0;
      if (amount_krw < 10000) {
        try {
          const balance = isPaper ? await getPaperBalance() : await getAccountBalance(true);
          const overseasKrw2 = isPaper ? await getOverseasValueKrw(true) : 0;
          const totalCapital = balance.totalEvalAmount + balance.orderableCash + overseasKrw2;
          // Paper: 현금 집계 지연 대응 → 총자산 기준 캡 적용
          const cashCap2 = isPaper ? totalCapital * 0.95 : balance.orderableCash * 0.95;
          const slFraction = Math.abs(stopLossPct) / 100;
          const riskBudget = totalCapital * 0.015;
          const computed = Math.round(riskBudget / slFraction);

          const { getDynamicPositionSizePct } = await import('../../../config/constants.js');
          const { MEGA_CAP_PRIORITY_CODES } = await import('../.././../ai/track-b/trading-rules.js');
          const dynPct =
            getDynamicPositionSizePct({
              score: aiScore,
              confidence: body.confidence,
              isMegaCap: MEGA_CAP_PRIORITY_CODES.has(stock_code),
              pullbackSignal: body.pullback_signal,
            }) / 100;
          const capByAlloc = Math.round(totalCapital * dynPct);
          const rawAmount = Math.max(Math.min(computed, capByAlloc, Math.round(cashCap2)), 10000);
          // 🏆 종목 승률 multiplier 적용 (40%↓ → 0.5x, 70%↑ → 1.2x)
          amount_krw = Math.max(10000, Math.round(rawAmount * sizingMultiplier));
          logger.info(
            `💰 동적 사이징: score=${aiScore} megacap=${MEGA_CAP_PRIORITY_CODES.has(stock_code)} 승률mult=${sizingMultiplier.toFixed(2)} → 비중${(dynPct * 100).toFixed(0)}% | 총자본 ${(totalCapital / 10000).toFixed(0)}만원 → ${(amount_krw / 10000).toFixed(1)}만원`,
            { component: 'CLAUDE_BUY' },
          );
        } catch (e) {
          logger.error(`잔고 조회 실패 — 주문 중단: ${e}`, { component: 'CLAUDE_BUY' });
          return c.json({ error: '잔고 조회 실패로 주문 중단' }, 503);
        }
      }

      // curPrice + priceData 는 위 HARD SAFETY GATES에서 이미 조회 완료

      // 기술지표 — 경고 수집만 (차단 X, CEO 책임 모드)
      if (!isPaper) {
        try {
          const { getDailyChart } = await import('../../../kis/market.js');
          const { analyzeTechnicals } = await import('../../../analysis/indicators.js');
          const chart = await getDailyChart(stock_code, 60);
          if (chart && chart.length >= 20) {
            const tech = analyzeTechnicals(chart);
            if (tech) {
              if (tech.score < 45) advisoryWarnings.push(`기술점수=${tech.score} (매수 부적합)`);
              else if (tech.score < 55) advisoryWarnings.push(`기술점수=${tech.score} (기준 55 미달)`);
              if (tech.macdCrossover === 'BEARISH') advisoryWarnings.push(`MACD=BEARISH (하락 모멘텀)`);
              if (tech.rsi14 > 70) advisoryWarnings.push(`RSI=${tech.rsi14.toFixed(0)} (과매수)`);
              if (tech.trendStrength === 'STRONG' && tech.sma5 < tech.sma20) advisoryWarnings.push(`강한 하락추세`);
              if (tech.sma5 < tech.sma20 && tech.sma20 < tech.sma60) advisoryWarnings.push(`SMA 역배열 (하락추세)`);
              if (tech.trendStrength === 'WEAK' && tech.volumeRatio < 0.8) advisoryWarnings.push(`약한 추세+저유동성`);
            }
          }
        } catch (e) {
          logger.warn(`기술지표 조회 실패 (진행): ${e}`, { component: 'CLAUDE_BUY' });
        }
      }

      let quantity = Math.floor(amount_krw / curPrice);
      if (quantity < 1)
        return c.json(
          { error: `수량 부족: ${curPrice.toLocaleString()}원 × 1주 > ${amount_krw.toLocaleString()}원` },
          400,
        );

      // 포지션 비중 제한: 초과 시 422 차단 대신 자동 수량 조정 (거래 차단 방지)
      // CEO 책임 모드 (ceo_override=true): cap 무시 — 사용자가 더 살 수 있음
      try {
        const balance = isPaper ? await getPaperBalance() : await getAccountBalance(true);
        const overseasKrw3 = isPaper ? await getOverseasValueKrw(true) : 0;
        const totalCapital = balance.totalEvalAmount + balance.orderableCash + overseasKrw3;
        const CAP_PCT = 35; // getDynamicPositionSizePct 상한(35%)에 맞춤
        const positionPct = ((quantity * curPrice) / totalCapital) * 100;
        if (positionPct > CAP_PCT) {
          if (body.ceo_override) {
            // CEO 책임 — cap 무시 (단 잔고 부족은 그대로 차단)
            const cashCap = Math.floor(balance.orderableCash / curPrice);
            if (quantity > cashCap) quantity = Math.max(1, cashCap);
            logger.warn(
              `⚠️ CEO 책임 매수 (cap ${CAP_PCT}% 초과): ${stock_code} 비중 ${positionPct.toFixed(0)}% ${quantity}주 (사유: ${body.override_reason ?? 'CEO 직접'})`,
              { component: 'CLAUDE_BUY' },
            );
          } else {
            const maxQty = Math.floor((totalCapital * (CAP_PCT / 100)) / curPrice);
            if (maxQty < 1) {
              return c.json({ error: `잔고 부족: 1주(${curPrice.toLocaleString()}원) 구매 불가` }, 422);
            }
            logger.info(
              `⚖️ 비중 ${positionPct.toFixed(0)}% → ${CAP_PCT}% 자동 조정: ${stock_code} ${quantity}주 → ${maxQty}주`,
              { component: 'CLAUDE_BUY' },
            );
            quantity = maxQty;
          }
        }
      } catch {
        /* 잔고 조회 실패 시 패스 */
      }

      // 리스크 엔진 검증 (실전만) — MDD/현금부족/일일손실/킬스위치는 하드블락, 나머지 경고
      if (!isPaper) {
        try {
          const riskResult = await riskEngine.validateOrder({
            stockCode: stock_code,
            side: 'BUY',
            quantity,
            estimatedPrice: curPrice,
            isPaper: false,
            ceoManual: true,
          });
          if (!riskResult.approved) {
            const reason = riskResult.reason ?? '';
            const isMddHardBlock = /mdd|max.*drawdown|최대.*손실/i.test(reason);
            const isCashBlock = /현금.*부족|잔고.*부족|cash/i.test(reason);
            // 일일손실 초과/소프트리밋/킬스위치: Track B와 동일 기준 적용
            // ceo_override라도 일일손실 보호는 우회 불가 (재매수=적자 주범)
            const isDailyLossBlock = /kill switch|소프트 리밋|일일 손실.*초과|일일 손실.*차단/i.test(reason);
            if (isMddHardBlock || isCashBlock || isDailyLossBlock) {
              // 하드블락: MDD -12%, 현금 부족, 일일손실 한도 초과
              logger.warn(`🚫 하드블락: ${stock_code} — ${reason}`, { component: 'CLAUDE_BUY' });
              return c.json({ error: `하드블락: ${reason}` }, 403);
            }
            // 나머지 리스크 → 경고만
            advisoryWarnings.push(`리스크: ${reason}`);
            logger.warn(`⚠️ 리스크 경고(진행): ${stock_code} — ${reason}`, { component: 'CLAUDE_BUY' });
          }
          // v16: 소프트 사이즈 조절 적용
          if (riskResult.sizeMultiplier && riskResult.sizeMultiplier < 1.0) {
            const adjusted = Math.max(1, Math.floor(quantity * riskResult.sizeMultiplier));
            advisoryWarnings.push(`리스크 사이즈: ${quantity}→${adjusted}주 (${(riskResult.sizeMultiplier * 100).toFixed(0)}%)`);
            logger.info(`📊 수동매수 리스크 사이즈: ${quantity}→${adjusted}주 (${(riskResult.sizeMultiplier * 100).toFixed(0)}%)`, { component: 'CLAUDE_BUY' });
            quantity = adjusted;
          }
        } catch (e) {
          advisoryWarnings.push('리스크 엔진 조회 실패 (진행)');
          logger.warn(`리스크 엔진 조회 실패 (진행): ${e}`, { component: 'CLAUDE_BUY' });
        }
      }

      const totalInvested = quantity * curPrice;
      const rrStr = `TP+${takeProfitPct}%/SL${stopLossPct}%(${(takeProfitPct / Math.abs(stopLossPct)).toFixed(2)}:1)${tpSlLabel ? ` [${tpSlLabel}]` : ''}`;

      // 중복 OPEN 체인 — 경고만 (물타기 허용, CEO 책임)
      const dupCheck = await getPool().query(
        `SELECT id FROM transaction_chains WHERE stock_code = $1 AND is_paper = $2 AND status = 'OPEN' LIMIT 1`,
        [stock_code, isPaper],
      );
      if (dupCheck.rows.length > 0) {
        advisoryWarnings.push(`이미 OPEN 포지션 있음 (물타기 진행)`);
        logger.warn(`⚠️ 중복 포지션 경고(진행): ${stock_code}`, { component: 'CLAUDE_BUY' });
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
        logger.info(
          `🤖 Claude 매수 (모의): ${stock_code} ${quantity}주 @${curPrice.toLocaleString()}원 ${rrStr} — ${reasoning}`,
          { component: 'CLAUDE_BUY' },
        );
        addPaperInvestment(quantity * curPrice); // 연습 원장 캐시 즉시 무효화 + 현금 차감 반영
        try {
          await notifyBuy(stock_code, quantity, curPrice, reasoning ?? 'Claude Code 스캘핑', 'MANUAL_BUY', true);
        } catch (notifyErr) {
          logger.warn(
            `notifyBuy() 실패: ${stock_code} — ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`,
            { component: 'CLAUDE_BUY' },
          );
        }
        invalidateBalanceCache();
        hardInvalidateMode(isPaper);
        invalidateStockCache(stock_code).catch(() => {});

        // 엘리트 자동 실전 프로모션 — 기본 OFF (CEO 철학: Live=안정 스윙만, Paper=실험)
        // env ENABLE_ELITE_AUTO_PROMOTE=true 명시 시에만 활성화
        let livePromoted = false;
        let liveAmount: number | undefined;
        const elitePromoteEnabled = process.env.ENABLE_ELITE_AUTO_PROMOTE === 'true';
        if (aiScore >= 90 && !elitePromoteEnabled) {
          logger.info(`⏸️ 엘리트 자동 프로모션 스킵 (default OFF — Live는 안정 스윙만): ${stock_code} AI${aiScore}점`, {
            component: 'CLAUDE_BUY',
          });
        }
        if (aiScore >= 90 && elitePromoteEnabled) {
          try {
            const liveDup = await getPool().query(
              `SELECT id FROM transaction_chains WHERE stock_code = $1 AND is_paper = false AND status = 'OPEN' LIMIT 1`,
              [stock_code],
            );
            if (liveDup.rows.length === 0) {
              const { getDynamicPositionSizePct } = await import('../../../config/constants.js');
              const { MEGA_CAP_PRIORITY_CODES } = await import('../.././../ai/track-b/trading-rules.js');
              const liveBal = await getAccountBalance(true);
              const liveTotalCapital = liveBal.totalEvalAmount + liveBal.orderableCash;
              const liveAvailCash = liveBal.orderableCash;
              const slFractionLive = Math.abs(stopLossPct) / 100;
              const liveDynPct =
                getDynamicPositionSizePct({
                  score: aiScore,
                  confidence: body.confidence,
                  isMegaCap: MEGA_CAP_PRIORITY_CODES.has(stock_code),
                  pullbackSignal: body.pullback_signal,
                }) / 100;
              const liveAmountKrw = Math.max(
                Math.min(
                  Math.round((liveTotalCapital * 0.015) / slFractionLive),
                  Math.round(liveTotalCapital * liveDynPct),
                  Math.round(liveAvailCash * 0.95),
                ),
                10000,
              );
              const liveQty = Math.floor(liveAmountKrw / curPrice);
              if (liveQty >= 1 && liveAvailCash >= liveQty * curPrice) {
                const liveTotalInvested = liveQty * curPrice;
                // createChain 먼저 — placeOrder 실패/예외 시 체인 삭제로 롤백
                const liveChainId = await createChain({
                  stock_code,
                  status: 'OPEN',
                  strategy_mode: 'SWING',
                  avg_buy_price: curPrice,
                  total_quantity: liveQty,
                  total_invested: liveTotalInvested,
                  realized_pnl: 0,
                  target_profit_pct: takeProfitPct,
                  stop_loss_pct: stopLossPct,
                  max_averaging_count: STRATEGY_PARAMS.SWING.maxAveragingCount,
                  current_averaging_count: 0,
                  is_paper: false,
                });
                let orderFilled = false;
                try {
                  const liveResult = await runWithMode(false, () =>
                    placeOrder({ stockCode: stock_code, side: 'BUY', quantity: liveQty }),
                  );
                  if (liveResult.success) {
                    orderFilled = true;
                    await getPool().query(
                      `INSERT INTO orders (chain_id, stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning)
                       VALUES ($1, $2, 'BUY', 'MARKET', $3, $4, $3, $4, $5, 'FILLED', 'live', 'CLAUDE', $6)`,
                      [
                        liveChainId,
                        stock_code,
                        liveQty,
                        curPrice,
                        liveResult.orderNo ?? '',
                        `AUTO_PROMOTE AI${aiScore}점 연습→실전`,
                      ],
                    );
                    livePromoted = true;
                    liveAmount = liveTotalInvested;
                    logger.info(
                      `⭐ 엘리트 자동 실전 매수: ${stock_code} ${liveQty}주 @${curPrice.toLocaleString()}원 (AI${aiScore}점)`,
                      { component: 'CLAUDE_BUY' },
                    );
                    invalidateBalanceCache();
                    await notifyBuy(
                      stock_code,
                      liveQty,
                      curPrice,
                      `AUTO_PROMOTE AI${aiScore}점 연습→실전`,
                      'ELITE_AUTO_PROMOTION',
                    ).catch((err) =>
                      logger.warn(`notifyBuy() 실패 (엘리트 자동 실전): ${err}`, { component: 'CLAUDE_BUY' }),
                    );
                  }
                } finally {
                  if (!orderFilled) {
                    await getPool().query(
                      `DELETE FROM transaction_chains WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM orders WHERE chain_id = $1)`,
                      [liveChainId],
                    ).catch((err) => logger.warn(`체인 삭제 실패 (FK 참조 존재 가능): ${err}`, { component: 'CLAUDE_BUY' }));
                  }
                }
              }
            }
          } catch (e) {
            logger.warn(`자동 실전 프로모션 실패 (연습만 진행): ${e}`, { component: 'CLAUDE_BUY' });
          }
        }

        return c.json({
          ok: true,
          orderNo: fakeOrderNo,
          stock_code,
          quantity,
          price: curPrice,
          totalInvested,
          takeProfitPct,
          stopLossPct,
          livePromoted,
          liveAmount,
          advisoryWarnings: advisoryWarnings.length > 0 ? advisoryWarnings : undefined,
        });
      }

      const result = await runWithMode(isPaper, () => placeOrder({ stockCode: stock_code, side: 'BUY', quantity }));
      if (!result.success) return c.json({ error: `KIS 매수 거부: ${result.message}` }, 502);
      const kisOrderNo = result.orderNo ?? '';

      // KIS 시장가 주문 수락 = 즉시 체결 — 잔고 반영 딜레이(3-10s) 기다리다 quantity=0 되는 버그 방지
      const confirmed = result.success;
      if (!confirmed) {
        logger.warn(`매수 주문 미수락 (${stock_code}) — PENDING으로 기록`, { component: 'CLAUDE_BUY' });
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
        [
          chainId,
          stock_code,
          quantity,
          curPrice,
          confirmed ? quantity : 0,
          confirmed ? curPrice : 0,
          kisOrderNo,
          orderStatus,
          tradingMode,
          reasoning ?? 'Claude Code 눌림매매',
        ],
      );
      logger.info(
        `🤖 Claude 매수 ${confirmed ? '체결' : '접수'}: ${stock_code} ${quantity}주 @${curPrice.toLocaleString()}원 (${kisOrderNo}) ${rrStr} — ${reasoning}`,
        { component: 'CLAUDE_BUY' },
      );
      try {
        await notifyBuy(stock_code, quantity, curPrice, reasoning ?? 'Claude Code 스캘핑', 'MANUAL_BUY', false);
      } catch (notifyErr) {
        logger.warn(
          `notifyBuy() 실패: ${stock_code} — ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`,
          { component: 'CLAUDE_BUY' },
        );
      }
      invalidateBalanceCache();
      hardInvalidateMode(isPaper);
      invalidateStockCache(stock_code).catch(() => {});
      return c.json({
        ok: true,
        orderNo: kisOrderNo,
        status: orderStatus,
        stock_code,
        quantity,
        price: curPrice,
        totalInvested,
        takeProfitPct,
        stopLossPct,
        advisoryWarnings: advisoryWarnings.length > 0 ? advisoryWarnings : undefined,
      });
    } catch (err: any) {
      logger.error(`Claude 매수 예외: ${err.message}`, { component: 'CLAUDE_BUY' });
      return c.json({ error: 'Internal server error' }, 500);
    }
  });
}
