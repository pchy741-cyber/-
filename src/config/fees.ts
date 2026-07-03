// ── 국내주식 수수료/세금 (2025 기준) ──
export const KR_FEE = {
  BUY_FEE_PCT: 0.00015,
  SELL_FEE_PCT: 0.00195,
  TRANSACTION_TAX_PCT: 0.0018,
  ROUND_TRIP_PCT: 0.0021,
} as const;

// ── 환율 비상 폴백 ──
export const FALLBACK_FX_RATE = Number(process.env.FALLBACK_FX_RATE) || 1_520;

// ── 매매 게이트 ──
export const GATE = {
  SLIPPAGE_PCT: 0.26,
  US_SLIPPAGE_PCT: 0.7,
  FX_SAFETY_MARGIN: 0.02,
  REENTRY_COOLDOWN_MS: 10 * 60_000,
  CONSECUTIVE_LOSS_HALT_MS: 10 * 60_000,
  CONSECUTIVE_LOSS_WARN_MS: 5 * 60_000,
  COOLDOWN_NOTIFY_MS: 30 * 60_000,
} as const;

/**
 * 해외주식 편도 수수료율 (매수/매도 각각 적용)
 * 합계: ~0.36% → 반올림 0.35%
 */
export const OVERSEAS_FEE_PCT = 0.0035;
