// ── 미국주식 해외 (통합증거금) ──
export const OVERSEAS = {
  UNIFIED_MARGIN: true,
  TOP_COUNT: 20,
  ASIA_TOP_COUNT: 6,
  AI_INTERVAL_MS: 10 * 60_000,
  PARKING_MIN_ORDER: 20,
  CONCENTRATION_MIN_PNL_PCT: 4.0,
} as const;

// ── 황금비율 자금배분 (해외) — 합산 100% ──
// v22: CASH 3%→10% (기존 93% 합산 → 100% 정규화, 88% 투자캡과 정합)
// v26: SWING 50%→70% (대부분 종목이 SWING 분류 → 50%에서 매수 차단 빈발)
export const ALLOCATION_GOLDEN = {
  SWING_PCT: 0.70,
  CORE_PCT: 0.15,
  TACTICAL_PCT: 0.05,
  CASH_PCT: 0.10,
} as const;

export type StrategyBucket = 'SWING' | 'CORE' | 'TACTICAL';

/** 포트폴리오 규모 기반 동적 파라미터 */
let _lastTier: 'micro' | 'small' | 'large' = 'small';
let _tierInitialized = false;
export function getOverseasDynamic(portfolioUsd: number, isPaper = false, posCapPct = 0.25) {
  const p = Math.max(100, portfolioUsd);

  if (!isPaper) {
    if (!_tierInitialized) {
      _lastTier = p < 2000 ? 'micro' : p < 10000 ? 'small' : 'large';
      _tierInitialized = true;
    } else if (_lastTier === 'micro') {
      if (p >= 2300) _lastTier = 'small';
      if (p >= 11500) _lastTier = 'large';
    } else if (_lastTier === 'small') {
      if (p < 1700) _lastTier = 'micro';
      if (p >= 11500) _lastTier = 'large';
    } else {
      if (p < 8500) _lastTier = 'small';
      if (p < 1700) _lastTier = 'micro';
    }
  }

  const tier = isPaper ? (p < 2000 ? 'micro' : p < 10000 ? 'small' : 'large') : _lastTier;
  const posPct = tier === 'large' ? Math.min(0.18, posCapPct) : posCapPct;
  const holdDays = tier === 'micro' ? 14 : tier === 'small' ? 21 : 30;

  const maxPos = isPaper
    ? Math.max(4, Math.min(12, Math.floor(1 / posPct)))
    : Math.max(3, Math.min(10, Math.floor(1 / posPct)));
  const positionCap = isPaper ? 10000 : 5000;
  return {
    maxPositions: maxPos,
    positionSizeUsd: Math.round(Math.min(p * posCapPct, positionCap)),
    positionPct: posPct,
    parkingCashBuffer: Math.round(p * 0.02),
    maxHoldDays: holdDays,
    concentrationCashBuffer: Math.round(p * 0.04),
    concentrationMinInvest: Math.round(p * 0.01),
  };
}
