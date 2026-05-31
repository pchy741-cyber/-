/**
 * 포지션 사이징 계산 — Kelly × EV × VIX × 쿨다운 × 기술점수 × 승률 통합
 * v2: 점수 비례성 개선 + 최소 포지션 바닥 + 고승률 보너스
 */
import type { RegimeAdjustment } from './vix-regime.js';
import type { KellyResult, GradualCooldown } from './types.js';
import type { BuyTarget } from './buy-filter.js';

export interface SizingParams {
  target: BuyTarget;
  portfolioValue: number;
  kellyResult: KellyResult;
  vixRegime: RegimeAdjustment;
  gradualCooldown: GradualCooldown;
  cash: number;
  isPaper: boolean;
  evMultiplier: number;
  mtfBonus: number;
  sessionSizingMult?: number;
  winRate?: number;        // 종목별 과거 승률 (0~1)
  winRateSamples?: number; // 승률 샘플 수
}

export interface SizingResult {
  sizingMult: number;
  positionSize: number;
  kellyPct: number;
}

// 최소 포지션 사이즈 (수수료 대비 의미있는 거래)
const MIN_POSITION_PAPER = 80;
const MIN_POSITION_LIVE = 150;

export function calcSizingMultiplier(params: {
  confidence: number;
  score: number;
  evMult: number;
  vixSizingMult: number;
  cooldownPenalty: number;
  isPaper: boolean;
  mtfBonus: number;
  winRateBonus: number;
}): number {
  const { confidence, score, evMult, vixSizingMult, cooldownPenalty, isPaper, mtfBonus, winRateBonus } = params;
  const confFactor = Math.min(1, Math.max(0, confidence + mtfBonus));
  // 점수 비례성 개선: (score + 30) / 110 → score 20=0.45, 50=0.73, 80=1.0
  const scoreFactor = Math.min(1, Math.max(0, (score + 30) / 110));
  const combined = confFactor * 0.50 + scoreFactor * 0.50;
  // 고승률 종목 보너스 (최대 +30% 추가 사이징)
  const wrMult = 1.0 + winRateBonus;
  const rawMult = Math.round((0.6 + combined * 1.4) * evMult * vixSizingMult * cooldownPenalty * wrMult * 100) / 100;
  return isPaper ? Math.max(rawMult, 0.50) : rawMult;
}

export function calcPositionSize(params: SizingParams): SizingResult {
  const { target, portfolioValue, kellyResult, vixRegime, gradualCooldown, cash, isPaper, evMultiplier, mtfBonus, sessionSizingMult } = params;

  // 기술 점수 → confidence 매핑 (선형화 개선)
  // score 15 → 0.41, score 30 → 0.55, score 50 → 0.73, score 80 → 1.0
  const techConf = Math.min(1, Math.max(0.35, (target.score + 30) / 110));
  // 모멘텀/빅무버 부스트
  const momentumBoost = target.isMomentum ? 0.08 : target.isBigMover ? 0.10 : 0;
  const effectiveConf = Math.min(1, techConf + momentumBoost);

  // 고승률 종목 사이징 보너스 (승률 55%+ & 5건 이상 → 최대 +30%)
  const wr = params.winRate ?? 0;
  const wrSamples = params.winRateSamples ?? 0;
  const winRateBonus = wrSamples >= 5
    ? wr >= 0.70 ? 0.30 : wr >= 0.60 ? 0.20 : wr >= 0.55 ? 0.10 : 0
    : 0;

  const sizingMult = calcSizingMultiplier({
    confidence: effectiveConf,
    score: target.score,
    evMult: evMultiplier * (sessionSizingMult ?? 1.0),
    vixSizingMult: vixRegime.sizingMult,
    cooldownPenalty: gradualCooldown.sizingPenalty,
    isPaper,
    mtfBonus,
    winRateBonus,
  });

  const isSmallAccount = portfolioValue < 500;
  const kellyDefault = isPaper ? 0.30 : 0.25;
  const kellyMomentum = isPaper ? 0.35 : 0.30;
  const kellyCap = isPaper ? 0.35 : 0.30;
  const kellyFloor = isPaper ? 0.15 : 0.20;
  // 소액: Paper 60%(집중), Live 40% — 이전 80%/50%는 과도
  const kellyPct = isSmallAccount ? (isPaper ? 0.60 : 0.40)
    : kellyResult.sampleCount >= 10 ? Math.max(kellyResult.halfKelly, kellyFloor)
    : (target.isMomentum && target.score >= 40 ? kellyMomentum : kellyDefault);
  const baseSize = portfolioValue * Math.min(kellyPct, isSmallAccount ? (isPaper ? 0.60 : 0.40) : kellyCap);
  const cashUsageCap = isSmallAccount ? (isPaper ? 0.90 : (cash < 200 ? 0.85 : 0.75)) : 0.70;
  let positionSize = Math.min(baseSize * sizingMult, cash * cashUsageCap);

  // 최소 포지션 바닥 (수수료 대비 의미있는 거래량 보장)
  const minPosition = isPaper ? MIN_POSITION_PAPER : MIN_POSITION_LIVE;
  if (positionSize < minPosition && cash >= minPosition) {
    positionSize = minPosition;
  }

  return { sizingMult, positionSize, kellyPct };
}
