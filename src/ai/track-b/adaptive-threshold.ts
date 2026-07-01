/**
 * 🎯 Innovation #1: Adaptive Buy Threshold (적응형 매수 기준)
 *
 * 시장 레짐, 변동성, 최근 성과, 포트폴리오 상태에 따라
 * buyThreshold를 동적으로 조정하여 시장 상황에 맞는 진입 기준 제공
 */

import type { RegimeV2 } from './regime-v2.js';
import { logger } from '../../utils/logger.js';

export interface AdaptiveThresholdInput {
  /** 전략별 기본 buyThreshold (SWING=70, MOMENTUM=65 등) */
  base: number;
  /** 현재 시장 레짐 */
  regime?: RegimeV2;
  /** ATR 기반 변동성 % (일봉 기준) */
  atrPct?: number;
  /** 최근 연속 승/패 횟수 (양수=연승, 음수=연패) */
  recentStreak?: number;
  /** 오늘 일일 PnL % */
  dailyPnlPct?: number;
  /** 포트폴리오 가동률 (0~1, 투자금/총자산) */
  portfolioUtil?: number;
}

/**
 * 적응형 매수 임계값 계산
 *
 * 양수 조정 = 더 보수적 (진입 어려움)
 * 음수 조정 = 더 적극적 (진입 쉬움)
 *
 * @returns 조정된 buyThreshold
 */
export function getAdaptiveBuyThreshold(input: AdaptiveThresholdInput): number {
  const { base, regime, atrPct, recentStreak, dailyPnlPct, portfolioUtil } = input;
  let adj = 0;
  const tags: string[] = [];

  // 1. 레짐 기반 조정
  if (regime) {
    const regimeAdj: Record<RegimeV2, number> = {
      TREND_BULL: -5,      // 상승추세 → 적극적 진입
      BREAKOUT: -3,        // 돌파 임박 → 약간 적극적
      RANGE_LOW_VOL: 0,    // 저변동 횡보 → 기본값 유지
      RANGE_HIGH_VOL: +5,  // 고변동 횡보 → 신중
      TREND_BEAR: +10,     // 하락추세 → 보수적
      DISTRIBUTION: +12,   // 분배구간 → 매우 보수적
    };
    const ra = regimeAdj[regime];
    if (ra !== 0) {
      adj += ra;
      tags.push(`레짐(${regime}:${ra > 0 ? '+' : ''}${ra})`);
    }
  }

  // 2. ATR 변동성 기반 조정
  if (atrPct != null && atrPct > 0) {
    if (atrPct >= 4.0) {
      adj += 3;
      tags.push(`고변동(ATR${atrPct.toFixed(1)}%:+3)`);
    } else if (atrPct <= 1.5) {
      adj -= 2;
      tags.push(`저변동(ATR${atrPct.toFixed(1)}%:-2)`);
    }
  }

  // 3. 연승/연패 기반 조정
  if (recentStreak != null) {
    if (recentStreak <= -3) {
      adj += 5; // 3연패 이상 → 방어적
      tags.push(`연패(${recentStreak}:+5)`);
    } else if (recentStreak >= 3) {
      adj -= 2; // 3연승 이상 → 적극적
      tags.push(`연승(${recentStreak}:-2)`);
    }
  }

  // 4. 일일 PnL 기반 조정
  if (dailyPnlPct != null) {
    if (dailyPnlPct <= -3.0) {
      adj += 8; // 큰 일일 손실 → 매우 방어적
      tags.push(`일손실(${dailyPnlPct.toFixed(1)}%:+8)`);
    } else if (dailyPnlPct <= -1.5) {
      adj += 4; // 중간 손실 → 방어적
      tags.push(`일손실(${dailyPnlPct.toFixed(1)}%:+4)`);
    }
  }

  // 5. 포트폴리오 가동률 기반 조정
  if (portfolioUtil != null) {
    if (portfolioUtil >= 0.8) {
      adj += 5; // 80%+ 투자 → 보수적 (현금 보전)
      tags.push(`고가동(${(portfolioUtil * 100).toFixed(0)}%:+5)`);
    } else if (portfolioUtil <= 0.2) {
      adj -= 3; // 20%- 투자 → 적극적 (현금 과다)
      tags.push(`저가동(${(portfolioUtil * 100).toFixed(0)}%:-3)`);
    }
  }

  // Clamp: [base - 12, base + 20]
  const result = Math.max(base - 12, Math.min(base + 20, base + adj));

  if (adj !== 0) {
    logger.info(
      `🎚️ ADAPTIVE_THRESH: base=${base} adj=${adj > 0 ? '+' : ''}${adj} → ${result} [${tags.join(', ')}]`,
      { component: 'TRACK_B' },
    );
  }

  return result;
}
