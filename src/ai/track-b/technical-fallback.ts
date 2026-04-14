import { analyzeTechnicals, type TechnicalSummary } from '../../analysis/indicators.js';
import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import type { TransactionChain } from '../../db/models.js';
import type { CurrentPrice, DailyCandle } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import type { TradeDecision } from '../../db/models.js';
import { BUY_BLOCKED_CODES, PRIORITY_SECTOR_CODES } from './trading-rules.js';

/**
 * AI API 없이 기술적 지표만으로 매매 판단
 * RSI + MACD + 볼린저밴드 + ADX + 골든/데드크로스 종합
 */
export function technicalFallbackDecisions(params: {
  mode: StrategyMode;
  watchlist: Array<{ stock_code: string; stock_name: string }>;
  livePrices: Map<string, CurrentPrice>;
  chartData: Map<string, DailyCandle[]>;
  openChains: TransactionChain[];
  orderableCash: number;
  maxPositionKrw: number;
  aiScores?: Array<{ stock_code: string; score: number }>;
  /** 14일 이내 손절 종목 코드 — 재진입 금지 */
  lossBlockedCodes?: Set<string>;
  /** 전체 자산 규모 (포지션 크기 동적 계산용) */
  totalAssets?: number;
  /** DB 전략 설정값 — 있으면 STRATEGY_PARAMS 하드코딩 대신 사용 */
  takeProfitPct?: number;
  stopLossPct?: number;
  buyThreshold?: number;
}): TradeDecision[] {
  const { mode, watchlist, livePrices, chartData, openChains, orderableCash, maxPositionKrw, aiScores, lossBlockedCodes, totalAssets } = params;
  // 포지션 규모: config 값과 자산 25% 중 큰 값 사용 (소규모 계좌에서 1~2주만 매수되는 버그 방지)
  const effectiveMaxPos = totalAssets
    ? Math.max(maxPositionKrw, Math.round(totalAssets * 0.25))
    : maxPositionKrw;
  const aiScoreMap = new Map((aiScores ?? []).map((s) => [s.stock_code, s.score]));
  const base = STRATEGY_PARAMS[mode];
  // DB 세팅값 우선 적용 (없으면 STRATEGY_PARAMS 하드코딩 fallback)
  const strategyParams = {
    ...base,
    takeProfitPct: params.takeProfitPct ?? base.takeProfitPct,
    stopLossPct: params.stopLossPct ?? base.stopLossPct,
    buyThreshold: params.buyThreshold ?? base.buyThreshold,
  };
  const decisions: TradeDecision[] = [];

  // 1. 보유 종목 매도 판단 (손절/익절)
  for (const chain of openChains) {
    const price = livePrices.get(chain.stock_code);
    if (!price || !chain.avg_buy_price) continue;

    const avgBuy = Number(chain.avg_buy_price);
    const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;

    // 익절
    if (pnlPct >= strategyParams.takeProfitPct) {
      const sellQty = Math.ceil(chain.total_quantity * strategyParams.takeProfitRatio);
      if (sellQty > 0) {
        decisions.push({
          action: sellQty >= chain.total_quantity ? 'SELL' : 'PARTIAL_SELL',
          stock_code: chain.stock_code,
          quantity: Math.min(sellQty, chain.total_quantity),
          price_type: 'MARKET',
          reasoning: `기술적 익절: +${pnlPct.toFixed(1)}% (목표 ${strategyParams.takeProfitPct}%)`,
          confidence: 0.9,
        });
        continue;
      }
    }

    // 트레일링 스톱: 부분매도 후 남은 수량 — 수익이 반으로 줄면 전량 청산
    if (chain.status === 'PROFIT_TAKING' && pnlPct > 0 && pnlPct < strategyParams.takeProfitPct / 2) {
      decisions.push({
        action: 'FORCE_CLOSE',
        stock_code: chain.stock_code,
        quantity: chain.total_quantity,
        price_type: 'MARKET',
        reasoning: `트레일링 스톱: 익절 후 수익 반토막 +${pnlPct.toFixed(1)}% (기준 +${(strategyParams.takeProfitPct / 2).toFixed(1)}%)`,
        confidence: 0.85,
      });
      continue;
    }

    // 손절
    if (pnlPct <= strategyParams.stopLossPct) {
      decisions.push({
        action: 'FORCE_CLOSE',
        stock_code: chain.stock_code,
        quantity: chain.total_quantity,
        price_type: 'MARKET',
        reasoning: `기술적 손절: ${pnlPct.toFixed(1)}% (한도 ${strategyParams.stopLossPct}%)`,
        confidence: 0.95,
      });
      continue;
    }

    // 기술적 지표 기반 매도 판단
    const candles = chartData.get(chain.stock_code);
    if (candles && candles.length >= 60) {
      const tech = analyzeTechnicals(candles);
      if (tech && tech.overallSignal === 'STRONG_SELL') {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `기술적 매도: RSI=${tech.rsi14.toFixed(0)} MACD=${tech.macdCrossover} score=${tech.score}`,
          confidence: 0.7,
        });
      }
    }
  }

  // 2. 신규 매수 판단 (기술적 지표 기반)
  const openStockCodes = new Set(openChains.map((c) => c.stock_code));
  const candidates: Array<{ stock_code: string; tech: TechnicalSummary; price: CurrentPrice }> = [];

  for (const stock of watchlist) {
    // 이미 포지션 있으면 스킵
    if (openStockCodes.has(stock.stock_code)) continue;

    // CEO 지시: 바이오/손실 종목 매수 차단
    if (BUY_BLOCKED_CODES.has(stock.stock_code)) {
      logger.info(`  🚫 ${stock.stock_code}(${stock.stock_name}): 매수 차단 목록 — 스킵`, { component: 'TRACK_B' });
      continue;
    }
    // 14일 이내 손절 쿨다운 종목 재진입 금지
    if (lossBlockedCodes?.has(stock.stock_code)) {
      logger.info(`  🚫 ${stock.stock_code}(${stock.stock_name}): 손절 쿨다운 (14일) — 재진입 금지`, { component: 'TRACK_B' });
      continue;
    }

    const candles = chartData.get(stock.stock_code);
    const price = livePrices.get(stock.stock_code);
    if (!candles || candles.length < 30 || !price || price.currentPrice <= 0) continue;

    const tech = analyzeTechnicals(candles);
    if (!tech) continue;

    // 각 종목 score 로깅 (디버깅용)
    logger.info(`  📊 ${stock.stock_code}: score=${tech.score} RSI=${tech.rsi14.toFixed(0)} ADX=${tech.adx14.toFixed(0)}(${tech.trendStrength}) MACD=${tech.macdCrossover}`, { component: 'TRACK_B' });

    // 매수 조건: AI 스코어 >= 매수임계치면 기술 완화, 아니면 기술적 점수 단독 기준 충족 필요
    const aiScore = aiScoreMap.get(stock.stock_code) ?? 0;
    const buyThreshold = strategyParams.buyThreshold;
    // 기술 단독 최소 점수 (수수료 감안 — 낮으면 저품질 진입 → 손절 반복)
    const minTechScore = mode === 'SCALPING' ? 55 : mode === 'DEFENSE' ? 60 : 40;

    // 우선 테마(반도체/에너지/방산) 보너스 +10점 적용
    const priorityBonus = PRIORITY_SECTOR_CODES.has(stock.stock_code) ? 10 : 0;
    const effectiveTechScore = tech.score + priorityBonus;

    if (aiScore >= buyThreshold || effectiveTechScore >= minTechScore) {
      candidates.push({ stock_code: stock.stock_code, tech, price });
      if (aiScore >= buyThreshold) {
        logger.info(`  ✅ ${stock.stock_code}: AI=${aiScore}점(>=${buyThreshold}) → 매수 후보 (기술=${tech.score}${priorityBonus > 0 ? `+${priorityBonus}우선테마` : ''})`, { component: 'TRACK_B' });
      } else {
        logger.info(`  ✅ ${stock.stock_code}: 기술=${effectiveTechScore}점(>=${minTechScore}) → 매수 후보 (AI=${aiScore}${priorityBonus > 0 ? ' 우선테마' : ''})`, { component: 'TRACK_B' });
      }
    }
  }

  // AI 스코어 + 기술적 점수 합산으로 정렬
  candidates.sort((a, b) => {
    const aTotal = (aiScoreMap.get(a.stock_code) ?? 0) + a.tech.score;
    const bTotal = (aiScoreMap.get(b.stock_code) ?? 0) + b.tech.score;
    return bTotal - aTotal;
  });

  // 현금 여유 확인하면서 매수 결정
  let remainingCash = orderableCash;
  const maxBuys = 5; // 한 번에 최대 5종목
  const splitCount = strategyParams.splitCount || 3;

  for (const cand of candidates.slice(0, maxBuys)) {
    const isPriority = PRIORITY_SECTOR_CODES.has(cand.stock_code);
    // 우선 테마(반도체/에너지/방산): 포지션 20% 확대
    const priorityMultiplier = isPriority ? 1.2 : 1.0;
    // 종목당 1차 매수: 자산 기반 동적 포지션 한도의 1/splitCount, 잔고 한도 내
    const positionSize = Math.min(effectiveMaxPos / splitCount * priorityMultiplier, remainingCash / maxBuys);
    if (positionSize < 50000) break; // 최소 5만원 (1주라도 매수)

    const quantity = Math.floor(positionSize / cand.price.currentPrice);
    if (quantity <= 0) continue;

    decisions.push({
      action: 'BUY',
      stock_code: cand.stock_code,
      quantity,
      price_type: 'MARKET',
      limit_price: cand.price.currentPrice,
      reasoning: `기술적 매수: score=${cand.tech.score} RSI=${cand.tech.rsi14.toFixed(0)} MACD=${cand.tech.macdCrossover} ADX=${cand.tech.adx14.toFixed(0)}(${cand.tech.trendStrength})${cand.tech.goldenCross ? ' 골든크로스' : ''}${isPriority ? ' [우선테마+20%]' : ''}`,
      confidence: Math.min(0.9, cand.tech.score / 100),
    });

    remainingCash -= quantity * cand.price.currentPrice;
  }

  // 3. 보유 종목 물타기 판단
  for (const chain of openChains) {
    const price = livePrices.get(chain.stock_code);
    if (!price || !chain.avg_buy_price) continue;

    const avgBuy = Number(chain.avg_buy_price);
    const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;
    const avgDownTrigger = strategyParams.averageDownPct; // 보통 -3%

    // 물타기 조건: 평단가 대비 하락률이 트리거 이하 + 횟수 미달
    if (avgDownTrigger !== 0 && pnlPct <= avgDownTrigger && chain.current_averaging_count < chain.max_averaging_count) {
      const avgDownSize = Math.min(effectiveMaxPos / splitCount, remainingCash / 4);
      if (avgDownSize >= 50000) {
        const qty = Math.floor(avgDownSize / price.currentPrice);
        if (qty > 0) {
          decisions.push({
            action: 'AVERAGE_DOWN',
            stock_code: chain.stock_code,
            quantity: qty,
            price_type: 'MARKET',
            reasoning: `기술적 물타기: 평단가 대비 ${pnlPct.toFixed(1)}% (트리거 ${avgDownTrigger}%) | ${chain.current_averaging_count + 1}/${chain.max_averaging_count}차`,
            confidence: 0.7,
          });
          remainingCash -= qty * price.currentPrice;
        }
      }
    }
  }

  logger.info(`📊 기술적 지표 판단: ${decisions.length}개 (매수 ${decisions.filter((d) => d.action === 'BUY').length}, 물타기 ${decisions.filter((d) => d.action === 'AVERAGE_DOWN').length}, 매도 ${decisions.filter((d) => ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action)).length})`, {
    component: 'TRACK_B',
  });

  return decisions;
}
