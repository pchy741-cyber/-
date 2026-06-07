/**
 * 스코어링: 보너스 계산 + effectiveTechScore
 *
 * 캔들·구조패턴·볼륨프로파일·눌림목·피보나치·RSI다이버전스·BB스퀴즈·시그널 보너스
 * 모두 여기서 계산하고 ScoringResult 로 반환한다.
 */

import { detectStructuralPatterns, volumeProfile } from '../../../analysis/indicators.js';
import { logger } from '../../../utils/logger.js';
import { getKSTNow } from '../../../utils/time.js';
import { PRIORITY_SECTOR_CODES } from '../trading-rules.js';
import type { ScoringInput, ScoringResult, SignalData } from './types.js';

/** KIS 시그널에서 필요한 값만 추출 */
function extractSignals(signals: ScoringInput['signals']): SignalData {
  return {
    raw: signals,
    intensity: signals?.tradingIntensity?.intensity ?? 0,
    shortRatio: signals?.shortSelling?.shortRatio ?? 0,
    bidAskRatio: signals?.orderbookDepth?.bidAskRatio ?? 1,
    foreignNetEst: signals?.intradayInvestor?.foreignNetEstMil ?? 0,
    instNetEst: signals?.intradayInvestor?.institutionNetEstMil ?? 0,
    foreignBrokerBuy: signals?.brokerInfo?.foreignBrokerNetBuy ?? false,
    lendingRatio: signals?.stockLending?.lendingRatio ?? 0,
  };
}

/** 시그널 보너스 계산 (기술점수에 가산) */
function calcSignalBonus(s: SignalData): number {
  return (
    (s.intensity >= 120 ? 6 : s.intensity >= 105 ? 3 : 0) +
    (s.foreignNetEst > 0 && s.instNetEst > 0 ? 5 : 0) +
    (s.foreignBrokerBuy ? 3 : 0) +
    (s.shortRatio > 5 ? -4 : 0) +
    (s.lendingRatio > 10 ? -3 : 0) +
    (s.bidAskRatio >= 1.5 ? 3 : s.bidAskRatio <= 0.6 ? -4 : 0)
  );
}

/** 거래량 시간대 보정 */
function calcAdjustedVolRatio(rawVolRatio: number): number {
  const kstNow = getKSTNow();
  const marketMinutes = (kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes()) - 540;
  const timeElapsedRatio = Math.max(0.15, Math.min(1.0, marketMinutes / 390));
  return rawVolRatio / timeElapsedRatio;
}

/**
 * 전체 스코어링 계산
 */
export function computeScoring(input: ScoringInput): ScoringResult {
  const { stock, tech, candles, price, signals, mode, megaCap, aiScore, feedbackMinVolRatio } = input;
  const code = stock.stock_code;
  const curPrice = price.currentPrice;

  // ── 캔들 패턴 ──
  const hasBullishCandle = tech.candlePatterns.some(p => p.bullish && p.strength === 'STRONG');
  const candleBonus = hasBullishCandle ? 12 : tech.candlePatterns.some(p => p.bullish && p.strength === 'MODERATE') ? 6 : 0;

  // ── 시그널 ──
  const signalData = extractSignals(signals);
  const signalBonus = calcSignalBonus(signalData);
  if (signals && signalBonus !== 0) {
    logger.info(`  📡 ${code}: 시그널 체결강도=${signalData.intensity.toFixed(0)} 공매도=${signalData.shortRatio.toFixed(1)}% 호가비=${signalData.bidAskRatio.toFixed(2)} 외인추정=${signalData.foreignNetEst}M → ${signalBonus > 0 ? '+' : ''}${signalBonus}점`, { component: 'TRACK_B' });
  }

  // ── 거래량 시간대 보정 ──
  const adjustedVolRatio = calcAdjustedVolRatio(tech.volumeRatio);

  // ── 우선주/테마 보너스 ──
  const priorityBonus = megaCap
    ? 10 + megaCap.bonus
    : PRIORITY_SECTOR_CODES.has(code) ? 10 : 0;

  // ── 구조 패턴 ──
  const structPatterns = detectStructuralPatterns(candles);
  const structBonus = structPatterns.reduce((sum, p) => sum + p.score, 0);
  if (structPatterns.length > 0) {
    logger.info(`  🔷 ${code}: 구조패턴 [${structPatterns.map(p => p.label).join(', ')}] → ${structBonus > 0 ? '+' : ''}${structBonus}점`, { component: 'TRACK_B' });
  }

  // ── 볼륨 프로파일 ──
  const vpLevels = volumeProfile(candles);
  const nearSupport = vpLevels.some(l => l.isSupport && Math.abs(l.priceLevel - curPrice) / curPrice < 0.02);
  const nearResistance = vpLevels.some(l => l.isResistance && Math.abs(l.priceLevel - curPrice) / curPrice < 0.015);
  const vpBonus = nearSupport ? 8 : nearResistance ? -6 : 0;
  if (vpBonus !== 0) {
    logger.info(`  📊 ${code}: 볼륨프로파일 ${nearSupport ? '지지선 근처' : '저항선 근처'} → ${vpBonus > 0 ? '+' : ''}${vpBonus}점`, { component: 'TRACK_B' });
  }

  // ── 눌림목 ──
  const recentHigh5 = candles.length >= 6 ? Math.max(...candles.slice(1, 6).map(c => c.high)) : 0;
  const truePullbackPattern = tech.sma20 > 0 && recentHigh5 > tech.sma20 * 1.04 &&
    curPrice >= tech.sma20 * 0.98 && curPrice <= tech.sma20 * 1.05;
  const pullbackBonus = truePullbackPattern ? 12 : 0;
  if (truePullbackPattern) {
    logger.info(`  🎯 ${code}: 눌림목 타점 +12점`, { component: 'TRACK_B' });
  }

  // ── 피보나치 ──
  const fibBonus = tech.fibResult?.fibScore ?? 0;
  if (fibBonus > 0 && tech.fibResult) {
    const nearLevel = tech.fibResult.levels.find(l => l.isNear);
    if (nearLevel) {
      logger.info(`  📐 ${code}: 피보나치 ${(nearLevel.level * 100).toFixed(1)}% → +${fibBonus}점`, { component: 'TRACK_B' });
    }
  }

  // ── RSI 다이버전스 ──
  const rsiDivBonus = tech.rsiDivergence?.type === 'BULLISH'
    ? Math.round(8 * (tech.rsiDivergence.strength || 0.5)) : 0;
  if (rsiDivBonus > 0) {
    logger.info(`  🔄 ${code}: RSI 불리쉬 다이버전스 → +${rsiDivBonus}점 (strength=${tech.rsiDivergence?.strength?.toFixed(2)})`, { component: 'TRACK_B' });
  }

  // ── 볼린저 스퀴즈 돌파 ──
  const bbSqueezeBonus = tech.bollingerBreakout === 'UP' && tech.bollingerSqueeze ? 10 : 0;
  if (bbSqueezeBonus > 0) {
    logger.info(`  💥 ${code}: 볼린저 스퀴즈 상방돌파 → +${bbSqueezeBonus}점`, { component: 'TRACK_B' });
  }

  // ── 합산 ──
  const effectiveTechScore = tech.score + priorityBonus + candleBonus + structBonus +
    vpBonus + pullbackBonus + fibBonus + signalBonus + rsiDivBonus + bbSqueezeBonus;
  const isFibSupport = fibBonus >= 10 && tech.macdCrossover !== 'BEARISH';

  // ── 5일 고점/금일 변화율 ──
  const high5d = candles.length >= 6 ? Math.max(...candles.slice(1, 6).map(c => c.high)) : 0;
  const atMultiDayHigh = high5d > 0 && curPrice >= high5d * 0.995;
  const prevClose5 = candles.length >= 2 ? Number(candles[1].close) : curPrice;
  const todayChangePct = prevClose5 > 0 ? ((curPrice - prevClose5) / prevClose5) * 100 : 0;

  // ── minTechScore ──
  const minTechScore = megaCap ? 45 : mode === 'SCALPING' ? 50 : 55;

  return {
    candleBonus, hasBullishCandle, structBonus, vpBonus, pullbackBonus,
    fibBonus, signalBonus, rsiDivBonus, bbSqueezeBonus, priorityBonus,
    effectiveTechScore, isFibSupport, nearSupport, nearResistance,
    atMultiDayHigh, todayChangePct, adjustedVolRatio, minTechScore,
    truePullbackPattern, signalData,
  };
}
