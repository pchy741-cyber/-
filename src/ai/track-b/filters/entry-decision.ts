/**
 * 진입 판정: 레짐라우터 / 스캘핑 / AI 필수 / 꽁돈
 *
 * 최종 매수 후보 결정 로직.
 * 품질+리스크 게이트 통과 후 호출된다.
 */

import { logger } from '../../../utils/logger.js';
import { winRateSummary } from '../../../analysis/win-rate.js';
import { getOverride } from '../../ai-overrides.js';
import type { EntryInput, EntryVerdict } from './types.js';

/** 진입 사유 문자열 생성 */
function buildEntryReason(input: EntryInput): string {
  const { tech, scoring, regimeRoute } = input;
  const { truePullbackPattern, isFibSupport, effectiveTechScore } = scoring;
  const tags = [
    tech.rsi14 < 30 ? '과매도반등' : tech.rsi14 < 45 ? '반등초기' : truePullbackPattern ? '🎯눌림목타점' : isFibSupport ? '📐피보나치지지' : `기술${effectiveTechScore}점`,
    tech.bollingerBreakout === 'UP' ? '🎯BB스퀴즈돌파' : tech.bollingerSqueeze ? '🔃BB응축중' : '',
    tech.vwapCross === 'JUST_ABOVE' ? '⚡VWAP돌파' : tech.vwapPullback ? '🔁VWAP풀백' : '',
    tech.ttmSqueeze.fireSignal === 'LONG' ? `🚀TTM발사(${tech.ttmSqueeze.consecutiveSqueezeOn}봉)` : '',
    tech.rsi2 < 15 ? `📉RSI2(${tech.rsi2.toFixed(0)})` : '',
    regimeRoute.routed ? `레짐${regimeRoute.regime}` : '',
  ].filter(Boolean);
  return tags.join('+');
}

/**
 * 레짐 라우터 빠른 진입 판정
 */
export function tryRegimeRouterEntry(input: EntryInput): EntryVerdict {
  const { stockCode, tech, regimeRoute, aiScore, buyThreshold, mode, scoring } = input;
  const { structBonus, candleBonus } = scoring;

  if (!regimeRoute.routed || mode === 'SCALPING') return { action: 'CONTINUE' };

  // AI 점수 필수
  if (!aiScore || aiScore === 0) {
    logger.info(`  🚫 ${stockCode}: 레짐라우터 AI없음 → 차단 (score=${tech.score})`, { component: 'TRACK_B' });
    return { action: 'CONTINUE' }; // 아래 AI 필수 게이트에서 최종 차단
  }

  // v4: routeMinScore 55→60 (카테고리Cap 시스템에서 60 = 최소 3/4 카테고리 양수)
  const routeMinScore = 60;
  const routeEffectiveScore = tech.score + candleBonus + structBonus;
  if (routeEffectiveScore >= routeMinScore && aiScore >= buyThreshold) {
    logger.info(`  ✅ ${stockCode}: 레짐라우터 진입 [${regimeRoute.reason}] score=${routeEffectiveScore} AI=${aiScore}`, { component: 'TRACK_B' });
    return { action: 'BUY', reason: `레짐라우터: ${regimeRoute.reason}` };
  }

  return { action: 'CONTINUE' };
}

/**
 * 스캘핑/ScalpRadar 판정
 */
export function tryScalpEntry(input: EntryInput): EntryVerdict {
  const { stockCode, mode, allowScalpingBuys } = input;
  const scalpTarget = getOverride<boolean>(`${stockCode}_scalpTarget`);

  // 2026-06 성과 검토: SCALPING WR 25.7% → 전면 비활성화
  if (mode === 'SCALPING') {
    return { action: 'SKIP', reason: 'SCALPING 비활성화 (WR 25.7%)' };
  }

  // ScalpRadar도 비활성화 — 모멘텀 스캘핑 진입 차단
  if (scalpTarget) {
    logger.info(`  🚫 ${stockCode}: ScalpRadar 무시 (SCALPING 비활성화)`, { component: 'TRACK_B' });
    return { action: 'CONTINUE' }; // 일반 진입 로직으로 평가
  }

  return { action: 'CONTINUE' };
}

/**
 * AI 필수 게이트 + 꽁돈 + 기술점수 최종 판정
 */
export function tryFinalEntry(input: EntryInput): EntryVerdict {
  const { stockCode, aiScore, buyThreshold, scoring, winRates } = input;
  const { effectiveTechScore, minTechScore, priorityBonus, candleBonus } = scoring;

  // AI 필수 게이트
  if (!aiScore || !Number.isFinite(aiScore) || aiScore === 0) {
    logger.info(`  🚫 ${stockCode}: AI 점수 없음 → 매수 차단 (tech=${effectiveTechScore})`, { component: 'TRACK_B' });
    return { action: 'SKIP', reason: 'AI 없음' };
  }

  // v4: 꽁돈 경로 폐지 — AI 고점수만으로 기술분석 부족 보완 불가
  // 이전: AI>=88~93이면 tech 낮아도 진입 → 승률 저하 원인
  // 변경: 반드시 tech>=minTechScore(55) AND AI>=buyThreshold 동시 충족
  const v4MinTechScore = Math.max(minTechScore, 55);  // 최소 55 보장

  if (effectiveTechScore >= v4MinTechScore) {
    const entryReason = buildEntryReason(input);
    const wrInfo = winRateSummary(stockCode, winRates?.get(stockCode));
    const bonusStr = [
      priorityBonus > 0 ? `+${priorityBonus}테마` : '',
      candleBonus > 0 ? `+${candleBonus}캔들` : '',
    ].filter(Boolean).join('');
    logger.info(`  ✅ ${stockCode}: 기술=${effectiveTechScore}점(>=${v4MinTechScore}) AI=${aiScore} [${entryReason}] RSI=${input.tech.rsi14.toFixed(0)} vol=${input.tech.volumeRatio.toFixed(2)}x → 매수 후보${bonusStr}${wrInfo}`, { component: 'TRACK_B' });
    return { action: 'BUY', reason: entryReason };
  }

  return { action: 'SKIP', reason: `tech=${effectiveTechScore}<${v4MinTechScore}` };
}
