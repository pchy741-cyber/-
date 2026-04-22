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
  /** 24시간 이내 CEO 수동 매도 종목 코드 — 재진입 금지 */
  manuallySoldCodes?: Set<string>;
  /** 전체 자산 규모 (포지션 크기 동적 계산용) */
  totalAssets?: number;
  /** DB 전략 설정값 — 있으면 STRATEGY_PARAMS 하드코딩 대신 사용 */
  takeProfitPct?: number;
  stopLossPct?: number;
  buyThreshold?: number;
}): TradeDecision[] {
  const { mode, watchlist, livePrices, chartData, openChains, orderableCash, maxPositionKrw, aiScores, lossBlockedCodes, manuallySoldCodes, totalAssets } = params;
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
  // 동일 종목에 다중 체인(분할 매수)이 있을 경우 중복 매도 신호 방지
  const processedSellCodes = new Set<string>();
  for (const chain of openChains) {
    const price = livePrices.get(chain.stock_code);
    if (!price || !chain.avg_buy_price) continue;

    const avgBuy = Number(chain.avg_buy_price);
    const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;

    // 동일 종목 중복 매도 신호 방지 (다중 체인 시 첫 번째 체인만 처리)
    if (processedSellCodes.has(chain.stock_code)) continue;

    // ─── 2단계 익절 전략 ────────────────────────────────────────────────
    // 1단계: takeProfitPct(0.5%) 도달 → 50% 부분 매도 (수익 확정)
    // 2단계: PROFIT_TAKING 상태에서 추가 상승 +1.5% 또는 트레일링 스톱(-0.3% from peak) → 잔여 전량 청산
    // 효과: 0.5% 이하 단순 익절 대비 수익 기회 2~3배, 동시에 수익 반납 방지
    if (chain.status !== 'PROFIT_TAKING' && pnlPct >= strategyParams.takeProfitPct) {
      // 1단계: 첫 익절 — 50% 부분 매도
      const sellQty = Math.ceil(chain.total_quantity * 0.5);
      if (sellQty > 0 && sellQty < chain.total_quantity) {
        decisions.push({
          action: 'PARTIAL_SELL',
          stock_code: chain.stock_code,
          quantity: sellQty,
          price_type: 'MARKET',
          reasoning: `1단계 익절(50%): +${pnlPct.toFixed(1)}% 도달 → 나머지 트레일링 대기`,
          confidence: 0.9,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
      // 수량 1주 등 분할 불가 → 전량 익절
      if (chain.total_quantity > 0) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `기술적 익절(전량): +${pnlPct.toFixed(1)}% (목표 ${strategyParams.takeProfitPct}%)`,
          confidence: 0.9,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
    }

    // 2단계: 부분 익절 후 잔여 수량 트레일링 스톱
    if (chain.status === 'PROFIT_TAKING') {
      const peakPrice = (chain as any).peak_price ? Number((chain as any).peak_price) : Number(chain.avg_buy_price) * (1 + strategyParams.takeProfitPct / 100);
      const trailDropPct = ((price.currentPrice - peakPrice) / peakPrice) * 100;
      const isTrailTriggered = trailDropPct <= -0.3; // peak 대비 -0.3% 하락 시 청산
      const isTargetReached = pnlPct >= 1.5;         // +1.5% 추가 목표 달성 시 익절

      if (isTargetReached || isTrailTriggered) {
        decisions.push({
          action: isTargetReached ? 'SELL' : 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: isTargetReached
            ? `2단계 익절(잔여전량): +${pnlPct.toFixed(1)}% 목표달성`
            : `트레일링 스톱: peak 대비 ${trailDropPct.toFixed(2)}% 하락 (peak=${peakPrice.toFixed(0)}원)`,
          confidence: 0.9,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
    }
    // ──────────────────────────────────────────────────────────────────────

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
      processedSellCodes.add(chain.stock_code);
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
        processedSellCodes.add(chain.stock_code);
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
    // 24시간 이내 CEO 수동 매도 종목 재진입 금지
    if (manuallySoldCodes?.has(stock.stock_code)) {
      logger.info(`  🚫 ${stock.stock_code}(${stock.stock_name}): CEO 수동 매도 쿨다운 (24h) — 재진입 금지`, { component: 'TRACK_B' });
      continue;
    }

    const candles = chartData.get(stock.stock_code);
    const price = livePrices.get(stock.stock_code);
    if (!candles || candles.length < 30 || !price || price.currentPrice <= 0) continue;

    const tech = analyzeTechnicals(candles);
    if (!tech) continue;

    // 각 종목 score 로깅 (디버깅용)
    logger.info(`  📊 ${stock.stock_code}: score=${tech.score} RSI=${tech.rsi14.toFixed(0)} ADX=${tech.adx14.toFixed(0)}(${tech.trendStrength}) MACD=${tech.macdCrossover}`, { component: 'TRACK_B' });

    // ─── ADX 횡보장 필터 ───────────────────────────────────────────────
    // ADX < 20 = 방향성 없음 = 저점에서 사고 팔다 끝나는 박스권 루프
    // SWING/DEFENSE 모드: ADX WEAK → 신규 진입 완전 차단 (추세 없으면 타지 않음)
    // SCALPING은 예외 (단타는 방향성 불필요)
    const aiScore = aiScoreMap.get(stock.stock_code) ?? 0;
    const buyThreshold = strategyParams.buyThreshold;

    if (mode !== 'SCALPING' && tech.trendStrength === 'WEAK') {
      // SCALPING만 예외 — SWING/DEFENSE 횡보장 진입 억제 (임계치 그대로, +5 제거)
      if (aiScore < buyThreshold) {
        logger.info(`  ⏸️ ${stock.stock_code}: ADX=${tech.adx14.toFixed(0)} 횡보(WEAK) → AI=${aiScore} < ${buyThreshold}, 진입 스킵`, { component: 'TRACK_B' });
        continue;
      }
    }
    // ───────────────────────────────────────────────────────────────────

    // ─── 하락추세 진입 차단 (낙칼 방지) ────────────────────────────────
    // 현재가 < SMA20 = 중기 하락추세 = 물려서 손절 반복의 근원
    // AI 점수 70 이상일 때만 예외 허용 (강한 확신 = 추세 역행 허용)
    if (mode === 'SWING' || mode === 'DEFENSE') {
      const sma20val = tech.sma20;
      // AI 있으면 70점 이상 확신 필요, AI 없으면 기술 점수 65점 이상으로 대체
      const sma20AiThreshold = aiScore > 0 ? 70 : 999; // AI 없을 땐 기술 점수로만 판단
      const sma20TechOk = tech.score >= 65 && tech.macdCrossover === 'BULLISH';
      if (price.currentPrice < sma20val && aiScore < sma20AiThreshold && !sma20TechOk) {
        logger.info(`  ⬇️ ${stock.stock_code}: 현재가 < SMA20 하락추세 → 진입 차단 (AI=${aiScore}, tech=${tech.score})`, { component: 'TRACK_B' });
        continue;
      }
    }
    // ───────────────────────────────────────────────────────────────────

    // 기술 단독 최소 점수 — 상향: 40→52 (저점에서 저품질 진입 방지)
    const minTechScore = mode === 'SCALPING' ? 55 : mode === 'DEFENSE' ? 65 : 52;

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

    // 물타기 차단: 익절 진행 중 체인 or SMA20 아래 깊은 하락 (추가 물타기는 손실만 키움)
    const chainCandles = chartData.get(chain.stock_code);
    const chainTech = chainCandles ? analyzeTechnicals(chainCandles) : null;
    const isBelowSma20Deep = chainTech ? price.currentPrice < chainTech.sma20 * 0.97 : false; // SMA20 -3% 이상 이탈 시 물타기 금지
    if (chain.status === 'PROFIT_TAKING' || isBelowSma20Deep) {
      if (isBelowSma20Deep) logger.info(`  🚫 ${chain.stock_code}: SMA20 -3% 이탈 → 물타기 차단 (손실확대 방지)`, { component: 'TRACK_B' });
      continue;
    }

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
