/**
 * 📊 전략 종합 성과 평가 (Strategy Health)
 *
 * 단일 API로 누적 수익률, MDD, 샤프/소르티노/칼마, 승률, PF, 등급 등
 * 전략 건강도를 종합 평가.
 *
 * 데이터 소스:
 *   - portfolio_snapshots: 일별 total_value, daily_pnl (수익률·MDD·변동성)
 *   - score_accuracy: 건별 WIN/LOSS/pnl_pct (승률·PF·payoff·연승연패)
 */

import { getPool } from '../db/client.js';
import { getKSTNow } from '../utils/time.js';

// ── Types ──

interface SnapshotRow {
  date: string;
  total_value: string;
  daily_pnl: string;
}

interface ScoreRow {
  outcome: string;
  realized_pnl_pct: string;
}

export interface StrategyHealthResult {
  period: { startDate: string; endDate: string; tradingDays: number };
  returns: {
    cumulativePct: number;
    monthlyAvgPct: number;
    dailyAvgPct: number;
    bestDayPct: number;
    worstDayPct: number;
    totalPnlKrw: number;
    initialCapital: number;
  };
  risk: {
    maxDrawdownPct: number;
    maxDrawdownDays: number;
    currentDrawdownPct: number;
    volatilityDaily: number;
    volatilityAnnual: number;
  };
  efficiency: {
    sharpeRatio: number;
    sortinoRatio: number;
    calmarRatio: number;
    profitFactor: number;
    payoffRatio: number;
  };
  consistency: {
    winRate: number;
    profitDaysRate: number;
    maxConsecutiveWins: number;
    maxConsecutiveLosses: number;
    recoveryFactor: number;
  };
  goal: {
    monthlyTargetPct: number;
    currentMonthPct: number;
    onTrack: boolean;
    projectedMonthlyPct: number;
    daysRemaining: number;
  };
  grade: string;
  mode: string;
}

/** 무위험 수익률 (한국 국채 기준 ~3.5%) */
const RISK_FREE_RATE_PCT = 3.5;

// ── Main ──

export async function computeStrategyHealth(
  isPaper: boolean,
  days = 90,
  monthlyTarget = 5.0,
): Promise<StrategyHealthResult> {
  const pool = getPool();

  // SQL 2개만 병렬 실행
  const [{ rows: snapshots }, { rows: scores }] = await Promise.all([
    pool.query<SnapshotRow>(
      `SELECT
         (snapshot_at AT TIME ZONE 'Asia/Seoul')::date AS date,
         MAX(total_value) AS total_value,
         MAX(daily_pnl)   AS daily_pnl
       FROM portfolio_snapshots
       WHERE is_paper = $1
         AND snapshot_at >= NOW() - ($2 || ' days')::INTERVAL
       GROUP BY 1
       ORDER BY 1 ASC`,
      [isPaper, days],
    ),
    // v23-audit: EXPLORE 프로파일 제외
    pool.query<ScoreRow>(
      `SELECT outcome, realized_pnl_pct
       FROM score_accuracy
       WHERE is_paper = $1
         AND recorded_at >= NOW() - ($2 || ' days')::INTERVAL
         AND COALESCE(trading_profile, 'LIVE') != 'EXPLORE'
       ORDER BY recorded_at ASC`,
      [isPaper, days],
    ),
  ]);

  const tradingDays = snapshots.length;

  // ── Returns ──
  const firstValue = tradingDays > 0 ? Number(snapshots[0].total_value) : 0;
  const lastValue = tradingDays > 0 ? Number(snapshots[tradingDays - 1].total_value) : 0;
  const cumulativePct = firstValue > 0 ? ((lastValue / firstValue) - 1) * 100 : 0;

  const dailyPnls = snapshots.map(r => Number(r.daily_pnl ?? 0));
  const totalPnlKrw = dailyPnls.reduce((s, v) => s + v, 0);

  // 일별 수익률 (total_value 기반)
  const dailyReturns: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = Number(snapshots[i - 1].total_value);
    if (prev > 0) {
      dailyReturns.push(((Number(snapshots[i].total_value) / prev) - 1) * 100);
    }
  }

  const dailyAvgPct = dailyReturns.length > 0
    ? dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length
    : 0;
  const months = Math.max(1, tradingDays / 21);
  const monthlyAvgPct = cumulativePct / months;

  let bestDayPct = 0;
  let worstDayPct = 0;
  for (const r of dailyReturns) {
    if (r > bestDayPct) bestDayPct = r;
    if (r < worstDayPct) worstDayPct = r;
  }

  // ── Risk: MDD (전체기간) ──
  let peak = 0;
  let maxDd = 0;
  let maxDdDays = 0;
  let peakIdx = 0;
  let currentDd = 0;

  for (let i = 0; i < snapshots.length; i++) {
    const val = Number(snapshots[i].total_value);
    if (val >= peak) {
      peak = val;
      peakIdx = i;
    }
    const dd = peak > 0 ? ((peak - val) / peak) * 100 : 0;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdDays = i - peakIdx;
    }
    currentDd = dd;
  }

  // ── Volatility ──
  const mean = dailyReturns.length > 0
    ? dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length
    : 0;
  const variance = dailyReturns.length > 1
    ? dailyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyReturns.length - 1)
    : 0;
  const volatilityDaily = Math.sqrt(variance);
  const volatilityAnnual = volatilityDaily * Math.sqrt(252);

  // 하방 변동성 (Sortino용, 음수 수익만)
  const negReturns = dailyReturns.filter(r => r < 0);
  const downsideVar = negReturns.length > 1
    ? negReturns.reduce((s, v) => s + v ** 2, 0) / (negReturns.length - 1)
    : 0;
  const downsideVol = Math.sqrt(downsideVar) * Math.sqrt(252);

  const annualizedReturn = dailyAvgPct * 252;

  // ── Efficiency ──
  const sharpeRatio = volatilityAnnual > 0
    ? (annualizedReturn - RISK_FREE_RATE_PCT) / volatilityAnnual
    : 0;
  const sortinoRatio = downsideVol > 0
    ? (annualizedReturn - RISK_FREE_RATE_PCT) / downsideVol
    : 0;
  const calmarRatio = maxDd > 0 ? annualizedReturn / maxDd : 0;

  // ── Consistency (score_accuracy 기반) ──
  const wins = scores.filter(s => s.outcome === 'WIN');
  const losses = scores.filter(s => s.outcome === 'LOSS');
  const totalTrades = scores.length;
  const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;

  const grossProfit = wins.reduce((s, w) => s + Math.abs(Number(w.realized_pnl_pct ?? 0)), 0);
  const grossLoss = losses.reduce((s, l) => s + Math.abs(Number(l.realized_pnl_pct ?? 0)), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 999 : 0);

  // 연속 승/패
  let maxConsWins = 0, maxConsLosses = 0;
  let curWins = 0, curLosses = 0;
  for (const s of scores) {
    if (s.outcome === 'WIN') {
      curWins++; curLosses = 0;
      if (curWins > maxConsWins) maxConsWins = curWins;
    } else if (s.outcome === 'LOSS') {
      curLosses++; curWins = 0;
      if (curLosses > maxConsLosses) maxConsLosses = curLosses;
    } else {
      curWins = 0; curLosses = 0;
    }
  }

  // 수익일 비율
  const profitDays = dailyPnls.filter(p => p > 0).length;
  const profitDaysRate = tradingDays > 0 ? (profitDays / tradingDays) * 100 : 0;

  const recoveryFactor = maxDd > 0 ? cumulativePct / maxDd : 0;

  // ── Goal (이번 달 진행도) ──
  const kstNow = getKSTNow();
  const year = kstNow.getUTCFullYear();
  const month = kstNow.getUTCMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const currentDay = kstNow.getUTCDate();
  const daysRemaining = daysInMonth - currentDay;

  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const thisMonthSnaps = snapshots.filter(s => s.date.startsWith(monthPrefix));

  let currentMonthPct = 0;
  if (thisMonthSnaps.length >= 2) {
    const mFirst = Number(thisMonthSnaps[0].total_value);
    const mLast = Number(thisMonthSnaps[thisMonthSnaps.length - 1].total_value);
    currentMonthPct = mFirst > 0 ? ((mLast / mFirst) - 1) * 100 : 0;
  }

  const elapsed = Math.max(1, thisMonthSnaps.length);
  const tradingDaysInMonth = Math.round(daysInMonth * 5 / 7);
  const projectedMonthlyPct = tradingDaysInMonth > 0
    ? (currentMonthPct / elapsed) * tradingDaysInMonth
    : 0;

  // ── Grade ──
  const grade = computeGrade(sharpeRatio, winRate, maxDd);

  const startDate = tradingDays > 0 ? snapshots[0].date : '';
  const endDate = tradingDays > 0 ? snapshots[tradingDays - 1].date : '';

  return {
    period: { startDate, endDate, tradingDays },
    returns: {
      cumulativePct: r2(cumulativePct),
      monthlyAvgPct: r2(monthlyAvgPct),
      dailyAvgPct: r2(dailyAvgPct),
      bestDayPct: r2(bestDayPct),
      worstDayPct: r2(worstDayPct),
      totalPnlKrw: Math.round(totalPnlKrw),
      initialCapital: Math.round(firstValue),
    },
    risk: {
      maxDrawdownPct: r2(maxDd),
      maxDrawdownDays: maxDdDays,
      currentDrawdownPct: r2(currentDd),
      volatilityDaily: r2(volatilityDaily),
      volatilityAnnual: r2(volatilityAnnual),
    },
    efficiency: {
      sharpeRatio: r2(sharpeRatio),
      sortinoRatio: r2(sortinoRatio),
      calmarRatio: r2(calmarRatio),
      profitFactor: r2(profitFactor),
      payoffRatio: r2(payoffRatio),
    },
    consistency: {
      winRate: r2(winRate),
      profitDaysRate: r2(profitDaysRate),
      maxConsecutiveWins: maxConsWins,
      maxConsecutiveLosses: maxConsLosses,
      recoveryFactor: r2(recoveryFactor),
    },
    goal: {
      monthlyTargetPct: monthlyTarget,
      currentMonthPct: r2(currentMonthPct),
      onTrack: projectedMonthlyPct >= monthlyTarget,
      projectedMonthlyPct: r2(projectedMonthlyPct),
      daysRemaining,
    },
    grade,
    mode: isPaper ? 'paper' : 'live',
  };
}

// ── Helpers ──

function computeGrade(sharpe: number, winRate: number, mdd: number): string {
  if (sharpe < 0 || mdd > 20) return 'D';
  if (sharpe >= 2.0 && winRate >= 60 && mdd < 5) return 'A+';
  if (sharpe >= 1.5 && winRate >= 55 && mdd < 8) return 'A';
  if (sharpe >= 1.0 && winRate >= 50 && mdd < 12) return 'B+';
  if (sharpe >= 0.5 && winRate >= 45 && mdd < 15) return 'B';
  return 'C';
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}
