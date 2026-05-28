import { analyzeTechnicals, detectStructuralPatterns, volumeProfile, analyzeIntraday, type TechnicalSummary } from '../../analysis/indicators.js';
import { getWinRateConfidenceBoost, winRateSummary, type StockWinRate } from '../../analysis/win-rate.js';
import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import type { TransactionChain } from '../../db/models.js';
import { getMinuteChart, isMarketOpen, type CurrentPrice, type DailyCandle } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import type { TradeDecision } from '../../db/models.js';
import { BUY_BLOCKED_CODES, PRIORITY_SECTOR_CODES, MEGA_CAP_PRIORITY_CODES } from './trading-rules.js';
import { getPool } from '../../db/client.js';

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
  /** 손절 쿨다운 종목 코드 — 재진입 금지 (14일) */
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
  /** 강세장 부스터: true이면 TP +1.5% 상향 */
  kospiBoost?: boolean;
  /** 황금비율 배분 목표 — 주식 비중 초과 시 매수 기준 상향 (더 선택적 진입) */
  allocationTarget?: { stock_pct: number; rebalance_threshold_pct: number; is_active: boolean } | null;
  /** 현재 주식 포지션 가치 (황금비율 계산용) */
  currentStockValue?: number;
  /** 잡주 필터: 외국인/기관 동반 이탈(STRONG_SELL) 종목 코드 — 신규 매수 차단 */
  junkStockCodes?: Set<string>;
  /** 승률피드백: 눌림목 패턴 없으면 스킵 (연속 손절 시 자동 강화) */
  requirePullback?: boolean;
  /** 승률피드백: 최소 거래량 배율 하한 (기본 1.0, 저확신 구간 1.5/2.0) */
  minVolumeRatio?: number;
  /** 호가 매도벽 차단: bid/ask ≤ 0.5인 종목 — 진입 완전 차단 (hard gate) */
  orderbookBlockedCodes?: Set<string>;
}): Promise<TradeDecision[]> {
  const { mode, watchlist, livePrices, chartData, openChains, orderableCash, maxPositionKrw, aiScores, lossBlockedCodes, manuallySoldCodes, totalAssets, winRates, blockNewBuys, junkStockCodes } = params;
  const feedbackRequirePullback = params.requirePullback ?? false;
  const feedbackMinVolRatio = params.minVolumeRatio ?? 1.0;
  // 종목당 최대 비중: SNIPER=30%, 일반=25% (portfolio-guard 집중도 25%와 정합)
  // 소자산(50만 미만): 80%까지 허용 (1-2종목 집중)
  const maxPosFraction = (totalAssets && totalAssets < 500000) ? 0.80
    : mode === 'SNIPER' ? 0.30 : 0.25;
  const effectiveMaxPos = totalAssets
    ? Math.min(maxPositionKrw, Math.round(totalAssets * maxPosFraction))
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

  // SCALPING 09:30 강제청산 판단용 KST 시간 (개장 09:15까지 진입 → 09:30까지 TP 대기)
  const _scalpNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const _scalpH = _scalpNow.getUTCHours();
  const _scalpM = _scalpNow.getUTCMinutes();
  const isPastScalpDeadline = _scalpH > 9 || (_scalpH === 9 && _scalpM >= 30);

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

    // SCALPING 09:30 이후: 수익/손실 무관 즉시 전량 강제청산 (SCALPING은 개장 30분 한정)
    if (chain.strategy_mode === 'SCALPING' && isPastScalpDeadline && chain.total_quantity > 0) {
      decisions.push({
        action: 'FORCE_CLOSE',
        stock_code: chain.stock_code,
        quantity: chain.total_quantity,
        price_type: 'MARKET',
        reasoning: `SCALPING 강제청산(09:30): 개장 윈도우 종료, 전량 청산 (${pnlPct.toFixed(1)}%)`,
        confidence: 1.0,
      });
      processedSellCodes.add(chain.stock_code);
      continue;
    }

    // 외국인+기관 동반 이탈(STRONG_SELL 수급) 보유 종목 → 50% 부분 매도 (CEO 가이드)
    // junkStockCodes는 pipeline.ts에서 외국인+기관 동반 순매도 종목으로 구성됨
    if (junkStockCodes?.has(chain.stock_code) && chain.total_quantity > 0) {
      const partialQty = Math.ceil(chain.total_quantity * 0.5);
      if (partialQty > 0 && partialQty < chain.total_quantity) {
        decisions.push({
          action: 'PARTIAL_SELL',
          stock_code: chain.stock_code,
          quantity: partialQty,
          price_type: 'MARKET',
          reasoning: `외국인+기관 동반이탈(STRONG_SELL): 보유 50% 부분매도 → 수급 리스크 축소`,
          confidence: 0.85,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
      // 1주 등 분할 불가 → 전량 매도
      if (chain.total_quantity > 0) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `외국인+기관 동반이탈(STRONG_SELL): 분할불가 전량매도 → 수급 리스크 차단`,
          confidence: 0.85,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
    }

    // 마감 근접 수익 확정 — 3단계: 충분한 수익만, 그다음 소폭, 마지막에 손익분기만 확정
    // 15:00~15:10: 1.0%+ 수익만 청산 | 15:10~15:20: 0.3%+ | 15:20~15:25: 0%+ (진짜 마감 직전)
    const isNearClose = _scalpH === 15 && _scalpM < 25;
    if (isNearClose && chain.strategy_mode !== 'SCALPING' && chain.total_quantity > 0) {
      const closeThreshold = _scalpM >= 20 ? 0.0 : _scalpM >= 10 ? 0.3 : 1.0;
      const closeLabel = _scalpM >= 20 ? '15:20+' : _scalpM >= 10 ? '15:10+' : '15:00+';
      if (pnlPct >= closeThreshold) {
        logger.info(
          `⏰ 마감전 수익확정: ${chain.stock_code} +${pnlPct.toFixed(1)}% (${closeLabel} 임계값 ${closeThreshold}%)`,
          { component: 'TRACK_B' },
        );
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `마감전 수익확정(${closeLabel}): +${pnlPct.toFixed(1)}% → 장마감 손실 방지`,
          confidence: 0.92,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
    }

    // 체인별 TP/SL 우선: 체인 자체 모드 기준 폴백 (현재 모드와 다를 수 있음)
    const chainModeParams = chain.strategy_mode && chain.strategy_mode !== mode
      ? (STRATEGY_PARAMS[chain.strategy_mode as StrategyMode] ?? strategyParams)
      : strategyParams;
    const chainTp = chain.target_profit_pct ?? chainModeParams.takeProfitPct;
    const chainSl = chain.stop_loss_pct ?? chainModeParams.stopLossPct;
    const isScalpChain = chain.strategy_mode === 'SCALPING';

    // ── 실시간 AI 재평가: 보유 중 AI 점수 변화 → TP/SL 동적 조정 ──────
    // 진입 시 고정 기준 대신 현재 AI 점수로 유연하게 익절/손절 조정
    const realtimeAiScore = aiScoreMap.get(chain.stock_code) ?? 0;
    let effectiveTp = Number(chainTp);
    let effectiveSl = Number(chainSl);

    if (realtimeAiScore > 0 && !isScalpChain) {
      if (realtimeAiScore >= 85) {
        // AI 강세 지속 → 수익 극대화, TP 상향 (승자를 더 오래 보유)
        effectiveTp = Math.max(Number(chainTp), 8.0);
      } else if (realtimeAiScore < 55) {
        if (pnlPct > 1.0) {
          // AI 약세 전환 + 수익 구간 → 빠른 수익 확정 (TP를 현재 수익 -0.5%로 낮춤)
          effectiveTp = Math.min(Number(chainTp), Math.max(pnlPct - 0.5, 1.0));
        } else {
          // AI 강한 약세 전환 + 손실 구간 → SL 타이트 (-2.0%)
          effectiveSl = Math.max(Number(chainSl), -2.0);
        }
      }
    }

    // ── ATR 기반 동적 TP: 강한 추세에서 TP 확장 (승자를 더 오래 보유) ──
    if (!isScalpChain) {
      const holdingChart = chartData.get(chain.stock_code);
      if (holdingChart && holdingChart.length >= 20) {
        const holdTech = analyzeTechnicals(holdingChart);
        if (holdTech) {
          // 강한 상승 추세 (ADX>30 + RSI 45-70): TP × 1.5 (최대 15%)
          if (holdTech.adx14 > 30 && holdTech.rsi14 >= 45 && holdTech.rsi14 <= 70) {
            effectiveTp = Math.min(15.0, effectiveTp * 1.5);
          }
          // 중간 추세 (ADX>22 + 골든크로스 활성): TP × 1.2 (최대 12%)
          else if (holdTech.adx14 > 22 && holdTech.sma5 > holdTech.sma20) {
            effectiveTp = Math.min(12.0, effectiveTp * 1.2);
          }
        }
      }
    }

    // ─── 2단계 익절 전략 ────────────────────────────────────────────────
    // 1단계: takeProfitPct(2.5%) 도달 → 50% 부분 매도 (수익 확정)
    // 2단계: PROFIT_TAKING 상태에서 추가 상승 +5.0% 또는 트레일링 스톱(-0.8% from peak) → 잔여 전량 청산
    // 효과: 손익비 1.67:1 유지, 수익 반납 방지
    if (chain.status !== 'PROFIT_TAKING' && pnlPct >= effectiveTp) {
      // SCALPING: 전량 즉시 익절 (takeProfitRatio=1.0, 분할 없음)
      if (isScalpChain && chain.total_quantity > 0) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `SCALPING 익절(전량): +${pnlPct.toFixed(1)}% (목표 ${effectiveTp}%)`,
          confidence: 0.95,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
      // 1단계: 첫 익절 — 30% 부분 매도 (낮은 타점에서 소량만 확정, 나머지 70%는 더 오른 후 청산)
      const sellQty = Math.ceil(chain.total_quantity * 0.3);
      if (sellQty > 0 && sellQty < chain.total_quantity) {
        decisions.push({
          action: 'PARTIAL_SELL',
          stock_code: chain.stock_code,
          quantity: sellQty,
          price_type: 'MARKET',
          reasoning: `1단계 익절(30%): +${pnlPct.toFixed(1)}% 도달 (목표 ${effectiveTp.toFixed(1)}% AI${realtimeAiScore}점) → 나머지 70% 트레일링 대기`,
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
          reasoning: `기술적 익절(전량): +${pnlPct.toFixed(1)}% (목표 ${effectiveTp}%)`,
          confidence: 0.9,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
    }

    // 차트 지표 (트레일링 스톱 + 손절 공통 사용)
    const sellCheckCandles = chartData.get(chain.stock_code);
    const sellTech = sellCheckCandles && sellCheckCandles.length >= 30 ? analyzeTechnicals(sellCheckCandles) : null;

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
      // ATR 동적 트레일링: 2×ATR% (min -1.5%, max -5.0%) — 변동성 낮은 종목은 더 촘촘하게 잠금
      const trailAtrPct = sellTech?.atrPct ?? 1.5;
      const dynamicTrailPct = Math.max(-5.0, Math.min(-1.5, -(trailAtrPct * 2.0)));
      const isTrailTriggered = trailDropPct <= dynamicTrailPct;
      const isTargetReached = pnlPct >= 5.0;         // +5.0% 추가 목표 달성 시 전량 익절

      if (isTargetReached || isTrailTriggered) {
        decisions.push({
          action: isTargetReached ? 'SELL' : 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: isTargetReached
            ? `2단계 익절(잔여전량): +${pnlPct.toFixed(1)}% 목표달성`
            : `트레일링 스톱: peak 대비 ${trailDropPct.toFixed(2)}% 하락 (ATR기준 ${dynamicTrailPct.toFixed(1)}%, peak=${peakPrice.toFixed(0)}원)`,
          confidence: 0.9,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    // 손절 (ATR 동적 손절 vs 전략 고정 손절 — 더 보수적인 쪽 적용)
    const dynamicStop = sellTech ? sellTech.dynamicStopLossPct : effectiveSl;
    // ATR 기반이 고정 손절보다 좁으면 ATR 우선 (더 빠른 손절로 손실 최소화)
    // AI 80점+ 고확신 종목은 손절 기준 1.4배 넓히기 (일시적 노이즈로 조기손절 방지)
    // AI 65점 미만 약세 전환 시 effectiveSl=-1.5%로 타이트 (위에서 산출)
    const stopWidenMultiplier = realtimeAiScore >= 80 ? 1.4 : realtimeAiScore >= 65 ? 1.2 : 1.0;
    const effectiveStop = Math.max(effectiveSl, dynamicStop) * stopWidenMultiplier;
    if (pnlPct <= effectiveStop) {
      // ── RSI<35 + 거래량 급증 = 패닉 매도 손절 억제 — 단, 손절선 1.5배 초과 시 무조건 청산 ──
      // 억제 허용 구간: stopPct ~ stopPct×1.5 (예: -5%~-7.5%) — 이 밖에선 루프 방지
      const suppressionFloor = effectiveStop * 1.5;
      if (sellTech && sellTech.rsi14 < 35 && sellTech.volumeRatio >= 2.5 && pnlPct > suppressionFloor) {
        logger.info(
          `🛡️ 패닉매도 손절 억제: ${chain.stock_code} RSI=${sellTech.rsi14.toFixed(0)}<35 거래량${sellTech.volumeRatio.toFixed(1)}x급증 — 보유 유지 (floor=${suppressionFloor.toFixed(1)}%)`,
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
          reasoning: `손절: ${pnlPct.toFixed(1)}% (ATR동적=${dynamicStop.toFixed(1)}% 기준=${effectiveSl.toFixed(1)}% AI${realtimeAiScore}점)`,
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

  const allocationBuyPenalty = 0;
  const allocationBoostFirstEntry = true;

  // DB에서 점수 티어별 실거래 역산 비율 로드 (없으면 하드코딩 fallback)
  let scoreTierParams: Array<{ tier_min: number; tier_max: number; alloc_pct: number; sample_count: number }> = [];
  try {
    const { rows } = await getPool().query(
      `SELECT tier_min, tier_max, alloc_pct::float, sample_count FROM score_tier_params ORDER BY tier_min`,
    );
    scoreTierParams = rows;
  } catch { /* DB 없으면 하드코딩 사용 */ }

  const openStockCodes = new Set(openChains.map((c) => c.stock_code));
  const candidates: Array<{ stock_code: string; tech: TechnicalSummary; price: CurrentPrice; candleBonus: number }> = [];
  // AI 스코어 없을 때(Track A 미실행) DEFENSE 기준 완화 여부 — 루프 밖에서 1회 계산
  const noAiScores = (aiScores ?? []).length === 0 || (aiScores ?? []).every((s) => s.score === 0);

  for (const stock of watchlist) {
    // 대형 우선주 조기 참조 (buyThreshold, minTechScore, ADX 필터 등에서 사용)
    const megaCap = MEGA_CAP_PRIORITY_CODES.get(stock.stock_code);

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

    // ── 잡주/저품질 종목 필터 (3중 게이트) ─────────────────────────────────
    // 1) 저가주: 2,000원 미만 = 유동성 부족 + 잡주/테마주 위험
    const earlyPrice = livePrices.get(stock.stock_code);
    if (earlyPrice && earlyPrice.currentPrice > 0 && earlyPrice.currentPrice < 2000) {
      logger.info(`  🗑️ ${stock.stock_code}(${stock.stock_name}): 저가주(${earlyPrice.currentPrice}원 < 2000) — 잡주 필터`, { component: 'TRACK_B' });
      continue;
    }
    // 2) 외국인/기관 동반 이탈(STRONG_SELL): 스마트머니가 집단 탈출 중
    if (junkStockCodes?.has(stock.stock_code)) {
      logger.info(`  🗑️ ${stock.stock_code}(${stock.stock_name}): 외국인+기관 동반 이탈(STRONG_SELL) — 잡주 필터`, { component: 'TRACK_B' });
      continue;
    }
    // 3) 구조적 패배 종목: 90일 내 승률 < 25%, 5건 이상 표본 — 개미만 계속 잃는 종목
    const stockWr = winRates?.get(stock.stock_code);
    if (stockWr && stockWr.sampleCount >= 5 && stockWr.winRate < 0.25) {
      logger.info(`  🗑️ ${stock.stock_code}(${stock.stock_name}): 패배 이력 승률=${(stockWr.winRate * 100).toFixed(0)}%(${stockWr.sampleCount}건) — 잡주 필터`, { component: 'TRACK_B' });
      continue;
    }
    // ─────────────────────────────────────────────────────────────────────

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

    const aiScore = aiScoreMap.get(stock.stock_code) ?? 0;
    // 대형 우선주: buyThreshold 하향 (삼성전자/SK하이닉스 등은 변동성 낮아 고점수 안 나옴)
    const buyThreshold = megaCap
      ? strategyParams.buyThreshold - megaCap.thresholdReduction
      : strategyParams.buyThreshold;

    // ─── 거래량 확인 필터 ─────────────────────────────────────────────────
    // 예외: 과매도(RSI<35) 반등은 거래량 바닥에서 발생 / 강한 불리쉬 캔들
    // AI 80점+ → 0.5x, AI buyThreshold+ → 0.8x
    // 개별종목 AI=0 또는 전체 AI 없음 → 0.8x (기술지표만으로 판단)
    // ★ 시간대 보정: 장중 당일 거래량은 경과 시간에 비례하므로
    //   볼륨비율을 시간경과율로 나눠 풀데이 추정치로 환산 (10:19AM → ×5배 보정)
    const kstNow = new Date(Date.now() + 9 * 3600_000);
    const marketMinutes = (kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes()) - 540; // 09:00 기준
    const totalMarketMinutes = 390; // 09:00~15:30 = 390분
    const timeElapsedRatio = Math.max(0.15, Math.min(1.0, marketMinutes / totalMarketMinutes));
    const adjustedVolRatio = tech.volumeRatio / timeElapsedRatio;
    const noAiForStock = noAiScores || aiScore === 0; // 개별종목 AI 없으면 완화
    const volThreshold = Math.max(
      feedbackMinVolRatio,
      aiScore >= 80 ? 0.5 : aiScore >= buyThreshold ? 0.8 : noAiForStock ? 0.8 : 1.2,
    );
    if (adjustedVolRatio < volThreshold && tech.rsi14 >= 35 && !hasBullishCandle) {
      logger.info(`  📉 ${stock.stock_code}: 거래량 부족 (${tech.volumeRatio.toFixed(2)}x→보정${adjustedVolRatio.toFixed(2)}x < ${volThreshold}${feedbackMinVolRatio > 1.0 ? ` 피드백${feedbackMinVolRatio}x` : ''}) → 스킵`, { component: 'TRACK_B' });
      continue;
    }

    // ─── ADX 횡보장 필터 ───────────────────────────────────────────────
    // ADX < 20 = 방향성 없음 = 저점에서 사고 팔다 끝나는 박스권 루프
    // SWING/DEFENSE 모드: ADX WEAK → 신규 진입 완전 차단 (추세 없으면 타지 않음)
    // SCALPING은 예외 (단타는 방향성 불필요)

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
      // AI 80점+ 고확신 → ADX WEAK 허용 (강한 섹터 모멘텀이 기술지표보다 선행)
      // 대형 우선주(MEGA_CAP) → ADX WEAK 허용 (대형주는 ADX 낮아도 추세 유지 가능)
      if (aiScore >= 80 || megaCap) {
        logger.info(`  ✅ ${stock.stock_code}: ADX WEAK이지만 ${megaCap ? `대형우선주(${megaCap.name})` : `AI고확신(${aiScore}점)`} → 진입 허용`, { component: 'TRACK_B' });
      } else {
        const sidewaysOk = tech.volumeRatio >= 1.0 && tech.macdCrossover === 'BULLISH';
        if (!sidewaysOk && aiScore < buyThreshold) {
          logger.info(`  ⏸️ ${stock.stock_code}: 횡보(WEAK) SWING → vol=${tech.volumeRatio.toFixed(2)} MACD=${tech.macdCrossover} 미충족 스킵`, { component: 'TRACK_B' });
          continue;
        }
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

    // SWING 중기 하락추세 차단: MA20 < MA60 = 추세 역행
    // AI 85+ 또는 극과매도(RSI<30)만 면제 — 하락장 낙칼 잡기 방지
    if (mode === 'SWING' && tech.sma20 < tech.sma60) {
      const canEnterDowntrend = aiScore >= 85 || tech.rsi14 < 30;
      if (!canEnterDowntrend) {
        logger.info(`  ⬇️ ${stock.stock_code}: MA20<MA60 중기하락 AI=${aiScore} RSI=${tech.rsi14.toFixed(0)} → 차단`, { component: 'TRACK_B' });
        continue;
      }
    }

    // SWING 단기 하락추세 차단: MA5 < MA20 = 단기 추세 역행
    // AI 85+ 또는 과매도 반등 구간(RSI<35)만 진입 허용
    // AI 없을 때: tech.score≥65 + MACD비하락이면 허용 (AI 없이도 강한 기술신호는 통과)
    if (mode === 'SWING' && tech.sma5 < tech.sma20 && aiScore < 85) {
      const isNearOversold = tech.rsi14 < 35;
      const techStrongEnough = (noAiScores || aiScore === 0) && tech.score >= 65 && tech.macdCrossover !== 'BEARISH';
      if (!isNearOversold && !techStrongEnough) {
        logger.info(`  ⬇️ ${stock.stock_code}: MA5<MA20 단기하락 AI=${aiScore} RSI=${tech.rsi14.toFixed(0)} → 차단`, { component: 'TRACK_B' });
        continue;
      }
    }
    // ───────────────────────────────────────────────────────────────────

    // 기술 단독 최소 점수 — SWING 65, DEFENSE 65 (품질 우선, 62→65 상향: 승률 개선)
    // AI 스코어 없으면(Track A 미실행) DEFENSE도 SWING 기준으로 완화
    // 대형 우선주(MEGA_CAP): 55점 (낮은 변동성으로 기술점수 낮게 나오는 보정)
    const baseMinTechScore = megaCap ? 55 : mode === 'SCALPING' ? 50 : (mode === 'DEFENSE' && !noAiScores) ? 65 : 65;
    const minTechScore = baseMinTechScore;

    // 우선 테마(반도체/에너지/방산) 보너스 +10점 적용
    // 대형 우선주(MEGA_CAP)는 추가 보너스: 삼성전자 +20, 한화에어로 +18 등
    const priorityBonus = megaCap
      ? 10 + megaCap.bonus  // PRIORITY_SECTOR +10 + MEGA_CAP 추가
      : PRIORITY_SECTOR_CODES.has(stock.stock_code) ? 10 : 0;

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

    // 진짜 눌림목 패턴: 돌파(최근 5봉 고점 > SMA20+4%) → SMA20 지지구간 복귀(±5%)
    // 국내 KOSPI 최적 매수 타점 — 갭 없는 안정적 재진입, 손익비 유리
    const recentHigh5 = candles.length >= 6 ? Math.max(...candles.slice(1, 6).map(c => c.high)) : 0;
    const truePullbackPattern = tech.sma20 > 0 && recentHigh5 > tech.sma20 * 1.04 &&
      curPrice >= tech.sma20 * 0.98 && curPrice <= tech.sma20 * 1.05;
    const pullbackBonus = truePullbackPattern ? 12 : 0;
    if (truePullbackPattern) {
      logger.info(`  🎯 ${stock.stock_code}: 눌림목 타점 (고점+${((recentHigh5 / tech.sma20 - 1) * 100).toFixed(1)}% → SMA20+${((curPrice / tech.sma20 - 1) * 100).toFixed(1)}%) +12점`, { component: 'TRACK_B' });
    }

    // ─── 피보나치 되돌림 레벨 진입 보너스 ────────────────────────────────
    // 38.2%/50%/61.8% 레벨 근처(±2%)이면 지지선 매수 보너스
    const fibBonus = tech.fibResult?.fibScore ?? 0;
    if (fibBonus > 0 && tech.fibResult) {
      const nearLevel = tech.fibResult.levels.find(l => l.isNear);
      if (nearLevel) {
        logger.info(`  📐 ${stock.stock_code}: 피보나치 ${(nearLevel.level * 100).toFixed(1)}% 되돌림 지지(${nearLevel.price.toFixed(0)}원, 현재가${nearLevel.pctFromCurrent > 0 ? '+' : ''}${nearLevel.pctFromCurrent.toFixed(1)}%) → +${fibBonus}점`, { component: 'TRACK_B' });
      }
    }

    // 승률피드백: 눌림목 필수 구간 — truePullbackPattern/피보나치 없으면 초고확신(AI 92점+)만 허용
    if (feedbackRequirePullback && !truePullbackPattern && fibBonus === 0 && aiScore < 92) {
      logger.info(`  ⏸️ ${stock.stock_code}: 승률피드백 눌림필수 — 눌림목/피보나치 패턴 없음 (AI=${aiScore}) → 스킵`, { component: 'TRACK_B' });
      continue;
    }

    const effectiveTechScore = tech.score + priorityBonus + candleBonus + structBonus + vpBonus + pullbackBonus + fibBonus;

    // ─── 진입 타이밍 품질 필터 (연구 기반) ───────────────────────────────
    // RSI 구간별 수익 기대치 (KOSPI 2010~2023 실증):
    //   RSI < 30: 과매도 → 3일 내 반등 확률 68%, 평균 +2.1%
    //   RSI 30~45: 반등 초기 → 진입 최적 (추세 전환 확인 후)
    //   RSI 45~60: 중립/눌림목 → MACD 골든크로스 필수
    //   RSI 60~70: 모멘텀 강세 → AI 점수 65+ 필수 (추격 위험 있음)
    //   RSI > 70: 과매수 → 진입 금지 (단기 조정 확률 72%)
    // AI buyThreshold 이상은 RSI 80까지 허용 (강한 확신 → 오버바웃 예외)
    const rsiCap = 70;
    const aiBypassRsi = aiScore >= buyThreshold && tech.rsi14 <= 80;
    if (tech.rsi14 > rsiCap && !aiBypassRsi) {
      logger.info(`  🔴 ${stock.stock_code}: RSI=${tech.rsi14.toFixed(0)}>${rsiCap} 과매수 → 스킵`, { component: 'TRACK_B' });
      continue;
    }

    // ── 진입 타이밍 분류 (RSI 구간별) ────────────────────────────────────────
    // 각 구간별 합격 조건을 명시적으로 정의 (낙칼 방지 강화)

    // 과매도(RSI<30): 반전 신호 1개 이상 필수 — RSI 혼자는 낙칼 잡기
    const oversoldReversalOk =
      tech.macdHistogram >= 0 ||
      tech.macdCrossover === 'BULLISH' ||
      tech.rsi2 < 15 ||
      hasBullishCandle ||
      tech.stochasticSignal === 'OVERSOLD';
    const isOversold = tech.rsi14 < 30 && oversoldReversalOk;

    // 반등 초기(RSI 30~45): MACD 비하락 OR 거래량 동반 OR 강세 캔들 필수
    const isEarlyBounce = tech.rsi14 >= 30 && tech.rsi14 < 45 && (
      tech.macdCrossover !== 'BEARISH' ||
      tech.volumeRatio >= 1.3 ||
      hasBullishCandle
    );

    // 피보나치 지지선 진입: 되돌림 레벨 근처 + MACD 비하락 → RSI 무관 진입 허용
    const isFibSupport = fibBonus >= 10 && tech.macdCrossover !== 'BEARISH';

    // 눌림목(RSI 45~65): 돌파 후 SMA20 복귀 패턴이면 직접 허용, 아니면 기존 조건
    const isPullback = tech.rsi14 >= 45 && tech.rsi14 <= 65 &&
      tech.macdCrossover !== 'BEARISH' && (
        truePullbackPattern ||        // 진짜 눌림목 타점 → 조건 면제
        isFibSupport ||               // 피보나치 지지 → 조건 면제
        tech.macdCrossover === 'BULLISH' ||
        aiScore >= buyThreshold ||
        effectiveTechScore >= minTechScore
      );
    // 모멘텀(RSI 65~70): 더 엄격 — AI승인 OR 기술점수 +5점 이상
    const isMomentum     = tech.rsi14 > 65 && tech.rsi14 <= 70 && (
      aiScore >= buyThreshold ||
      effectiveTechScore >= minTechScore + 5
    );
    // 고확신 예외: AI 80+ 또는 기술점수 매우 높으면 전 구간 허용
    const isHighConviction = (aiScore >= 80 || effectiveTechScore >= minTechScore + 15) &&
      (effectiveTechScore >= minTechScore || aiScore >= buyThreshold);
    const isValidEntry   = isOversold || isEarlyBounce || isPullback || isMomentum || isHighConviction || isFibSupport;

    if (!isValidEntry) {
      logger.info(`  🟡 ${stock.stock_code}: RSI=${tech.rsi14.toFixed(0)} MACD=${tech.macdCrossover} AI=${aiScore} → 타이밍 미충족 스킵`, { component: 'TRACK_B' });
      continue;
    }

    // ── 세계급 트레이더 기준: 컨플루언스(독립 신호 일치) 최소 요건 ─────────────
    // 단일 신호 진입 = 코인 플립. 3개+ 독립 신호가 동시에 매수를 가리킬 때만 집행.
    // 강한 단일 신호(BB돌파/TTM발사/VWAP크로스/RSI2 극과매도)는 면제.
    if (mode !== 'SCALPING') {
      const hasStrongCatalyst =
        tech.bollingerBreakout === 'UP' ||
        tech.ttmSqueeze.fireSignal === 'LONG' ||
        tech.vwapCross === 'JUST_ABOVE' ||
        tech.rsi2 < 10;
      if (!hasStrongCatalyst) {
        const cf = {
          momentum: tech.macdCrossover !== 'BEARISH' || tech.macdHistogram > 0,
          rsi: tech.rsi14 <= 60 || isOversold,
          volume: adjustedVolRatio >= 1.2,
          vwap: tech.vwapPosition === 'ABOVE' || tech.vwapPullback,
          pattern: hasBullishCandle || tech.candlePatterns.some(p => p.bullish && p.strength !== 'WEAK'),
          trend: tech.trendStrength !== 'WEAK',
        };
        const cfCount = Object.values(cf).filter(Boolean).length;
        // AI 없으면 2개로 완화 (개별종목 AI=0도 포함)
        const noAiForCf = noAiScores || aiScore === 0;
        const minCf = aiScore >= 85 ? 1 : aiScore >= 80 ? 2 : noAiForCf ? 2 : 3;
        if (cfCount < minCf) {
          logger.info(`  🔍 ${stock.stock_code}: 컨플루언스 ${cfCount}/${minCf} 미달 [mom=${cf.momentum} rsi=${cf.rsi} vol=${cf.volume} vwap=${cf.vwap} pat=${cf.pattern} trend=${cf.trend}] → 스킵`, { component: 'TRACK_B' });
          continue;
        }
      }
    }

    // ── 당일 바 위치: 고점 80%+ 추격 차단 ──────────────────────────────────
    // 전문 트레이더: "저점에서 사고 고점에서 팔아라" — 당일 고점권 신규 진입 방지
    if (aiScore < 85) {  // 고점 추격 차단 — SCALPING 포함 전 모드 적용 (갭업 고점 단타 진입 차단)
      const todayRange = candles[0].high - candles[0].low;
      const priceInRange = todayRange > 50 ? (price.currentPrice - candles[0].low) / todayRange : 0.5;
      const hasStrongMomentum = tech.bollingerBreakout === 'UP' || tech.ttmSqueeze.fireSignal === 'LONG' || tech.volumeRatio >= 2.5;
      if (priceInRange > 0.80 && !hasStrongMomentum) {
        logger.info(`  🚫 ${stock.stock_code}: 당일 고점권(${(priceInRange * 100).toFixed(0)}%) 추격 위험 — vol=${tech.volumeRatio.toFixed(2)}x 모멘텀 부족 → 스킵`, { component: 'TRACK_B' });
        continue;
      }
    }
    // ───────────────────────────────────────────────────────────────────────

    // SCALPING은 Track B에서 신규 매수 불가 — opening-bell-job 전용
    if (mode === 'SCALPING') continue;
    // ───────────────────────────────────────────────────────────────────
    const squeezeTag = tech.bollingerBreakout === 'UP' ? '🎯BB스퀴즈돌파' : tech.bollingerSqueeze ? '🔃BB응축중' : '';
    const vwapTag = tech.vwapCross === 'JUST_ABOVE' ? '⚡VWAP돌파' : tech.vwapPullback ? '🔁VWAP풀백' : '';
    const ttmTag = tech.ttmSqueeze.fireSignal === 'LONG' ? `🚀TTM발사(${tech.ttmSqueeze.consecutiveSqueezeOn}봉)` : '';
    const rsi2Tag = tech.rsi2 < 15 ? `📉RSI2(${tech.rsi2.toFixed(0)})` : '';
    const fibTag = isFibSupport && tech.fibResult ? `📐피보${(tech.fibResult.levels.find(l => l.isNear)?.level ?? 0) * 100}%` : '';
    const entryReason = [
      isOversold ? '과매도반등' : isEarlyBounce ? '반등초기(최적)' : isFibSupport ? '📐피보나치지지' : (isPullback && truePullbackPattern) ? '🎯눌림목타점' : isPullback ? '눌림목' : isHighConviction ? `고확신(기술${effectiveTechScore}점)` : '모멘텀',
      squeezeTag, vwapTag, ttmTag, rsi2Tag, fibTag,
    ].filter(Boolean).join('+');
    // ─────────────────────────────────────────────────────────────────────

    // 진입 게이트: 기술점수 충족 OR AI 꽁돈(>=92점, 단 기술점수 절대하한 45점)
    // isKongdon이라도 tech.score 45 미만이면 차단 — AI 과대평가 낙칼 방지
    const isKongdon = aiScore >= 85 && effectiveTechScore >= 45;
    if (effectiveTechScore >= minTechScore || isKongdon) {
      candidates.push({ stock_code: stock.stock_code, tech, price, candleBonus });
      const wrInfo = winRateSummary(stock.stock_code, winRates?.get(stock.stock_code));
      const bonusStr = [priorityBonus > 0 ? `+${priorityBonus}테마` : '', candleBonus > 0 ? `+${candleBonus}캔들` : '', isKongdon ? `🎰꽁돈(AI${aiScore}점)` : ''].filter(Boolean).join('');
      logger.info(`  ✅ ${stock.stock_code}: 기술=${effectiveTechScore}점(>=${minTechScore})${isKongdon ? ` 꽁돈AI=${aiScore}점` : ''} [${entryReason}] RSI=${tech.rsi14.toFixed(0)} vol=${tech.volumeRatio.toFixed(2)}x → 매수 후보${bonusStr}${wrInfo}`, { component: 'TRACK_B' });
    }
  }

  // AI 스코어 + 기술적 점수 합산으로 정렬
  candidates.sort((a, b) => {
    const aTotal = (aiScoreMap.get(a.stock_code) ?? 0) + a.tech.score;
    const bTotal = (aiScoreMap.get(b.stock_code) ?? 0) + b.tech.score;
    return bTotal - aTotal;
  });

  // ─── 분봉 멀티타임프레임 확인 (상위 5개 후보, 장중에만) ──────────────────
  // 프로 트레이더 기준: 일봉 BUY + 15분봉 비하락 + 1분봉 양수 = 3중 확인
  const intradayBonus = new Map<string, number>();
  const intraday15mDown = new Set<string>();  // 15분봉 하락 종목
  if (isMarketOpen() && candidates.length > 0) {
    const top5 = candidates.slice(0, 5);
    await Promise.allSettled(top5.map(async (cand) => {
      try {
        const minuteCandles = await getMinuteChart(cand.stock_code);
        if (minuteCandles.length >= 5) {
          const intraday = analyzeIntraday(minuteCandles);
          intradayBonus.set(cand.stock_code, intraday.score);
          if (intraday.trend15m === 'DOWN') intraday15mDown.add(cand.stock_code);
          logger.info(`  ⏱️ ${cand.stock_code}: 분봉=${intraday.trend}(${intraday.score}) 15m=${intraday.trend15m} VWAP=${intraday.vwapPosition} vol급등=${intraday.volumeSurge} | ${intraday.reason}`, { component: 'TRACK_B' });
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
        (c) => Number(c.total_quantity) > 0,
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
  // SCALPING: 최대 2종목 (3→2, 상위 고점수 집중 — 분산 시 승률 희석) / SNIPER: 최대 2종목 / 일반: 최대 4종목
  const maxBuys = mode === 'SCALPING' ? 2 : mode === 'SNIPER' ? 2 : 4;
  const splitCount = strategyParams.splitCount || 2;

  for (const cand of candidates.slice(0, maxBuys)) {
    // ── 멀티타임프레임 인트라데이 게이트 (프로 트레이더 기준 강화) ──────────
    // AI 없는 기술 단독 진입은 분봉 양수 필수 (불량 진입 원천 차단)
    const idBonus = intradayBonus.get(cand.stock_code) ?? 0;
    const _idAiScore = aiScoreMap.get(cand.stock_code) ?? 0;
    // 15분봉 하락 추세 패널티: 15분 단위로 하락 중이면 -10 추가 감산
    const id15mPenalty = intraday15mDown.has(cand.stock_code) ? -10 : 0;
    const effectiveIdBonus = idBonus + id15mPenalty;
    // AI 확신도별 통과 기준 (높을수록 인트라데이 약세 허용)
    const idPassThreshold = _idAiScore >= 85 ? -20 : _idAiScore >= 80 ? -10 : _idAiScore >= (strategyParams.buyThreshold ?? 72) ? -3 : 0;
    if (effectiveIdBonus < idPassThreshold) {
      logger.info(`  ⏸️ ${cand.stock_code}: 분봉게이트 미달(${idBonus}${id15mPenalty < 0 ? `+15m${id15mPenalty}` : ''}=${effectiveIdBonus} < ${idPassThreshold}, AI=${_idAiScore}) → 진입 보류`, { component: 'TRACK_B' });
      continue;
    }

    // 호가 매도벽 차단 (pipeline.ts에서 전달된 orderbookBlockedCodes)
    if (params.orderbookBlockedCodes?.has(cand.stock_code)) {
      logger.info(`  🚫 ${cand.stock_code}: 호가 매도벽(bid/ask≤0.5) → 진입 차단`, { component: 'TRACK_B' });
      continue;
    }

    const isPriority = PRIORITY_SECTOR_CODES.has(cand.stock_code);
    const aiScore = aiScoreMap.get(cand.stock_code) ?? 0;

    // ── 점수 기반 목표 투자비율 계산 (총자산 대비 %) ──────────────────────
    // 기술점수(0~100) + AI점수를 실제 투자비율로 직접 변환
    // 기준: 60점=8%, 70점=12%, 80점=16%, 90점+=20%
    // DEFENSE/SCALPING은 절반 비율 적용 (보수 운용)
    const techScore = Math.min(100, cand.tech.score + (cand.candleBonus ?? 0) * 0.5);
    const blendedScore = aiScore > 0 ? techScore * 0.5 + aiScore * 0.5 : techScore;

    // DB 실거래 역산 비율 사용 (샘플 10건 이상인 티어만), 부족하면 하드코딩 fallback
    const getDbAllocPct = (score: number): number | null => {
      const tier = scoreTierParams.find((t) => score >= t.tier_min && score <= t.tier_max);
      if (!tier || tier.sample_count < 10) return null;
      return tier.alloc_pct;
    };

    // ── AI 허락 여부로 투자비율 결정 ──────────────────────────────────────
    // AI가 buyThreshold 이상 승인 → 점수 비례 풀 비율
    // 기술지표만 통과(AI 미허락) → 소액 탐색(4-5%)으로 제한
    const aiApproved = aiScore >= strategyParams.buyThreshold;

    // 황금비율 v2: 확신도 비례 투입 (portfolio-guard 25% 상한과 정합)
    const hardcodedAllocPct = aiApproved
      ? (mode === 'SNIPER'
          // SNIPER: 단일 최고확신 종목 집중 — 총자산의 25/22/20%
          ? (blendedScore >= 90 ? 0.25 :
             blendedScore >= 85 ? 0.22 : 0.20)
          : (blendedScore >= 90 ? 0.22 :   // 90+: 22% (고확신, effectiveMaxPos 25%에 근접)
             blendedScore >= 85 ? 0.18 :   // 85-89: 18%
             blendedScore >= 80 ? 0.12 :   // 80-84: 12% (데이터 경계구간)
             blendedScore >= 75 ? 0.0 :    // 75-79: 진입 차단 (수익률 마이너스 구간 유지)
             blendedScore >= 70 ? 0.14 : 0.10))
      : (noAiScores || aiScore === 0)
        // AI 부재(전체 미실행 또는 개별종목 AI=0) → 기술지표만으로 판단, 배분 상향
        ? (blendedScore >= 80 ? 0.18 : blendedScore >= 70 ? 0.14 : blendedScore >= 62 ? 0.10 : 0.06)
        // AI 있지만 이 종목은 미허락 → 소액 탐색
        : (blendedScore >= 80 ? 0.14 : blendedScore >= 70 ? 0.10 : 0.06);
    let baseAllocPct = getDbAllocPct(blendedScore) ?? hardcodedAllocPct;
    // 소자산(현금 50만 미만): 배분율 최소 30% (있는 돈으로 1-2종목 집중)
    // 중자산(50만~200만): 배분율 최소 20%
    // orderableCash 기준 (totalAssets는 KIS 장애 시 0이 되므로 신뢰 불가)
    if (orderableCash < 500000) {
      baseAllocPct = Math.max(baseAllocPct, 0.30);
    } else if (orderableCash < 2000000) {
      baseAllocPct = Math.max(baseAllocPct, 0.20);
    }
    const modeScale = mode === 'SCALPING' ? 0.5 : mode === 'DEFENSE' ? 0.6 : 1.0;

    // 승률 기반 보정: 실거래 데이터 기반으로 비율 조정
    const wr = winRates?.get(cand.stock_code);
    const winRateMultiplier = wr && wr.sampleCount >= 3
      ? (wr.winRate >= 0.80 ? 1.30 : wr.winRate >= 0.65 ? 1.15 : wr.winRate <= 0.35 ? 0.65 : 1.0)
      : 1.0;
    if (winRateMultiplier !== 1.0) {
      logger.info(`  📈 ${cand.stock_code}: 승률배율 ×${winRateMultiplier} (승률${wr ? (wr.winRate * 100).toFixed(0) : 0}%/${wr?.sampleCount ?? 0}건)`, { component: 'TRACK_B' });
    }

    // 우선 테마 보정
    const priorityBonus = PRIORITY_SECTOR_CODES.has(cand.stock_code) ? 1.1 : 1.0;

    // 목표 금액 = 총자산 × 비율 × 보정들
    // AI허락 고확신(85점+) → 1차에 72~80% 진입 (물타기 여지 20~28% 확보)
    // AI허락 일반(70-84점) → 1차 65~75%
    // AI 미허락 탐색 → 1차 100% (소액이므로 분할 의미 없음)
    const firstEntryRatio = mode === 'SNIPER' ? 1.0   // 저격수: 한 번에 풀 포지션
      : !aiApproved ? 1.0
      : blendedScore >= 85 ? (allocationBoostFirstEntry ? 0.80 : 0.72)  // 72~80% 1차 진입 (물타기 여지 20~28%)
      : splitCount <= 1 ? 1.0
      : splitCount <= 2 ? (allocationBoostFirstEntry ? 0.78 : 0.70) : (allocationBoostFirstEntry ? 0.75 : 0.65);
    // AI 고확신 포지션 확대 — blend 점수도 함께 높아야 적용 (AI만 높고 tech 낮으면 억제)
    // blend >= 80이어야 2.0x, blend >= 72이어야 1.5x (낮은 tech 종목 과대투입 방지)
    const aiPosMultiplier = (aiScore >= 90 && blendedScore >= 80) ? 2.0
      : (aiScore >= 85 && blendedScore >= 72) ? 1.5 : 1.0;
    const targetKrw = totalAssets
      ? Math.round(totalAssets * baseAllocPct * modeScale * winRateMultiplier * priorityBonus * firstEntryRatio * aiPosMultiplier)
      : Math.round(effectiveMaxPos * firstEntryRatio * aiPosMultiplier);

    // AI 고확신: 포지션 한도 확대 (최대 총자산 25% 캡 — portfolio-guard 집중도와 일치)
    // 소자산(50만 미만)은 maxPosFraction=80%이므로 별도 상한 적용 안 함
    const concentrationCap = (totalAssets && totalAssets < 500000)
      ? totalAssets * 0.80
      : totalAssets ? totalAssets * 0.25 : Infinity;
    const aiMaxPos = aiPosMultiplier > 1.0 && totalAssets
      ? Math.min(effectiveMaxPos * aiPosMultiplier, concentrationCap)
      : effectiveMaxPos;
    // 상한: aiMaxPos (AI확신도 반영 종목당 한도), 남은 현금의 92%까지 사용 (현금 최소화)
    const positionSize = Math.min(targetKrw, aiMaxPos, remainingCash * 0.92);
    // 소자산 모드: 현금 50만 미만이면 남은 현금의 80%를 직접 사용 (배분율/maxPos 무시)
    // totalAssets가 KIS 장애 등으로 0이 되면 effectiveMaxPos도 0이 되므로
    // 실제 잔고(orderableCash) 기준으로 판단
    const isSmallAccount = orderableCash < 500000;
    const effectivePositionSize = isSmallAccount
      ? Math.round(remainingCash * 0.80)   // 있는 돈의 80% 직접 사용 (maxPos 캡 제거)
      : positionSize;
    // 최소 매수금액: 총자산 비례 동적 계산 (고정 금액 제거)
    const minPositionKrw = totalAssets
      ? Math.max(50000, Math.round(totalAssets * (aiApproved ? 0.04 : 0.025)))
      : Math.max(50000, Math.round(orderableCash * (aiApproved ? 0.08 : 0.05)));
    if (effectivePositionSize < minPositionKrw) {
      logger.info(`  ❌ ${cand.stock_code}: 포지션크기 ${Math.round(effectivePositionSize).toLocaleString()}원 < 최소 ${minPositionKrw.toLocaleString()}원 (blend=${blendedScore.toFixed(0)} alloc=${(baseAllocPct*100).toFixed(0)}% cash=${Math.round(remainingCash).toLocaleString()}) → 스킵`, { component: 'TRACK_B' });
      continue;
    }

    let quantity = Math.floor(effectivePositionSize / cand.price.currentPrice);
    if (quantity <= 0) {
      // 고가주(1주 > positionSize): 현금이 충분하면 최소 1주 매수
      if (remainingCash >= cand.price.currentPrice) {
        quantity = 1;
        logger.info(`  💡 ${cand.stock_code}: positionSize(${Math.round(effectivePositionSize / 10000)}만원) < 주가(${cand.price.currentPrice.toLocaleString()}원) → 최소 1주 매수`, { component: 'TRACK_B' });
      } else {
        logger.info(`  ❌ ${cand.stock_code}: 주가 ${cand.price.currentPrice.toLocaleString()}원 > 잔여현금 ${Math.round(remainingCash).toLocaleString()}원 → 매수불가`, { component: 'TRACK_B' });
        continue;
      }
    }

    const allocStr = ` [비율${(baseAllocPct * modeScale * firstEntryRatio * 100).toFixed(0)}%→${Math.round(effectivePositionSize / 10000)}만원]`;
    decisions.push({
      action: 'BUY',
      stock_code: cand.stock_code,
      quantity,
      price_type: 'MARKET',
      limit_price: cand.price.currentPrice,
      reasoning: `기술적 매수: score=${cand.tech.score}(blend=${blendedScore.toFixed(0)})${cand.candleBonus > 0 ? `+${cand.candleBonus}캔들` : ''}${idBonus !== 0 ? `${idBonus > 0 ? '+' : ''}${idBonus}분봉` : ''} RSI=${cand.tech.rsi14.toFixed(0)} MACD=${cand.tech.macdCrossover} ADX=${cand.tech.adx14.toFixed(0)}(${cand.tech.trendStrength}) vol=${cand.tech.volumeRatio.toFixed(2)}x${cand.tech.goldenCross ? ' 골든크로스' : ''}${isPriority ? ' [우선테마]' : ''}${allocStr}${winRateSummary(cand.stock_code, winRates?.get(cand.stock_code))}`,
      confidence: Math.min(0.95, Math.max(0.5, cand.tech.score / 100 + getWinRateConfidenceBoost(winRates?.get(cand.stock_code)) + (cand.candleBonus > 0 ? 0.05 : 0))),
      ai_score: aiScore > 0 ? aiScore : cand.tech.score, // 점수 기반 TP/SL 계산용
    });

    remainingCash -= quantity * cand.price.currentPrice;
  }

  // 2-b. 현금 추가 소진 패스: 매수 후 남은 현금이 총자산 15% 이상 & AI허락 후보 더 있으면 추가 진입
  // (1차 매수에서 firstEntryRatio로 아낀 여지 + 아직 안 산 후보 종목에 배분)
  // SNIPER: 최대 2종목 제한이므로 추가 소진 패스 건너뜀
  if (totalAssets && remainingCash >= totalAssets * 0.15 && mode !== 'SCALPING' && mode !== 'SNIPER') {
    const alreadyBuying = new Set(decisions.filter(d => d.action === 'BUY').map(d => d.stock_code));
    // 아직 매수 결정 안 된 AI허락 후보만 — 이미 사이클 내 매수한 종목 중복 제외
    const extraCandidates = candidates.filter(c => {
      const score = aiScoreMap.get(c.stock_code) ?? 0;
      return !alreadyBuying.has(c.stock_code) && score >= strategyParams.buyThreshold;
    });
    // 이미 매수 결정한 AI허락 종목에 물타기가 아닌 추가 비중 투입
    for (const cand of extraCandidates.slice(0, 2)) {
      const addSize = Math.min(Math.round(remainingCash * 0.50), effectiveMaxPos);
      const minAddSize = Math.max(50000, Math.round((totalAssets ?? orderableCash) * 0.03));
      if (addSize < minAddSize) continue;
      const qty = Math.floor(addSize / cand.price.currentPrice);
      if (qty <= 0) continue;
      const aiScoreEx = aiScoreMap.get(cand.stock_code) ?? 0;
      logger.info(`  💰 현금추가투입: ${cand.stock_code} +${Math.round(addSize / 10000)}만원 (남은현금 ${Math.round(remainingCash / 10000)}만원)`, { component: 'TRACK_B' });
      decisions.push({
        action: 'BUY',
        stock_code: cand.stock_code,
        quantity: qty,
        price_type: 'MARKET',
        limit_price: cand.price.currentPrice,
        reasoning: `현금추가투입: AI${aiScoreEx}점 고확신 추가매수 (잔여현금 소진)`,
        confidence: 0.75,
        ai_score: aiScoreEx,
      });
      remainingCash -= qty * cand.price.currentPrice;
    }
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
    // 포지션 집중도 한도: 총자산의 10% 이상이면 추가 물타기 차단 (단일 종목 집중 방지)
    const positionValue = price.currentPrice * Number(chain.total_quantity ?? 0);
    const concentrationPct = (totalAssets ?? 0) > 0 ? positionValue / totalAssets! : 0;
    const isTooConcentrated = concentrationPct >= 0.10;
    // ── 지지선 + 반등신호 없는 물타기 차단 ──────────────────────────────────
    // 지지선 근처(BB하단/RSI과매도)에 있더라도, 실제 반전 신호가 있어야 물타기 허용
    // "제이마니아 판정": 차트에서 반등 시그널 확인 후 추가매수 (기계적 % 물타기 금지)
    const hasBullishReversalCandle = chainTech
      ? chainTech.candlePatterns.some((p) => p.bullish && (p.strength === 'STRONG' || p.strength === 'MODERATE'))
      : false;
    const avgDownSupportOk = chainTech
      ? (chainTech.bollingerPosition === 'BELOW_LOWER' || chainTech.bollingerPosition === 'NEAR_LOWER' || chainTech.rsi14 < 38)
      : true;
    // 반등신호: 불리쉬 캔들(망치형 등) OR MACD 전환 OR RSI 과매도+MACD 비하락
    const avgDownReversalOk = chainTech
      ? (hasBullishReversalCandle || chainTech.macdCrossover === 'BULLISH' || (chainTech.rsi14 < 35 && chainTech.macdCrossover !== 'BEARISH'))
      : true;
    if (chain.status === 'PROFIT_TAKING' || isBelowSma20Deep || isTooDeepUnderwater || !avgDownSupportOk || !avgDownReversalOk || isTooConcentrated) {
      if (isBelowSma20Deep) logger.info(`  🚫 ${chain.stock_code}: SMA20 -3% 이탈 → 물타기 차단 (손실확대 방지)`, { component: 'TRACK_B' });
      if (isTooDeepUnderwater) logger.info(`  🚫 ${chain.stock_code}: ${pnlPct.toFixed(1)}% ≤ -8% → 물타기 하드 차단 (나락 방지)`, { component: 'TRACK_B' });
      if (isTooConcentrated) logger.info(`  🚫 ${chain.stock_code}: 비중 ${(concentrationPct*100).toFixed(1)}% ≥ 10% → 물타기 차단 (집중 방지)`, { component: 'TRACK_B' });
      if (!avgDownSupportOk && !isBelowSma20Deep && !isTooDeepUnderwater && !isTooConcentrated) logger.info(`  🚫 ${chain.stock_code}: 지지선 미확인(BB=${chainTech?.bollingerPosition} RSI=${chainTech?.rsi14.toFixed(0)}) → 물타기 차단`, { component: 'TRACK_B' });
      if (avgDownSupportOk && !avgDownReversalOk && !isBelowSma20Deep && !isTooDeepUnderwater && !isTooConcentrated) logger.info(`  🔄 ${chain.stock_code}: 지지선 OK지만 반등신호 없음(MACD=${chainTech?.macdCrossover} 캔들없음) → 물타기 대기`, { component: 'TRACK_B' });
      continue;
    }

    // 물타기 조건: 평단가 대비 하락률이 트리거 이하 + 횟수 미달
    // + 이미 대기 중인 BUY 주문 없어야 함 (count는 체결 후 업데이트 → 중복 방지)
    if (avgDownTrigger !== 0 && pnlPct <= avgDownTrigger && chain.current_averaging_count < chain.max_averaging_count) {
      let hasPendingBuy = false;
      try {
        const { rows: pendingRows } = await getPool().query(
          `SELECT 1 FROM orders WHERE chain_id = $1 AND side = 'BUY' AND status IN ('PENDING','OPEN','SUBMITTED') LIMIT 1`,
          [chain.id],
        );
        hasPendingBuy = pendingRows.length > 0;
      } catch { /* DB 오류 시 안전하게 허용 */ }
      if (hasPendingBuy) {
        logger.info(`  ⏳ ${chain.stock_code}: 미체결 BUY 주문 존재 → 물타기 중복 차단`, { component: 'TRACK_B' });
        continue;
      }
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
