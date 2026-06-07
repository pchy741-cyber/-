/**
 * 📈 체제 연동 전략 배분기
 *
 * 시장 체제(BULLISH/NEUTRAL/BEARISH/CRASH)에 따라
 * Paper 토너먼트의 전략별 자본 배분 가중치를 결정.
 *
 * 30일 실적 기반 자동 조정 (월 1회, 자기학습 연동).
 */

import { type StrategyMode } from '../config/constants.js';
import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

type RegimeType = 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'CRASH';

// 기본 배분 (합계 100 아닐 수 있음 — 비율로 사용)
const DEFAULT_WEIGHTS: Record<RegimeType, Partial<Record<StrategyMode, number>>> = {
  BULLISH:  { SWING: 35, SNIPER: 25, BREAKOUT: 20, SCALPING: 15, BOTTOM_FISHING: 5 },
  NEUTRAL:  { SWING: 40, DEFENSE: 20, SNIPER: 15, BOTTOM_FISHING: 15, SCALPING: 10 },
  BEARISH:  { DEFENSE: 40, BOTTOM_FISHING: 25, SWING: 20, SCALPING: 15 },
  CRASH:    { DEFENSE: 50, BOTTOM_FISHING: 30, SWING: 20 },
};

// 캐시 (5분 TTL)
let _cache: { regime: RegimeType; allocation: Record<string, number>; ts: number } | null = null;
const CACHE_TTL = 5 * 60_000;

/**
 * 현재 시장 체제 판별
 * market-regime.ts의 penalty 기반:
 *   penalty=0 + boost → BULLISH
 *   penalty=0         → NEUTRAL
 *   penalty=1         → BEARISH
 *   penalty=2         → CRASH
 */
async function detectRegime(): Promise<RegimeType> {
  try {
    const { rows } = await getPool().query(
      `SELECT value FROM system_state WHERE key = 'last_kospi_regime'`,
    );
    if (rows[0]?.value) {
      const parsed = JSON.parse(rows[0].value);
      if (parsed.penalty >= 2) return 'CRASH';
      if (parsed.penalty >= 1) return 'BEARISH';
      if (parsed.boost) return 'BULLISH';
      return 'NEUTRAL';
    }
  } catch {}

  // DB에 없으면 NEUTRAL
  return 'NEUTRAL';
}

/**
 * 체제별 전략 배분 가중치 반환
 * 캐시 5분, 학습된 오버라이드가 있으면 적용
 */
export async function getRegimeAllocation(): Promise<Record<string, number>> {
  const now = Date.now();
  if (_cache && now - _cache.ts < CACHE_TTL) return _cache.allocation;

  const regime = await detectRegime();
  let allocation: Record<string, number> = { ...(DEFAULT_WEIGHTS[regime] ?? DEFAULT_WEIGHTS.NEUTRAL) };

  // 학습된 오버라이드 조회 (strategy_optimizer가 기록)
  try {
    const { rows } = await getPool().query(
      `SELECT value FROM system_state WHERE key = 'regime_allocation_override'`,
    );
    if (rows[0]?.value) {
      const overrides = JSON.parse(rows[0].value);
      if (overrides[regime]) {
        allocation = { ...allocation, ...overrides[regime] };
      }
    }
  } catch {}

  _cache = { regime, allocation, ts: now };
  logger.info(`📈 체제 배분: ${regime} → ${Object.entries(allocation).map(([k, v]) => `${k}:${v}%`).join(' ')}`, { component: 'REGIME_ALLOC' });
  return allocation;
}

/** 캐시 무효화 (테스트/수동 트리거용) */
export function invalidateRegimeCache(): void {
  _cache = null;
}
