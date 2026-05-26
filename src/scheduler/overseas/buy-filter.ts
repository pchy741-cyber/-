/**
 * 12단계 매수 필터 체인 — 쿨다운→메모리→VIX→어닝→시장→섹터→기술→AI 확신도
 * overseas-job.ts에서 추출 (순수 필터 + 정렬, 사이드이펙트 없음)
 */
import { SECTOR_CLASS } from '../../config/constants.js';
import { logger } from '../../utils/logger.js';
import type { RegimeAdjustment } from './risk-intelligence.js';
import { checkSectorGroupLimit, applyUncertaintyPenalty } from './risk-intelligence.js';
import { GLOBAL_WATCHLIST } from './watchlist.js';
import { hasEarningsRisk, interpretMarketSentiment, type EarningsEvent } from '../../market/external-signals.js';

type MarketSignalResult = ReturnType<typeof interpretMarketSentiment>;
import type { TechResult, Holding } from './sell-logic.js';
import type { OverseasWinRate } from './analytics.js';

import type { AIDecision, GradualCooldown } from './types.js';

export interface BuyFilterContext {
  techResults: TechResult[];
  updatedHoldings: Map<string, Holding>;
  pendingOrderStocks: Set<string>;
  lossCooldownSet: Set<string>;
  recentLossSet: Set<string>;
  memoryBlockedStocks: Set<string>;
  vixRegime: RegimeAdjustment;
  vixValue: number;
  gradualCooldown: GradualCooldown;
  upcomingEarnings: EarningsEvent[];
  sentinelBlockedCodes: Set<string>;
  mktSignal: MarketSignalResult | null;
  sectorValues: Map<string, number>;
  portfolioValue: number;
  aiMap: Map<string, AIDecision>;
  freshBreadth: number;
  uncertaintyMap: Map<string, { penalty: number; reasons: string[] }>;
  overseasWinRates: Map<string, OverseasWinRate>;
  isUSExtended: boolean;
  recoveryMode: boolean;
  isPaper?: boolean;
}

export type BuyTarget = TechResult & { ai?: AIDecision };

/**
 * 12단계 필터 체인 → 매수 대상 종목 리스트 (정렬 완료)
 */
export function filterAndRankBuyTargets(ctx: BuyFilterContext): BuyTarget[] {
  const {
    techResults, updatedHoldings, pendingOrderStocks,
    lossCooldownSet, recentLossSet, memoryBlockedStocks,
    vixRegime, vixValue, gradualCooldown,
    upcomingEarnings, sentinelBlockedCodes, mktSignal,
    sectorValues, portfolioValue, aiMap, freshBreadth,
    uncertaintyMap, overseasWinRates, isUSExtended, recoveryMode, isPaper,
  } = ctx;

  return techResults
    // 1. 이미 보유 / 미체결 제외
    .filter(t => !updatedHoldings.has(t.code) && !pendingOrderStocks.has(t.code))
    // 2. 손절 쿨다운
    .filter(t => {
      if (lossCooldownSet.has(t.code)) { logger.info(`🚫 손절 쿨다운 차단: ${t.code} (24h 재매수 금지)`, { component: 'OVERSEAS' }); return false; }
      return true;
    })
    // 3. 최근 손실 종목 재진입 (Paper: 55%, Live: 80%)
    .filter(t => {
      if (!recentLossSet.has(t.code)) return true;
      const ai = aiMap.get(t.code);
      const reentryThreshold = isPaper ? 0.55 : 0.80;
      if (ai?.action === 'BUY' && ai.confidence >= reentryThreshold) return true;
      // Paper: AI 없어도 STRONG_BUY + score 40 이상이면 허용
      if (isPaper && !ai && t.signal === 'STRONG_BUY' && t.score >= 40) return true;
      logger.info(`⚠️ 최근 손실 종목 재진입 차단: ${t.code} AI 확신 부족 (${ai ? `${(ai.confidence * 100).toFixed(0)}%` : 'AI 없음'} < ${(reentryThreshold * 100).toFixed(0)}%)`, { component: 'OVERSEAS' });
      return false;
    })
    // 4. Memory Agent 차단 (Live 소액 계좌: STRONG_BUY만 바이패스 — 매수 기회 확보)
    .filter(t => {
      if (memoryBlockedStocks.has(t.code)) {
        if (!isPaper && portfolioValue < 500 && t.signal === 'STRONG_BUY' && t.score >= 40) {
          logger.info(`🧠 Memory 경고(소액 바이패스): ${t.code} (60일 승률≤25%, STRONG_BUY score=${t.score})`, { component: 'OVERSEAS' });
          return true;
        }
        logger.info(`🧠 Memory Agent 차단: ${t.code} (60일 승률≤25%)`, { component: 'OVERSEAS' }); return false;
      }
      return true;
    })
    // 5. VIX 위기 / 점진적 쿨다운
    .filter(t => {
      if (!vixRegime.allowNewBuy) {
        // VIX CRISIS 예외: Paper 모드 허용 / STRONG_BUY+높은확신 or BigMover는 공포 속 매수 기회
        const ai = aiMap.get(t.code);
        const crisisOverride = isPaper
          || (ai?.action === 'BUY' && ai.confidence >= 0.85 && t.signal === 'STRONG_BUY')
          || (t.isBigMover && t.score >= 30);
        if (crisisOverride) {
          logger.info(`🔥 VIX CRISIS 기회매수 통과: ${t.code} (VIX=${vixValue.toFixed(0)}, ${isPaper ? 'PAPER' : t.isBigMover ? 'BigMover' : `AI${((ai?.confidence ?? 0) * 100).toFixed(0)}%`})`, { component: 'OVERSEAS' });
          return true;
        }
        logger.info(`🌡️ VIX CRISIS 매수 차단: ${t.code} (VIX=${vixValue.toFixed(0)})`, { component: 'OVERSEAS' }); return false;
      }
      if (gradualCooldown.level >= 2 && !t.isBigMover) { logger.info(`⏸️ 쿨다운Lv${gradualCooldown.level} 전체 차단: ${t.code}`, { component: 'OVERSEAS' }); return false; }
      return true;
    })
    // 6. 어닝 리스크
    .filter(t => {
      if (t.isBigMover) return true;
      if (hasEarningsRisk(t.code, upcomingEarnings, 3) || sentinelBlockedCodes.has(t.code)) {
        logger.info(`📅 어닝 리스크 차단: ${t.code} (3일 이내 실적 발표)`, { component: 'OVERSEAS' }); return false;
      }
      return true;
    })
    // 7. 시장 센티먼트
    .filter(t => {
      if (!mktSignal) return true;
      if (!mktSignal.allowBuy && !mktSignal.aggressive) { logger.info(`📊 시장 과열/공황 차단: ${t.code} — ${mktSignal.reason}`, { component: 'OVERSEAS' }); return false; }
      if (mktSignal.marketQuality === 'DANGER' && SECTOR_CLASS.DANGER_HIGH_BETA.includes(t.sector)) { logger.info(`📊 DANGER 장세 고베타 차단: ${t.code}(${t.sector})`, { component: 'OVERSEAS' }); return false; }
      return true;
    })
    // 8. 섹터 그룹 / 단일 섹터 집중도
    .filter(t => {
      const groupCheck = checkSectorGroupLimit({ targetSector: t.sector, sectorValues, portfolioValue });
      if (groupCheck?.blocked) { logger.info(`📊 섹터 그룹 초과: ${t.code}(${groupCheck.group}) ${groupCheck.currentPct.toFixed(0)}% ≥ ${groupCheck.limitPct}%`, { component: 'OVERSEAS' }); return false; }
      const sectorValue = sectorValues.get(t.sector) ?? 0;
      const sectorWeight = portfolioValue > 0 ? sectorValue / portfolioValue : 0;
      if (sectorWeight >= 0.40) { logger.info(`📊 섹터 집중도 초과: ${t.code}(${t.sector}) ${(sectorWeight * 100).toFixed(0)}% ≥ 40%`, { component: 'OVERSEAS' }); return false; }
      return true;
    })
    // 9. 기술적 진입 필터 (RSI/ADX/MA/BB/dayRange) + AI 확신도
    .filter(t => {
      const ai = aiMap.get(t.code);
      const isOversold = t.rsi <= 35 && t.trendStrength !== 'WEAK';
      const isAbove50 = t.rsi >= 50;
      // Paper: ADX 12, Live: ADX 15 (소액 계좌 진입 허용)
      const adxThreshold = isPaper ? 12 : 15;
      const trendFilterOk = t.isMomentum || t.isBigMover || isOversold || (isAbove50 && t.adx > adxThreshold);
      if (!trendFilterOk) { logger.info(`  ⛔ 진입 필터 탈락: ${t.code} RSI=${t.rsi.toFixed(0)} ADX=${t.adx.toFixed(0)}`, { component: 'OVERSEAS' }); return false; }
      // MA20/MA60/BB 스퀴즈 필터 완화 — 강한 시그널이면 통과
      const paperSignalPass = isPaper && (t.signal === 'STRONG_BUY' || t.signal === 'BUY');
      // Live: STRONG_BUY + score≥30이면 MA/BB 필터 바이패스 (소액 계좌 매수 기회 확보)
      const liveSignalPass = !isPaper && t.signal === 'STRONG_BUY' && t.score >= 30;
      const signalPass = paperSignalPass || liveSignalPass;
      if (!t.isMomentum && !isOversold && t.aboveMA20 === false && !signalPass) { logger.info(`  ⛔ MA20 하방 진입 차단: ${t.code}`, { component: 'OVERSEAS' }); return false; }
      if (!t.isMomentum && t.aboveMA60 === false && !signalPass) { logger.info(`  ⛔ MA60 하방 진입 차단: ${t.code}`, { component: 'OVERSEAS' }); return false; }
      if (t.bollingerSqueeze && t.bollingerBreakout !== 'UP' && !t.isMomentum && !signalPass) { logger.info(`  ⛔ BB 스퀴즈 차단: ${t.code}`, { component: 'OVERSEAS' }); return false; }
      const bullDay = freshBreadth >= 0.65;
      const dayRangeCap = bullDay ? 85 : 70;
      const dayRangeOk = t.isMomentum || t.isBigMover || t.dayRangePct === undefined || t.dayRangePct < dayRangeCap;
      if (!dayRangeOk) { logger.info(`  ⛔ 고점 진입 차단: ${t.code} dayRangePct=${t.dayRangePct?.toFixed(0)}%`, { component: 'OVERSEAS' }); return false; }
      // Paper: 중베타 RSI 과열 75, Live: 70 (62→70 완화: 소액 계좌 진입 기회 확보)
      if (!t.isMomentum && !isOversold) {
        const entryWatchSector = GLOBAL_WATCHLIST.find(w => w.code === t.code)?.sector ?? '';
        const isMedBetaEntry = SECTOR_CLASS.MEDIUM_BETA.includes(entryWatchSector);
        const rsiOverheatLimit = isPaper ? 75 : 70;
        if (isMedBetaEntry && t.rsi > rsiOverheatLimit) { logger.info(`  ⛔ 중베타 RSI 과열 차단: ${t.code} RSI=${t.rsi.toFixed(0)}`, { component: 'OVERSEAS' }); return false; }
      }
      const mq = mktSignal?.marketQuality ?? 'OK';
      const breadthPenalty = freshBreadth < 0.35 ? 0.04 : 0;
      const breadthBonus = freshBreadth >= 0.65 ? 0.02 : 0;
      const breadthAdj = breadthPenalty - breadthBonus;
      const isBigMoverTarget = t.isBigMover;
      // Paper: AI 확신도 기준 15% 낮게 (더 공격적 진입)
      const paperDiscount = isPaper ? 0.15 : 0;
      const baseMinConf = recoveryMode ? 0.85 - paperDiscount
        : mq === 'GREAT' ? 0.66 - paperDiscount : mq === 'CAUTIOUS' ? 0.76 - paperDiscount : mq === 'DANGER' ? 0.82 - paperDiscount : 0.68 - paperDiscount;
      const minConf = (isBigMoverTarget ? Math.max(isPaper ? 0.50 : 0.65, baseMinConf - 0.05 + breadthAdj) : baseMinConf + breadthAdj) + vixRegime.confBoost;
      const minConfMomentum = (isBigMoverTarget ? Math.max(isPaper ? 0.45 : 0.60, (recoveryMode ? 0.83 - paperDiscount
        : mq === 'GREAT' ? 0.63 - paperDiscount : mq === 'CAUTIOUS' ? 0.73 - paperDiscount : mq === 'DANGER' ? 0.80 - paperDiscount : 0.66 - paperDiscount) - 0.05 + breadthAdj)
        : (recoveryMode ? 0.83 - paperDiscount
        : mq === 'GREAT' ? 0.63 - paperDiscount : mq === 'CAUTIOUS' ? 0.73 - paperDiscount : mq === 'DANGER' ? 0.80 - paperDiscount : 0.66 - paperDiscount) + breadthAdj) + vixRegime.confBoost;
      // 불확실성 보정
      const uncPenalty = uncertaintyMap.get(t.code);
      const effectiveConf = uncPenalty ? applyUncertaintyPenalty(ai?.confidence ?? 0, uncPenalty) : (ai?.confidence ?? 0);
      if (uncPenalty && uncPenalty.penalty > 0) logger.info(`  📉 불확실성 보정: ${t.code} conf ${((ai?.confidence ?? 0) * 100).toFixed(0)}% → ${(effectiveConf * 100).toFixed(0)}% (${uncPenalty.reasons.join(',')})`, { component: 'OVERSEAS' });
      if (ai?.action === 'BUY' && effectiveConf >= minConf) return true;
      if (ai?.action === 'BUY' && (t.signal === 'STRONG_BUY' || t.isMomentum) && effectiveConf >= minConfMomentum) return true;
      // Paper: STRONG_BUY/BUY 시그널 + score >= 30이면 AI 없어도 통과
      if (!ai && isPaper) {
        const isBuySignal = (t.signal === 'STRONG_BUY' && t.score >= 30) || (t.signal === 'BUY' && t.score >= 40);
        const rsiOk = t.rsi >= 40 && t.rsi <= 75;
        if (isBuySignal && rsiOk) return true;
      }
      if (!ai && !recoveryMode && (mq === 'GREAT' || mq === 'OK')) {
        // ── Momentum Cascade: AI 없어도 강한 모멘텀은 즉시 진입 ──
        if (t.isBigMover && t.score >= 20 && t.rsi >= 40 && t.rsi <= 72) return true;
        if (t.isMomentum && t.score >= 25 && t.aboveMA20 && t.rsi >= 45 && t.rsi <= 68) return true;
        // STRONG_BUY: score≥30 + ADX≥20 + RSI 45-70 (AI 없이도 강한 기술 시그널)
        if (t.signal === 'STRONG_BUY' && t.score >= 30 && t.adx >= 20 && t.rsi >= 45 && t.rsi <= 70) return true;
        // BUY: 소액 계좌는 score≥30, 일반은 score≥40
        const buyScoreMin = (!isPaper && portfolioValue < 500) ? 30 : 40;
        const buyAdxMin = (!isPaper && portfolioValue < 500) ? 20 : 25;
        if (t.signal === 'BUY' && t.score >= buyScoreMin && t.adx >= buyAdxMin && t.rsi >= 45 && t.rsi <= 70) return true;
        const isBollingerMomentum = t.bollingerBreakout === 'UP' && t.isMomentum && t.score >= 30 && t.aboveMA20 && t.rsi >= 45 && t.rsi <= 72;
        if (isBollingerMomentum) return true;
        return false;
      }
      if (!ai) logger.info(`  ⛔ ${recoveryMode ? '손실회복모드' : mq} AI 없음 차단: ${t.code}`, { component: 'OVERSEAS' });
      return false;
    })
    // 10. 장외시간 필터
    .filter(t => {
      if (!isUSExtended) return true;
      const isBargin = t.price.changePct <= -3.0;
      const isBigUp = t.isBigMover;
      if (isBargin || isBigUp) return true;
      return false;
    })
    // 11. AI 정보 병합
    .map(t => ({ ...t, ai: aiMap.get(t.code) }))
    // 12. 종합 점수 정렬 (AI확신도×55% + 기술점수×30% + 모멘텀 + 승률)
    .sort((a, b) => {
      const wrA = overseasWinRates.get(a.code);
      const wrB = overseasWinRates.get(b.code);
      const wrBoostA = wrA && wrA.sampleCount >= 5 ? (wrA.winRate >= 0.65 ? 15 : wrA.winRate >= 0.55 ? 8 : wrA.winRate <= 0.30 ? -15 : wrA.winRate <= 0.40 ? -8 : 0) : 0;
      const wrBoostB = wrB && wrB.sampleCount >= 5 ? (wrB.winRate >= 0.65 ? 15 : wrB.winRate >= 0.55 ? 8 : wrB.winRate <= 0.30 ? -15 : wrB.winRate <= 0.40 ? -8 : 0) : 0;
      const losspenA = recentLossSet.has(a.code) ? -25 : 0;
      const losspenB = recentLossSet.has(b.code) ? -25 : 0;
      const sa = (a.ai?.confidence ?? 0) * 100 + a.score * 0.3 + (a.isMomentum ? 20 : 0) + wrBoostA + losspenA;
      const sb = (b.ai?.confidence ?? 0) * 100 + b.score * 0.3 + (b.isMomentum ? 20 : 0) + wrBoostB + losspenB;
      return sb - sa;
    });
}
