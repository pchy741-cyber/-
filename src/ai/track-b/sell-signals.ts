import { analyzeTechnicals } from '../../analysis/indicators.js';
import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import type { TradeDecision } from '../../db/models.js';
import { logger } from '../../utils/logger.js';
import { type TechnicalFallbackParams, resolveStrategyParams, getKstScalpTime, buildAiScoreMap } from './technical-fallback-types.js';

/**
 * 보유 종목 매도 판단 (손절/익절/강제청산/기술매도)
 */
export async function generateSellDecisions(params: TechnicalFallbackParams): Promise<TradeDecision[]> {
  const { mode, livePrices, chartData, openChains, junkStockCodes, totalAssets, marketSignals } = params;
  const strategyParams = resolveStrategyParams(mode, params);
  const aiScoreMap = buildAiScoreMap(params.aiScores);
  const { h: _scalpH, m: _scalpM, isPastScalpDeadline } = getKstScalpTime();
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
    const rawAiScore = aiScoreMap.get(chain.stock_code) ?? 0;
    const realtimeAiScore = Number.isFinite(rawAiScore) ? rawAiScore : 0;
    let effectiveTp = Number(chainTp);
    let effectiveSl = Number(chainSl);

    if (realtimeAiScore > 0 && !isScalpChain) {
      if (realtimeAiScore >= 85) {
        // AI 강세 지속 → 수익 극대화, TP 상향 (승자를 더 오래 보유)
        effectiveTp = Math.max(Number(chainTp), 8.0);
      } else if (realtimeAiScore < 55 && pnlPct > 1.0) {
        // AI 약세 전환 + 수익 구간 → 빠른 수익 확정 (TP를 현재 수익 -0.5%로 낮춤)
        effectiveTp = Math.min(Number(chainTp), Math.max(pnlPct - 0.5, 1.0));
        // 2026-06: AI<55 손실구간 SL 타이트(-2%) 제거 — AI 저점수가 곧 하락 아님 (승률 역상관)
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

    // ── 데드머니 탈출: 장기 보유 저성과 종목 현금 재배치 ──────────────
    // SCALPING/PROFIT_TAKING 예외 — 이미 별도 청산 로직 존재
    if (chain.strategy_mode !== 'SCALPING' && chain.status !== 'PROFIT_TAKING' && chain.opened_at) {
      const holdingDays = Math.floor((Date.now() - new Date(chain.opened_at).getTime()) / (24 * 60 * 60_000));

      // 8일+ 보유 + 수익 < 2% → 모멘텀 부족, 현금 재배치
      if (holdingDays >= 8 && pnlPct < 2.0 && pnlPct >= 0) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `데드머니탈출(${holdingDays}일 보유 +${pnlPct.toFixed(1)}%<2%): 모멘텀 부족 → 현금 재배치`,
          confidence: 0.80,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }

      // 5일+ 보유 + PnL ±1% 이내 → 기회비용 청산
      if (holdingDays >= 5 && Math.abs(pnlPct) <= 1.0) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `데드머니탈출(${holdingDays}일 보유 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%): 기회비용 청산`,
          confidence: 0.75,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }

      // 3일+ 보유 + 손실 > 1% → 손절선 타이트닝 (pnlPct - 0.5%)
      if (holdingDays >= 3 && pnlPct < -1.0) {
        const tightenedSl = pnlPct - 0.5;
        // 체인 SL이 타이트닝보다 넓으면 → 좁힌 SL로 교체 (즉시 청산은 아니고, 기존 SL 대신 적용)
        const chainSl = chain.stop_loss_pct ?? chainModeParams.stopLossPct;
        if (Number(chainSl) < tightenedSl) {
          // 타이트닝된 SL이 현재 손실보다 이미 넓으면 즉시 청산
          logger.info(
            `⏰ 데드머니 타이트닝: ${chain.stock_code} ${holdingDays}일 보유 ${pnlPct.toFixed(1)}% → SL ${tightenedSl.toFixed(1)}% (기존 ${Number(chainSl).toFixed(1)}%)`,
            { component: 'TRACK_B' },
          );
          // effectiveSl을 타이트닝 값으로 교체 — 아래 손절 로직에서 사용됨
          effectiveSl = tightenedSl;
        }
      }
    }
    // ────────────────────────────────────────────────────────────────────

    // 손절 (ATR 동적 손절 vs 전략 고정 손절 — 더 보수적인 쪽 적용)
    const dynamicStop = sellTech ? sellTech.dynamicStopLossPct : effectiveSl;
    // AI 80점+ 고확신 종목은 손절 기준 1.2배 넓히기 (일시적 노이즈로 조기손절 방지)
    const stopWidenMultiplier = realtimeAiScore >= 80 ? 1.2 : 1.0;
    // 시그널 보정: 체결강도 < 80(매도세 압도) → 손절 타이트닝 (0.85x), 체결강도 > 120(매수세) → 1.1x 완화
    const sigIntensity = marketSignals?.get(chain.stock_code)?.tradingIntensity?.intensity ?? 0;
    const signalStopMult = sigIntensity > 0
      ? (sigIntensity < 80 ? 0.85 : sigIntensity >= 120 ? 1.10 : 1.0)
      : 1.0;
    const effectiveStop = Math.min(effectiveSl, dynamicStop) * stopWidenMultiplier * signalStopMult;
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

  return decisions;
}
