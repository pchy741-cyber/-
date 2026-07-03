/**
 * 스코어링: 보너스 계산 + effectiveTechScore
 *
 * 캔들·구조패턴·볼륨프로파일·눌림목·피보나치·RSI다이버전스·BB스퀴즈·시그널 보너스
 * 모두 여기서 계산하고 ScoringResult 로 반환한다.
 */

import { detectStructuralPatterns, volumeProfile } from '../../../analysis/indicators.js';
import { analyzeSequencePatterns } from '../../../analysis/sequence-patterns.js';
import type { BonusWeights } from '../../../automation/self-learning/bonus-calibration.js';
import { logger } from '../../../utils/logger.js';
import { getKSTNow } from '../../../utils/time.js';
import { PRIORITY_SECTOR_CODES } from '../trading-rules.js';
import type { ScoringInput, SignalData, TechScoring } from './types.js';

// ── Tier 4: 보너스 가중치 캐시 (비동기 로드 → 동기 적용) ──
let _bonusWeights: BonusWeights | null = null;
let _bonusWeightsLoadedAt = 0;
const BONUS_WEIGHTS_TTL = 30 * 60 * 1000; // 30분

/** 보너스 가중치 비동기 갱신 (fire-and-forget) */
function refreshBonusWeightsIfStale(): void {
  if (_bonusWeights && Date.now() - _bonusWeightsLoadedAt < BONUS_WEIGHTS_TTL) return;
  import('../../../automation/self-learning/bonus-calibration.js')
    .then((m) => m.getBonusWeights())
    .then((w) => { _bonusWeights = w; _bonusWeightsLoadedAt = Date.now(); })
    .catch(() => { /* 실패 시 기본값 유지 */ });
}

function bw(key: keyof BonusWeights): number {
  return _bonusWeights?.[key] ?? 1.0;
}

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

/** 시그널 보너스 계산 (기술점수에 가산) — v16.1: 체결강도+수급 가중치 강화 */
function calcSignalBonus(s: SignalData): number {
  // v9-fix: 시그널 데이터 미수신(전부 0) → 페널티 없이 0 반환
  const hasAnyData =
    s.intensity > 0 || s.shortRatio > 0 || s.bidAskRatio !== 1 || s.foreignNetEst !== 0 || s.instNetEst !== 0;
  if (!hasAnyData) return 0;
  return (
    // 체결강도: 매수>매도 비율 (v16.1: 140+ 추가, 상방 확대)
    (s.intensity >= 140 ? 15 : s.intensity >= 130 ? 12 : s.intensity >= 120 ? 8 : s.intensity >= 105 ? 3 : s.intensity < 80 ? -7 : s.intensity < 90 ? -3 : 0) +
    // 외국인+기관 동반 매수 = 기관 컨센서스 (v16.1: +12, 가장 강력한 선행지표)
    (s.foreignNetEst > 0 && s.instNetEst > 0 ? 12 : s.foreignNetEst < 0 && s.instNetEst < 0 ? -12 : 0) +
    // 외국인 단독 대량 매수 추가 (v16.1: 10M+ = +4)
    (s.foreignNetEst >= 10 ? 4 : 0) +
    // 외국계 증권사 순매수 = 외국인 대형 유입 신호
    (s.foreignBrokerBuy ? 6 : 0) +
    // 공매도 비율: 높으면 하방 압력 (v16.1: 10%→12% 완화, 숏스퀴즈 기회 보존)
    (s.shortRatio > 12 ? -8 : s.shortRatio > 7 ? -4 : 0) +
    // 대차잔고: 공매도 대기 물량
    (s.lendingRatio > 15 ? -6 : s.lendingRatio > 10 ? -3 : 0) +
    // 호가 비대칭: 매수벽 = 강한 지지 (v16.1: 2.0+ 추가 구간)
    (s.bidAskRatio >= 2.0 ? 8 : s.bidAskRatio >= 1.5 ? 5 : s.bidAskRatio >= 1.2 ? 2 : s.bidAskRatio <= 0.5 ? -8 : s.bidAskRatio <= 0.7 ? -3 : 0)
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

  // Tier 4: 보너스 가중치 비동기 갱신 트리거
  refreshBonusWeightsIfStale();

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

  // ── v16.1: 거래량 동적 보너스 + Volume Climax Guard ──
  // 적정 거래량(1.5~2.5x) = 건강한 매수세 → 보너스, 폭증(4x+) = 반전 위험
  const volumeBonus =
    adjustedVolRatio >= 5.0 ? -15 : // 극단 폭증: 반전 위험 최고
    adjustedVolRatio >= 3.5 ? -8 :  // 과열 구간
    adjustedVolRatio >= 2.5 ? 0 :   // 중립 (과열 vs 강세 경계)
    adjustedVolRatio >= 2.0 ? 6 :   // 강한 매수세 동반
    adjustedVolRatio >= 1.5 ? 4 :   // 건강한 거래량 증가
    adjustedVolRatio >= 1.2 ? 2 :   // 약한 증가
    adjustedVolRatio < 0.5 ? -5 :   // 거래량 고갈 (유동성 리스크)
    0;
  // 하위 호환: volumeClimaxPenalty 변수명 유지
  const volumeClimaxPenalty = volumeBonus;
  if (volumeBonus !== 0) {
    logger.info(`  📊 ${code}: 거래량 ${adjustedVolRatio.toFixed(1)}x → ${volumeBonus > 0 ? '+' : ''}${volumeBonus}점`, {
      component: 'TRACK_B',
    });
  }

  // ── Tier 5: 시퀀스 패턴 보너스 ──
  let sequenceBonus = 0;
  try {
    const seqResult = analyzeSequencePatterns(candles);
    sequenceBonus = seqResult.bonus;
    if (sequenceBonus !== 0) {
      logger.info(
        `  🔢 ${code}: 시퀀스 ${sequenceBonus > 0 ? '+' : ''}${sequenceBonus}점 [${seqResult.details.join(', ')}]`,
        { component: 'TRACK_B' },
      );
    }
  } catch {
    // 폴백: sequenceBonus = 0
  }

  // ── 합산 (Tier 4: 보너스 가중치 적용) ──
  let effectiveTechScore =
    tech.score +
    Math.round(priorityBonus * bw('priorityBonus')) +
    Math.round(candleBonus * bw('candleBonus')) +
    Math.round(structBonus * bw('structBonus')) +
    Math.round(vpBonus * bw('vpBonus')) +
    Math.round(pullbackBonus * bw('pullbackBonus')) +
    Math.round(fibBonus * bw('fibBonus')) +
    Math.round(signalBonus * bw('signalBonus')) +
    Math.round(rsiDivBonus * bw('rsiDivBonus')) +
    Math.round(bbSqueezeBonus * bw('bbSqueezeBonus')) +
    Math.round(volumeClimaxPenalty * bw('volumeBonus')) +
    Math.round(sequenceBonus * bw('sequenceBonus'));
  const isFibSupport = fibBonus >= 10 && tech.macdCrossover !== 'BEARISH';

  // ── 5일 고점/금일 변화율 ──
  const high5d = candles.length >= 6 ? Math.max(...candles.slice(1, 6).map((c) => c.high)) : 0;
  const atMultiDayHigh = high5d > 0 && curPrice >= high5d * 0.995;
  const prevClose5 = candles.length >= 2 ? Number(candles[1].close) : curPrice;
  const todayChangePct = prevClose5 > 0 ? ((curPrice - prevClose5) / prevClose5) * 100 : 0;

  // ── v17: 거래량 폭증 + 고모멘텀 교차 감점 — 고점 확인 매물소진을 매수로 오인 방지 ──
  if (adjustedVolRatio >= 2.0 && tech.catMomentum > 10) {
    const volMomPenalty = adjustedVolRatio >= 3.5 ? -15 : adjustedVolRatio >= 2.5 ? -10 : -6;
    effectiveTechScore += volMomPenalty;
    logger.info(
      `  ⚠️ ${code}: 거래량폭증+고모멘텀 교차감점 ${volMomPenalty}점 (vol=${adjustedVolRatio.toFixed(1)}x mom=${tech.catMomentum})`,
      { component: 'TRACK_B' },
    );
  }

  // ── v17: 5일 고점 방어 — atMultiDayHigh + 거래량 동반 시 고점 추격 강력 감점 ──
  if (atMultiDayHigh) {
    const highPenalty = adjustedVolRatio >= 2.0 ? -15 : adjustedVolRatio >= 1.5 ? -10 : -5;
    effectiveTechScore += highPenalty;
    logger.info(
      `  🔺 ${code}: 5일고점 방어 ${highPenalty}점 (vol=${adjustedVolRatio.toFixed(1)}x) — 고점 추격 억제`,
      { component: 'TRACK_B' },
    );
  }

  // ── v22: 모멘텀 품질 체크 — RSI 방향 + 거래량 동반 = 진짜 모멘텀 ──
  // RSI 하락 중 + 거래량 부족 = 가짜 시그널 → 감점
  // RSI 상승 중 + 적정 거래량 = 진짜 모멘텀 → 가점
  let momentumQualityAdj = 0;
  try {
    if (candles.length >= 3) {
      const rsi0 = tech.rsi14; // 현재 RSI
      // RSI 추세 판단 (최근 캔들 기반)
      const rsiRising = rsi0 >= 40 && rsi0 <= 70 && tech.catMomentum > 0;
      const rsiFalling = rsi0 > 60 && tech.catMomentum < -5;

      if (rsiRising && adjustedVolRatio >= 1.0 && adjustedVolRatio <= 3.0) {
        // RSI 적정 구간에서 상승 + 거래량 동반 = 양질의 모멘텀
        momentumQualityAdj = +8;
      } else if (rsiFalling && adjustedVolRatio < 0.8) {
        // RSI 하락 + 거래량 감소 = 매도 분위기
        momentumQualityAdj = -10;
      } else if (rsi0 > 75 && adjustedVolRatio >= 2.0) {
        // RSI 과매수 + 거래량 폭증 = 고점 소진
        momentumQualityAdj = -12;
      }

      if (momentumQualityAdj !== 0) {
        effectiveTechScore += momentumQualityAdj;
        logger.info(
          `  📈 ${code}: 모멘텀품질 ${momentumQualityAdj > 0 ? '+' : ''}${momentumQualityAdj}점 (RSI=${rsi0.toFixed(0)} mom=${tech.catMomentum} vol=${adjustedVolRatio.toFixed(1)}x)`,
          { component: 'TRACK_B' },
        );
      }
    }
  } catch { /* 폴백: adj=0 */ }

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
