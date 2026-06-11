/**
 * 🔀 레짐 기반 전략 라우터
 *
 * 레짐별 진입 조건 분기 — 기존 필터 체인과 병행 경로
 * 라우터 통과 시 기존 컨플루언스/RSI타이밍 스킵 가능
 * 미통과 시 기존 필터 체인 그대로 실행 (backward compatible)
 */

import type { TechnicalSummary } from '../../analysis/indicators.js';
import { detectRegimeV2, getRegimeEntryConfig, type RegimeV2, type RegimeEntryConfig } from './regime-v2.js';

export interface RouteResult {
  routed: boolean;           // 라우터가 진입을 승인했는가
  regime: RegimeV2;
  regimeConfidence: number;
  entryConfig: RegimeEntryConfig;
  reason: string;
  buyThresholdAdj: number;   // buyThreshold 조정값 (TREND_BEAR: +25 등)
}

/**
 * 레짐 기반 진입 경로 판단
 *
 * @param tech - analyzeTechnicals 결과
 * @param closes - 종가 배열 (desc, candles[].close)
 * @param aiScore - AI 점수 (0이면 없음)
 * @returns RouteResult — routed=true이면 기존 필터 체인 스킵 가능
 */
export function routeByRegime(
  tech: TechnicalSummary,
  closes: number[],
  aiScore: number,
): RouteResult {
  const regimeResult = detectRegimeV2(tech, closes);
  const entryConfig = getRegimeEntryConfig(regimeResult.regime);

  const base: RouteResult = {
    routed: false,
    regime: regimeResult.regime,
    regimeConfidence: regimeResult.confidence,
    entryConfig,
    reason: '',
    buyThresholdAdj: 0,
  };

  switch (regimeResult.regime) {
    case 'TREND_BULL': {
      // v4: 강세장 완화 축소 — -10→-5 (실질 threshold 최소 75 유지)
      // 이전: buyThreshold 80 - 10 = 70 → 약한 AI 종목도 진입 → 승률 저하
      const checks = [
        tech.macdCrossover !== 'BEARISH',
        tech.adx14 > 25,
        tech.volumeRatio >= 1.2 || tech.vwapPosition === 'ABOVE',
      ];
      const passed = checks.filter(Boolean).length;
      if (passed >= 2) {
        return {
          ...base,
          routed: true,
          buyThresholdAdj: -5,   // v4: -10→-5 (80→75, 약한 신호 차단)
          reason: `TREND_BULL: ${passed}/3 통과 (ADX=${tech.adx14.toFixed(0)}, MACD=${tech.macdCrossover}, vol=${tech.volumeRatio.toFixed(2)}x)`,
        };
      }
      // 2/3 미달 → threshold 조정 없음 (기존 -5→0)
      return { ...base, buyThresholdAdj: 0, reason: `TREND_BULL: ${passed}/3 미달 → 기존 필터 (조정 없음)` };
    }

    case 'RANGE_LOW_VOL': {
      // (RSI2<15 OR RSI14<32) + (BB하단) → 평균회귀 진입
      const rsiOversold = tech.rsi2 < 15 || tech.rsi14 < 32;
      const bbLower = tech.bollingerPosition === 'BELOW_LOWER' || tech.bollingerPosition === 'NEAR_LOWER';
      if (rsiOversold && bbLower) {
        return {
          ...base,
          routed: true,
          reason: `RANGE_LOW_VOL 평균회귀: RSI=${tech.rsi14.toFixed(0)}/RSI2=${tech.rsi2.toFixed(0)}, BB=${tech.bollingerPosition}`,
        };
      }
      return { ...base, reason: 'RANGE_LOW_VOL: 평균회귀 조건 미충족 → 기존 필터' };
    }

    case 'BREAKOUT': {
      // TTM fire=LONG + vol>=1.5x → 스퀴즈 돌파 진입
      const ttmLong = tech.ttmSqueeze.fireSignal === 'LONG';
      const volOk = tech.volumeRatio >= 1.5;
      if (ttmLong && volOk) {
        return {
          ...base,
          routed: true,
          reason: `BREAKOUT 스퀴즈돌파: TTM=${tech.ttmSqueeze.fireSignal}, vol=${tech.volumeRatio.toFixed(2)}x, 스퀴즈${tech.ttmSqueeze.consecutiveSqueezeOn}봉`,
        };
      }
      // TTM만 통과해도 BB돌파가 있으면 허용
      if (ttmLong && tech.bollingerBreakout === 'UP') {
        return {
          ...base,
          routed: true,
          reason: `BREAKOUT BB돌파: TTM=${tech.ttmSqueeze.fireSignal}, BB돌파=UP`,
        };
      }
      return { ...base, reason: 'BREAKOUT: 돌파 조건 미충족 → 기존 필터' };
    }

    case 'TREND_BEAR': {
      // 사실상 차단: buyThreshold +25
      return {
        ...base,
        routed: false,
        buyThresholdAdj: 25,
        reason: `TREND_BEAR: buyThreshold +25 (ADX=${tech.adx14.toFixed(0)}, SMA20<SMA60)`,
      };
    }

    case 'RANGE_HIGH_VOL': {
      // 고변동 횡보: 진입 기준 +8pt 상향 + 포지션 50% 축소 (저품질 진입 차단)
      return { ...base, buyThresholdAdj: 8, reason: 'RANGE_HIGH_VOL: buyThreshold +8 + 포지션 50% 축소' };
    }

    case 'DISTRIBUTION': {
      // 노출 축소 — buyThreshold +15
      return {
        ...base,
        routed: false,
        buyThresholdAdj: 15,
        reason: `DISTRIBUTION: buyThreshold +15 (autocorr=${regimeResult.autocorrelation.toFixed(2)}, 고점권 분배)`,
      };
    }
  }
}
