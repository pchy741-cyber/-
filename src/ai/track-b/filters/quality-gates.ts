/**
 * 품질 게이트 (6개 중 N개 통과)
 *
 * qVolume, qTrendStrength, qTrendDirection, qRsiTiming, qConfluence, qSignalFlow
 */

import { getCtxIsPaper } from '../../../config/context.js';
import type { GateResult, QualityGateInput } from './types.js';

export function checkQualityGates(input: QualityGateInput): GateResult {
  const { tech, scoring, mode, aiScore, buyThreshold, megaCap, noAiForStock, feedbackMinVolRatio, curPrice } = input;
  const {
    adjustedVolRatio,
    hasBullishCandle,
    effectiveTechScore,
    minTechScore,
    isFibSupport,
    truePullbackPattern,
    signalData,
  } = scoring;
  const isPaper = getCtxIsPaper();

  // ─ qVolume ─
  const volThreshold = Math.max(
    feedbackMinVolRatio,
    aiScore >= 80 ? 0.5 : aiScore >= buyThreshold ? 0.8 : noAiForStock ? 0.8 : 1.2,
  );
  const qVolume = adjustedVolRatio >= volThreshold || tech.rsi14 < 35 || hasBullishCandle;

  // ─ qTrendStrength ─
  const qTrendStrength = tech.trendStrength !== 'WEAK' || aiScore >= 80 || !!megaCap;

  // ─ qTrendDirection ─ (paper: SMA 정렬 요건 면제 — 연습매매 활성화)
  const qTrendDirection = (() => {
    if (!isPaper && mode === 'SWING' && tech.sma20 < tech.sma60 && aiScore < 85 && tech.rsi14 >= 30) return false;
    if (!isPaper && mode === 'SWING' && tech.sma5 < tech.sma20 && aiScore < 85 && tech.rsi14 >= 35) return false;
    if (mode === 'DEFENSE' && curPrice < tech.sma20 && aiScore < 65 && tech.score < 50) return false;
    return true;
  })();

  // ─ qRsiTiming ─
  const qRsiTiming = (() => {
    const rsiCap = megaCap ? 80 : 75;
    const aiBypassRsi = aiScore >= buyThreshold && tech.rsi14 <= 80;
    if (tech.rsi14 > rsiCap && !aiBypassRsi) return false;
    const oversoldReversalOk =
      tech.macdHistogram >= 0 ||
      tech.macdCrossover === 'BULLISH' ||
      tech.rsi2 < 15 ||
      hasBullishCandle ||
      tech.stochasticSignal === 'OVERSOLD';
    const isOversold = tech.rsi14 < 30 && oversoldReversalOk;
    const isEarlyBounce =
      tech.rsi14 >= 30 &&
      tech.rsi14 < 45 &&
      (tech.macdCrossover !== 'BEARISH' || tech.volumeRatio >= 1.3 || hasBullishCandle);
    const isPullback =
      tech.rsi14 >= 45 &&
      tech.rsi14 <= 65 &&
      tech.macdCrossover !== 'BEARISH' &&
      (truePullbackPattern ||
        isFibSupport ||
        tech.macdCrossover === 'BULLISH' ||
        aiScore >= buyThreshold ||
        effectiveTechScore >= minTechScore);
    const isMomentum =
      tech.rsi14 > 65 && tech.rsi14 <= 75 && (aiScore >= buyThreshold || effectiveTechScore >= minTechScore + 5);
    const isHighConviction =
      (aiScore >= 80 || effectiveTechScore >= minTechScore + 15) &&
      (effectiveTechScore >= minTechScore || aiScore >= buyThreshold);
    return isOversold || isEarlyBounce || isPullback || isMomentum || isHighConviction || isFibSupport;
  })();

  // ─ qConfluence ─
  const qConfluence = (() => {
    const hasStrongCatalyst =
      tech.bollingerBreakout === 'UP' ||
      tech.ttmSqueeze.fireSignal === 'LONG' ||
      tech.vwapCross === 'JUST_ABOVE' ||
      tech.rsi2 < 10;
    if (hasStrongCatalyst) return true;
    const cf = {
      momentum: tech.macdCrossover !== 'BEARISH' || tech.macdHistogram > 0,
      rsi: tech.rsi14 <= 60 || tech.rsi14 < 30,
      volume: adjustedVolRatio >= 1.2,
      vwap: tech.vwapPosition === 'ABOVE' || tech.vwapPullback,
      pattern: hasBullishCandle || tech.candlePatterns.some((p) => p.bullish && p.strength !== 'WEAK'),
      trend: tech.trendStrength !== 'WEAK',
    };
    const cfCount = Object.values(cf).filter(Boolean).length;
    // paper: 컨플루언스 1개로 충분 (연습매매 활성화), live: 기존 기준 유지
    const minCf = isPaper ? 1 : aiScore >= 90 ? 2 : aiScore >= 70 ? 3 : noAiForStock ? 3 : 3;
    return cfCount >= minCf;
  })();

  // ─ qSignalFlow ─ v6: 외국인+기관 동반 매도 시 하드 차단 (AI 90+ 제외)
  // paper: 실시간 KIS 시그널 불필요 → 항상 통과 (연습매매 활성화)
  // v13: 시그널 없음 = 중립 처리 (기술지표 단독 모드에서 4/5 품질게이트로 판단 위임)
  const qSignalFlow = isPaper
    ? true
    : !signalData.raw
      ? true
      : (() => {
          // 외국인+기관 동시 매도 = 기관 컨센서스 매도 → 개인만 매수 중 → 위험
          if (signalData.foreignNetEst < 0 && signalData.instNetEst < 0 && aiScore < 90) return false;
          // 체결강도 < 85 (매도 압도) + 호가 매도벽 → 하방 압력
          if (signalData.intensity > 0 && signalData.intensity < 85 && signalData.bidAskRatio < 0.7) return false;
          return (
            signalData.intensity >= 90 ||
            signalData.foreignNetEst > 0 ||
            signalData.instNetEst > 0 ||
            signalData.foreignBrokerBuy
          );
        })();

  const details = {
    vol: qVolume,
    trend: qTrendStrength,
    dir: qTrendDirection,
    rsi: qRsiTiming,
    cf: qConfluence,
    sig: qSignalFlow,
  };
  const count = Object.values(details).filter(Boolean).length;
  const isRally = input.isRallyDay ?? false;
  // v11: paper 3/6, live 4-5/6 (paper도 최소한의 품질 검증 필수)
  const liveMin = isRally ? 4 : aiScore >= 80 ? 4 : 5;
  const min = isPaper ? 3 : liveMin;

  return { passed: count >= min, count, min, details };
}
