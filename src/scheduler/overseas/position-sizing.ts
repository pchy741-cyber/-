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
  marketBreadth?: number;  // 개선#10: 시장 breadth (0~1)
}

export interface SizingResult {
  sizingMult: number;
  positionSize: number;
  kellyPct: number;
}

// 최소 포지션 사이즈 (수수료 대비 의미있는 거래)
const MIN_POSITION_PAPER = 80;
const MIN_POSITION_LIVE = 40;  // 소액계좌 대응: $150→$40 (통합증거금 기준 수수료 낮음)

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

  // 개선#10: 시장 breadth 기반 레짐 사이징 배율
  const breadth = params.marketBreadth ?? 0.5;
  const regimeMult = breadth >= 0.65 ? 1.15   // BULL: +15% 공격적
    : breadth >= 0.45 ? 1.0                   // NEUTRAL: 기본
    : breadth >= 0.35 ? 0.90                  // WEAK: -10% (기존 -15%)
    : 0.80;                                   // BEAR: -20% (기존 -30%, 과도)

  const sizingMult = calcSizingMultiplier({
    confidence: effectiveConf,
    score: target.score,
    evMult: evMultiplier * (sessionSizingMult ?? 1.0) * regimeMult,
    vixSizingMult: vixRegime.sizingMult,
    cooldownPenalty: gradualCooldown.sizingPenalty,
    isPaper,
    mtfBonus,
    winRateBonus,
  });

  const isSmallAccount = portfolioValue < 500;
  const isMicroAccount = portfolioValue < 250;  // $250 미만 초소액
  const kellyDefault = isPaper ? 0.30 : 0.30;
  const kellyMomentum = isPaper ? 0.35 : 0.35;
  const kellyCap = isPaper ? 0.35 : 0.35;
  const kellyFloor = isPaper ? 0.15 : 0.15;
  // 소액: 집중 투자 — Paper/Live 동일하게 60% (작은 돈일수록 집중해야 수익)
  // 초소액(<$250): 70% 집중 (2~3종목 운영)
  const kellyPct = isMicroAccount ? 0.70
    : isSmallAccount ? 0.60
    : kellyResult.sampleCount >= 10 ? Math.max(kellyResult.halfKelly, kellyFloor)
    : (target.isMomentum && target.score >= 40 ? kellyMomentum : kellyDefault);
  const baseSize = portfolioValue * Math.min(kellyPct, isMicroAccount ? 0.70 : isSmallAccount ? 0.60 : kellyCap);
  // 소액/초소액: 현금 최대한 활용 (놀리지 않기)
  const cashUsageCap = isMicroAccount ? 0.92 : isSmallAccount ? 0.90 : 0.85;
  // 복합 감소기 바닥: sizingMult가 여러 팩터 곱셈으로 0.3 이하로 붕괴 방지
  const flooredSizingMult = Math.max(sizingMult, 0.40);
  let positionSize = Math.min(baseSize * flooredSizingMult, cash * cashUsageCap);

  // 최소 포지션 바닥 (수수료 대비 의미있는 거래량 보장)
  const minPosition = isPaper ? MIN_POSITION_PAPER : MIN_POSITION_LIVE;
  if (positionSize < minPosition && cash >= minPosition) {
    positionSize = minPosition;
  }

  return { sizingMult, positionSize, kellyPct };
}
