/**
 * 12단계 매수 필터 체인 — 쿨다운→메모리→VIX→어닝→시장→섹터→기술→AI 확신도
 * overseas-job.ts에서 추출 (순수 필터 + 정렬, 사이드이펙트 없음)
 */
import { SECTOR_CLASS } from '../../config/constants.js';
import { type EarningsEvent, hasEarningsRisk, type interpretMarketSentiment } from '../../market/external-signals.js';
import { logger } from '../../utils/logger.js';
import type { RegimeAdjustment } from './risk-intelligence.js';
import { applyUncertaintyPenalty, checkSectorGroupLimit } from './risk-intelligence.js';
import { isUSDST } from './session.js';
import { GLOBAL_WATCHLIST } from './watchlist.js';
import { getCachedSecFundamentalScore } from '../../automation/sec-research.js';

type MarketSignalResult = ReturnType<typeof interpretMarketSentiment>;

import type { OverseasWinRate } from './analytics.js';
import type { Holding, TechResult } from './sell-logic.js';
import type { SessionStrategyBrief } from './session-strategy.js';
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
  sessionBrief?: SessionStrategyBrief | null;
  earningsDrift?: { code: string; direction: 'BULL' | 'BEAR'; gapPct: number; strength: number }[]; // 개선#7
  userBlacklist?: Set<string>; // CEO 블랙리스트 (절대 매수 금지)
  userFavorites?: Set<string>; // CEO 즐겨찾기 (매수 우선순위 +20)
  kospiPenalty?: number; // 0=정상, 1=조정, 2=하락장 — penalty≥2시 비모멘텀 해외 매수 차단
  sectorMomentumMap?: Map<string, number>; // 섹터별 평균 등락률 (%) — 상위 섹터 매수 점수 가산
}

export type BuyTarget = TechResult & { ai?: AIDecision; _effectiveConf?: number };

// ── Named constants ──
/** Small account threshold (USD) for relaxed filter bypass */
const SMALL_ACCOUNT_USD = 500;
/** AI re-entry threshold for recent loss stocks */
const REENTRY_CONF_THRESHOLD = 0.8;
/** RSI threshold for oversold bounce detection */
const RSI_OVERSOLD = 38;
/** Sector concentration weight limit */
const SECTOR_WEIGHT_LIMIT = 0.3;

// ── 개선#3: 미국 시간대별 진입 가중치 (DST 대응) ──
function getUSTimeBonus(): number {
  const kst = new Date();
  const kstH = kst.getUTCHours() + 9; // UTC → KST
  const kstM = kst.getUTCMinutes();
  const kstTotal = (kstH % 24) * 60 + kstM;
  // 서머타임: 개장 22:30 KST / 겨울: 개장 23:30 KST
  const shift = isUSDST() ? 0 : 60; // 겨울 = 1시간 뒤로
  const open = 22 * 60 + 30 + shift;     // 개장 시각 (분)
  const open30 = open + 30;               // 개장 +30분
  const open90 = open + 90;               // 개장 +1.5시간
  const close60 = (5 * 60 + shift) % (24 * 60) - 60; // 마감 1시간 전
  const close = (5 * 60 + shift) % (24 * 60);         // 마감
  // 개장 30분: 모멘텀 포착 구간 → +5점
  if (kstTotal >= open && kstTotal < open30) return 5;
  // 개장 30분~1.5시간: 트렌드 확정 구간 → +10점
  if (kstTotal >= open30 && kstTotal < open90) return 10;
  // 최적 진입 (개장 1.5~2.5시간 후) → +8점
  if (kstTotal >= open90 && kstTotal < open90 + 60) return 8;
  // 마감 1시간 전: 방향 확정 → +5점
  if (kstTotal >= close60 && kstTotal < close) return 5;
  return 0;
}

/**
 * 12단계 필터 체인 → 매수 대상 종목 리스트 (정렬 완료)
 */
export function filterAndRankBuyTargets(ctx: BuyFilterContext): BuyTarget[] {
  const {
    techResults,
    updatedHoldings,
    pendingOrderStocks,
    lossCooldownSet,
    recentLossSet,
    memoryBlockedStocks,
    vixRegime,
    vixValue,
    gradualCooldown,
    upcomingEarnings,
    sentinelBlockedCodes,
    mktSignal,
    sectorValues,
    portfolioValue,
    aiMap,
    freshBreadth,
    uncertaintyMap,
    overseasWinRates,
    isUSExtended,
    recoveryMode,
    isPaper: _isPaperRaw,
    sessionBrief,
    userBlacklist,
    userFavorites,
    kospiPenalty,
    sectorMomentumMap,
  } = ctx;

  // 🔒 isPaper undefined → false 기본값 (undefined가 live로 취급되는 크로스오염 방지)
  const isPaper = _isPaperRaw ?? false;

  // 세션전략에서 avoidStocks/priorityStocks/confidenceFloor 추출
  const avoidSet = new Set(sessionBrief?.avoidStocks ?? []);
  const prioritySet = new Set(sessionBrief?.priorityStocks ?? []);
  const focusSectorSet = new Set((sessionBrief?.focusSectors ?? []).map((s) => s.toUpperCase()));
  const sessionConfFloor = sessionBrief?.confidenceFloor ?? 0;

  // uncertainty 보정 confidence 저장 (필터 통과 후 랭킹에서도 사용)
  const effectiveConfMap = new Map<string, number>();

  return (
    techResults
      // 1. 이미 보유 / 미체결 제외
      .filter((t) => !updatedHoldings.has(t.code) && !pendingOrderStocks.has(t.code))
      // 1-b. 세션전략 회피 종목 차단
      .filter((t) => {
        if (avoidSet.has(t.code)) {
          logger.info(`🚫 세션전략 회피 차단: ${t.code} (avoidStocks)`, { component: 'OVERSEAS' });
          return false;
        }
        return true;
      })
      // 1-c. CEO 블랙리스트 (절대 매수 금지)
      .filter((t) => {
        if (userBlacklist?.has(t.code)) {
          logger.info(`🚫 CEO 블랙리스트: ${t.code} (매수 차단)`, { component: 'OVERSEAS' });
          return false;
        }
        return true;
      })
      // 2. 손절 쿨다운
      .filter((t) => {
        if (lossCooldownSet.has(t.code)) {
          logger.info(`🚫 손절 쿨다운 차단: ${t.code} (24h 재매수 금지)`, { component: 'OVERSEAS' });
          return false;
        }
        return true;
      })
      // 3. 최근 손실 종목 재진입 (Paper/Live 동일 80% — 55%는 손절 후 재매수 반복 유발)
      .filter((t) => {
        if (!recentLossSet.has(t.code)) return true;
        const ai = aiMap.get(t.code);
        const reentryThreshold = REENTRY_CONF_THRESHOLD;
        if (ai?.action === 'BUY' && ai.confidence >= reentryThreshold) return true;
        logger.info(
          `⚠️ 최근 손실 종목 재진입 차단: ${t.code} AI 확신 부족 (${ai ? `${(ai.confidence * 100).toFixed(0)}%` : 'AI 없음'} < ${(reentryThreshold * 100).toFixed(0)}%)`,
          { component: 'OVERSEAS' },
        );
        return false;
      })
      // 4. Memory Agent 차단 (Live 소액 계좌: STRONG_BUY만 바이패스 — 매수 기회 확보)
      .filter((t) => {
        if (memoryBlockedStocks.has(t.code)) {
          if (!isPaper && portfolioValue < SMALL_ACCOUNT_USD && t.signal === 'STRONG_BUY' && t.score >= 40) {
            logger.info(`🧠 Memory 경고(소액 바이패스): ${t.code} (60일 승률≤25%, STRONG_BUY score=${t.score})`, {
              component: 'OVERSEAS',
            });
            return true;
          }
          logger.info(`🧠 Memory Agent 차단: ${t.code} (60일 승률≤25%)`, { component: 'OVERSEAS' });
          return false;
        }
        return true;
      })
      // 5. VIX 위기 / 점진적 쿨다운
      .filter((t) => {
        if (vixRegime.regime === 'CRISIS') {
          // VIX CRISIS: 오버솔드 반등 + 고확신 + BigMover만 허용
          const ai = aiMap.get(t.code);
          const oversoldBounce = t.rsi !== undefined && t.rsi <= 30; // RSI 30 이하 = 과매도 반등 기회
          const crisisOverride =
            isPaper ||
            oversoldBounce ||
            (ai?.action === 'BUY' && ai.confidence >= 0.85 && t.signal === 'STRONG_BUY') ||
            (t.isBigMover && t.score >= 30);
          if (crisisOverride) {
            logger.info(
              `🔥 VIX CRISIS 기회매수: ${t.code} (VIX=${vixValue.toFixed(0)}, RSI=${t.rsi?.toFixed(0) ?? '?'}, ${oversoldBounce ? '과매도반등' : isPaper ? 'PAPER' : t.isBigMover ? 'BigMover' : `AI${((ai?.confidence ?? 0) * 100).toFixed(0)}%`})`,
              { component: 'OVERSEAS' },
            );
            return true;
          }
          logger.info(
            `🌡️ VIX CRISIS 매수 제한: ${t.code} (VIX=${vixValue.toFixed(0)}, RSI=${t.rsi?.toFixed(0) ?? '?'} — 과매도 아님)`,
            { component: 'OVERSEAS' },
          );
          return false;
        }
        if (gradualCooldown.level >= 2 && !t.isBigMover) {
          logger.info(`⏸️ 쿨다운Lv${gradualCooldown.level} 전체 차단: ${t.code}`, { component: 'OVERSEAS' });
          return false;
        }
        return true;
      })
      // 6. 어닝 리스크
      .filter((t) => {
        if (t.isBigMover) return true;
        if (hasEarningsRisk(t.code, upcomingEarnings, 3) || sentinelBlockedCodes.has(t.code)) {
          logger.info(`📅 어닝 리스크 차단: ${t.code} (3일 이내 실적 발표)`, { component: 'OVERSEAS' });
          return false;
        }
        return true;
      })
      // 7. 시장 센티먼트
      .filter((t) => {
        if (!mktSignal) return true;
        if (!mktSignal.allowBuy && !mktSignal.aggressive) {
          logger.info(`📊 시장 과열/공황 차단: ${t.code} — ${mktSignal.reason}`, { component: 'OVERSEAS' });
          return false;
        }
        if (mktSignal.marketQuality === 'DANGER' && SECTOR_CLASS.DANGER_HIGH_BETA.includes(t.sector)) {
          logger.info(`📊 DANGER 장세 고베타 차단: ${t.code}(${t.sector})`, { component: 'OVERSEAS' });
          return false;
        }
        return true;
      })
      // 7.5. KOSPI 하락장 크로스전략 — penalty≥2 시 비모멘텀 해외 신규 매수 차단
      .filter((t) => {
        if (!kospiPenalty || kospiPenalty < 2) return true;
        if (t.isMomentum || t.signal === 'STRONG_BUY') return true;
        logger.info(`📉 KOSPI 하락장(p=${kospiPenalty}) 해외 매수 차단: ${t.code}`, { component: 'OVERSEAS' });
        return false;
      })
      // 8. 섹터 그룹 / 단일 섹터 집중도
      .filter((t) => {
        const groupCheck = checkSectorGroupLimit({
          targetSector: t.sector,
          sectorValues,
          portfolioValue,
          holdingCount: updatedHoldings.size,
        });
        if (groupCheck?.blocked) {
          logger.info(
            `📊 섹터 그룹 초과: ${t.code}(${groupCheck.group}) ${groupCheck.currentPct.toFixed(0)}% ≥ ${groupCheck.limitPct}%`,
            { component: 'OVERSEAS' },
          );
          return false;
        }
        const sectorValue = sectorValues.get(t.sector) ?? 0;
        const sectorWeight = portfolioValue > 0 ? sectorValue / portfolioValue : 0;
        if (sectorWeight >= SECTOR_WEIGHT_LIMIT) {
          logger.info(`📊 섹터 집중도 초과: ${t.code}(${t.sector}) ${(sectorWeight * 100).toFixed(0)}% ≥ 30%`, {
            component: 'OVERSEAS',
          });
          return false;
        }
        return true;
      })
      // 9. 기술적 진입 필터 (RSI/ADX/MA/BB/dayRange) + AI 확신도
      .filter((t) => {
        const ai = aiMap.get(t.code);
        const isOversold = t.rsi <= RSI_OVERSOLD && t.trendStrength !== 'WEAK';
        const isAbove50 = t.rsi >= 50;
        // RSI "developing zone" (38-49): 추세 발전 중, ADX가 확인해주면 진입 허용
        const isDeveloping = t.rsi >= 38 && t.rsi < 50 && t.adx >= 20 && t.aboveMA20;
        // v10.9: ADX 진입 최소 기준 강화 (13→18 Live) — 횡보장 진입 차단
        const adxThreshold = isPaper ? 15 : 18;
        const trendFilterOk =
          t.isMomentum || t.isBigMover || isOversold || isDeveloping || (isAbove50 && t.adx > adxThreshold);
        if (!trendFilterOk) {
          logger.info(`  ⛔ 진입 필터 탈락: ${t.code} RSI=${t.rsi.toFixed(0)} ADX=${t.adx.toFixed(0)}`, {
            component: 'OVERSEAS',
          });
          return false;
        }
        // MA20/MA60/BB 스퀴즈 필터 완화 — 강한 시그널이면 통과
        const paperSignalPass = isPaper && (t.signal === 'STRONG_BUY' || t.signal === 'BUY');
        // Live: STRONG_BUY + score≥30이면 MA/BB 필터 바이패스 (소액 계좌 매수 기회 확보)
        const liveSignalPass = !isPaper && t.signal === 'STRONG_BUY' && t.score >= 30;
        const signalPass = paperSignalPass || liveSignalPass;
        if (!t.isMomentum && !isOversold && t.aboveMA20 === false && !signalPass) {
          logger.info(`  ⛔ MA20 하방 진입 차단: ${t.code}`, { component: 'OVERSEAS' });
          return false;
        }
        if (!t.isMomentum && t.aboveMA60 === false && !signalPass) {
          logger.info(`  ⛔ MA60 하방 진입 차단: ${t.code}`, { component: 'OVERSEAS' });
          return false;
        }
        const squeezeBypass = t.adx >= 20 && t.rsi >= 42 && t.aboveMA20; // 추세 발전 중 squeeze는 breakout 전조
        if (t.bollingerSqueeze && t.bollingerBreakout !== 'UP' && !t.isMomentum && !signalPass && !squeezeBypass) {
          logger.info(`  ⛔ BB 스퀴즈 차단: ${t.code}`, { component: 'OVERSEAS' });
          return false;
        }
        const bullDay = freshBreadth >= 0.65;
        const dayRangeCap = bullDay ? 85 : 70;
        const dayRangeOk = t.isMomentum || t.isBigMover || t.dayRangePct === undefined || t.dayRangePct < dayRangeCap;
        if (!dayRangeOk) {
          logger.info(`  ⛔ 고점 진입 차단: ${t.code} dayRangePct=${t.dayRangePct?.toFixed(0)}%`, {
            component: 'OVERSEAS',
          });
          return false;
        }
        // 중베타 RSI 과열 70 (Paper/Live 동일 — paper 75는 과열 진입 유발, BigMover 예외)
        if (!t.isMomentum && !t.isBigMover && !isOversold) {
          const entryWatchSector = GLOBAL_WATCHLIST.find((w) => w.code === t.code)?.sector ?? '';
          const isMedBetaEntry = SECTOR_CLASS.MEDIUM_BETA.includes(entryWatchSector);
          const rsiOverheatLimit = 70;
          if (isMedBetaEntry && t.rsi > rsiOverheatLimit) {
            logger.info(`  ⛔ 중베타 RSI 과열 차단: ${t.code} RSI=${t.rsi.toFixed(0)}`, { component: 'OVERSEAS' });
            return false;
          }
        }
        const mq = mktSignal?.marketQuality ?? 'OK';
        const breadthPenalty = freshBreadth < 0.35 ? 0.04 : 0;
        const breadthBonus = freshBreadth >= 0.65 ? 0.02 : 0;
        const breadthAdj = breadthPenalty - breadthBonus;
        const isBigMoverTarget = t.isBigMover;
        // 신뢰도 바닥: Gemini 출력 0.68-0.72 현실 반영
        const baseMinConf = recoveryMode
          ? 0.78
          : mq === 'GREAT'
            ? 0.63
            : mq === 'CAUTIOUS'
              ? 0.68
              : mq === 'DANGER'
                ? 0.78
                : 0.65;
        const minConf =
          (isBigMoverTarget
            ? Math.max(isPaper ? 0.5 : 0.6, baseMinConf - 0.05 + breadthAdj)
            : baseMinConf + breadthAdj) + vixRegime.confBoost;
        const minConfMomentum =
          (isBigMoverTarget
            ? Math.max(
                isPaper ? 0.45 : 0.55,
                (recoveryMode ? 0.75 : mq === 'GREAT' ? 0.6 : mq === 'CAUTIOUS' ? 0.65 : mq === 'DANGER' ? 0.75 : 0.62) -
                  0.05 +
                  breadthAdj,
              )
            : (recoveryMode ? 0.75 : mq === 'GREAT' ? 0.6 : mq === 'CAUTIOUS' ? 0.65 : mq === 'DANGER' ? 0.75 : 0.62) + breadthAdj) + vixRegime.confBoost;
        // 불확실성 보정
        const uncPenalty = uncertaintyMap.get(t.code);
        const effectiveConf = uncPenalty
          ? applyUncertaintyPenalty(ai?.confidence ?? 0, uncPenalty)
          : (ai?.confidence ?? 0);
        if (uncPenalty && uncPenalty.penalty > 0)
          logger.info(
            `  📉 불확실성 보정: ${t.code} conf ${((ai?.confidence ?? 0) * 100).toFixed(0)}% → ${(effectiveConf * 100).toFixed(0)}% (${uncPenalty.reasons.join(',')})`,
            { component: 'OVERSEAS' },
          );
        // 세션전략 confidence 바닥값 적용 (Gemini 세션 리뷰가 정한 최소 임계)
        const _confFloorAdj = sessionConfFloor > 0 ? Math.max(minConf, sessionConfFloor) : minConf;
        const _confFloorMom =
          sessionConfFloor > 0 ? Math.max(minConfMomentum, sessionConfFloor - 0.03) : minConfMomentum;
        // effectiveConf를 Map에 저장 → 랭킹에서 재사용
        effectiveConfMap.set(t.code, effectiveConf);

        // ════════════════════════════════════════════════════════
        // Gemini AI 단독 매수 — Paper/Live 모두 차단 (무료 Gemini 승률 저조)
        // AI는 보조 지표로만 사용, 기술적 필터 통과 필수
        // 유료 AI(Claude/GPT) 충전 시 해제 가능
        // ════════════════════════════════════════════════════════

        // VIX CRISIS → Step 5에서 이미 통과한 종목은 여기서 다시 차단하지 않음
        // Step 5 override: isPaper, oversoldBounce, AI고확신+STRONG_BUY, BigMover
        // 여기서는 기술적 진입 경로 자체의 RSI/score 기준이 보호

        // ════════════════════════════════════════════════════════
        // 기술적 진입 — AI 없이 기술 지표 + 승률 피드백으로 매수
        // Paper/Live 통합 (승률 기반 가중치 적용)
        // ════════════════════════════════════════════════════════
        const wr = overseasWinRates.get(t.code);
        const hasGoodWinRate = wr && wr.sampleCount >= 5 && wr.winRate >= 0.55;
        const hasBadWinRate = wr && wr.sampleCount >= 5 && wr.winRate <= 0.35;
        // 승률 나쁜 종목은 기술적으로도 차단 (Memory Agent와 이중 보호)
        // Paper: 학습 데이터 수집을 위해 완화 (sample 10건 이상 + 승률 25% 미만만 차단)
        const paperRelaxedBadWR = isPaper && wr && wr.sampleCount >= 10 && wr.winRate <= 0.25;
        const effectiveBadWR = isPaper ? paperRelaxedBadWR : hasBadWinRate;
        if (effectiveBadWR && !t.isBigMover) {
          logger.info(
            `  ⛔ 승률 피드백 차단: ${t.code} 승률 ${(wr!.winRate * 100).toFixed(0)}% (${wr!.sampleCount}건)`,
            { component: 'OVERSEAS' },
          );
          return false;
        }
        // 손실회복 모드에서는 고승률 종목만 진입
        if (recoveryMode && !hasGoodWinRate && !t.isBigMover) {
          return false;
        }

        // ── 기술적 진입 경로 (강→약 순서) ──
        // 1. BigMover (급등주) — 초급등(+8%)은 RSI 88, 일반급등(+5%)은 RSI 82까지 허용
        // 근거: 10% 급등 종목 RSI는 75~85 범위 → 기존 72 상한으로 핫 종목 전부 차단됨
        // 안전장치: dayRangePct≥40(일중저점 아님) + aboveMA20 + 승률 피드백 유지
        const bigMoverRsiCap = t.price.changePct >= 8 ? 78 : 75; // RSI 88→78 하향 (과매수 고점 진입 방지)
        if (t.isBigMover && t.score >= 18 && t.rsi >= 35 && t.rsi <= bigMoverRsiCap && t.dayRangePct >= 40 && t.aboveMA20 && !effectiveBadWR)
          return true;
        // 2. Momentum (모멘텀 확인: 볼륨+추세) — RSI 상한 79로 확장
        if (t.isMomentum && t.score >= 20 && t.aboveMA20 && t.rsi >= 38 && t.rsi <= 79) return true;
        // 3. STRONG_BUY 기술 시그널 (복합 지표 합산 최상위)
        if (t.signal === 'STRONG_BUY' && t.score >= 25 && t.adx >= 18 && t.rsi >= 38 && t.rsi <= 74) return true;
        // 4. Bollinger 돌파 + 모멘텀
        if (t.bollingerBreakout === 'UP' && t.score >= 20 && t.aboveMA20 && t.rsi >= 38 && t.rsi <= 75)
          return true;
        // 5. BUY 시그널 + 트렌드 확인 (ADX 확인, RSI 적정 범위)
        if (t.signal === 'BUY' && t.score >= 30 && t.adx >= 20 && t.rsi >= 42 && t.rsi <= 70 && t.aboveMA20)
          return true;
        // 5b. Paper BUY 완화 — positiveCats<3 점수 반감(score≥20 → <30)으로 path-5 탈락하는 케이스 구제
        if (
          isPaper &&
          t.signal === 'BUY' &&
          t.score >= 20 &&
          t.adx >= 20 &&
          t.rsi >= 45 &&
          t.rsi <= 68 &&
          t.aboveMA20 &&
          !effectiveBadWR
        ) {
          logger.info(
            `  ✅ Paper BUY완화진입: ${t.code} score=${t.score} RSI=${t.rsi.toFixed(0)} ADX=${t.adx.toFixed(0)}`,
            { component: 'OVERSEAS' },
          );
          return true;
        }
        // 6. 과매도 반등 (RSI ≤ 35 + 트렌드 약하지 않음)
        if (isOversold && t.aboveMA60 && t.score >= 20) return true;
        // 7. 고승률 종목 완화 진입 (5거래 이상, 승률 55%+)
        if (hasGoodWinRate && t.signal !== 'SELL' && t.score >= 18 && t.rsi >= 35 && t.rsi <= 72 && t.aboveMA20)
          return true;
        // 8. Paper 전용 추가 진입 경로 제거 (낮은 기준이 손실 원인)

        // 개선#7: 어닝 드리프트 진입 — 실적 서프라이즈 후 갭업 +5%+ 고거래량 = 추격 매수
        const drift = ctx.earningsDrift?.find((d) => d.code === t.code && d.direction === 'BULL' && d.strength >= 0.5);
        if (drift && t.score >= 22 && t.rsi <= 75 && !hasBadWinRate) return true;

        // Live 추가: 시장 상황이 좋을 때만 일반 BUY 완화
        if (!isPaper && (mq === 'GREAT' || mq === 'OK')) {
          if (
            t.signal === 'BUY' &&
            t.score >= 25 &&
            t.adx >= 18 &&
            t.rsi >= 42 &&
            t.rsi <= 70 &&
            t.aboveMA20 &&
            !hasBadWinRate
          )
            return true;
        }
        // 9. AI 미사용시 기술적 보통 진입 — NEUTRAL 장에서도 양호한 셋업 진입
        // 조건: AI 결과 없음 + score>0 + MA20↑ + RSI 적정 + ADX 추세 확인 + 과열 아님
        if (
          aiMap.size === 0 &&
          t.score >= 10 &&
          t.aboveMA20 &&
          t.rsi >= 42 &&
          t.rsi <= 68 &&
          t.adx >= 20 &&
          !hasBadWinRate
        ) {
          logger.info(
            `  ✅ AI폴백 기술진입: ${t.code} score=${t.score} RSI=${t.rsi.toFixed(0)} ADX=${t.adx.toFixed(0)}`,
            { component: 'OVERSEAS' },
          );
          return true;
        }

        logger.info(
          `  ⛔ 기술적 필터 미달: ${t.code} sig=${t.signal} score=${t.score} RSI=${t.rsi.toFixed(0)} ADX=${t.adx.toFixed(0)} ${wr ? `승률${(wr.winRate * 100).toFixed(0)}%` : ''}`,
          { component: 'OVERSEAS' },
        );
        return false;
      })
      // 10. 장외시간 필터 (Paper: 시뮬레이션이므로 무조건 통과, 소액 계좌: STRONG_BUY도 허용)
      .filter((t) => {
        if (!isUSExtended || isPaper) return true;
        const isBargin = t.price.changePct <= -3.0;
        const isBigUp = t.isBigMover;
        if (isBargin || isBigUp) return true;
        // 소액 계좌: 장외에서도 STRONG_BUY 매수 기회 확보
        if (!isPaper && portfolioValue < SMALL_ACCOUNT_USD && t.signal === 'STRONG_BUY' && t.score >= 40) return true;
        return false;
      })
      // 11. AI 정보 + 보정 confidence 병합
      .map((t) => ({ ...t, ai: aiMap.get(t.code), _effectiveConf: effectiveConfMap.get(t.code) }))
      // 12. 종합 점수 정렬 (기술점수 중심 + VWAP + 시간대 + ATR진입가 + 어닝드리프트)
      .sort((a, b) => {
        const wrA = overseasWinRates.get(a.code);
        const wrB = overseasWinRates.get(b.code);
        const wrScoreA =
          wrA && wrA.sampleCount >= 5
            ? wrA.winRate >= 0.65
              ? 25
              : wrA.winRate >= 0.55
                ? 15
                : wrA.winRate <= 0.3
                  ? -20
                  : wrA.winRate <= 0.4
                    ? -10
                    : 0
            : 0;
        const wrScoreB =
          wrB && wrB.sampleCount >= 5
            ? wrB.winRate >= 0.65
              ? 25
              : wrB.winRate >= 0.55
                ? 15
                : wrB.winRate <= 0.3
                  ? -20
                  : wrB.winRate <= 0.4
                    ? -10
                    : 0
            : 0;
        // 개선#6: 바운스 리엔트리 — 최근 손실 종목이 3%+ 반등 시 페널티 감소
        const losspenA = recentLossSet.has(a.code) ? (a.price.changePct >= 3 && a.score >= 25 ? -8 : -25) : 0;
        const losspenB = recentLossSet.has(b.code) ? (b.price.changePct >= 3 && b.score >= 25 ? -8 : -25) : 0;
        const priorityA = prioritySet.has(a.code) ? 12 : 0;
        const priorityB = prioritySet.has(b.code) ? 12 : 0;
        // CEO 즐겨찾기: +20점 (세션 priority보다 강력)
        const favA = userFavorites?.has(a.code) ? 20 : 0;
        const favB = userFavorites?.has(b.code) ? 20 : 0;
        const sectorBoostA = focusSectorSet.has((a.sector ?? '').toUpperCase()) ? 8 : 0;
        const sectorBoostB = focusSectorSet.has((b.sector ?? '').toUpperCase()) ? 8 : 0;
        const techA = a.score * 0.6 + (a.isMomentum ? 20 : 0) + (a.isBigMover ? 15 : 0) + Math.min(a.adx * 0.3, 12);
        const techB = b.score * 0.6 + (b.isMomentum ? 20 : 0) + (b.isBigMover ? 15 : 0) + Math.min(b.adx * 0.3, 12);
        // 개선#4: VWAP 가중치 — VWAP 아래 매수 = 기관 평균보다 저렴
        const vwapA = a.vwapPosition === 'BELOW' ? 12 : a.vwapPosition === 'AT' ? 5 : -8;
        const vwapB = b.vwapPosition === 'BELOW' ? 12 : b.vwapPosition === 'AT' ? 5 : -8;
        // 개선#2: ATR 진입가 품질 — 일중저점 근처(dayRangePct < 30%) = 좋은 진입
        const atrEntryA = a.dayRangePct < 30 ? 10 : a.dayRangePct < 50 ? 5 : a.dayRangePct > 80 ? -5 : 0;
        const atrEntryB = b.dayRangePct < 30 ? 10 : b.dayRangePct < 50 ? 5 : b.dayRangePct > 80 ? -5 : 0;
        // 개선#3: 시간대 가중치 (전체 동일하므로 정렬엔 영향 없지만 절대값 기여)
        const timeBonus = getUSTimeBonus();
        // 개선#7: 어닝 드리프트 보너스
        const driftA = ctx.earningsDrift?.find((d) => d.code === a.code && d.direction === 'BULL');
        const driftB = ctx.earningsDrift?.find((d) => d.code === b.code && d.direction === 'BULL');
        const driftScoreA = driftA ? Math.min(20, driftA.strength * 25) : 0;
        const driftScoreB = driftB ? Math.min(20, driftB.strength * 25) : 0;
        // 섹터 모멘텀 보너스: 섹터 평균 등락 +2%↑ → +12점, +1%↑ → +7점, -1%↓ → -5점, -2%↓ → -10점
        const sectorMomA = sectorMomentumMap?.get(a.sector ?? '') ?? 0;
        const sectorMomB = sectorMomentumMap?.get(b.sector ?? '') ?? 0;
        const sectorMomScoreA = sectorMomA >= 2 ? 12 : sectorMomA >= 1 ? 7 : sectorMomA <= -2 ? -10 : sectorMomA <= -1 ? -5 : 0;
        const sectorMomScoreB = sectorMomB >= 2 ? 12 : sectorMomB >= 1 ? 7 : sectorMomB <= -2 ? -10 : sectorMomB <= -1 ? -5 : 0;
        // SEC fundamentalScore: 재무건전성 우량 → 매수 우선, 취약 → 차감
        const secScoreA = getCachedSecFundamentalScore(a.code);
        const secScoreB = getCachedSecFundamentalScore(b.code);
        const fundAdjA = secScoreA != null ? (secScoreA >= 75 ? 8 : secScoreA >= 60 ? 4 : secScoreA <= 30 ? -10 : 0) : 0;
        const fundAdjB = secScoreB != null ? (secScoreB >= 75 ? 8 : secScoreB >= 60 ? 4 : secScoreB <= 30 ? -10 : 0) : 0;
        const sa =
          techA + wrScoreA + losspenA + priorityA + favA + sectorBoostA + vwapA + atrEntryA + timeBonus + driftScoreA + sectorMomScoreA + fundAdjA;
        const sb =
          techB + wrScoreB + losspenB + priorityB + favB + sectorBoostB + vwapB + atrEntryB + timeBonus + driftScoreB + sectorMomScoreB + fundAdjB;
        return sb - sa;
      })
  );
}
