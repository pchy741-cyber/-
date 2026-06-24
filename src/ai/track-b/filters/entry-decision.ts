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
import { MEGA_CAP_PRIORITY_CODES } from '../trading-rules.js';
import type { EntryInput, EntryVerdict } from './types.js';

/** 레짐 신뢰도 No-Trade 임계값 — 이 미만이면 레짐 불확실 → 진입 금지 */
const REGIME_CONFIDENCE_THRESHOLD = 0.65;
/** 메가캡 대형주: 변동성 구조적으로 낮아 RANGE_LOW_VOL 빈발 → 신뢰도 임계 완화 */
const MEGA_CAP_REGIME_THRESHOLD = 0.45;

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

  if (!regimeRoute.routed) return { action: 'CONTINUE' };

  // No-Trade 게이트: 레짐 신뢰도 부족 → 진입 금지 (메가캡은 임계 완화)
  const regimeThreshold = MEGA_CAP_PRIORITY_CODES.has(stockCode)
    ? MEGA_CAP_REGIME_THRESHOLD
    : REGIME_CONFIDENCE_THRESHOLD;
  if (regimeRoute.regimeConfidence < regimeThreshold) {
    logger.info(
      `  🚫 ${stockCode}: 레짐 불확실 (confidence=${(regimeRoute.regimeConfidence * 100).toFixed(0)}% < ${regimeThreshold * 100}%) → No-Trade`,
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

  const routeMinScore = 75; // v11: 60→75 강화 (추격매수 방지, 충분한 기술적 신호 요구)
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
 * AI 필수 게이트 + 꽁돈 + 기술점수 최종 판정
 */
export function tryFinalEntry(input: EntryInput): EntryVerdict {
  const { stockCode, aiScore, buyThreshold, scoring, winRates } = input;
  const { effectiveTechScore, minTechScore, priorityBonus, candleBonus } = scoring;

  // No-Trade 게이트: 레짐 신뢰도 부족 → 진입 금지 (메가캡은 임계 완화)
  const regimeThreshold2 = MEGA_CAP_PRIORITY_CODES.has(stockCode)
    ? MEGA_CAP_REGIME_THRESHOLD
    : REGIME_CONFIDENCE_THRESHOLD;
  if (input.regimeRoute.regimeConfidence < regimeThreshold2) {
    logger.info(
      `  🚫 ${stockCode}: 레짐 불확실 (confidence=${(input.regimeRoute.regimeConfidence * 100).toFixed(0)}%) → No-Trade 강제`,
      { component: 'TRACK_B' },
    );
    return { action: 'SKIP', reason: `레짐 신뢰도 부족 (${(input.regimeRoute.regimeConfidence * 100).toFixed(0)}%)` };
  }

  // SCALPING 시간 게이트: 개장창구(allowScalpingBuys=true) 이후 → AI 97점 필수
  if (input.mode === 'SCALPING' && input.allowScalpingBuys === false) {
    const scalpOffHourMinScore = 97;
    const hasHighAI = aiScore && aiScore >= scalpOffHourMinScore;
    if (!hasHighAI) {
      logger.info(
        `  🚫 ${stockCode}: 스캘핑 시간외 — AI=${aiScore} < ${scalpOffHourMinScore} → 차단 (개장창구 09:00-09:14만 허용)`,
        { component: 'TRACK_B' },
      );
      return { action: 'SKIP', reason: `스캘핑 시간외 (AI=${aiScore}<${scalpOffHourMinScore})` };
    }
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
  // v11-fix: Paper/Live 괴리 축소 — Paper도 최소 기술점수 적용
  // 이전: Paper=1(무제한) → Live 대비 성과 부풀림, 프로모션 신뢰도 하락
  // 변경: Paper=40(최소한의 필터), Live는 기존 유지
  const v4MinTechScore = getCtxIsPaper()
    ? Math.max(minTechScore, 40)
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
