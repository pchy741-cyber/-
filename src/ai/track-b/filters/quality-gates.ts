/**
 * 품질 게이트 (6개 중 N개 통과)
 *
 * qVolume, qTrendStrength, qTrendDirection, qRsiTiming, qConfluence, qSignalFlow
 */

import type { QualityGateInput, GateResult } from './types.js';

export function checkQualityGates(input: QualityGateInput): GateResult {
  const { tech, scoring, mode, aiScore, buyThreshold, megaCap, noAiForStock, feedbackMinVolRatio, curPrice } = input;
  const { adjustedVolRatio, hasBullishCandle, effectiveTechScore, minTechScore,
    isFibSupport, truePullbackPattern, signalData } = scoring;

  // ─ qVolume ─
  const volThreshold = Math.max(
    feedbackMinVolRatio,
    aiScore >= 80 ? 0.5 : aiScore >= buyThreshold ? 0.8 : noAiForStock ? 0.8 : 1.2,
  );
  const qVolume = adjustedVolRatio >= volThreshold || tech.rsi14 < 35 || hasBullishCandle;

  // ─ qTrendStrength ─
  const qTrendStrength = tech.trendStrength !== 'WEAK' || aiScore >= 80 || !!megaCap;

  // ─ qTrendDirection ─
  const qTrendDirection = (() => {
    if (mode === 'SWING' && tech.sma20 < tech.sma60 && aiScore < 85 && tech.rsi14 >= 30) return false;
    if (mode === 'SWING' && tech.sma5 < tech.sma20 && aiScore < 85 && tech.rsi14 >= 35) return false;
    if (mode === 'DEFENSE' && curPrice < tech.sma20 && aiScore < 65 && tech.score < 50) return false;
    return true;
  })();

  // ─ qRsiTiming ─
  const qRsiTiming = (() => {
    const rsiCap = megaCap ? 80 : 75;
    const aiBypassRsi = aiScore >= buyThreshold && tech.rsi14 <= 80;
    if (tech.rsi14 > rsiCap && !aiBypassRsi) return false;
    const oversoldReversalOk = tech.macdHistogram >= 0 || tech.macdCrossover === 'BULLISH' || tech.rsi2 < 15 || hasBullishCandle || tech.stochasticSignal === 'OVERSOLD';
    const isOversold = tech.rsi14 < 30 && oversoldReversalOk;
    const isEarlyBounce = tech.rsi14 >= 30 && tech.rsi14 < 45 && (tech.macdCrossover !== 'BEARISH' || tech.volumeRatio >= 1.3 || hasBullishCandle);
    const isPullback = tech.rsi14 >= 45 && tech.rsi14 <= 65 && tech.macdCrossover !== 'BEARISH' && (
      truePullbackPattern || isFibSupport || tech.macdCrossover === 'BULLISH' || aiScore >= buyThreshold || effectiveTechScore >= minTechScore
    );
    const isMomentum = tech.rsi14 > 65 && tech.rsi14 <= 75 && (aiScore >= buyThreshold || effectiveTechScore >= minTechScore + 5);
    const isHighConviction = (aiScore >= 80 || effectiveTechScore >= minTechScore + 15) && (effectiveTechScore >= minTechScore || aiScore >= buyThreshold);
    return isOversold || isEarlyBounce || isPullback || isMomentum || isHighConviction || isFibSupport;
  })();

  // ─ qConfluence ─
  const qConfluence = (() => {
    if (mode === 'SCALPING') return true;
    const hasStrongCatalyst = tech.bollingerBreakout === 'UP' || tech.ttmSqueeze.fireSignal === 'LONG' || tech.vwapCross === 'JUST_ABOVE' || tech.rsi2 < 10;
    if (hasStrongCatalyst) return true;
    const cf = {
      momentum: tech.macdCrossover !== 'BEARISH' || tech.macdHistogram > 0,
      rsi: tech.rsi14 <= 60 || tech.rsi14 < 30,
      volume: adjustedVolRatio >= 1.2,
      vwap: tech.vwapPosition === 'ABOVE' || tech.vwapPullback,
      pattern: hasBullishCandle || tech.candlePatterns.some(p => p.bullish && p.strength !== 'WEAK'),
      trend: tech.trendStrength !== 'WEAK',
    };
    const cfCount = Object.values(cf).filter(Boolean).length;
    // 2026-06: 최소 2개 컨플루언스 필수 (AI 85+도 1개는 허점)
    const minCf = aiScore >= 90 ? 2 : aiScore >= 70 ? 3 : noAiForStock ? 3 : 3;
    return cfCount >= minCf;
  })();

  // ─ qSignalFlow ─
  const qSignalFlow = !signalData.raw ? true : (
    signalData.intensity >= 100 || signalData.foreignNetEst > 0 || signalData.instNetEst > 0 || signalData.foreignBrokerBuy
  );

  const details = { vol: qVolume, trend: qTrendStrength, dir: qTrendDirection, rsi: qRsiTiming, cf: qConfluence, sig: qSignalFlow };
  const count = Object.values(details).filter(Boolean).length;
  // 2026-06 성과 검토: WR 30.8% → 품질 게이트 최소 2개로 상향 (AI 85+도 1개는 불충분)
  // 기존: AI≥85 → min=1 → 사실상 무필터 → 잘못된 진입 70% → 승률 30.8%
  const min = buyThreshold >= 85 ? (aiScore >= 92 ? 2 : 3) : aiScore >= 90 ? 2 : aiScore >= 70 ? 3 : 4;

  return { passed: count >= min, count, min, details };
}
