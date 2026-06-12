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

// ── 가드 #1: R:R 비율 검증 ──────────────────────────────
export interface RrCheck {
  passed: boolean;
  rrRatio: number;
  reason: string;
}

/** TP/SL 비율 검증 — 매수 전 호출 */
export function checkRiskReward(takeProfitPct: number, stopLossPct: number, minRr = 1.5): RrCheck {
  const absSL = Math.abs(stopLossPct);
  if (absSL === 0) return { passed: false, rrRatio: 0, reason: 'SL=0 (위험 무방어)' };
  const rrRatio = takeProfitPct / absSL;
  if (rrRatio < minRr) {
    return {
      passed: false,
      rrRatio,
      reason: `R:R ${rrRatio.toFixed(2)}:1 < 최소 ${minRr}:1 (TP+${takeProfitPct.toFixed(1)}% / SL${stopLossPct.toFixed(1)}%)`,
    };
  }
  return {
    passed: true,
    rrRatio,
    reason: `R:R ${rrRatio.toFixed(2)}:1 ✓`,
  };
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
    rr: RrCheck;
    sizing: StockWinRateSizing;
    dailyLoss: DailyLossStatus;
  };
}

export async function checkBuyGate(params: {
  stockCode: string;
  takeProfitPct: number;
  stopLossPct: number;
  isPaper?: boolean;
  minRr?: number;
}): Promise<BuyGateResult> {
  const isPaper = params.isPaper ?? false;
  const minRr = params.minRr ?? 1.5;
  const [sizing, dailyLoss] = await Promise.all([
    getStockSizing(params.stockCode, isPaper),
    checkDailyLossStop(isPaper),
  ]);
  const rr = checkRiskReward(params.takeProfitPct, params.stopLossPct, minRr);

  // 일일 손실 정지가 최우선
  if (dailyLoss.shouldStop) {
    return {
      allowed: false,
      amountMultiplier: 0,
      reason: dailyLoss.reason,
      details: { rr, sizing, dailyLoss },
    };
  }
  // R:R 미달
  if (!rr.passed) {
    return {
      allowed: false,
      amountMultiplier: 0,
      reason: rr.reason,
      details: { rr, sizing, dailyLoss },
    };
  }
  // 승률 사이징 — multiplier=0이면 차단
  if (sizing.multiplier === 0) {
    return {
      allowed: false,
      amountMultiplier: 0,
      reason: sizing.reason,
      details: { rr, sizing, dailyLoss },
    };
  }

  return {
    allowed: true,
    amountMultiplier: sizing.multiplier,
    reason: `허용 (${rr.reason}, ${sizing.reason})`,
    details: { rr, sizing, dailyLoss },
  };
}
