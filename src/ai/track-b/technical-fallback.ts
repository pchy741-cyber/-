import { analyzeTechnicals, type TechnicalSummary } from '../../analysis/indicators.js';
import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import type { TransactionChain } from '../../db/models.js';
import type { CurrentPrice, DailyCandle } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import type { TradeDecision } from '../../db/models.js';

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
}): TradeDecision[] {
  const { mode, watchlist, livePrices, chartData, openChains, orderableCash, maxPositionKrw } = params;
  const strategyParams = STRATEGY_PARAMS[mode];
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

    const candles = chartData.get(stock.stock_code);
    const price = livePrices.get(stock.stock_code);
    if (!candles || candles.length < 30 || !price) continue;

    const tech = analyzeTechnicals(candles);
    if (!tech) continue;

    // 매수 시그널: STRONG_BUY 또는 BUY + 추세 강도 확인
    if (tech.overallSignal === 'STRONG_BUY' || (tech.overallSignal === 'BUY' && tech.trendStrength !== 'WEAK')) {
      candidates.push({ stock_code: stock.stock_code, tech, price });
    }
  }

  // 점수 높은 순으로 정렬
  candidates.sort((a, b) => b.tech.score - a.tech.score);

  // 현금 여유 확인하면서 매수 결정
  let remainingCash = orderableCash;
  const maxBuys = 3; // 한 번에 최대 3종목

  for (const cand of candidates.slice(0, maxBuys)) {
    const positionSize = Math.min(maxPositionKrw, remainingCash * 0.3); // 잔고의 30% 이내
    if (positionSize < 50000) break; // 최소 5만원

    const quantity = Math.floor(positionSize / cand.price.currentPrice);
    if (quantity <= 0) continue;

    decisions.push({
      action: 'BUY',
      stock_code: cand.stock_code,
      quantity,
      price_type: 'MARKET',
      reasoning: `기술적 매수: score=${cand.tech.score} RSI=${cand.tech.rsi14.toFixed(0)} MACD=${cand.tech.macdCrossover} ADX=${cand.tech.adx14.toFixed(0)}(${cand.tech.trendStrength})${cand.tech.goldenCross ? ' 골든크로스' : ''}`,
      confidence: Math.min(0.9, cand.tech.score / 100),
    });

    remainingCash -= quantity * cand.price.currentPrice;
  }

  logger.info(`📊 기술적 지표 판단: ${decisions.length}개 (매수 ${decisions.filter((d) => d.action === 'BUY').length}, 매도 ${decisions.filter((d) => ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action)).length})`, {
    component: 'TRACK_B',
  });

  return decisions;
}
