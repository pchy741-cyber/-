// ── 스케줄러 ──
export const SCHEDULE = {
  TRACK_A_CRON: ['30 7 * * 1-5', '0 9 * * 1-5', '30 12 * * 1-5', '0 18 * * 1-5'],
  TRACK_B_INTERVAL_MINUTES: 2,
} as const;
