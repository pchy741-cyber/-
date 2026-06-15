/**
 * 진입 판정: 레짐라우터 / 스캘핑 / AI 필수 / 꽁돈
 *
 * 최종 매수 후보 결정 로직.
 * 품질+리스크 게이트 통과 후 호출된다.
 */

import { winRateSummary } from '../../../analysis/win-rate.js';
import { getCtxIsPaper } from '../../../config/context.js';
import { config } from '../../../config/index.js';
import { logger } from '../../../utils/logger.js';
import { getOverride } from '../../ai-overrides.js';
import type { EntryInput, EntryVerdict } from './types.js';

/** 레짐 신뢰도 No-Trade 임계값 — 이 미만이면 레짐 불확실 → 진입 금지 */
const REGIME_CONFIDENCE_THRESHOLD = 0.65;

/** 진입 사유 문자열 생성 */
function buildEntryReason(input: EntryInput): string {
  const { tech, scoring, regimeRoute } = input;
  const { truePullbackPattern, isFibSupport, effectiveTechScore } = scoring;
  const tags = [
    tech.rsi14 < 30
      ? '과매도반등'
      : tech.rsi14 < 45
        ? '반등초기'
        : truePullbackPattern
          ? '🎯눌림목타점'
          : isFibSupport
            ? '📐피보나치지지'
            : `기술${effectiveTechScore}점`,
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

  // No-Trade 게이트: 레짐 신뢰도 부족 → 진입 금지
  if (regimeRoute.regimeConfidence < REGIME_CONFIDENCE_THRESHOLD) {
    logger.info(
      `  🚫 ${stockCode}: 레짐 불확실 (confidence=${(regimeRoute.regimeConfidence * 100).toFixed(0)}% < ${REGIME_CONFIDENCE_THRESHOLD * 100}%) → No-Trade`,
      { component: 'TRACK_B' },
    );
    return { action: 'SKIP', reason: `레짐 신뢰도 부족 (${(regimeRoute.regimeConfidence * 100).toFixed(0)}%)` };
  }

  // AI 점수 체크: Gemini OFF 또는 전역 AI 탈락(globalNoAi) → 기술점수만으로 진입 허용
  const hasAI = aiScore && aiScore > 0;
  const globalNoAi = input.noAiScores === true;
  if (!hasAI && config.geminiEnabled && !globalNoAi) {
    logger.info(`  🚫 ${stockCode}: 레짐라우터 AI없음 → 차단 (score=${tech.score})`, { component: 'TRACK_B' });
    return { action: 'CONTINUE' };
  }

  const routeMinScore = 60;
  const routeEffectiveScore = tech.score + candleBonus + structBonus;
  const aiOk = hasAI ? aiScore >= buyThreshold : !config.geminiEnabled; // Gemini OFF → AI 조건 면제
  if (routeEffectiveScore >= routeMinScore && aiOk) {
    logger.info(
      `  ✅ ${stockCode}: 레짐라우터 진입 [${regimeRoute.reason}] score=${routeEffectiveScore} AI=${aiScore}`,
      { component: 'TRACK_B' },
    );
    return { action: 'BUY', reason: `레짐라우터: ${regimeRoute.reason}` };
  }

  return { action: 'CONTINUE' };
}

/**
 * 스캘핑/ScalpRadar 판정
 */
export function tryScalpEntry(input: EntryInput): EntryVerdict {
  // SCALPING 영구 비활성화 (구조적 판단):
  // 290건 실전 분석 — 당일 매매 23% 승률, -0.76% 평균
  // 트랜잭션 비용(0.20% 거래세 + 0.04% 수수료) + 슬리피지가 에지를 잡아먹음
  // 이는 파라미터 튜닝이 아닌 구조적 진실 → 영구 제거
  return { action: 'SKIP', reason: 'SCALPING 영구 비활성화 (구조적 비용 > 에지)' };
}

/**
 * AI 필수 게이트 + 꽁돈 + 기술점수 최종 판정
 */
export function tryFinalEntry(input: EntryInput): EntryVerdict {
  const { stockCode, aiScore, buyThreshold, scoring, winRates } = input;
  const { effectiveTechScore, minTechScore, priorityBonus, candleBonus } = scoring;

  // No-Trade 게이트: 레짐 신뢰도 부족 → 진입 금지 (모든 진입 경로 공통 적용)
  if (input.regimeRoute.regimeConfidence < REGIME_CONFIDENCE_THRESHOLD) {
    logger.info(
      `  🚫 ${stockCode}: 레짐 불확실 (confidence=${(input.regimeRoute.regimeConfidence * 100).toFixed(0)}%) → No-Trade 강제`,
      { component: 'TRACK_B' },
    );
    return { action: 'SKIP', reason: `레짐 신뢰도 부족 (${(input.regimeRoute.regimeConfidence * 100).toFixed(0)}%)` };
  }

  // AI 게이트: Gemini ON → AI 필수, Gemini OFF → 기술지표 단독 매매 허용
  const hasAI = aiScore && Number.isFinite(aiScore) && aiScore > 0;
  // 전역 AI 탈락: confidence 필터로 전체 스코어가 제거된 상태 (RSS폴백 0.55 → 0.60 미달 등)
  // 이 경우 "AI없음"으로 차단하지 않고 기술지표 단독 모드로 폴백 (Gemini 설정은 ON이지만 실질적 데이터 없음)
  const globalNoAi = input.noAiScores === true;

  if (!hasAI && config.geminiEnabled && !globalNoAi) {
    // Gemini 활성 + 개별 AI 없음 + 전역 스코어도 있음 → 진짜 미산출 → 차단
    logger.info(`  🚫 ${stockCode}: AI 점수 없음 → 매수 차단 (tech=${effectiveTechScore})`, { component: 'TRACK_B' });
    return { action: 'SKIP', reason: 'AI 없음' };
  }
  if (!hasAI && globalNoAi) {
    logger.info(`  ⚡ ${stockCode}: AI 전량 탈락(confidence 필터) → 기술지표 단독 폴백 (tech=${effectiveTechScore})`, {
      component: 'TRACK_B',
    });
  }

  // techOnlyMode: Gemini OFF 또는 전역 AI 탈락(globalNoAi) → 기술지표만으로 판단
  const techOnlyMode = !hasAI && (!config.geminiEnabled || globalNoAi);
  // 연습: 기술점수 무제한(1점) — AI점수 vs 수익률 상관관계 데이터 수집 최대화
  const v4MinTechScore = getCtxIsPaper()
    ? 1
    : techOnlyMode
      ? Math.max(minTechScore, 78) // v10: Live AI없이: 78점 이상 (엄격 선별)
      : Math.max(minTechScore, 55); // Live AI 병행: 55점 이상

  if (effectiveTechScore >= v4MinTechScore) {
    const entryReason = buildEntryReason(input);
    const wrInfo = winRateSummary(stockCode, winRates?.get(stockCode));
    const bonusStr = [priorityBonus > 0 ? `+${priorityBonus}테마` : '', candleBonus > 0 ? `+${candleBonus}캔들` : '']
      .filter(Boolean)
      .join('');
    const aiStr = hasAI ? `AI=${aiScore}` : 'AI=OFF(기술단독)';
    logger.info(
      `  ✅ ${stockCode}: 기술=${effectiveTechScore}점(>=${v4MinTechScore}) ${aiStr} [${entryReason}] RSI=${input.tech.rsi14.toFixed(0)} vol=${input.tech.volumeRatio.toFixed(2)}x → 매수 후보${bonusStr}${wrInfo}`,
      { component: 'TRACK_B' },
    );
    return { action: 'BUY', reason: entryReason };
  }

  return { action: 'SKIP', reason: `tech=${effectiveTechScore}<${v4MinTechScore}` };
}
