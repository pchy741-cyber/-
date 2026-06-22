/**
 * 연속 손실 트래커 — 포지션 사이징 자동 축소
 *
 * 1연속 손실: 1.0x (정상)
 * 2연속 손실: 0.7x
 * 3+연속 손실: 0.5x
 * 승리 시: 즉시 리셋
 *
 * DB(system_state) 영속화 — 서버 재시작 후에도 유지
 */
import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

const KEY_LIVE = 'loss_streak_live';
const KEY_PAPER = 'loss_streak_paper';

const RESYNC_TTL_MS = 5 * 60 * 1000; // 5분 — 멀티 인스턴스 DB 동기화 주기

let streakLive = 0;
let streakPaper = 0;
let lastLoadedAt = 0;

async function load(): Promise<void> {
  if (Date.now() - lastLoadedAt < RESYNC_TTL_MS) return;
  try {
    const { rows } = await getPool().query(`SELECT key, value FROM system_state WHERE key IN ($1, $2)`, [
      KEY_LIVE,
      KEY_PAPER,
    ]);
    for (const r of rows) {
      const v = parseInt(r.value, 10);
      const safeV = Number.isFinite(v) ? v : 0;
      if (r.key === KEY_LIVE) streakLive = safeV;
      if (r.key === KEY_PAPER) streakPaper = safeV;
    }
  } catch {
    /* DB 없으면 0으로 시작 */
  }
  lastLoadedAt = Date.now();
}

async function persist(isPaper: boolean): Promise<void> {
  try {
    const key = isPaper ? KEY_PAPER : KEY_LIVE;
    const val = String(isPaper ? streakPaper : streakLive);
    await getPool().query(
      `INSERT INTO system_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, val],
    );
  } catch {
    /* non-critical */
  }
}

/** Streak thresholds and corresponding position size multipliers
 * v10.9.4: 5연패 0.25x 추가, 8연패 거래 중단 (기존: 3+연패 0.5x가 최대 → 무한 손실 누적) */
const STREAK_HALT = 8; // 8+ consecutive losses → 거래 중단
const STREAK_CRITICAL = 5; // 5+ consecutive losses → 25% position
const STREAK_SEVERE = 3; // 3+ consecutive losses → 50% position
const STREAK_MODERATE = 2; // 2 consecutive losses → 70% position
const MULTIPLIER_HALT = 0; // 거래 중단
const MULTIPLIER_CRITICAL = 0.25;
const MULTIPLIER_SEVERE = 0.5;
const MULTIPLIER_MODERATE = 0.7;
const MULTIPLIER_NORMAL = 1.0;

function calcMultiplier(streak: number): number {
  if (streak >= STREAK_HALT) return MULTIPLIER_HALT;
  if (streak >= STREAK_CRITICAL) return MULTIPLIER_CRITICAL;
  if (streak >= STREAK_SEVERE) return MULTIPLIER_SEVERE;
  if (streak >= STREAK_MODERATE) return MULTIPLIER_MODERATE;
  return MULTIPLIER_NORMAL;
}

/** 거래 결과 기록 — SELL 체결 후 호출
 * v10.9.4: 승리 시 점진적 회복 (기존: 0.1% 수익으로도 즉시 리셋 → 연패 보호 무력화)
 * 3연패 이상이었으면 1승 = -2, 그 외 = 즉시 리셋 */
export async function recordTradeOutcome(win: boolean, isPaper: boolean): Promise<void> {
  await load();
  if (win) {
    const prev = isPaper ? streakPaper : streakLive;
    // 3연패 이상 상태에서 1승 → 2단계 낮추기 (점진 회복), 2 이하면 즉시 리셋
    const next = prev >= STREAK_SEVERE ? Math.max(0, prev - 2) : 0;
    if (isPaper) streakPaper = next;
    else streakLive = next;
  } else {
    if (isPaper) streakPaper += 1;
    else streakLive += 1;
  }
  const streak = isPaper ? streakPaper : streakLive;
  const mult = calcMultiplier(streak);
  if (streak >= STREAK_HALT) {
    logger.warn(`🛑 연속손실 ${streak}회 → 거래 중단! (자동 재개: 수동 리셋 또는 점진 회복)`, { component: 'RISK' });
  } else {
    logger.info(`📉 연속손실 ${streak}회 → 포지션 배율 ×${mult}${mult < 1 ? ' ⚠️ 축소 중' : ''}`, { component: 'RISK' });
  }
  await persist(isPaper);
}

/** 현재 포지션 축소 배율 반환 (1.0 / 0.7 / 0.5) */
export async function getLossStreakMultiplier(isPaper: boolean): Promise<number> {
  await load();
  return calcMultiplier(isPaper ? streakPaper : streakLive);
}

export async function getLossStreakStatus(isPaper: boolean): Promise<{ streak: number; multiplier: number }> {
  await load();
  const streak = isPaper ? streakPaper : streakLive;
  return { streak, multiplier: calcMultiplier(streak) };
}
