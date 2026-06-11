/**
 * 리스크 게이트 (5개 중 N개 통과) + 돌파 확인 하드 블록
 *
 * rHighChase, rTechScore, rVolumeProfile, rShortPressure, rBreakoutConfirm
 */

import { logger } from '../../../utils/logger.js';
import type { RiskGateInput, GateResult } from './types.js';

/**
 * 가짜 돌파 하드 블록 (리스크 게이트 이전에 적용)
 * @returns true = 차단, false = 통과
 */
export function isBreakoutBlocked(input: RiskGateInput): boolean {
  const { scoring, aiScore, curPrice } = input;
  const { atMultiDayHigh, nearResistance, adjustedVolRatio } = scoring;

  if (atMultiDayHigh && nearResistance && adjustedVolRatio < 1.5 && aiScore < 90) {
    logger.info(`  🚫 ${input.stockCode}: 5일고점+저항선+무성량(${adjustedVolRatio.toFixed(2)}x<1.5) → 가짜돌파 차단`, { component: 'TRACK_B' });
    return true;
  }
  return false;
}

export function checkRiskGates(input: RiskGateInput): GateResult {
  const { tech, candles, scoring, aiScore, signals, curPrice } = input;
  const { effectiveTechScore, minTechScore, nearResistance, atMultiDayHigh,
    todayChangePct, adjustedVolRatio, signalData } = scoring;

  // ─ rHighChase ─
  const rHighChase = (() => {
    if (aiScore >= 95) return true;
    const todayRange = candles[0].high - candles[0].low;
    let priceInRange: number;
    if (todayRange > curPrice * 0.003) {
      priceInRange = (curPrice - candles[0].low) / todayRange;
    } else {
      const prevClose = Number(candles[1]?.close ?? candles[0].close);
      const gapPct = prevClose > 0 ? (curPrice - prevClose) / prevClose * 100 : 0;
      priceInRange = gapPct >= 2.0 ? 0.90 : gapPct >= 1.0 ? 0.72 : 0.45;
    }
    const hasStrongMomentum = tech.bollingerBreakout === 'UP' || tech.ttmSqueeze.fireSignal === 'LONG' || tech.volumeRatio >= 2.5;
    return priceInRange <= 0.75 || (priceInRange <= 0.85 && hasStrongMomentum);
  })();

  // ─ rTechScore ─
  const rTechScore = effectiveTechScore >= minTechScore || (aiScore >= 85 && effectiveTechScore >= 45);

  // ─ rVolumeProfile ─
  const rVolumeProfile = !nearResistance;

  // ─ rShortPressure ─ v6: 공매도+대차잔고 강화, 호가벽 추가
  const rShortPressure = !signals ? true : (
    signalData.shortRatio < 8 && signalData.lendingRatio < 15 && signalData.bidAskRatio > 0.5
  );

  // ─ rBreakoutConfirm ─ v6: 호가 비대칭 검증 추가 (매수잔량 부족 돌파 = 가짜)
  const rBreakoutConfirm = (() => {
    if (!atMultiDayHigh) return true;
    // 돌파 + 거래량 확인 = OK
    if (todayChangePct >= 2 && adjustedVolRatio >= 1.5) return true;
    if (todayChangePct < 1) return true;
    // v6: 돌파인데 매도벽(bid/ask < 0.8) = 기관이 물량 던지는 중 → 가짜
    if (signals && signalData.bidAskRatio < 0.8 && adjustedVolRatio < 2.0) {
      logger.info(`  🚫 ${input.stockCode}: 돌파+매도벽(bid/ask=${signalData.bidAskRatio.toFixed(2)}) → 가짜돌파 차단`, { component: 'TRACK_B' });
      return false;
    }
    return false;
  })();

  const details = { chase: rHighChase, tech: rTechScore, vp: rVolumeProfile, short: rShortPressure, breakout: rBreakoutConfirm };
  const count = Object.values(details).filter(Boolean).length;
  const min = 2;

  return { passed: count >= min, count, min, details };
}
