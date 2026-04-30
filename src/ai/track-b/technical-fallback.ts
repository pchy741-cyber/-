import { analyzeTechnicals, detectStructuralPatterns, volumeProfile, analyzeIntraday, type TechnicalSummary } from '../../analysis/indicators.js';
import { getWinRateConfidenceBoost, getWinRateThresholdAdj, winRateSummary, type StockWinRate } from '../../analysis/win-rate.js';
import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import type { TransactionChain } from '../../db/models.js';
import { getMinuteChart, isMarketOpen, type CurrentPrice, type DailyCandle } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import type { TradeDecision } from '../../db/models.js';
import { BUY_BLOCKED_CODES, IDLE_PARK_CODES, PRIORITY_SECTOR_CODES } from './trading-rules.js';

const IDLE_PARK_CODE_SET = new Set<string>(IDLE_PARK_CODES);

/**
 * AI API 없이 기술적 지표만으로 매매 판단
 * RSI + MACD + 볼린저밴드 + ADX + 골든/데드크로스 종합
 */
export async function technicalFallbackDecisions(params: {
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
  /** 황금비율 배분 목표 — 주식 비중 초과 시 매수 기준 상향 (더 선택적 진입) */
  allocationTarget?: { stock_pct: number; rebalance_threshold_pct: number; is_active: boolean } | null;
  /** 현재 주식 포지션 가치 (황금비율 계산용) */
  currentStockValue?: number;
}): Promise<TradeDecision[]> {
  const { mode, watchlist, livePrices, chartData, openChains, orderableCash, maxPositionKrw, aiScores, lossBlockedCodes, manuallySoldCodes, totalAssets, winRates, blockNewBuys, allocationTarget, currentStockValue } = params;
  // 종목당 최대 비중: 총자산의 20% 또는 maxPositionKrw 중 작은 값
  // — pipeline(15%)보다 약간 넓게 (고가주 최소 1주 매수 보장)
  const effectiveMaxPos = totalAssets
    ? Math.min(maxPositionKrw, Math.round(totalAssets * 0.25))
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
      // 1단계: 첫 익절 — 30% 부분 매도 (낮은 타점에서 소량만 확정, 나머지 70%는 더 오른 후 청산)
      const sellQty = Math.ceil(chain.total_quantity * 0.3);
      if (sellQty > 0 && sellQty < chain.total_quantity) {
        decisions.push({
          action: 'PARTIAL_SELL',
          stock_code: chain.stock_code,
          quantity: sellQty,
          price_type: 'MARKET',
          reasoning: `1단계 익절(30%): +${pnlPct.toFixed(1)}% 도달 → 나머지 70% 트레일링 대기`,
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

    // 손절 (ATR 동적 손절 vs 전략 고정 손절 — 더 보수적인 쪽 적용)
    const sellCheckCandles = chartData.get(chain.stock_code);
    const sellTech = sellCheckCandles && sellCheckCandles.length >= 30 ? analyzeTechnicals(sellCheckCandles) : null;
    const dynamicStop = sellTech ? sellTech.dynamicStopLossPct : strategyParams.stopLossPct;
    // ATR 기반이 고정 손절보다 좁으면 ATR 우선 (더 빠른 손절로 손실 최소화)
    const effectiveStop = Math.max(strategyParams.stopLossPct, dynamicStop);
    if (pnlPct <= effectiveStop) {
      // ── RSI<35 + 거래량 급증 = 패닉 매도 손절 억제 (공황 매도 직후 반등 확률 높음) ──
      if (sellTech && sellTech.rsi14 < 35 && sellTech.volumeRatio >= 2.5) {
        logger.info(
          `🛡️ 패닉매도 손절 억제: ${chain.stock_code} RSI=${sellTech.rsi14.toFixed(0)}<35 거래량${sellTech.volumeRatio.toFixed(1)}x급증 — 공황 손절 대신 보유 유지`,
          { component: 'TRACK_B' },
        );
        continue; // 이 사이클 손절 스킵 — 다음 사이클에서 재판단
      }

      // ── 대형 포지션 회복 신호 판단 (비중 8% 이상 — 팍 손절 대신 절반 지키기) ──
      // 논리: 비중이 크면 전량 손절 충격이 크고, 회복 신호 있으면 더 기다리는 게 유리
      // 회복 조건 중 2개 이상 충족 시 50% 부분 손절 후 대기 (전량 강제청산 차단)
      const positionValue = price.currentPrice * Number(chain.total_quantity);
      const positionWeight = (totalAssets ?? 0) > 0 ? positionValue / totalAssets! : 0;
      const isLargePosition = positionWeight >= 0.08; // 포트폴리오 8% 이상 = 대형

      let usedPartialStop = false;
      if (isLargePosition && sellTech) {
        const recoverySignals = [
          sellTech.rsi14 < 32,                                                // 극단 과매도 (단기 반등 확률 68%)
          sellTech.macdHistogram > 0,                                         // MACD 히스토그램 양전환 (상승 모멘텀)
          sellTech.bollingerPosition === 'BELOW_LOWER' || sellTech.bollingerPosition === 'NEAR_LOWER', // 볼린저 하단 지지
          sellTech.volumeRatio < 0.6,                                         // 거래량 급감 = 매도 소진
          sellTech.rsi2 < 10,                                                 // RSI(2) 극단 과매도 — 91% 반등 확률
        ].filter(Boolean).length;

        if (recoverySignals >= 2) {
          // 전량 손절 대신 50% 부분 매도: 절반 확정 손절 + 나머지 회복 대기
          const partialQty = Math.ceil(Number(chain.total_quantity) * 0.5);
          if (partialQty > 0 && partialQty < Number(chain.total_quantity)) {
            logger.info(
              `🛡️ 대형포지션 부분손절(50%): ${chain.stock_code} ${pnlPct.toFixed(1)}% | 비중${(positionWeight*100).toFixed(0)}% | 회복신호${recoverySignals}개 → 전량청산 보류`,
              { component: 'TRACK_B' },
            );
            decisions.push({
              action: 'PARTIAL_SELL',
              stock_code: chain.stock_code,
              quantity: partialQty,
              price_type: 'MARKET',
              reasoning: `대형포지션 부분손절(50%): ${pnlPct.toFixed(1)}% | 회복신호${recoverySignals}개(RSI과매도/MACD반전/볼린저지지/거래량소진) → 나머지 50% 회복 대기`,
              confidence: 0.85,
            });
            processedSellCodes.add(chain.stock_code);
            usedPartialStop = true;
          }
        }
      }

      if (!usedPartialStop) {
        decisions.push({
          action: 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `손절: ${pnlPct.toFixed(1)}% (ATR동적=${dynamicStop.toFixed(1)}% 고정=${strategyParams.stopLossPct}%)`,
          confidence: 0.95,
        });
        processedSellCodes.add(chain.stock_code);
      }
      continue;
    }

    // 기술적 지표 기반 매도 판단 (대형 포지션은 STRONG_SELL도 완화)
    const candles = chartData.get(chain.stock_code);
    if (candles && candles.length >= 60) {
      const tech = analyzeTechnicals(candles);
      if (tech && tech.overallSignal === 'STRONG_SELL') {
        const positionValueSell = price.currentPrice * Number(chain.total_quantity);
        const positionWeightSell = (totalAssets ?? 0) > 0 ? positionValueSell / totalAssets! : 0;
        // 대형 포지션(8% 이상) + STRONG_SELL: 전량 매도 대신 30% 부분 매도
        if (positionWeightSell >= 0.08) {
          const partialQty = Math.ceil(Number(chain.total_quantity) * 0.3);
          if (partialQty > 0 && partialQty < Number(chain.total_quantity)) {
            decisions.push({
              action: 'PARTIAL_SELL',
              stock_code: chain.stock_code,
              quantity: partialQty,
              price_type: 'MARKET',
              reasoning: `대형포지션 기술적 부분매도(30%): STRONG_SELL | RSI=${tech.rsi14.toFixed(0)} MACD=${tech.macdCrossover} | 나머지 70% 추가 확인 후 판단`,
              confidence: 0.65,
            });
            processedSellCodes.add(chain.stock_code);
          }
        } else {
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
  }

  // 2. 신규 매수 판단 (기술적 지표 기반)
  if (blockNewBuys) {
    logger.info('⏰ 15:10 이후 — 신규 매수 차단 (마감 20분 전)', { component: 'TRACK_B' });
    return decisions; // 매도/손절 결정만 반환
  }

  // 황금비율 배분 편차 계산 — 주식 비중 초과 시 매수 기준 상향
  let allocationBuyPenalty = 0; // 양수 = minTechScore 상향 (더 선택적)
  if (allocationTarget?.is_active && totalAssets && totalAssets > 0 && currentStockValue !== undefined) {
    const currentStockPct = (currentStockValue / totalAssets) * 100;
    const targetStockPct = allocationTarget.stock_pct;
    const threshold = allocationTarget.rebalance_threshold_pct;
    const deviation = currentStockPct - targetStockPct;
    if (deviation > threshold) {
      // 주식 비중 목표 초과 → 신규 매수 기준 상향 (최대 +15점)
      allocationBuyPenalty = Math.min(15, Math.round((deviation - threshold) * 1.5));
      logger.info(`⚖️ 황금비율 편차: 현재주식 ${currentStockPct.toFixed(1)}% > 목표 ${targetStockPct}%+${threshold}% → 매수 임계값 +${allocationBuyPenalty}점 상향`, { component: 'TRACK_B' });
    } else if (deviation < -threshold) {
      // 주식 비중 목표 미달 → 매수 기준 소폭 완화 (최대 -5점)
      allocationBuyPenalty = Math.max(-5, Math.round((deviation + threshold) * 0.5));
      logger.info(`⚖️ 황금비율 편차: 현재주식 ${currentStockPct.toFixed(1)}% < 목표 ${targetStockPct}%-${threshold}% → 매수 임계값 ${allocationBuyPenalty}점 완화`, { component: 'TRACK_B' });
    }
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
    const minTechScore = baseMinTechScore + wrAdj + allocationBuyPenalty;

    // 우선 테마(반도체/에너지/방산) 보너스 +10점 적용
    const priorityBonus = PRIORITY_SECTOR_CODES.has(stock.stock_code) ? 10 : 0;

    // ─── 구조적 패턴 보너스 ────────────────────────────────────────────────
    const structPatterns = detectStructuralPatterns(candles);
    const structBonus = structPatterns.reduce((sum, p) => sum + p.score, 0);
    if (structPatterns.length > 0) {
      logger.info(`  🔷 ${stock.stock_code}: 구조패턴 [${structPatterns.map(p => p.label).join(', ')}] → ${structBonus > 0 ? '+' : ''}${structBonus}점`, { component: 'TRACK_B' });
    }

    // ─── 볼륨 프로파일 지지/저항 보너스 ──────────────────────────────────
    const vpLevels = volumeProfile(candles);
    const curPrice = price.currentPrice;
    const nearSupport = vpLevels.some(l => l.isSupport && Math.abs(l.priceLevel - curPrice) / curPrice < 0.02);
    const nearResistance = vpLevels.some(l => l.isResistance && Math.abs(l.priceLevel - curPrice) / curPrice < 0.015);
    const vpBonus = nearSupport ? 8 : nearResistance ? -6 : 0;
    if (vpBonus !== 0) {
      logger.info(`  📊 ${stock.stock_code}: 볼륨프로파일 ${nearSupport ? '지지선 근처' : '저항선 근처'} → ${vpBonus > 0 ? '+' : ''}${vpBonus}점`, { component: 'TRACK_B' });
    }

    const effectiveTechScore = tech.score + priorityBonus + candleBonus + structBonus + vpBonus;

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

    // ─── SCALPING 전용 진입 기준 ─────────────────────────────────────────
    // 단타는 과매도 반등(RSI<30) 대신 모멘텀 돌파에 집중
    // BB 상단 돌파 / TTM 발사 / VWAP 돌파 + 거래량 2배 이상 필수
    // 예외: AI점수 >= buyThreshold(72)이면 모멘텀 신호 없어도 매수 허용
    if (mode === 'SCALPING') {
      const hasMomentumSignal =
        tech.bollingerBreakout === 'UP' ||
        tech.ttmSqueeze.fireSignal === 'LONG' ||
        tech.vwapCross === 'JUST_ABOVE';
      const scalpVolumeOk = tech.volumeRatio >= 2.0;
      const scalpRsiOk = tech.rsi14 >= 40 && tech.rsi14 <= 72; // 모멘텀 구간 (과매도 반등은 너무 느림)
      const aiBypassScalp = aiScore >= buyThreshold; // AI 고확신 → 엄격 필터 면제
      if (!aiBypassScalp && (!hasMomentumSignal || !scalpVolumeOk || !scalpRsiOk)) {
        logger.info(
          `  ⚡ ${stock.stock_code}: SCALPING 기준 미달 — 모멘텀=${hasMomentumSignal ? '✓' : '✗'} vol=${tech.volumeRatio.toFixed(1)}x(>=2.0) RSI=${tech.rsi14.toFixed(0)}(40-72) AI=${aiScore}(bypass=${aiBypassScalp}) → 스킵`,
          { component: 'TRACK_B' },
        );
        continue;
      }
      if (aiBypassScalp && (!hasMomentumSignal || !scalpVolumeOk || !scalpRsiOk)) {
        logger.info(
          `  ✅ ${stock.stock_code}: SCALPING — AI고확신(${aiScore}점>=${buyThreshold}) 모멘텀필터 면제`,
          { component: 'TRACK_B' },
        );
      }
    }
    // ───────────────────────────────────────────────────────────────────
    const squeezeTag = tech.bollingerBreakout === 'UP' ? '🎯BB스퀴즈돌파' : tech.bollingerSqueeze ? '🔃BB응축중' : '';
    const vwapTag = tech.vwapCross === 'JUST_ABOVE' ? '⚡VWAP돌파' : tech.vwapPullback ? '🔁VWAP풀백' : '';
    const ttmTag = tech.ttmSqueeze.fireSignal === 'LONG' ? `🚀TTM발사(${tech.ttmSqueeze.consecutiveSqueezeOn}봉)` : '';
    const rsi2Tag = tech.rsi2 < 15 ? `📉RSI2(${tech.rsi2.toFixed(0)})` : '';
    const entryReason = [
      isOversold ? '과매도반등' : isEarlyBounce ? '반등초기(최적)' : isPullback ? '눌림목MACD' : isHighAiScore ? `AI고확신(${aiScore}점)` : '강한모멘텀',
      squeezeTag, vwapTag, ttmTag, rsi2Tag,
    ].filter(Boolean).join('+');
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

  // ─── 분봉 인트라데이 확인 (상위 3개 후보만, 장중에만) ──────────────────
  const intradayBonus = new Map<string, number>();
  if (isMarketOpen() && candidates.length > 0) {
    const top3 = candidates.slice(0, 3);
    await Promise.allSettled(top3.map(async (cand) => {
      try {
        const minuteCandles = await getMinuteChart(cand.stock_code);
        if (minuteCandles.length >= 5) {
          const intraday = analyzeIntraday(minuteCandles);
          intradayBonus.set(cand.stock_code, intraday.score);
          logger.info(`  ⏱️ ${cand.stock_code}: 분봉신호 ${intraday.trend} score=${intraday.score} vol급등=${intraday.volumeSurge} | ${intraday.reason}`, { component: 'TRACK_B' });
        }
      } catch {
        // 분봉 실패 시 무시 — 일봉 분석으로 진행
      }
    }));
  }

  // ─── 점수 기반 교체매매: 고점수 신호 왔는데 현금 부족 시 저점수 보유종목 청산 ───
  // 조건: 1위 후보 AI점수 ≥ 80점 AND 현금 < 1차 매수금액 AND 교체 대상 점수 차 ≥ 15점
  if (!blockNewBuys && candidates.length > 0 && mode !== 'SCALPING') {
    const topCand = candidates[0];
    const topAiScore = aiScoreMap.get(topCand.stock_code) ?? 0;
    const topScore = topAiScore + topCand.tech.score;
    const needCash = Math.min(effectiveMaxPos / (strategyParams.splitCount || 2), orderableCash + 1);
    const isHighConvictionCandidate = topAiScore >= 80 || (topCand.tech.score >= 70 && topAiScore >= (strategyParams.buyThreshold ?? 58));

    if (isHighConvictionCandidate && orderableCash < needCash) {
      // 교체 대상: 파킹 ETF 제외, 수익 중인 종목 우선 (손실 실현 최소화)
      // 점수가 가장 낮은 종목 선택
      const tradingChains = openChains.filter(
        (c) => !IDLE_PARK_CODE_SET.has(c.stock_code) && Number(c.total_quantity) > 0,
      );

      if (tradingChains.length > 0) {
        // 보유 종목별 현재 AI 점수 조회
        const chainScored = tradingChains.map((c) => ({
          chain: c,
          aiScore: aiScoreMap.get(c.stock_code) ?? 0,
          techScore: (() => {
            const candles = chartData.get(c.stock_code);
            return analyzeTechnicals(candles ?? [])?.score ?? 0;
          })(),
        }));

        // 점수 낮은 순 정렬 → 가장 낮은 종목
        chainScored.sort((a, b) => (a.aiScore + a.techScore) - (b.aiScore + b.techScore));
        const weakest = chainScored[0];
        const weakScore = weakest.aiScore + weakest.techScore;
        const scoreDiff = topScore - weakScore;

        // 교체 조건: 점수 차 15점 이상 + 대상 종목이 현금 부족 해소에 충분한 보유량
        if (scoreDiff >= 15) {
          const price = livePrices.get(weakest.chain.stock_code);
          const qty = Number(weakest.chain.total_quantity ?? 0);
          const pnlPct = price && weakest.chain.avg_buy_price
            ? ((price.currentPrice - Number(weakest.chain.avg_buy_price)) / Number(weakest.chain.avg_buy_price)) * 100
            : 0;

          // 손실 중인 종목은 -3% 이내일 때만 교체 허용 (깊은 손실 실현 방지)
          const lossOk = pnlPct >= -3.0;

          if (lossOk && qty > 0 && price) {
            logger.info(
              `🔄 교체매매: ${weakest.chain.stock_code}(점수${weakScore}) → ${topCand.stock_code}(점수${topScore}) 차이=${scoreDiff}점 수익률=${pnlPct.toFixed(1)}%`,
              { component: 'TRACK_B' },
            );
            decisions.push({
              action: 'SELL',
              stock_code: weakest.chain.stock_code,
              quantity: qty,
              price_type: 'MARKET',
              limit_price: price.currentPrice,
              reasoning: `교체매매: 점수${weakScore}점 → 고확신${topScore}점(${topCand.stock_code}) 차이=${scoreDiff}점, 현금확보 후 재매수`,
              confidence: 0.7,
            });
          } else {
            logger.info(
              `⏭️ 교체매매 보류: ${weakest.chain.stock_code} 손실${pnlPct.toFixed(1)}% > -3% 한도 초과`,
              { component: 'TRACK_B' },
            );
          }
        }
      }
    }
  }

  // 현금 여유 확인하면서 매수 결정
  let remainingCash = orderableCash;
  // SCALPING: 개장 10분 단타 — 최대 2종목, 확신배율 없음 (과집중 방지)
  const maxBuys = mode === 'SCALPING' ? 2 : 7;
  const splitCount = strategyParams.splitCount || 2;

  for (const cand of candidates.slice(0, maxBuys)) {
    // 분봉 신호가 강하게 하락(-15 이하)이면 진입 보류
    const idBonus = intradayBonus.get(cand.stock_code) ?? 0;
    if (idBonus <= -15) {
      logger.info(`  ⏸️ ${cand.stock_code}: 분봉 하락신호(${idBonus}) → 일봉 매수 보류`, { component: 'TRACK_B' });
      continue;
    }

    const isPriority = PRIORITY_SECTOR_CODES.has(cand.stock_code);
    const priorityMultiplier = isPriority ? 1.2 : 1.0;

    // 확신 배율: 고점수 + 고거래량 = 최강 신호 → 포지션 확대
    // SCALPING 제외 — 단타는 크게 넣을수록 손실 폭이 커짐
    const aiScore = aiScoreMap.get(cand.stock_code) ?? 0;
    const isHighConviction = mode !== 'SCALPING' && cand.tech.score >= 65 && cand.tech.volumeRatio >= 1.5;
    const isMedConviction = mode !== 'SCALPING' && ((aiScore >= strategyParams.buyThreshold && cand.tech.volumeRatio >= 1.3) || cand.candleBonus >= 12);
    const convictionMultiplier = isHighConviction ? 1.4 : isMedConviction ? 1.25 : 1.0;

    // 승률 기반 포지션 배율: 실거래 고승률 종목은 더 크게 진입, 저승률은 줄임
    const wr = winRates?.get(cand.stock_code);
    const winRateMultiplier = wr && wr.sampleCount >= 3
      ? (wr.winRate >= 0.80 ? 1.35 : wr.winRate >= 0.65 ? 1.18 : wr.winRate <= 0.35 ? 0.65 : 1.0)
      : 1.0;
    if (winRateMultiplier !== 1.0) {
      logger.info(`  📈 ${cand.stock_code}: 승률배율 ×${winRateMultiplier} (승률${wr ? (wr.winRate * 100).toFixed(0) : 0}%/${wr?.sampleCount ?? 0}건)`, { component: 'TRACK_B' });
    }

    // 종목당 1차 매수: 자산 기반 동적 포지션 한도의 1/splitCount, 잔고 한도 내
    // remainingCash / 3 → 현금의 최대 1/3씩 배분 (현금 효율 극대화)
    const positionSize = Math.min(
      effectiveMaxPos / splitCount * priorityMultiplier * convictionMultiplier * winRateMultiplier,
      remainingCash / Math.max(3, maxBuys - candidates.indexOf(cand)),
    );
    if (positionSize < 200000) break; // 최소 20만원

    const quantity = Math.floor(positionSize / cand.price.currentPrice);
    if (quantity <= 0) continue;

    const convStr = isHighConviction ? ' [확신MAX+40%]' : isMedConviction ? ' [확신+25%]' : '';
    decisions.push({
      action: 'BUY',
      stock_code: cand.stock_code,
      quantity,
      price_type: 'MARKET',
      limit_price: cand.price.currentPrice,
      reasoning: `기술적 매수: score=${cand.tech.score}${cand.candleBonus > 0 ? `+${cand.candleBonus}캔들` : ''}${idBonus !== 0 ? `${idBonus > 0 ? '+' : ''}${idBonus}분봉` : ''} RSI=${cand.tech.rsi14.toFixed(0)} MACD=${cand.tech.macdCrossover} ADX=${cand.tech.adx14.toFixed(0)}(${cand.tech.trendStrength}) vol=${cand.tech.volumeRatio.toFixed(2)}x${cand.tech.goldenCross ? ' 골든크로스' : ''}${isPriority ? ' [우선테마]' : ''}${convStr}${winRateSummary(cand.stock_code, winRates?.get(cand.stock_code))}`,
      confidence: Math.min(0.95, Math.max(0.5, cand.tech.score / 100 + getWinRateConfidenceBoost(winRates?.get(cand.stock_code)) + (cand.candleBonus > 0 ? 0.05 : 0))),
      ai_score: aiScore > 0 ? aiScore : cand.tech.score, // 점수 기반 TP/SL 계산용
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
    // 하드 손실 한도: -8% 초과 수중에서는 물타기 절대 금지 (나락 방지)
    const isTooDeepUnderwater = pnlPct <= -8.0;
    // ── 지지선 확인 없는 물타기 차단 (Barber&Odean 1999: 기계적 물타기 → 추가 손실) ──
    // 볼린저 하단 또는 RSI 과매도 근처에서만 물타기 허용 (지지선 근거 있는 경우)
    const avgDownSupportOk = chainTech
      ? (chainTech.bollingerPosition === 'BELOW_LOWER' || chainTech.bollingerPosition === 'NEAR_LOWER' || chainTech.rsi14 < 38)
      : true; // 차트 없으면 허용 (데이터 없는 경우 차단 안 함)
    if (chain.status === 'PROFIT_TAKING' || isBelowSma20Deep || isTooDeepUnderwater || !avgDownSupportOk) {
      if (isBelowSma20Deep) logger.info(`  🚫 ${chain.stock_code}: SMA20 -3% 이탈 → 물타기 차단 (손실확대 방지)`, { component: 'TRACK_B' });
      if (isTooDeepUnderwater) logger.info(`  🚫 ${chain.stock_code}: ${pnlPct.toFixed(1)}% ≤ -8% → 물타기 하드 차단 (나락 방지)`, { component: 'TRACK_B' });
      if (!avgDownSupportOk && !isBelowSma20Deep && !isTooDeepUnderwater) logger.info(`  🚫 ${chain.stock_code}: 지지선 미확인(BB=${chainTech?.bollingerPosition} RSI=${chainTech?.rsi14.toFixed(0)}) → 물타기 차단`, { component: 'TRACK_B' });
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
