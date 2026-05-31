/**
 * 포지션 사이징 계산 — Kelly × EV × VIX × 쿨다운 × 기술점수 통합
 * Gemini 매수 차단 모드: AI confidence 대신 기술 점수 + 승률 기반
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
  sessionSizingMult?: number; // 세션전략 sizingMultiplier (0.5~1.5)
}

export interface SizingResult {
  sizingMult: number;
  positionSize: number;
  kellyPct: number;
}

export function calcSizingMultiplier(params: {
  confidence: number;
  score: number;
  evMult: number;
  vixSizingMult: number;
  cooldownPenalty: number;
  isPaper: boolean;
  mtfBonus: number;
}): number {
  const { confidence, score, evMult, vixSizingMult, cooldownPenalty, isPaper, mtfBonus } = params;
  const confFactor = Math.min(1, Math.max(0, confidence + mtfBonus));
  const scoreFactor = Math.min(1, Math.max(0, (score + 50) / 100));
  const combined = confFactor * 0.55 + scoreFactor * 0.45;
  const rawMult = Math.round((0.6 + combined * 1.2) * evMult * vixSizingMult * cooldownPenalty * 100) / 100;
  return isPaper ? Math.max(rawMult, 0.50) : rawMult;
}

export function calcPositionSize(params: SizingParams): SizingResult {
  const { target, portfolioValue, kellyResult, vixRegime, gradualCooldown, cash, isPaper, evMultiplier, mtfBonus, sessionSizingMult } = params;

  // 기술 점수 기반 pseudo-confidence (Gemini 매수 차단 → AI conf 대신 기술 지표)
  // score 범위: -50~+80 → 0~1 매핑 (score 30 → conf 0.65, score 50 → conf 0.78)
  const techConf = Math.min(1, Math.max(0.4, (target.score + 20) / 130));
  // 모멘텀/빅무버 부스트
  const momentumBoost = target.isMomentum ? 0.08 : target.isBigMover ? 0.10 : 0;
  const effectiveConf = Math.min(1, techConf + momentumBoost);

  const sizingMult = calcSizingMultiplier({
    confidence: effectiveConf,
    score: target.score,
    evMult: evMultiplier * (sessionSizingMult ?? 1.0),
    vixSizingMult: vixRegime.sizingMult,
    cooldownPenalty: gradualCooldown.sizingPenalty,
    isPaper,
    mtfBonus,
  });

  const isSmallAccount = portfolioValue < 500;
  const kellyDefault = isPaper ? 0.30 : 0.25;
  const kellyMomentum = isPaper ? 0.35 : 0.30;
  const kellyCap = isPaper ? 0.35 : 0.30;
  const kellyFloor = isPaper ? 0.15 : 0.20;
  const kellyPct = isSmallAccount ? (isPaper ? 0.80 : 0.50)
    : kellyResult.sampleCount >= 10 ? Math.max(kellyResult.halfKelly, kellyFloor)
    : (target.isMomentum && target.score >= 40 ? kellyMomentum : kellyDefault);
  const baseSize = portfolioValue * Math.min(kellyPct, isSmallAccount ? (isPaper ? 0.80 : 0.50) : kellyCap);
  const cashUsageCap = isSmallAccount ? (isPaper ? 0.95 : (cash < 200 ? 0.90 : 0.80)) : 0.70;
  const positionSize = Math.min(baseSize * sizingMult, cash * cashUsageCap);

  return { sizingMult, positionSize, kellyPct };
}
