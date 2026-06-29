/**
 * 포지션 사이징 계산 — 황금비율(피보나치) 기반 유연 %
 *
 * 포트폴리오 크기에 관계없이 동일한 % 비율로 동작:
 *   - Kelly/캡/바닥 모두 포트폴리오 대비 %
 *   - 최소 포지션도 고정 $ 대신 포트폴리오 대비 %
 *   - 황금비율: 38.2%, 23.6%, 15.0%(CASH), 14.6%, 61.8%
 */

import type { BuyTarget } from './buy-filter.js';
import type { GradualCooldown, KellyResult } from './types.js';
import type { RegimeAdjustment } from './vix-regime.js';

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
  winRate?: number; // 종목별 과거 승률 (0~1)
  winRateSamples?: number; // 승률 샘플 수
  marketBreadth?: number; // 시장 breadth (0~1)
  atrPct?: number; // ATR(14) as % of price — 변동성 역비례 사이징용
}

export interface SizingResult {
  sizingMult: number;
  positionSize: number;
  kellyPct: number;
}

// ── 황금비율 상수 (피보나치) ──
const PHI = {
  MAJOR: 0.40, // v15: 38.2%→40% — 주력 포지션 소폭 확대
  MEDIUM: 0.27, // v15: 23.6%→27% — 중간 포지션 소폭 확대
  MINOR: 0.17, // v15: 14.6%→17% — 소형 포지션
  CASH: 0.10, // v15: 15%→10% — 해외는 적당한 현금유보
  MAX: 0.618, // 61.8% 유지 (소액 집중)
} as const;

// 최소 포지션: 포트폴리오의 % (고정 $ 폐지)
// v10.11: 10% → 5% (buy-loop.ts MIN_POSITION_RATIO와 통일)
const MIN_POSITION_PCT = 0.05; // 포트폴리오의 5% (절대 최소)

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
  const scoreFactor = Math.min(1, Math.max(0, (score + 30) / 110));
  const combined = confFactor * 0.5 + scoreFactor * 0.5;
  const wrMult = 1.0 + winRateBonus;
  // 배율 스택 캡: evMult × wrMult 합산이 1.5x 초과 방지 (과집중 사고 방지)
  const combinedBoostMult = Math.min(evMult * wrMult, 1.5);
  const rawMult = Math.round((0.6 + combined * 1.4) * combinedBoostMult * vixSizingMult * cooldownPenalty * 100) / 100;
  // 상한 캡 2.0x 유지 (해외는 안정적)
  const cappedMult = Math.min(2.0, rawMult);
  // v14: Paper/Live 통합 0.5x floor
  return Math.max(cappedMult, 0.5);
}

export function calcPositionSize(params: SizingParams): SizingResult {
  const {
    target,
    portfolioValue,
    kellyResult,
    vixRegime,
    gradualCooldown,
    cash,
    isPaper,
    evMultiplier,
    mtfBonus,
    sessionSizingMult,
  } = params;

  // ── 기술 점수 + AI 신뢰도 → confidence ──
  const techConf = Math.min(1, Math.max(0.35, (target.score + 30) / 110));
  const momentumBoost = target.isMomentum ? 0.08 : target.isBigMover ? 0.1 : 0;
  // v14: AI 신뢰도 반영 — 기존 기술점수만 사용 → AI 40% 블렌딩
  // AI 고확신(0.85) vs 저확신(0.50) → 사이즈 차이 14% (기존: 0%)
  const aiConf = target.ai?.confidence ?? 0;
  const effectiveConf = aiConf > 0
    ? Math.min(1, techConf * 0.6 + aiConf * 0.4 + momentumBoost)
    : Math.min(1, techConf + momentumBoost);

  // ── 고승률 보너스 ──
  const wr = params.winRate ?? 0;
  const wrSamples = params.winRateSamples ?? 0;
  const winRateBonus = wrSamples >= 5 ? (wr >= 0.7 ? 0.3 : wr >= 0.6 ? 0.2 : wr >= 0.55 ? 0.1 : 0) : 0;

  // ── 시장 breadth 레짐 배율 ──
  const breadth = params.marketBreadth ?? 0.5;
  const regimeMult = breadth >= 0.65 ? 1.15 : breadth >= 0.45 ? 1.0 : breadth >= 0.35 ? 0.9 : 0.8;

  // ── v12.2: 변동성 역비례 사이징 (Moreira & Muir, JoF 2017) ──
  // ATR(14)이 높으면 작은 포지션, 낮으면 큰 포지션 → 샤프 +50~100% 개선
  // 기준: ATR 2% = 정상(1.0x), ATR 1% = 저변동성(1.15x), ATR 4% = 고변동성(0.7x)
  const atrPct = params.atrPct ?? 2.0;
  const volInverseMult = atrPct <= 0.5 ? 1.2 : atrPct <= 1.0 ? 1.15 : atrPct <= 2.0 ? 1.0
    : atrPct <= 3.0 ? 0.85 : atrPct <= 4.5 ? 0.7 : 0.55;

  // ── 세이버메트릭스 배율: Kelly EV/PF 기반 사이징 조정 ──
  const kellyEV = kellyResult.evPerTrade ?? 0;
  const kellyPF = kellyResult.profitFactor ?? 1.0;
  const kellyBEP = kellyResult.breakevenWinRate ?? 0.5;
  const wR = kellyResult.winRate ?? 0.5;
  // EV 음수→0.7x 축소, EV 양수(3%+)→1.2x 확대, PF<1.0→0.8x
  const saberMult =
    kellyEV < -0.5
      ? 0.7
      : kellyPF < 1.0
        ? 0.8
        : wR < kellyBEP
          ? 0.85 // 손익분기 미달
          : kellyEV >= 3.0
            ? 1.2
            : kellyEV >= 1.5
              ? 1.1
              : 1.0;

  const sizingMult = calcSizingMultiplier({
    confidence: effectiveConf,
    score: target.score,
    evMult: evMultiplier * (sessionSizingMult ?? 1.0) * regimeMult * saberMult * volInverseMult,
    vixSizingMult: vixRegime.sizingMult,
    cooldownPenalty: gradualCooldown.sizingPenalty,
    isPaper,
    mtfBonus,
    winRateBonus,
  });

  // ── 황금비율 기반 Kelly % (포트폴리오 크기 무관, 순수 비율) ──
  // 포트폴리오 크기별 최적 집중도:
  //   <$500:   PHI.MAX(61.8%) — 2~3종목 극집중 (작은 돈은 분산하면 의미 없음)
  //   <$2000:  PHI.MAJOR+PHI.MEDIUM = 61.8% — 3~5종목
  //   $2000+:  Kelly 롤링 또는 기본 38.2%
  const isSmallAccount = portfolioValue < 2000;
  const isMicroAccount = portfolioValue < 500;

  // v10.9: 포지션 사이징 현실화 — Kelly 위반 해소
  // 기존 61.8% 극집중 → 한 종목 5% 하락이면 -30% 계좌 손실 (gambler's ruin)
  // 38.2% → 한 종목 5% 하락이면 -19% 계좌 손실 (생존 가능)
  const kellyPct = isMicroAccount
    ? PHI.MAJOR // 38.2% (기존 61.8%)
    : isSmallAccount
      ? PHI.MAJOR // 38.2% (기존 61.8%)
      : kellyResult.sampleCount >= 10
        ? Math.max(kellyResult.halfKelly, PHI.MINOR) // Kelly 롤링, 바닥 14.6%
        : target.isMomentum && target.score >= 40
          ? PHI.MAJOR // 38.2% 모멘텀 강세
          : PHI.MEDIUM; // 23.6% 기본

  // v15: Kelly Cap 소폭 상향 (해외는 안정적 운용)
  const kellyCap = isPaper ? 0.50 : 0.45;
  const baseSize = portfolioValue * Math.min(kellyPct, kellyCap);

  // v16.2: 현금 유보 최소화 — 통합증거금 KRW→USD 자동전환 활용, idle 현금 줄이기
  // BULL: 1% 유보, NORMAL: 3% 유보, BEAR: 7% 유보
  const dynamicCashReserve = breadth >= 0.65 ? 0.01 : breadth >= 0.45 ? 0.03 : 0.07;
  const cashUsageCap = 1.0 - dynamicCashReserve;

  // 복합 감소기 바닥: 소액 0.60 / 일반 0.40 (여러 팩터 곱셈 붕괴 방지)
  // 단, VIX CRISIS(0.3x) 시에는 바닥 적용 안 함 — 위기 보호 우선
  const sizingFloor = vixRegime.regime === 'CRISIS' ? 0 : isSmallAccount ? 0.6 : 0.4;
  const flooredSizingMult = Math.max(sizingMult, sizingFloor);
  let positionSize = Math.min(baseSize * flooredSizingMult, cash * cashUsageCap);

  // 최소 포지션: 포트폴리오의 10% (고정 $ 대신 비율)
  const minPosition = portfolioValue * MIN_POSITION_PCT;
  if (positionSize < minPosition && cash >= minPosition) {
    positionSize = minPosition;
  }

  return { sizingMult, positionSize, kellyPct };
}
