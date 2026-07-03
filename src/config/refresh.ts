// ── 캐시 & 갱신 주기 ──
export const REFRESH = {
  DART_INTERVAL_MS: 60 * 60_000,
  EARNINGS_CACHE_TTL_MS: 4 * 60 * 60_000,
  EARNINGS_WINDOW_DAYS: 7,
  EARNINGS_FETCH_TIMEOUT_MS: 5_000,
} as const;

// ── 거래대금 임계값 ──
export const TRADING_VALUE = {
  SURGE_MIN: 50_000_000_000,
  MEGA_CAP_SURGE_MIN: 300_000_000_000,
} as const;

// ── 월간 MDD 한도 ──
export const MDD_LIMIT = {
  LIVE: 12,
  PAPER: 80,
} as const;
