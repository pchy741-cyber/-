import type { StrategyMode } from '../config/constants.js';
import { config } from '../config/index.js';
import { getActiveStrategy, getActiveWatchlist, getLatestScores, getPool, logSystem } from '../db/client.js';
import type { TradeDecision } from '../db/models.js';
import { getAccountBalance } from '../kis/account.js';
import { getBatchPrices, getDailyChart } from '../kis/market.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { tradeExecutor } from '../trading/executor.js';
import { logger } from '../utils/logger.js';
import { calcPnlPct, roundKrw } from '../utils/money.js';
import { getLearnedParameters } from './self-learning.js';

/**
 * 💰 자금 흐름 최적화 엔진 (Capital Flow Optimizer)
 *
 * CEO의 핵심 철학:
 * "투자금이 계속 고여있지 않고 흘러갈 수 있는 구조"
 *
 * 문제 상황:
 * - 종목 A에 30만원 묶여있는데 수익도 손실도 아닌 횡보 (-1~+1%)
 * - 종목 B에서 기관 5일 연속 순매수 시그널 발생 (90% 확률)
 * - 하지만 현금이 없어서 B를 못 삼
 * → A를 정리하고 B로 자금 이동시켜야 함
 *
 * 해결:
 * 1. 기회비용 분석 — "이 돈이 여기 묶여있는 게 맞나?"
 * 2. 자금 재배치 — 낮은 기대수익 종목 → 높은 기대수익 종목으로 이동
 * 3. 방어 파킹 — 시장 나쁠 때 안전 종목에 잠깐 파킹
 * 4. 유동성 확보 — 항상 총 자산의 20%+ 현금 유지
 *
 * 실행 시점: 장중 30분마다 (Track B와 번갈아 실행)
 */

interface PositionEval {
  stockCode: string;
  chainId: string;
  investedAmount: number;
  currentValue: number;
  pnlPct: number;
  holdingDays: number;
  aiScore: number | null; // 현재 AI 스코어
  entryType: 'SNIPER' | 'SWING';
  volatilityPct: number; // 개별 종목 변동성 (%)
  momentum: 'RISING' | 'FLAT' | 'FALLING';
  opportunityCost: number; // 기회비용 점수 (높을수록 다른 곳에 써야 함)
  recommendation: 'KEEP' | 'REDUCE' | 'EXIT' | 'PARK';
  exitReason?: string;
}

/**
 * ATR (Average True Range) 계산
 * @param candles - 일봉 데이터 (최신순 정렬)
 * @param period - 계산 기간 (보통 14)
 * @returns ATR 값
 */
function calculateATR(candles: { high: number; low: number; close: number }[], period: number): number {
  // Expects candles sorted newest to oldest
  if (candles.length < period + 1) return 0;

  const trueRanges = [];
  for (let i = 0; i < period; i++) {
    const currentCandle = candles[i];
    const prevCandle = candles[i + 1];
    const tr = Math.max(
      currentCandle.high - currentCandle.low,
      Math.abs(currentCandle.high - prevCandle.close),
      Math.abs(currentCandle.low - prevCandle.close),
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length === 0) return 0;
  return trueRanges.reduce((sum, val) => sum + val, 0) / trueRanges.length;
}

/**
 * 장세와 포트폴리오 변동성에 따라 동적 현금 목표 설정
 */
function determineTargetCashRatio(
  mode: StrategyMode,
  portfolioVolatility: number,
): { targetRatio: number; reason: string } {
  let targetRatio = mode === 'DEFENSE' ? 40 : 20;
  const reasons = [`기본 목표(${mode} 모드): ${targetRatio}%`];

  if (portfolioVolatility > 3.0) {
    targetRatio += 10;
    reasons.push(`포트폴리오 변동성 높음(+10%)`);
  } else if (portfolioVolatility < 1.5 && mode === 'SWING') {
    // DEFENSE 모드에서는 비중을 줄이지 않음
    targetRatio -= 10;
    reasons.push(`포트폴리오 변동성 낮음(-10%)`);
  }

  // 10% ~ 60% 범위로 제한
  targetRatio = Math.max(10, Math.min(60, targetRatio));

  return { targetRatio, reason: reasons.join(', ') };
}

/**
 * 전체 포트폴리오 자금 흐름 분석
 */
export async function analyzeCapitalFlow(): Promise<void> {
  // 모든 활성 체인 (OPEN + AVERAGING + PROFIT_TAKING) + 주문 정보
  const { rows: chainsRaw } = await getPool().query(
    `SELECT tc.*,
       COALESCE(json_agg(json_build_object('ai_reasoning', o.ai_reasoning, 'side', o.side))
         FILTER (WHERE o.id IS NOT NULL), '[]') AS orders
     FROM transaction_chains tc
     LEFT JOIN orders o ON o.chain_id = tc.id
     WHERE tc.status IN ('OPEN', 'AVERAGING', 'PROFIT_TAKING')
       AND tc.is_paper = $1
     GROUP BY tc.id`,
    [config.isPaper],
  );
  const chains = chainsRaw;

  if (!chains || chains.length === 0) return;

  // 서버 모드에 맞는 잔고 조회 (paper → getPaperBalance 사용, live → KIS 실계좌)
  const { getPaperBalance } = await import('../risk/engine.js');
  const balance = config.isPaper ? await getPaperBalance() : await getAccountBalance();
  const totalPortfolio = balance.totalDeposit + balance.totalEvalAmount;
  const cashRatio = totalPortfolio > 0 ? (balance.orderableCash / totalPortfolio) * 100 : 100;

  // 🧠 자기학습 파라미터 로드
  const learnedParams = await getLearnedParameters();

  const watchlist = await getActiveWatchlist();
  const stockCodes = watchlist.map((w) => w.stock_code);
  const scores = await getLatestScores(stockCodes);
  const strategy = await getActiveStrategy();
  const mode = (strategy?.mode ?? 'SWING') as StrategyMode;

  // ── 전 종목 시세 배치 조회 (N+1 방지) ──
  const activeChains = chains.filter((c) => c.total_quantity > 0);
  const chainCodes = activeChains.map((c) => c.stock_code);
  const priceMap = await getBatchPrices(chainCodes);

  // ── 각 포지션 평가 (2-Pass 구조) ──

  // Pass 1: 데이터 수집 및 개별 변동성 계산
  const positionData = [];
  for (const chain of activeChains) {
    try {
      const price = priceMap.get(chain.stock_code);
      if (!price) continue;

      const chartData = await getDailyChart(chain.stock_code, 20);
      const atr = calculateATR(chartData, 14);
      const volatilityPct = price.currentPrice > 0 ? (atr / price.currentPrice) * 100 : 0;

      positionData.push({ chain, price, volatilityPct, chartData });
      await new Promise((r) => setTimeout(r, 100)); // rate limit
    } catch {
      // 개별 종목 실패 무시
    }
  }

  // 중간 계산: 포트폴리오 전체 변동성 및 목표 현금 비율 계산
  const totalInvestedValue = positionData.reduce(
    (sum, p) => sum + Number(p.chain.avg_buy_price) * p.chain.total_quantity,
    0,
  );
  const portfolioVolatility =
    totalInvestedValue > 0
      ? positionData.reduce((sum, p) => {
          const invested = Number(p.chain.avg_buy_price) * p.chain.total_quantity;
          return sum + invested * p.volatilityPct;
        }, 0) / totalInvestedValue
      : 0;

  const { targetRatio: targetCashRatio, reason: targetCashReason } = determineTargetCashRatio(
    mode,
    portfolioVolatility,
  );
  logger.info(
    `💰 동적 현금 목표: ${targetCashRatio.toFixed(0)}% (현재 ${cashRatio.toFixed(0)}%, 근거: ${targetCashReason})`,
    { component: 'FLOW' },
  );
  const cashShortfall = targetCashRatio - cashRatio;

  // Pass 2: 기회비용 계산 및 최종 평가
  const evaluations: PositionEval[] = [];
  const chainUpdates: { id: string; peak_price_since_open: number }[] = [];

  for (const { chain, price, volatilityPct, chartData } of positionData) {
    const avgBuy = Number(chain.avg_buy_price);
    const pnlPct = calcPnlPct(avgBuy, price.currentPrice);
    const investedAmount = roundKrw(avgBuy * chain.total_quantity);
    const currentValue = roundKrw(price.currentPrice * chain.total_quantity);
    const openedAt = new Date(chain.opened_at);
    const holdingDays = Math.floor((Date.now() - openedAt.getTime()) / (1000 * 60 * 60 * 24));
    const score = scores.find((s) => s.stock_code === chain.stock_code);
    const aiScore = score ? Number(score.composite_score) : null;
    const firstOrder = (chain.orders as any[])?.find((o) => o.side === 'BUY');
    let entryType: 'SNIPER' | 'SWING' = 'SWING';
    let sniperType: string | undefined;
    if (firstOrder?.ai_reasoning?.includes('[SNIPER')) {
      entryType = 'SNIPER';
      const sniperMatch = firstOrder.ai_reasoning.match(/\[SNIPER\s(.*?)]/);
      if (sniperMatch) sniperType = sniperMatch[1];
    }
    const momentum: PositionEval['momentum'] =
      price.changePct > 1 ? 'RISING' : price.changePct < -1 ? 'FALLING' : 'FLAT';
    let opportunityCost = 0;
    const costReasons: string[] = [];
    if (Math.abs(pnlPct) < 2.0 && holdingDays >= 2) {
      const stagnationCost = holdingDays * 5;
      opportunityCost += stagnationCost;
      costReasons.push(`횡보(${holdingDays}일):+${stagnationCost}`);
    }
    const unownedScores = scores.filter((s) => !chains.some((c) => c.stock_code === s.stock_code));
    const topOpportunityScore =
      unownedScores.length > 0 ? Math.max(...unownedScores.map((s) => Number(s.composite_score))) : 0;
    if (aiScore !== null && topOpportunityScore > aiScore + 10) {
      const scoreGapCost = Math.round((topOpportunityScore - aiScore) * 0.4);
      opportunityCost += scoreGapCost;
      costReasons.push(`점수격차(${topOpportunityScore}vs${aiScore}):+${scoreGapCost}`);
    }
    if (cashShortfall > 5) {
      const cashPressureCost = Math.round(cashShortfall * 1.5);
      opportunityCost += cashPressureCost;
      costReasons.push(`현금확보(${targetCashRatio.toFixed(0)}%):+${cashPressureCost}`);
    }
    if (momentum === 'FALLING') {
      opportunityCost += 20;
      costReasons.push(`모멘텀(하락):+20`);
    } else if (momentum === 'RISING' && pnlPct > 1) {
      opportunityCost -= 15;
      costReasons.push(`모멘텀(상승):-15`);
    }
    if (pnlPct > 3) {
      opportunityCost -= 10;
      costReasons.push(`수익쿠션:-10`);
    } else if (pnlPct < -3) {
      opportunityCost += 10;
      costReasons.push(`손실패널티:+10`);
    }
    if (mode === 'DEFENSE') {
      opportunityCost = Math.round(opportunityCost * 1.2);
      costReasons.push(`방어모드:x1.2`);
    }
    opportunityCost = Math.max(0, opportunityCost);
    let recommendation: PositionEval['recommendation'] = 'KEEP';
    let exitReason: string | undefined;
    if (entryType === 'SNIPER') {
      const rawPeak = Number(chain.peak_price_since_open ?? chain.avg_buy_price);
      const partialSold = rawPeak < 0; // negative = holding-check-job partial-sold flag
      let peakPrice = Math.abs(rawPeak);
      if (price.currentPrice > peakPrice) {
        peakPrice = price.currentPrice;
        chainUpdates.push({ id: chain.id, peak_price_since_open: partialSold ? -peakPrice : peakPrice });
      }
      const atr = calculateATR(chartData, 14);
      const atrMultiplier = sniperType ? (learnedParams.trailingStopMultipliers[sniperType] ?? 2.5) : 2.5;
      const trailingStopPrice = peakPrice - atr * atrMultiplier;
      if (price.currentPrice <= trailingStopPrice && atr > 0) {
        recommendation = 'EXIT';
        const dropAmount = peakPrice - price.currentPrice;
        exitReason = `[SNIPER] 트레일링 스탑 발동 (ATR x${atrMultiplier.toFixed(1)}, 최고가 ${peakPrice.toLocaleString()}원 대비 ${dropAmount.toLocaleString()}원 하락)`;
      }
    }
    if (recommendation === 'KEEP') {
      if (pnlPct >= 5 && momentum === 'FALLING') {
        recommendation = 'REDUCE';
        exitReason = `[자금흐름] 수익 ${pnlPct.toFixed(1)}%이나 모멘텀 하락 → 50% 정리`;
      } else if (opportunityCost >= 60 && pnlPct < 2) {
        recommendation = 'EXIT';
        exitReason = `[자금흐름] 기회비용 ${opportunityCost}점 (${costReasons.slice(0, 2).join(', ')}) → 자금 해방`;
      } else if (mode === 'DEFENSE' && pnlPct < 0 && holdingDays >= 2) {
        recommendation = 'EXIT';
        exitReason = `[자금흐름] 방어모드 + 손실 지속 → 빠른 정리`;
      } else if (opportunityCost >= 40 && Math.abs(pnlPct) < 1) {
        recommendation = 'PARK';
      }
    }
    evaluations.push({
      stockCode: chain.stock_code,
      chainId: chain.id,
      investedAmount,
      currentValue,
      pnlPct,
      holdingDays,
      aiScore,
      entryType,
      volatilityPct,
      momentum,
      opportunityCost,
      recommendation,
      exitReason,
    });
  }

  // ── 최고가 일괄 업데이트 ──
  if (chainUpdates.length > 0) {
    try {
      for (const upd of chainUpdates) {
        await getPool().query('UPDATE transaction_chains SET peak_price_since_open = $1 WHERE id = $2', [
          upd.peak_price_since_open,
          upd.id,
        ]);
      }
    } catch (err: any) {
      logger.error(`최고가 업데이트 실패: ${err.message}`, { component: 'FLOW' });
    }
  }

  // ── 자금 재배치 실행 ──
  const exitTargets = evaluations.filter((e) => e.recommendation === 'EXIT');
  const reduceTargets = evaluations.filter((e) => e.recommendation === 'REDUCE');

  if (exitTargets.length === 0 && reduceTargets.length === 0) {
    // 현금 부족 경고 (20% 미만)
    if (cashRatio < 20) {
      logger.warn(`💰 현금 비율 ${cashRatio.toFixed(0)}% (권장 20%+) — 유동성 부족 주의`, { component: 'FLOW' });
    }
    return;
  }

  const decisions: TradeDecision[] = [];

  // EXIT 대상 → 전량 시장가 매도
  for (const target of exitTargets) {
    const chain = chains.find((c) => c.id === target.chainId);
    if (!chain || chain.total_quantity <= 0) continue;

    decisions.push({
      action: 'FORCE_CLOSE',
      stock_code: target.stockCode,
      quantity: chain.total_quantity,
      price_type: 'MARKET',
      reasoning:
        target.exitReason ??
        `[자금흐름] 기회비용 ${target.opportunityCost}점, 수익률 ${target.pnlPct.toFixed(1)}% → 자금 해방`,
      confidence: 0.8,
    });
  }

  // REDUCE 대상 → 50% 매도 (수익 확보 + 일부 유지)
  for (const target of reduceTargets) {
    const chain = chains.find((c) => c.id === target.chainId);
    if (!chain || chain.total_quantity <= 0) continue;

    const sellQty = Math.ceil(chain.total_quantity * 0.5);
    decisions.push({
      action: 'PARTIAL_SELL',
      stock_code: target.stockCode,
      quantity: sellQty,
      price_type: 'MARKET',
      reasoning: target.exitReason ?? `[자금흐름] 수익 ${target.pnlPct.toFixed(1)}% 모멘텀 하락 → 50% 정리`,
      confidence: 0.7,
    });
  }

  if (decisions.length > 0) {
    const freedAmount =
      exitTargets.reduce((s, t) => s + t.currentValue, 0) +
      reduceTargets.reduce((s, t) => s + Math.ceil(t.currentValue * 0.5), 0);

    logger.info(
      `💰 자금 재배치: ${exitTargets.length}개 정리, ${reduceTargets.length}개 축소 → 약 ${freedAmount.toLocaleString()}원 해방`,
      { component: 'FLOW' },
    );

    await tradeExecutor.processDecisions(decisions, mode);

    await logSystem(
      'TRADE',
      'FLOW',
      `자금 재배치 실행: ${decisions.length}건, 예상 해방 자금 ${freedAmount.toLocaleString()}원`,
    );

    // 평가 요약 텔레그램 발송
    const summary = evaluations
      .filter((e) => e.recommendation !== 'KEEP')
      .map((e) => {
        const emoji = e.recommendation === 'EXIT' ? '🔓' : e.recommendation === 'REDUCE' ? '📉' : '🅿️';
        return `${emoji} ${e.stockCode}: ${e.recommendation} (수익 ${e.pnlPct.toFixed(1)}%, 기회비용 ${e.opportunityCost}점)`;
      })
      .join('\n');

    await sendTelegramMessage(
      `💰 *자금 흐름 최적화*\n\n` +
        `현금 비율: ${cashRatio.toFixed(0)}%\n` +
        `해방 자금: ~${freedAmount.toLocaleString()}원\n\n` +
        `${summary}\n\n` +
        `해방된 자금은 다음 Track B에서 자동 재투자됩니다.`,
    );
  }
}

/**
 * 현금 비율 체크 + 경고
 */
export async function checkCashRatio(): Promise<{ ratio: number; healthy: boolean }> {
  const { getPaperBalance } = await import('../risk/engine.js');
  const balance = config.isPaper ? await getPaperBalance() : await getAccountBalance();
  const total = balance.totalDeposit + balance.totalEvalAmount;
  const ratio = total > 0 ? (balance.orderableCash / total) * 100 : 100;

  return {
    ratio,
    healthy: ratio >= 20, // 20% 이상이면 건강
  };
}
