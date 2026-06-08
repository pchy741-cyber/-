/**
 * 진입 판정: 레짐라우터 / 스캘핑 / AI 필수 / 꽁돈
 *
 * 최종 매수 후보 결정 로직.
 * 품질+리스크 게이트 통과 후 호출된다.
 */

import { logger } from '../../../utils/logger.js';
import { winRateSummary } from '../../../analysis/win-rate.js';
import { getOverride } from '../../ai-overrides.js';
import { config } from '../../../config/index.js';
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

  // AI 점수 체크: Gemini OFF면 기술점수만으로 진입 허용
  const hasAI = aiScore && aiScore > 0;
  if (!hasAI && config.geminiEnabled) {
    logger.info(`  🚫 ${stockCode}: 레짐라우터 AI없음 → 차단 (score=${tech.score})`, { component: 'TRACK_B' });
    return { action: 'CONTINUE' };
  }

  const routeMinScore = 60;
  const routeEffectiveScore = tech.score + candleBonus + structBonus;
  const aiOk = hasAI ? aiScore >= buyThreshold : !config.geminiEnabled; // Gemini OFF → AI 조건 면제
  if (routeEffectiveScore >= routeMinScore && aiOk) {
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

  // AI 게이트: Gemini ON → AI 필수, Gemini OFF → 기술지표 단독 매매 허용
  const hasAI = aiScore && Number.isFinite(aiScore) && aiScore > 0;

  if (!hasAI && config.geminiEnabled) {
    // Gemini 활성 상태인데 AI 점수 없음 → 차단 (정상: AI가 아직 미산출)
    logger.info(`  🚫 ${stockCode}: AI 점수 없음 → 매수 차단 (tech=${effectiveTechScore})`, { component: 'TRACK_B' });
    return { action: 'SKIP', reason: 'AI 없음' };
  }

  // Gemini OFF + AI 없음 → 기술지표만으로 판단 (임계값 대폭 상향 — 75점 이상만 진입)
  const techOnlyMode = !hasAI && !config.geminiEnabled;
  const v4MinTechScore = techOnlyMode
    ? Math.max(minTechScore, 75)   // AI없이 기술지표 단독: 75점 이상 (60→75 강화, 블라인드 진입 방지)
    : Math.max(minTechScore, 55);  // AI 병행 시: 55점 이상

  if (effectiveTechScore >= v4MinTechScore) {
    const entryReason = buildEntryReason(input);
    const wrInfo = winRateSummary(stockCode, winRates?.get(stockCode));
    const bonusStr = [
      priorityBonus > 0 ? `+${priorityBonus}테마` : '',
      candleBonus > 0 ? `+${candleBonus}캔들` : '',
    ].filter(Boolean).join('');
    const aiStr = hasAI ? `AI=${aiScore}` : 'AI=OFF(기술단독)';
    logger.info(`  ✅ ${stockCode}: 기술=${effectiveTechScore}점(>=${v4MinTechScore}) ${aiStr} [${entryReason}] RSI=${input.tech.rsi14.toFixed(0)} vol=${input.tech.volumeRatio.toFixed(2)}x → 매수 후보${bonusStr}${wrInfo}`, { component: 'TRACK_B' });
    return { action: 'BUY', reason: entryReason };
  }

  return { action: 'SKIP', reason: `tech=${effectiveTechScore}<${v4MinTechScore}` };
}
