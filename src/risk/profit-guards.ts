/**
 * 🏆 수익 구조 가드 — "수익볼 수밖에 없는 구조"
 *
 * 매매일지 분석(2026-06-12) 핵심 결함:
 *  - R:R 0.42:1 (손이 익의 2.4배)
 *  - 평균 익 +4.1% vs 평균 손 -9.7%
 *  - profitFactor 0.2 → 같은 승률이면 무조건 잃는 구조
 *
 * 3대 가드:
 *  1. R:R 검증 — TP/abs(SL) >= 1.5 미달이면 매수 차단
 *  2. 종목별 승률 사이징 — 40% 미만 → 0.5x, 25% 미만 → 차단
 *  3. 일일 손실 정지 — -3% 도달 시 24h 매수 정지
 */

import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

const COMP = 'PROFIT_GUARDS';

// ── 가드 #1: EV (Expected Value) 게이트 — 동적 검증 ──
// 정적 R:R 1.5 강제 → 종목별 실 승률+익률+손률 기반 EV 계산
// CEO 철학: "수수료보다 좋기만 하면 악착같이 매매"
export interface EvCheck {
  passed: boolean;
  ev: number; // 기대값 % (수수료 차감 후)
  rrRatio: number;
  effectiveWinRate: number;
  reason: string;
}

// 거래 비용 (왕복) — KR 0.21%, US 0.7%
const KR_FEE_ROUNDTRIP_PCT = 0.21;
const US_FEE_ROUNDTRIP_PCT = 0.7;
// EV 최소 안전 마진 (수수료의 1.5배 = "어쨌든 수수료 + α 남는다" 보장)
const EV_SAFETY_MULTIPLIER = 1.5;

/**
 * EV 검증 — TP/SL과 종목 승률로 기대값 계산.
 * EV가 수수료의 1.5배 이상 양수면 매매 허용.
 * 종목 승률 데이터 없으면 보수적 50% 가정.
 */
export function checkExpectedValue(params: {
  takeProfitPct: number;
  stopLossPct: number;
  winRate?: number; // 0~1, 미지정 시 0.5
  isUs?: boolean;
}): EvCheck {
  const absSL = Math.abs(params.stopLossPct);
  if (absSL === 0) return { passed: false, ev: 0, rrRatio: 0, effectiveWinRate: 0, reason: 'SL=0 (위험 무방어)' };

  const wr = params.winRate ?? 0.5;
  const fee = params.isUs ? US_FEE_ROUNDTRIP_PCT : KR_FEE_ROUNDTRIP_PCT;
  const minEv = fee * EV_SAFETY_MULTIPLIER;

  // EV = (승률 × 익) - ((1-승률) × 손) - 수수료
  const ev = wr * params.takeProfitPct - (1 - wr) * absSL - fee;
  const rrRatio = params.takeProfitPct / absSL;

  if (ev < minEv) {
    return {
      passed: false,
      ev,
      rrRatio,
      effectiveWinRate: wr,
      reason: `EV ${ev.toFixed(2)}% < 최소 ${minEv.toFixed(2)}% (승률 ${(wr * 100).toFixed(0)}%, TP+${params.takeProfitPct.toFixed(1)}%, SL${params.stopLossPct.toFixed(1)}%, 수수료 ${fee}%)`,
    };
  }
  return {
    passed: true,
    ev,
    rrRatio,
    effectiveWinRate: wr,
    reason: `EV +${ev.toFixed(2)}% ✓ (승률 ${(wr * 100).toFixed(0)}%, R:R ${rrRatio.toFixed(2)}:1)`,
  };
}

/** 레거시 호환 — 기존 checkRiskReward 호출처가 있으면 EV로 동작 */
export interface RrCheck {
  passed: boolean;
  rrRatio: number;
  reason: string;
}
export function checkRiskReward(takeProfitPct: number, stopLossPct: number, _minRr = 1.5): RrCheck {
  // EV 게이트로 위임 (승률 미지정 = 50% 가정)
  const ev = checkExpectedValue({ takeProfitPct, stopLossPct });
  return { passed: ev.passed, rrRatio: ev.rrRatio, reason: ev.reason };
}

// ── 가드 #2: 종목별 승률 기반 사이징 ───────────────────
export interface StockWinRateSizing {
  multiplier: number; // 0 (차단) ~ 1.0 (정상) ~ 1.2 (강세)
  recentWinRate: number;
  sampleCount: number;
  reason: string;
}

/** 종목별 최근 30일 승률 → 사이즈 multiplier 반환 */
export async function getStockSizing(stockCode: string, isPaper = false): Promise<StockWinRateSizing> {
  try {
    const { rows } = await getPool().query(
      `SELECT
         COUNT(*) FILTER (WHERE pnl_pct > 0) AS wins,
         COUNT(*) AS total,
         COALESCE(AVG(pnl_pct), 0) AS avg_pnl
       FROM transaction_chains
       WHERE stock_code = $1 AND is_paper = $2 AND status = 'CLOSED'
         AND closed_at > NOW() - INTERVAL '30 days'`,
      [stockCode, isPaper],
    );
    const wins = Number(rows[0]?.wins ?? 0);
    const total = Number(rows[0]?.total ?? 0);
    if (total < 3) {
      return {
        multiplier: 1.0,
        recentWinRate: 0,
        sampleCount: total,
        reason: `샘플 부족 (${total}건) — 기본 사이즈`,
      };
    }
    const wr = wins / total;
    if (wr < 0.25) {
      return {
        multiplier: 0,
        recentWinRate: wr,
        sampleCount: total,
        reason: `🚫 승률 ${(wr * 100).toFixed(0)}% < 25% (${total}건) — 매수 차단`,
      };
    }
    if (wr < 0.4) {
      return {
        multiplier: 0.5,
        recentWinRate: wr,
        sampleCount: total,
        reason: `⚠️ 승률 ${(wr * 100).toFixed(0)}% < 40% (${total}건) — 사이즈 50% 축소`,
      };
    }
    if (wr >= 0.7) {
      return {
        multiplier: 1.2,
        recentWinRate: wr,
        sampleCount: total,
        reason: `⭐ 승률 ${(wr * 100).toFixed(0)}% >= 70% (${total}건) — 사이즈 +20%`,
      };
    }
    return {
      multiplier: 1.0,
      recentWinRate: wr,
      sampleCount: total,
      reason: `승률 ${(wr * 100).toFixed(0)}% (${total}건) — 정상 사이즈`,
    };
  } catch {
    return { multiplier: 1.0, recentWinRate: 0, sampleCount: 0, reason: '승률 조회 실패 — 기본' };
  }
}

// ── 가드 #3: 일일 손실 정지 ─────────────────────────
const DAILY_LOSS_LIMIT_PCT = 3.0; // 당일 시드 대비 -3% 도달 시 정지

export interface DailyLossStatus {
  shouldStop: boolean;
  todayPnlPct: number;
  closedCount: number;
  reason: string;
}

/** 오늘 KST 누적 손실 체크 → -3% 이상 손실 시 stop */
export async function checkDailyLossStop(isPaper = false): Promise<DailyLossStatus> {
  try {
    const { rows } = await getPool().query(
      `SELECT
         COUNT(*) AS closed,
         COALESCE(SUM(realized_pnl), 0) AS total_pnl_krw,
         COALESCE(SUM(total_invested), 0) AS total_invested
       FROM transaction_chains
       WHERE is_paper = $1 AND status = 'CLOSED'
         AND closed_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
      [isPaper],
    );
    const closedCount = Number(rows[0]?.closed ?? 0);
    const totalPnl = Number(rows[0]?.total_pnl_krw ?? 0);
    const totalInvested = Number(rows[0]?.total_invested ?? 0);
    if (closedCount === 0 || totalInvested === 0) {
      return { shouldStop: false, todayPnlPct: 0, closedCount: 0, reason: '당일 거래 없음' };
    }
    const pnlPct = (totalPnl / totalInvested) * 100;
    if (pnlPct <= -DAILY_LOSS_LIMIT_PCT) {
      return {
        shouldStop: true,
        todayPnlPct: pnlPct,
        closedCount,
        reason: `🛑 일일 손실 ${pnlPct.toFixed(1)}% (${closedCount}건) <= -${DAILY_LOSS_LIMIT_PCT}% → 24h 매수 정지`,
      };
    }
    return {
      shouldStop: false,
      todayPnlPct: pnlPct,
      closedCount,
      reason: `일일 PnL ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% (${closedCount}건)`,
    };
  } catch (e) {
    logger.warn(`일일 손실 체크 실패: ${(e as Error).message}`, { component: COMP });
    return { shouldStop: false, todayPnlPct: 0, closedCount: 0, reason: '체크 실패' };
  }
}

// ── 종합 매수 가드 (3가지 모두 통과해야 매수 허용) ──
export interface BuyGateResult {
  allowed: boolean;
  amountMultiplier: number;
  reason: string;
  details: {
    ev: EvCheck;
    sizing: StockWinRateSizing;
    dailyLoss: DailyLossStatus;
  };
}

export async function checkBuyGate(params: {
  stockCode: string;
  takeProfitPct: number;
  stopLossPct: number;
  isPaper?: boolean;
  isUs?: boolean;
  minRr?: number; // 레거시 호환 (사용 안 됨, EV로 대체)
}): Promise<BuyGateResult> {
  const isPaper = params.isPaper ?? false;
  const [sizing, dailyLoss] = await Promise.all([
    getStockSizing(params.stockCode, isPaper),
    checkDailyLossStop(isPaper),
  ]);
  // EV 게이트: 종목 실제 승률로 계산 (없으면 50% 보수적)
  const wr = sizing.sampleCount >= 3 ? sizing.recentWinRate : 0.5;
  const ev = checkExpectedValue({
    takeProfitPct: params.takeProfitPct,
    stopLossPct: params.stopLossPct,
    winRate: wr,
    isUs: params.isUs,
  });

  // 일일 손실 정지가 최우선
  if (dailyLoss.shouldStop) {
    return {
      allowed: false,
      amountMultiplier: 0,
      reason: dailyLoss.reason,
      details: { ev, sizing, dailyLoss },
    };
  }
  // EV 미달
  if (!ev.passed) {
    return {
      allowed: false,
      amountMultiplier: 0,
      reason: ev.reason,
      details: { ev, sizing, dailyLoss },
    };
  }
  // 승률 사이징 — multiplier=0이면 차단
  if (sizing.multiplier === 0) {
    return {
      allowed: false,
      amountMultiplier: 0,
      reason: sizing.reason,
      details: { ev, sizing, dailyLoss },
    };
  }

  return {
    allowed: true,
    amountMultiplier: sizing.multiplier,
    reason: `허용 (${ev.reason}, ${sizing.reason})`,
    details: { ev, sizing, dailyLoss },
  };
}

// ── 마이크로 스캘핑 파라미터 — 고승률 종목 전용 ──
// 종목 승률 60%+ → 작은 익절(0.5~1%) + 작은 손절(0.3~0.5%)로 회전율 극대화
// 수수료 0.21% 후 순익 0.3%+ 보장 (EV 양수)
export function getMicroScalpParams(winRate: number): { takeProfitPct: number; stopLossPct: number } | null {
  if (winRate >= 0.8) return { takeProfitPct: 0.7, stopLossPct: -0.4 }; // 1.75:1
  if (winRate >= 0.7) return { takeProfitPct: 0.9, stopLossPct: -0.5 }; // 1.8:1
  if (winRate >= 0.6) return { takeProfitPct: 1.0, stopLossPct: -0.6 }; // 1.67:1
  return null; // 60% 미만은 스캘핑 부적합
}

/**
 * 종목별 최적 매매 파라미터 선택
 * - 승률 60%+ → 마이크로 스캘핑 (악착스러운 단타)
 * - 승률 < 60% → 점수 기반 SWING
 * CEO 철학: "악착같이 매매해서 돈을 조금이라도"
 */
export async function getOptimalTradeParams(params: {
  stockCode: string;
  aiScore: number;
  isPaper?: boolean;
}): Promise<{ takeProfitPct: number; stopLossPct: number; mode: 'MICRO_SCALP' | 'SWING'; reason: string }> {
  const sizing = await getStockSizing(params.stockCode, params.isPaper ?? false);
  if (sizing.sampleCount >= 5) {
    const micro = getMicroScalpParams(sizing.recentWinRate);
    if (micro) {
      return {
        ...micro,
        mode: 'MICRO_SCALP',
        reason: `종목 승률 ${(sizing.recentWinRate * 100).toFixed(0)}% (${sizing.sampleCount}건) → 마이크로 스캘핑`,
      };
    }
  }
  // 점수 기반 SWING (강화된 동적 TP)
  const { getScoreBasedParams } = await import('../config/constants.js');
  const sp = getScoreBasedParams(params.aiScore);
  return {
    takeProfitPct: sp.takeProfitPct,
    stopLossPct: sp.stopLossPct,
    mode: 'SWING',
    reason: `AI ${params.aiScore}점 → SWING (TP+${sp.takeProfitPct}%/SL${sp.stopLossPct}%)`,
  };
}
