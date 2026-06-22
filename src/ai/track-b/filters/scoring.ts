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
import type { ScoringInput, TechScoring, SignalData } from './types.js';

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

/** 시그널 보너스 계산 (기술점수에 가산) — v6: 수급 가중치 대폭 강화 */
function calcSignalBonus(s: SignalData): number {
  // v9-fix: 시그널 데이터 미수신(전부 0) → 페널티 없이 0 반환
  // KIS API 장애/미지원 종목일 때 일괄 -5점 방지
  const hasAnyData = s.intensity > 0 || s.shortRatio > 0 || s.bidAskRatio !== 1 || s.foreignNetEst !== 0 || s.instNetEst !== 0;
  if (!hasAnyData) return 0;
  return (
    // 체결강도: 매수>매도 비율 (120↑ = 강한 매수세)
    (s.intensity >= 130 ? 10 : s.intensity >= 120 ? 7 : s.intensity >= 105 ? 3 : s.intensity < 85 ? -5 : 0) +
    // 외국인+기관 동반 매수 = 기관 컨센서스 (가장 강력한 선행지표)
    (s.foreignNetEst > 0 && s.instNetEst > 0 ? 10 : s.foreignNetEst < 0 && s.instNetEst < 0 ? -12 : 0) +
    // 외국계 증권사 순매수 = 외국인 대형 유입 신호
    (s.foreignBrokerBuy ? 5 : 0) +
    // 공매도 비율: 높으면 하방 압력 또는 숏스퀴즈 (8%↑ = 주의)
    (s.shortRatio > 10 ? -8 : s.shortRatio > 5 ? -4 : 0) +
    // 대차잔고: 공매도 대기 물량 (15%↑ = 위험, 10%↑ = 주의)
    (s.lendingRatio > 15 ? -6 : s.lendingRatio > 10 ? -3 : 0) +
    // 호가 비대칭: 매수벽(1.8↑) = 강한 지지, 매도벽(0.5↓) = 급락 위험
    (s.bidAskRatio >= 1.8 ? 6 : s.bidAskRatio >= 1.3 ? 2 : s.bidAskRatio <= 0.5 ? -8 : s.bidAskRatio <= 0.7 ? -3 : 0)
  );
}

/** 거래량 시간대 보정 */
function calcAdjustedVolRatio(rawVolRatio: number): number {
  const kstNow = getKSTNow();
  const marketMinutes = kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes() - 540;
  const timeElapsedRatio = Math.max(0.15, Math.min(1.0, marketMinutes / 390));
  return rawVolRatio / timeElapsedRatio;
}

/**
 * 전체 스코어링 계산
 */
export function computeScoring(input: ScoringInput): TechScoring {
  const { stock, tech, candles, price, signals, mode, megaCap } = input;
  const code = stock.stock_code;
  const curPrice = price.currentPrice;

  // ── 캔들 패턴 ──
  const hasBullishCandle = tech.candlePatterns.some((p) => p.bullish && p.strength === 'STRONG');
  const candleBonus = hasBullishCandle
    ? 12
    : tech.candlePatterns.some((p) => p.bullish && p.strength === 'MODERATE')
      ? 6
      : 0;

  // ── 시그널 ──
  const signalData = extractSignals(signals);
  const signalBonus = calcSignalBonus(signalData);
  if (signals && signalBonus !== 0) {
    logger.info(
      `  📡 ${code}: 시그널 체결강도=${signalData.intensity.toFixed(0)} 공매도=${signalData.shortRatio.toFixed(1)}% 호가비=${signalData.bidAskRatio.toFixed(2)} 외인추정=${signalData.foreignNetEst}M → ${signalBonus > 0 ? '+' : ''}${signalBonus}점`,
      { component: 'TRACK_B' },
    );
  }

  // ── 거래량 시간대 보정 ──
  const adjustedVolRatio = calcAdjustedVolRatio(tech.volumeRatio);

  // ── 우선주/테마 보너스 ──
  const priorityBonus = megaCap ? 10 + megaCap.bonus : PRIORITY_SECTOR_CODES.has(code) ? 10 : 0;

  // ── 구조 패턴 ──
  const structPatterns = detectStructuralPatterns(candles);
  const structBonus = structPatterns.reduce((sum, p) => sum + p.score, 0);
  if (structPatterns.length > 0) {
    logger.info(
      `  🔷 ${code}: 구조패턴 [${structPatterns.map((p) => p.label).join(', ')}] → ${structBonus > 0 ? '+' : ''}${structBonus}점`,
      { component: 'TRACK_B' },
    );
  }

  // ── 볼륨 프로파일 ──
  const vpLevels = volumeProfile(candles);
  const nearSupport = vpLevels.some((l) => l.isSupport && Math.abs(l.priceLevel - curPrice) / curPrice < 0.02);
  const nearResistance = vpLevels.some((l) => l.isResistance && Math.abs(l.priceLevel - curPrice) / curPrice < 0.015);
  const vpBonus = nearSupport ? 8 : nearResistance ? -6 : 0;
  if (vpBonus !== 0) {
    logger.info(
      `  📊 ${code}: 볼륨프로파일 ${nearSupport ? '지지선 근처' : '저항선 근처'} → ${vpBonus > 0 ? '+' : ''}${vpBonus}점`,
      { component: 'TRACK_B' },
    );
  }

  // ── 눌림목 ──
  const recentHigh5 = candles.length >= 6 ? Math.max(...candles.slice(1, 6).map((c) => c.high)) : 0;
  const truePullbackPattern =
    tech.sma20 > 0 && recentHigh5 > tech.sma20 * 1.04 && curPrice >= tech.sma20 * 0.98 && curPrice <= tech.sma20 * 1.02;
  const pullbackBonus = truePullbackPattern ? 12 : 0;
  if (truePullbackPattern) {
    logger.info(`  🎯 ${code}: 눌림목 타점 +12점`, { component: 'TRACK_B' });
  }

  // ── 피보나치 ──
  const fibBonus = tech.fibResult?.fibScore ?? 0;
  if (fibBonus > 0 && tech.fibResult) {
    const nearLevel = tech.fibResult.levels.find((l) => l.isNear);
    if (nearLevel) {
      logger.info(`  📐 ${code}: 피보나치 ${(nearLevel.level * 100).toFixed(1)}% → +${fibBonus}점`, {
        component: 'TRACK_B',
      });
    }
  }

  // ── RSI 다이버전스 ──
  const rsiDivBonus = tech.rsiDivergence?.type === 'BULLISH' ? Math.round(8 * (tech.rsiDivergence.strength || 0.5)) : 0;
  if (rsiDivBonus > 0) {
    logger.info(
      `  🔄 ${code}: RSI 불리쉬 다이버전스 → +${rsiDivBonus}점 (strength=${tech.rsiDivergence?.strength?.toFixed(2)})`,
      { component: 'TRACK_B' },
    );
  }

  // ── 볼린저 스퀴즈 돌파 ──
  const bbSqueezeBonus = tech.bollingerBreakout === 'UP' && tech.bollingerSqueeze ? 10 : 0;
  if (bbSqueezeBonus > 0) {
    logger.info(`  💥 ${code}: 볼린저 스퀴즈 상방돌파 → +${bbSqueezeBonus}점`, { component: 'TRACK_B' });
  }

  // ── Volume Climax Guard: 거래량 3x+ = 반전 가능성 높음 (학술 검증) ──
  const volumeClimaxPenalty = adjustedVolRatio >= 4.0 ? -12 : adjustedVolRatio >= 3.0 ? -8 : 0;
  if (volumeClimaxPenalty < 0) {
    logger.info(
      `  ⚡ ${code}: 거래량 폭증 ${adjustedVolRatio.toFixed(1)}x (반전 위험) → ${volumeClimaxPenalty}점`,
      { component: 'TRACK_B' },
    );
  }

  // ── 합산 ──
  const effectiveTechScore =
    tech.score +
    priorityBonus +
    candleBonus +
    structBonus +
    vpBonus +
    pullbackBonus +
    fibBonus +
    signalBonus +
    rsiDivBonus +
    bbSqueezeBonus +
    volumeClimaxPenalty;
  const isFibSupport = fibBonus >= 10 && tech.macdCrossover !== 'BEARISH';

  // ── 5일 고점/금일 변화율 ──
  const high5d = candles.length >= 6 ? Math.max(...candles.slice(1, 6).map((c) => c.high)) : 0;
  const atMultiDayHigh = high5d > 0 && curPrice >= high5d * 0.995;
  const prevClose5 = candles.length >= 2 ? Number(candles[1].close) : curPrice;
  const todayChangePct = prevClose5 > 0 ? ((curPrice - prevClose5) / prevClose5) * 100 : 0;

  // ── minTechScore ──
  const minTechScore = megaCap ? 45 : 55;

  return {
    candleBonus,
    hasBullishCandle,
    structBonus,
    vpBonus,
    pullbackBonus,
    fibBonus,
    signalBonus,
    rsiDivBonus,
    bbSqueezeBonus,
    volumeClimaxPenalty,
    priorityBonus,
    effectiveTechScore,
    isFibSupport,
    nearSupport,
    nearResistance,
    atMultiDayHigh,
    todayChangePct,
    adjustedVolRatio,
    minTechScore,
    truePullbackPattern,
    signalData,
  };
}
