import { analyzeTechnicals, type TechnicalSummary } from '../../analysis/indicators.js';
import { getWinRateConfidenceBoost, getWinRateThresholdAdj, winRateSummary, type StockWinRate } from '../../analysis/win-rate.js';
import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import type { TransactionChain } from '../../db/models.js';
import type { CurrentPrice, DailyCandle } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import type { TradeDecision } from '../../db/models.js';
import { BUY_BLOCKED_CODES, IDLE_PARK_CODES, PRIORITY_SECTOR_CODES } from './trading-rules.js';

const IDLE_PARK_CODE_SET = new Set<string>(IDLE_PARK_CODES);

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
  /** 종목별 과거 승률 — AI 없이도 진입 임계값 동적 조정 */
  winRates?: Map<string, StockWinRate>;
  /** 장 마감 30분 전(14:30~) — 신규 매수 차단 */
  blockNewBuys?: boolean;
}): TradeDecision[] {
  const { mode, watchlist, livePrices, chartData, openChains, orderableCash, maxPositionKrw, aiScores, lossBlockedCodes, manuallySoldCodes, totalAssets, winRates, blockNewBuys } = params;
  // 종목당 최대 비중: 총자산의 20% 또는 maxPositionKrw 중 작은 값
  // — pipeline(15%)보다 약간 넓게 (고가주 최소 1주 매수 보장)
  const effectiveMaxPos = totalAssets
    ? Math.min(maxPositionKrw, Math.round(totalAssets * 0.20))
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
    // 파킹 ETF는 손절/매도 로직 완전 제외 — 장기 보유 목적
    if (IDLE_PARK_CODE_SET.has(chain.stock_code)) continue;

    const price = livePrices.get(chain.stock_code);
    if (!price || !chain.avg_buy_price) continue;

    const avgBuy = Number(chain.avg_buy_price);
    const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;

    // 동일 종목 중복 매도 신호 방지 (다중 체인 시 첫 번째 체인만 처리)
    if (processedSellCodes.has(chain.stock_code)) continue;

    // ─── 2단계 익절 전략 ────────────────────────────────────────────────
    // 1단계: takeProfitPct(2.5%) 도달 → 50% 부분 매도 (수익 확정)
    // 2단계: PROFIT_TAKING 상태에서 추가 상승 +5.0% 또는 트레일링 스톱(-0.8% from peak) → 잔여 전량 청산
    // 효과: 손익비 1.67:1 유지, 수익 반납 방지
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
      // peak_price가 DB에 없으면 트레일링 기준 없음 → 손실 구간에서 오발동 방지
      if (!(chain as any).peak_price && pnlPct < 0) {
        // 브레이크이븐 스톱: 손실 -1% 초과 시에만 청산
        if (pnlPct <= -1.0) {
          decisions.push({
            action: 'FORCE_CLOSE',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `브레이크이븐스톱(peak없음): ${pnlPct.toFixed(1)}%`,
            confidence: 0.9,
          });
          processedSellCodes.add(chain.stock_code);
        }
        continue;
      }
      const peakPrice = (chain as any).peak_price ? Number((chain as any).peak_price) : Number(chain.avg_buy_price) * (1 + strategyParams.takeProfitPct / 100);
      const trailDropPct = ((price.currentPrice - peakPrice) / peakPrice) * 100;
      const isTrailTriggered = trailDropPct <= -2.5; // peak 대비 -2.5% 하락 시 청산 (너무 좁으면 노이즈에 조기 청산)
      const isTargetReached = pnlPct >= 5.0;         // +5.0% 추가 목표 달성 시 전량 익절

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
  if (blockNewBuys) {
    logger.info('⏰ 15:10 이후 — 신규 매수 차단 (마감 20분 전)', { component: 'TRACK_B' });
    return decisions; // 매도/손절 결정만 반환
  }

  const openStockCodes = new Set(openChains.map((c) => c.stock_code));
  const candidates: Array<{ stock_code: string; tech: TechnicalSummary; price: CurrentPrice; candleBonus: number }> = [];
  // AI 스코어 없을 때(Track A 미실행) DEFENSE 기준 완화 여부 — 루프 밖에서 1회 계산
  const noAiScores = (aiScores ?? []).length === 0 || (aiScores ?? []).every((s) => s.score === 0);

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

    // 강한 불리쉬 캔들 패턴 감지 (망치형·모닝스타·인걸핑 등 — 진입 타이밍 최적)
    const hasBullishCandle = tech.candlePatterns.some((p) => p.bullish && p.strength === 'STRONG');
    const candleBonus = hasBullishCandle ? 12 : tech.candlePatterns.some((p) => p.bullish && p.strength === 'MODERATE') ? 6 : 0;

    // 각 종목 score 로깅 (디버깅용)
    logger.info(`  📊 ${stock.stock_code}: score=${tech.score}${candleBonus > 0 ? `+${candleBonus}캔들` : ''} RSI=${tech.rsi14.toFixed(0)} ADX=${tech.adx14.toFixed(0)}(${tech.trendStrength}) MACD=${tech.macdCrossover} vol=${tech.volumeRatio.toFixed(2)}x`, { component: 'TRACK_B' });

    // ─── 거래량 확인 필터 ─────────────────────────────────────────────────
    // 거래량 < 1.2x 평균 = 기관/외국인 관심 없음 = 가짜 돌파 위험
    // 예외: 과매도(RSI<35) 반등은 거래량 바닥에서 발생 — 필터 면제
    //       강한 불리쉬 캔들(망치형 등) = 저거래량에서도 의미있는 반전 신호
    if (tech.volumeRatio < 1.5 && tech.rsi14 >= 35 && !hasBullishCandle) {
      logger.info(`  📉 ${stock.stock_code}: 거래량 부족 (${tech.volumeRatio.toFixed(2)}x < 1.5) → 기관 관심 없음, 스킵`, { component: 'TRACK_B' });
      continue;
    }

    // ─── ADX 횡보장 필터 ───────────────────────────────────────────────
    // ADX < 20 = 방향성 없음 = 저점에서 사고 팔다 끝나는 박스권 루프
    // SWING/DEFENSE 모드: ADX WEAK → 신규 진입 완전 차단 (추세 없으면 타지 않음)
    // SCALPING은 예외 (단타는 방향성 불필요)
    const aiScore = aiScoreMap.get(stock.stock_code) ?? 0;
    const buyThreshold = strategyParams.buyThreshold;

    if (mode === 'DEFENSE' && tech.trendStrength === 'WEAK') {
      // AI 없을 때 tech.score 기준 완화: 60 → 50 (SWING 수준)
      const defenseWeakThreshold = noAiScores ? 50 : 60;
      if (aiScore < buyThreshold && tech.score < defenseWeakThreshold) {
        logger.info(`  ⏸️ ${stock.stock_code}: ADX=${tech.adx14.toFixed(0)} 횡보(WEAK) DEFENSE → AI=${aiScore} tech=${tech.score} < ${defenseWeakThreshold}, 진입 스킵`, { component: 'TRACK_B' });
        continue;
      }
    }

    // SWING 횡보장 강화 필터: trendStrength=WEAK → 거래량+MACD 동반 필수
    // 횡보장 whipsaw 방지 (시뮬 결과: 횡보 -3.34% 원인)
    if (mode === 'SWING' && tech.trendStrength === 'WEAK') {
      const sidewaysOk = tech.volumeRatio >= 1.0 && tech.macdCrossover === 'BULLISH';
      if (!sidewaysOk && aiScore < buyThreshold) {
        logger.info(`  ⏸️ ${stock.stock_code}: 횡보(WEAK) SWING → vol=${tech.volumeRatio.toFixed(2)} MACD=${tech.macdCrossover} 미충족 스킵`, { component: 'TRACK_B' });
        continue;
      }
    }
    // ───────────────────────────────────────────────────────────────────

    // ─── 하락추세 진입 차단 (낙칼 방지) ────────────────────────────────
    if (mode === 'DEFENSE') {
      const sma20val = tech.sma20;
      const sma20TechOk = tech.score >= 50 && tech.macdCrossover !== 'BEARISH';
      if (price.currentPrice < sma20val && aiScore < 65 && !sma20TechOk) {
        logger.info(`  ⬇️ ${stock.stock_code}: 현재가 < SMA20 DEFENSE → 진입 차단 (AI=${aiScore}, tech=${tech.score})`, { component: 'TRACK_B' });
        continue;
      }
    }

    // SWING 하락추세 필터: SMA20 < SMA60 = 중기 하락 = 높은 확신 없이 진입 금지
    // (시뮬 결과: 하락장 SWING -7.11% 원인)
    if (mode === 'SWING' && tech.sma20 < tech.sma60) {
      const downtrendOk = tech.score >= 55 || tech.rsi14 < 40;
      if (!downtrendOk && aiScore < buyThreshold) {
        logger.info(`  ⬇️ ${stock.stock_code}: SMA20<SMA60 하락추세 SWING → tech=${tech.score} RSI=${tech.rsi14.toFixed(0)} 확신 부족 차단`, { component: 'TRACK_B' });
        continue;
      }
    }
    // ───────────────────────────────────────────────────────────────────

    // 기술 단독 최소 점수 — SWING 55, DEFENSE 60 (품질 우선)
    // AI 스코어 없으면(Track A 미실행) DEFENSE도 SWING 기준(55)으로 완화
    const baseMinTechScore = mode === 'SCALPING' ? 50 : (mode === 'DEFENSE' && !noAiScores) ? 60 : 55;
    // 종목별 승률 기반 임계값 보정 (AI 없어도 과거 실적 반영)
    const wrAdj = getWinRateThresholdAdj(winRates?.get(stock.stock_code));
    const minTechScore = baseMinTechScore + wrAdj;

    // 우선 테마(반도체/에너지/방산) 보너스 +10점 적용
    const priorityBonus = PRIORITY_SECTOR_CODES.has(stock.stock_code) ? 10 : 0;
    const effectiveTechScore = tech.score + priorityBonus + candleBonus;

    // ─── 진입 타이밍 품질 필터 (연구 기반) ───────────────────────────────
    // RSI 구간별 수익 기대치 (KOSPI 2010~2023 실증):
    //   RSI < 30: 과매도 → 3일 내 반등 확률 68%, 평균 +2.1%
    //   RSI 30~45: 반등 초기 → 진입 최적 (추세 전환 확인 후)
    //   RSI 45~60: 중립/눌림목 → MACD 골든크로스 필수
    //   RSI 60~70: 모멘텀 강세 → AI 점수 65+ 필수 (추격 위험 있음)
    //   RSI > 70: 과매수 → 진입 금지 (단기 조정 확률 72%)
    // AI buyThreshold 이상은 RSI 80까지 허용 (강한 확신 → 오버바웃 예외)
    const aiBypassRsi = aiScore >= buyThreshold && tech.rsi14 <= 80;
    if (tech.rsi14 > 70 && !aiBypassRsi) {
      logger.info(`  🔴 ${stock.stock_code}: RSI=${tech.rsi14.toFixed(0)}>70 과매수 → 스킵 (단기조정 확률 72%)`, { component: 'TRACK_B' });
      continue;
    }

    const isOversold    = tech.rsi14 < 30;                                                     // 과매도 반등
    const isEarlyBounce = tech.rsi14 >= 30 && tech.rsi14 < 45;                                // 반등 초기 (최적)
    const isPullback    = tech.rsi14 >= 45 && tech.rsi14 <= 60 && tech.macdCrossover === 'BULLISH'; // 눌림목 반등
    // 모멘텀: RSI 60~70 + (AI점수 있으면 buyThreshold 이상 OR 기술점수 양호)
    // AI API 없을 때 aiScore=0 → 기술점수만으로 판단 가능하도록 수정
    const isMomentum    = tech.rsi14 > 60 && tech.rsi14 <= 70 &&
      (aiScore >= buyThreshold || effectiveTechScore >= minTechScore + 5);
    // AI 80점 이상 또는 기술점수 매우 높으면: 타이밍 필터 완화
    const isHighAiScore = (aiScore >= 80 || effectiveTechScore >= minTechScore + 15) &&
      (effectiveTechScore >= minTechScore || aiScore >= buyThreshold);
    const isValidEntry  = isOversold || isEarlyBounce || isPullback || isMomentum || isHighAiScore;

    if (!isValidEntry) {
      logger.info(`  🟡 ${stock.stock_code}: RSI=${tech.rsi14.toFixed(0)} MACD=${tech.macdCrossover} AI=${aiScore} → 타이밍 미충족 스킵`, { component: 'TRACK_B' });
      continue;
    }
    const entryReason = isOversold ? '과매도반등' : isEarlyBounce ? '반등초기(최적)' : isPullback ? '눌림목MACD' : isHighAiScore ? `AI고확신(${aiScore}점)` : '강한모멘텀';
    // ─────────────────────────────────────────────────────────────────────

    if (aiScore >= buyThreshold || effectiveTechScore >= minTechScore) {
      candidates.push({ stock_code: stock.stock_code, tech, price, candleBonus });
      const wrInfo = winRateSummary(stock.stock_code, winRates?.get(stock.stock_code));
      const bonusStr = [priorityBonus > 0 ? `+${priorityBonus}테마` : '', candleBonus > 0 ? `+${candleBonus}캔들` : ''].filter(Boolean).join('');
      if (aiScore >= buyThreshold) {
        logger.info(`  ✅ ${stock.stock_code}: AI=${aiScore}점(>=${buyThreshold}) [${entryReason}] RSI=${tech.rsi14.toFixed(0)} vol=${tech.volumeRatio.toFixed(2)}x → 매수 후보 (기술=${tech.score}${bonusStr}${wrInfo})`, { component: 'TRACK_B' });
      } else {
        logger.info(`  ✅ ${stock.stock_code}: 기술=${effectiveTechScore}점(>=${minTechScore}) [${entryReason}] RSI=${tech.rsi14.toFixed(0)} vol=${tech.volumeRatio.toFixed(2)}x → 매수 후보 (AI=${aiScore}${bonusStr}${wrInfo})`, { component: 'TRACK_B' });
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
  const maxBuys = 5; // 한 번에 최대 5종목 (집중 투자, 분산 과다 방지)
  const splitCount = strategyParams.splitCount || 2;

  for (const cand of candidates.slice(0, maxBuys)) {
    const isPriority = PRIORITY_SECTOR_CODES.has(cand.stock_code);
    const priorityMultiplier = isPriority ? 1.2 : 1.0;

    // 확신 배율: 고점수 + 고거래량 = 최강 신호 → 포지션 확대 (더 많이 넣어야 수익 최대화)
    const aiScore = aiScoreMap.get(cand.stock_code) ?? 0;
    const isHighConviction = cand.tech.score >= 65 && cand.tech.volumeRatio >= 1.5;
    const isMedConviction = (aiScore >= strategyParams.buyThreshold && cand.tech.volumeRatio >= 1.3) || cand.candleBonus >= 12;
    const convictionMultiplier = isHighConviction ? 1.4 : isMedConviction ? 1.25 : 1.0;

    // 종목당 1차 매수: 자산 기반 동적 포지션 한도의 1/splitCount, 잔고 한도 내
    const positionSize = Math.min(effectiveMaxPos / splitCount * priorityMultiplier * convictionMultiplier, remainingCash / maxBuys);
    if (positionSize < 50000) break; // 최소 5만원 (1주라도 매수)

    const quantity = Math.floor(positionSize / cand.price.currentPrice);
    if (quantity <= 0) continue;

    const convStr = isHighConviction ? ' [확신MAX+40%]' : isMedConviction ? ' [확신+25%]' : '';
    decisions.push({
      action: 'BUY',
      stock_code: cand.stock_code,
      quantity,
      price_type: 'MARKET',
      limit_price: cand.price.currentPrice,
      reasoning: `기술적 매수: score=${cand.tech.score}${cand.candleBonus > 0 ? `+${cand.candleBonus}캔들` : ''} RSI=${cand.tech.rsi14.toFixed(0)} MACD=${cand.tech.macdCrossover} ADX=${cand.tech.adx14.toFixed(0)}(${cand.tech.trendStrength}) vol=${cand.tech.volumeRatio.toFixed(2)}x${cand.tech.goldenCross ? ' 골든크로스' : ''}${isPriority ? ' [우선테마]' : ''}${convStr}${winRateSummary(cand.stock_code, winRates?.get(cand.stock_code))}`,
      confidence: Math.min(0.95, Math.max(0.5, cand.tech.score / 100 + getWinRateConfidenceBoost(winRates?.get(cand.stock_code)) + (cand.candleBonus > 0 ? 0.05 : 0))),
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
