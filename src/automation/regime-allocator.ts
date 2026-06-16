/**
 * 📈 체제 연동 전략 배분기 — 자기학습 자동 조정
 *
 * 시장 체제(BULLISH/NEUTRAL/BEARISH/CRASH)에 따라
 * 전략별 자본 배분 가중치를 결정.
 *
 * 매일 자동 조정: 30일 전략별 승률/PnL → 가중치 자동 튜닝.
 * 수익 나는 전략은 확대, 손실 전략은 축소 — "악착같이 수익으로만 운영".
 */

import type { StrategyMode } from '../config/constants.js';
import { getCtxIsPaper } from '../config/context.js';
import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

type RegimeType = 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'CRASH';

// 기본 배분 (합계 100 아닐 수 있음 — 비율로 사용)
// SCALPING/EOD_BETTING 영구 제거
const DEFAULT_WEIGHTS: Record<RegimeType, Partial<Record<StrategyMode, number>>> = {
  BULLISH:  { SWING: 40, SNIPER: 25, BREAKOUT: 25, BOTTOM_FISHING: 5, DEFENSE: 5 },
  NEUTRAL:  { SWING: 40, DEFENSE: 20, SNIPER: 15, BOTTOM_FISHING: 15, BREAKOUT: 10 },
  BEARISH:  { DEFENSE: 35, BOTTOM_FISHING: 25, SWING: 25, BREAKOUT: 10, SNIPER: 5 },
  CRASH:    { DEFENSE: 45, BOTTOM_FISHING: 25, SWING: 20, BREAKOUT: 5, SNIPER: 5 },
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
    const { rows } = await getPool().query(`SELECT value FROM system_state WHERE key = 'last_kospi_regime'`);
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
 * 30일 전략별 성과 → 가중치 자동 조정
 *
 * 원리:
 * 1. 30일 체인에서 strategy_mode별 승률/총PnL 집계
 * 2. 수익 나는 전략 → 가중치 확대 (최대 DEFAULT의 2배)
 * 3. 손실 나는 전략 → 가중치 축소 (최소 DEFAULT의 30%)
 * 4. 결과를 system_state에 저장 → getRegimeAllocation에서 자동 적용
 *
 * 데이터 스누핑 방지: 표본 최소 5건, 승률 변동 ±20%p 상한 (과적합 차단)
 */
// 자동 조정 rate limit: 1시간에 1회 (루프마다 호출되어도 과부하 방지)
let _lastAutoTuneAt = 0;
const AUTO_TUNE_INTERVAL = 60 * 60_000; // 1시간

export async function autoTuneRegimeWeights(): Promise<void> {
  const now = Date.now();
  if (now - _lastAutoTuneAt < AUTO_TUNE_INTERVAL) return;
  _lastAutoTuneAt = now;

  const isPaper = getCtxIsPaper();
  try {
    const { rows } = await getPool().query(
      `SELECT strategy_mode, COUNT(*)::int AS total,
              SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END)::int AS wins,
              SUM(realized_pnl)::float AS total_pnl
       FROM transaction_chains
       WHERE status = 'CLOSED'
         AND closed_at >= NOW() - INTERVAL '30 days'
         AND is_paper = $1
         AND strategy_mode IS NOT NULL
       GROUP BY strategy_mode
       HAVING COUNT(*) >= 3`,
      [isPaper],
    );

    if (rows.length === 0) {
      logger.info('📈 자동 가중치 조정: 30일 데이터 부족 — 기본 가중치 유지', { component: 'REGIME_ALLOC' });
      return;
    }

    const regime = await detectRegime();
    const base = { ...(DEFAULT_WEIGHTS[regime] ?? DEFAULT_WEIGHTS.NEUTRAL) };

    // 전략별 성과 점수: 승률 × (1 + PnL 부호) → 수익성 반영
    const adjusted: Record<string, number> = { ...base };
    const changes: string[] = [];

    for (const row of rows) {
      const mode = row.strategy_mode as StrategyMode;
      const baseWeight = (base[mode] ?? 0);
      if (baseWeight <= 0) continue; // 기본 가중치 없는 전략은 건드리지 않음

      const winRate = row.total > 0 ? row.wins / row.total : 0;
      const pnlSign = row.total_pnl > 0 ? 1 : -1;

      // 성과 배수: 승률 50% 기준, ±20%p마다 ±0.3 배수 (상한 2.0, 하한 0.3)
      // 데이터 스누핑 방지: 표본 5건 미만이면 배수 1.0 (변경 없음)
      let multiplier = 1.0;
      if (row.total >= 5) {
        const winRateAdj = (winRate - 0.5) * 1.5; // -0.75 ~ +0.75
        const pnlBonus = pnlSign > 0 ? 0.1 : -0.1; // 수익 전략 소폭 추가 보너스
        multiplier = Math.max(0.3, Math.min(2.0, 1.0 + winRateAdj + pnlBonus));
      }

      const newWeight = Math.round(baseWeight * multiplier);
      if (newWeight !== baseWeight) {
        adjusted[mode] = newWeight;
        const emoji = multiplier > 1.0 ? '🔺' : '🔻';
        changes.push(
          `${emoji}${mode}: ${baseWeight}→${newWeight}% (승률${(winRate * 100).toFixed(0)}% ${row.wins}/${row.total}건 PnL${row.total_pnl > 0 ? '+' : ''}${Math.round(row.total_pnl).toLocaleString()})`,
        );
      }
    }

    if (changes.length === 0) {
      logger.info('📈 자동 가중치: 현재 배분 적절 — 변경 없음', { component: 'REGIME_ALLOC' });
      return;
    }

    // system_state에 오버라이드 저장 (regime별)
    const overrideKey = 'regime_allocation_override';
    let existing: Record<string, Record<string, number>> = {};
    try {
      const { rows: stateRows } = await getPool().query(
        `SELECT value FROM system_state WHERE key = $1`,
        [overrideKey],
      );
      if (stateRows[0]?.value) existing = JSON.parse(stateRows[0].value);
    } catch {}

    existing[regime] = adjusted;
    await getPool().query(
      `INSERT INTO system_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [overrideKey, JSON.stringify(existing)],
    );

    _cache = null; // 캐시 무효화

    const label = isPaper ? '🧪Paper' : '💰Live';
    logger.info(
      `📈 ${label} 자동 가중치 조정 (${regime}): ${changes.join(' | ')}`,
      { component: 'REGIME_ALLOC' },
    );

    // 텔레그램 알림 (Live만)
    if (!isPaper) {
      try {
        const { sendTelegramMessage } = await import('../notifications/telegram.js');
        await sendTelegramMessage(
          `📈 *황금비율 자동 조정* (${regime})\n${changes.map((c) => `• ${c}`).join('\n')}`,
        ).catch(() => {});
      } catch {}
    }
  } catch (err) {
    logger.warn(`자동 가중치 조정 실패: ${err}`, { component: 'REGIME_ALLOC' });
  }
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

  // 학습된 오버라이드 조회 (autoTuneRegimeWeights가 기록)
  try {
    const { rows } = await getPool().query(`SELECT value FROM system_state WHERE key = 'regime_allocation_override'`);
    if (rows[0]?.value) {
      const overrides = JSON.parse(rows[0].value);
      if (overrides[regime]) {
        allocation = { ...allocation, ...overrides[regime] };
      }
    }
  } catch {}

  _cache = { regime, allocation, ts: now };
  logger.info(
    `📈 체제 배분: ${regime} → ${Object.entries(allocation)
      .map(([k, v]) => `${k}:${v}%`)
      .join(' ')}`,
    { component: 'REGIME_ALLOC' },
  );
  return allocation;
}

/** 캐시 무효화 (테스트/수동 트리거용) */
export function invalidateRegimeCache(): void {
  _cache = null;
}
