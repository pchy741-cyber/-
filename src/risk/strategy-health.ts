/**
 * 📊 전략 종합 성과 평가 (Strategy Health) — v25 전면 개편
 *
 * v25 변경점:
 *   P0-1: TWR (Time-Weighted Return) — 입출금 오염 제거, 종가 기준 스냅샷
 *   P0-2: CAGR 기하 연환산, Sortino TDD (전체 N 분모), Calmar CAGR 기반
 *   P0-3: PSR + MinTRL — 샤프 유의성 검정, 등급 게이트
 *   P1-1: 벤치마크 대비 평가 (alpha/beta/IR) — benchmark_prices 데이터 존재 시
 *   P1-3: 목표 추적 — 장기 궤도 1σ 밴드, 현실성 검증
 *   P2: maxUnderwaterDays, EXPLORE 등급 미부여, Recovery Factor TWR 기반
 *
 * 레퍼런스:
 *   empyrical (quantopian/empyrical stats.py)
 *   PSR: Bailey & López de Prado, 2012
 *   Sortino TDD: Red Rock Capital
 *   TWR/GIPS: GIPS Guidance Statement on Calculation Methodology
 */

import { getPool } from '../db/client.js';
import { getKSTNow } from '../utils/time.js';
import { normalCdf, sampleSkewness, sampleKurtosis, computePSR, computeMinTRL } from './statistics.js';

// ── Types ──

interface SnapshotRow {
  date: string;
  total_value: string;
  daily_pnl: string;
}

interface CashFlowRow {
  date: string;
  net_flow: string;
}

interface ScoreRow {
  outcome: string;
  realized_pnl_pct: string;
}

interface BenchmarkRow {
  date: string;
  close_price: string;
}

export interface StrategyHealthResult {
  period: { startDate: string; endDate: string; tradingDays: number };
  returns: {
    cumulativePct: number;      // TWR 누적 수익률
    cagr: number;               // v25: 기하 연환산 (CAGR)
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
    maxUnderwaterDays: number;   // v25: 고점→회복까지 기간 (-1 = 미회복)
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
    psr: number;                 // v25: Probabilistic Sharpe Ratio
    minTRL: number;              // v25: 유의 판정 최소 관측일
    psrSignificant: boolean;     // v25: PSR ≥ 0.95 여부
  };
  consistency: {
    winRate: number;
    profitDaysRate: number;
    maxConsecutiveWins: number;
    maxConsecutiveLosses: number;
    recoveryFactor: number;
  };
  benchmark: {                   // v25 P1-1
    alpha: number;               // CAPM 초과수익 (연율)
    beta: number;
    informationRatio: number;
    trackingError: number;
    benchmarkCagr: number;
    available: boolean;          // 벤치마크 데이터 유무
  };
  goal: {
    monthlyTargetPct: number;
    currentMonthPct: number;
    onTrack: boolean;            // 단순 외삽 기준
    onTrackLongTerm: 'ON_TRACK' | 'NEUTRAL' | 'OFF_TRACK'; // v25: 1σ 밴드
    projectedMonthlyPct: number;
    daysRemaining: number;
    requiredSharpe: number;      // v25: 목표 달성 필요 샤프
    goalRealistic: boolean;      // v25: 필요샤프 ≤ 3.0
  };
  grade: string;
  mode: string;
}

/** 무위험 수익률 (한국 국채 기준 ~3.5%) */
const RF_ANNUAL_PCT = 3.5;
const RF_ANNUAL = RF_ANNUAL_PCT / 100;
const RF_DAILY = (1 + RF_ANNUAL) ** (1 / 252) - 1;

// ── Main ──

export async function computeStrategyHealth(
  isPaper: boolean,
  days = 90,
  monthlyTarget = 5.0,
): Promise<StrategyHealthResult> {
  const pool = getPool();

  // 4개 쿼리 병렬: 스냅샷(종가), 캐시플로우, 거래기록, 벤치마크
  const [
    { rows: snapshots },
    { rows: cashFlows },
    { rows: scores },
    { rows: benchmarkRows },
  ] = await Promise.all([
    // v25 P0-1: DISTINCT ON → 일 마지막 스냅샷 (종가 기준)
    pool.query<SnapshotRow>(
      `SELECT DISTINCT ON ((snapshot_at AT TIME ZONE 'Asia/Seoul')::date)
         (snapshot_at AT TIME ZONE 'Asia/Seoul')::date AS date,
         total_value,
         daily_pnl
       FROM portfolio_snapshots
       WHERE is_paper = $1
         AND snapshot_at >= NOW() - ($2 || ' days')::INTERVAL
       ORDER BY (snapshot_at AT TIME ZONE 'Asia/Seoul')::date, snapshot_at DESC`,
      [isPaper, days],
    ),
    // v25 P0-1: 일별 순 캐시플로우 합산
    pool.query<CashFlowRow>(
      `SELECT (flow_at AT TIME ZONE 'Asia/Seoul')::date AS date,
              SUM(amount_krw) AS net_flow
       FROM cash_flows
       WHERE is_paper = $1
         AND flow_at >= NOW() - ($2 || ' days')::INTERVAL
       GROUP BY 1`,
      [isPaper, days],
    ).catch(() => ({ rows: [] as CashFlowRow[] })),
    // v23: EXPLORE 프로파일 제외
    pool.query<ScoreRow>(
      `SELECT outcome, realized_pnl_pct
       FROM score_accuracy
       WHERE is_paper = $1
         AND recorded_at >= NOW() - ($2 || ' days')::INTERVAL
         AND COALESCE(trading_profile, 'LIVE') != 'EXPLORE'
       ORDER BY recorded_at ASC`,
      [isPaper, days],
    ),
    // v25 P1-1: 벤치마크 (SPY 기본, 없으면 빈 배열)
    pool.query<BenchmarkRow>(
      `SELECT price_date::text AS date, close_price
       FROM benchmark_prices
       WHERE symbol = 'SPY'
         AND price_date >= (NOW() - ($1 || ' days')::INTERVAL)::date
       ORDER BY price_date ASC`,
      [days],
    ).catch(() => ({ rows: [] as BenchmarkRow[] })),
  ]);

  const tradingDays = snapshots.length;

  // ── 캐시플로우 맵 ──
  const flowMap = new Map<string, number>();
  for (const cf of cashFlows) {
    flowMap.set(cf.date, Number(cf.net_flow));
  }

  // ── Returns: TWR 일별 수익률 ──
  const firstValue = tradingDays > 0 ? Number(snapshots[0].total_value) : 0;
  const lastValue = tradingDays > 0 ? Number(snapshots[tradingDays - 1].total_value) : 0;

  const dailyReturns: number[] = []; // 소수 비율 (0.01 = 1%)
  for (let i = 1; i < snapshots.length; i++) {
    const vPrev = Number(snapshots[i - 1].total_value);
    const vCur = Number(snapshots[i].total_value);
    const flow = flowMap.get(snapshots[i].date) ?? 0;
    const denom = vPrev + flow; // start-of-day convention
    if (denom > 0) {
      dailyReturns.push((vCur - vPrev - flow) / denom);
    }
  }

  // TWR 누적 수익률
  let cumTWR = 1;
  for (const r of dailyReturns) cumTWR *= 1 + r;
  const cumulativePct = (cumTWR - 1) * 100;

  // v25 P0-2: CAGR (기하 연환산)
  const cagr =
    dailyReturns.length > 0
      ? (cumTWR ** (252 / dailyReturns.length) - 1) * 100
      : 0;

  const dailyReturnsPct = dailyReturns.map((r) => r * 100);
  const dailyAvgPct =
    dailyReturnsPct.length > 0
      ? dailyReturnsPct.reduce((s, v) => s + v, 0) / dailyReturnsPct.length
      : 0;
  const months = Math.max(1, tradingDays / 21);
  const monthlyAvgPct = cumulativePct / months;

  const dailyPnls = snapshots.map((r) => Number(r.daily_pnl ?? 0));
  const totalPnlKrw = dailyPnls.reduce((s, v) => s + v, 0);

  let bestDayPct = 0;
  let worstDayPct = 0;
  for (const r of dailyReturnsPct) {
    if (r > bestDayPct) bestDayPct = r;
    if (r < worstDayPct) worstDayPct = r;
  }

  // ── Risk: MDD + Underwater Duration (종가 기반, 캐시플로우 보정) ──
  let peak = 0;
  let maxDd = 0;
  let maxDdDays = 0;
  let peakIdx = 0;
  let currentDd = 0;
  let maxUnderwaterDays = 0;
  let underwaterStart = -1;

  // TWR 에퀴티 커브 (flow 제거 후 순수 성과)
  const equityCurve: number[] = [1];
  for (const r of dailyReturns) {
    equityCurve.push(equityCurve[equityCurve.length - 1] * (1 + r));
  }

  for (let i = 0; i < equityCurve.length; i++) {
    const val = equityCurve[i];
    if (val >= peak) {
      peak = val;
      peakIdx = i;
      // 회복 → underwater 기간 계산
      if (underwaterStart >= 0) {
        const uwDays = i - underwaterStart;
        if (uwDays > maxUnderwaterDays) maxUnderwaterDays = uwDays;
        underwaterStart = -1;
      }
    } else if (underwaterStart < 0) {
      underwaterStart = peakIdx;
    }
    const dd = peak > 0 ? ((peak - val) / peak) * 100 : 0;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdDays = i - peakIdx;
    }
    currentDd = dd;
  }
  // 미회복 상태
  if (underwaterStart >= 0) {
    const uwDays = equityCurve.length - 1 - underwaterStart;
    if (uwDays > maxUnderwaterDays) maxUnderwaterDays = uwDays;
    maxUnderwaterDays = -maxUnderwaterDays; // 음수 = 미회복 진행 중
  }

  // ── Volatility (일별 수익률 기반, N-1 분모) ──
  const mean = dailyReturns.length > 0 ? dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length : 0;
  const variance =
    dailyReturns.length > 1
      ? dailyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyReturns.length - 1)
      : 0;
  const volatilityDaily = Math.sqrt(variance) * 100;
  const volatilityAnnual = volatilityDaily * Math.sqrt(252);

  // ── v25 P0-2: Sortino — Target Downside Deviation (Red Rock / empyrical) ──
  // MAR = 일별 무위험수익률, 분모 = 전체 N (음수 개수 아님!)
  const downsideSquaredSum = dailyReturns.reduce((s, r) => {
    const downside = Math.min(0, r - RF_DAILY);
    return s + downside * downside;
  }, 0);
  const tdd = dailyReturns.length > 0 ? Math.sqrt(downsideSquaredSum / dailyReturns.length) : 0;
  const tddAnnual = tdd * Math.sqrt(252) * 100;

  // ── Efficiency ──
  const cagrDecimal = cagr / 100;
  const sharpeRatio =
    volatilityAnnual > 0 ? (cagr - RF_ANNUAL_PCT) / volatilityAnnual : 0;
  const sortinoRatio =
    tddAnnual > 0 ? (cagr - RF_ANNUAL_PCT) / tddAnnual : 0;
  const calmarRatio = maxDd > 0 ? cagr / maxDd : 0;

  // ── v25 P0-3: PSR + MinTRL ──
  // 비연환산 일별 샤프 (PSR 입력)
  const dailySR =
    dailyReturns.length > 1 && Math.sqrt(variance) > 0
      ? mean / Math.sqrt(variance)
      : 0;
  const skew = sampleSkewness(dailyReturns);
  const kurt = sampleKurtosis(dailyReturns);
  const n = dailyReturns.length;
  const psr = computePSR(dailySR, 0, n, skew, kurt);
  const minTRL = computeMinTRL(dailySR, 0, skew, kurt);
  const psrSignificant = psr >= 0.95;

  // ── Consistency (score_accuracy 기반) ──
  const wins = scores.filter((s) => s.outcome === 'WIN');
  const losses = scores.filter((s) => s.outcome === 'LOSS');
  const totalTrades = scores.length;
  const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;

  const grossProfit = wins.reduce((s, w) => s + Math.abs(Number(w.realized_pnl_pct ?? 0)), 0);
  const grossLoss = losses.reduce((s, l) => s + Math.abs(Number(l.realized_pnl_pct ?? 0)), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? 999 : 0;

  // 연속 승/패
  let maxConsWins = 0,
    maxConsLosses = 0;
  let curWins = 0,
    curLosses = 0;
  for (const s of scores) {
    if (s.outcome === 'WIN') {
      curWins++;
      curLosses = 0;
      if (curWins > maxConsWins) maxConsWins = curWins;
    } else if (s.outcome === 'LOSS') {
      curLosses++;
      curWins = 0;
      if (curLosses > maxConsLosses) maxConsLosses = curLosses;
    } else {
      curWins = 0;
      curLosses = 0;
    }
  }

  // 수익일 비율
  const profitDays = dailyPnls.filter((p) => p > 0).length;
  const profitDaysRate = tradingDays > 0 ? (profitDays / tradingDays) * 100 : 0;

  // v25 P2: Recovery Factor — TWR 누적 / MDD
  const recoveryFactor = maxDd > 0 ? cumulativePct / maxDd : 0;

  // ── v25 P1-1: 벤치마크 ──
  const benchmark = computeBenchmark(dailyReturns, snapshots, benchmarkRows, days);

  // ── Goal (이번 달 + 장기 궤도) ──
  const kstNow = getKSTNow();
  const year = kstNow.getUTCFullYear();
  const month = kstNow.getUTCMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const currentDay = kstNow.getUTCDate();
  const daysRemaining = daysInMonth - currentDay;

  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const thisMonthSnaps = snapshots.filter((s) => s.date.startsWith(monthPrefix));

  let currentMonthPct = 0;
  if (thisMonthSnaps.length >= 2) {
    const mFirst = Number(thisMonthSnaps[0].total_value);
    const mLast = Number(thisMonthSnaps[thisMonthSnaps.length - 1].total_value);
    currentMonthPct = mFirst > 0 ? ((mLast / mFirst) - 1) * 100 : 0;
  }

  const elapsed = Math.max(1, thisMonthSnaps.length);
  const tradingDaysInMonth = Math.round(daysInMonth * 5 / 7);
  const projectedMonthlyPct =
    tradingDaysInMonth > 0 ? (currentMonthPct / elapsed) * tradingDaysInMonth : 0;

  // v25 P1-3: 장기 궤도 판정
  const goalAnnual = (1 + monthlyTarget / 100) ** 12 - 1; // 월 5% = 연 79.6%
  const goalDaily = (1 + goalAnnual) ** (1 / 252) - 1;
  const sigmaDaily = dailyReturns.length > 0 ? Math.sqrt(variance) : 0;

  let onTrackLongTerm: 'ON_TRACK' | 'NEUTRAL' | 'OFF_TRACK' = 'NEUTRAL';
  if (dailyReturns.length >= 10 && sigmaDaily > 0) {
    const expectedCum = (1 + goalDaily) ** dailyReturns.length - 1;
    const oneSigmaBand = sigmaDaily * Math.sqrt(dailyReturns.length);
    const actualCum = cumTWR - 1;
    if (actualCum >= expectedCum - oneSigmaBand) onTrackLongTerm = 'ON_TRACK';
    else onTrackLongTerm = 'OFF_TRACK';
    if (actualCum >= expectedCum - oneSigmaBand && actualCum < expectedCum + oneSigmaBand) {
      onTrackLongTerm = 'NEUTRAL';
    }
    // 더 정밀한 판정: 밴드 아래 = OFF, 밴드 내 = NEUTRAL, 밴드 위 = ON
    if (actualCum < expectedCum - oneSigmaBand) onTrackLongTerm = 'OFF_TRACK';
    else if (actualCum > expectedCum + oneSigmaBand) onTrackLongTerm = 'ON_TRACK';
    else onTrackLongTerm = 'NEUTRAL';
  }

  // v25 P1-3: 필요 샤프 & 현실성 검증
  const requiredSharpe =
    volatilityAnnual > 0 ? (goalAnnual * 100 - RF_ANNUAL_PCT) / volatilityAnnual : 0;
  const goalRealistic = requiredSharpe <= 3.0;

  // ── Grade (v25: PSR 게이트) ──
  // v25 P2: EXPLORE 프로파일은 등급 미부여
  const isExplore = isPaper; // Paper 모드에서 EXPLORE 가능
  const grade = computeGrade(sharpeRatio, winRate, maxDd, psr, isExplore);

  const startDate = tradingDays > 0 ? snapshots[0].date : '';
  const endDate = tradingDays > 0 ? snapshots[tradingDays - 1].date : '';

  return {
    period: { startDate, endDate, tradingDays },
    returns: {
      cumulativePct: r2(cumulativePct),
      cagr: r2(cagr),
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
      maxUnderwaterDays,
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
      psr: r4(psr),
      minTRL: Number.isFinite(minTRL) ? minTRL : 9999,
      psrSignificant,
    },
    consistency: {
      winRate: r2(winRate),
      profitDaysRate: r2(profitDaysRate),
      maxConsecutiveWins: maxConsWins,
      maxConsecutiveLosses: maxConsLosses,
      recoveryFactor: r2(recoveryFactor),
    },
    benchmark,
    goal: {
      monthlyTargetPct: monthlyTarget,
      currentMonthPct: r2(currentMonthPct),
      onTrack: projectedMonthlyPct >= monthlyTarget,
      onTrackLongTerm,
      projectedMonthlyPct: r2(projectedMonthlyPct),
      daysRemaining,
      requiredSharpe: r2(requiredSharpe),
      goalRealistic,
    },
    grade,
    mode: isPaper ? 'paper' : 'live',
  };
}

// ── Benchmark ──

function computeBenchmark(
  portfolioReturns: number[],
  _snapshots: SnapshotRow[],
  benchmarkRows: BenchmarkRow[],
  _days: number,
): StrategyHealthResult['benchmark'] {
  const empty: StrategyHealthResult['benchmark'] = {
    alpha: 0, beta: 0, informationRatio: 0, trackingError: 0, benchmarkCagr: 0, available: false,
  };

  if (benchmarkRows.length < 10 || portfolioReturns.length < 10) return empty;

  // 벤치마크 일별 수익률
  const bmReturns: number[] = [];
  for (let i = 1; i < benchmarkRows.length; i++) {
    const prev = Number(benchmarkRows[i - 1].close_price);
    const cur = Number(benchmarkRows[i].close_price);
    if (prev > 0) bmReturns.push(cur / prev - 1);
  }

  // 포트폴리오/벤치마크 길이 맞춤 (짧은 쪽 기준)
  const len = Math.min(portfolioReturns.length, bmReturns.length);
  if (len < 10) return empty;
  const pRets = portfolioReturns.slice(-len);
  const bRets = bmReturns.slice(-len);

  // Beta = Cov(r_p, r_b) / Var(r_b)
  const pMean = pRets.reduce((s, v) => s + v, 0) / len;
  const bMean = bRets.reduce((s, v) => s + v, 0) / len;
  let cov = 0, varB = 0;
  for (let i = 0; i < len; i++) {
    cov += (pRets[i] - pMean) * (bRets[i] - bMean);
    varB += (bRets[i] - bMean) ** 2;
  }
  cov /= len - 1;
  varB /= len - 1;

  const beta = varB > 0 ? cov / varB : 0;

  // CAGR (포트폴리오 + 벤치마크)
  let cumP = 1, cumB = 1;
  for (let i = 0; i < len; i++) {
    cumP *= 1 + pRets[i];
    cumB *= 1 + bRets[i];
  }
  const cagrP = (cumP ** (252 / len) - 1) * 100;
  const cagrB = (cumB ** (252 / len) - 1) * 100;

  // Alpha (CAPM)
  const alpha = cagrP - (RF_ANNUAL_PCT + beta * (cagrB - RF_ANNUAL_PCT));

  // Tracking Error + IR
  const activeReturns = pRets.map((p, i) => p - bRets[i]);
  const arMean = activeReturns.reduce((s, v) => s + v, 0) / len;
  const arVar = activeReturns.reduce((s, v) => s + (v - arMean) ** 2, 0) / (len - 1);
  const trackingError = Math.sqrt(arVar) * Math.sqrt(252) * 100;
  const ir = trackingError > 0 ? (cagrP - cagrB) / trackingError : 0;

  return {
    alpha: r2(alpha),
    beta: r2(beta),
    informationRatio: r2(ir),
    trackingError: r2(trackingError),
    benchmarkCagr: r2(cagrB),
    available: true,
  };
}

// ── Grade ──

function computeGrade(
  sharpe: number,
  winRate: number,
  mdd: number,
  psr: number,
  _isPaper: boolean,
): string {
  if (sharpe < 0 || mdd > 20) return 'D';

  // v25 P0-3: PSR < 0.95 → A+/A 등급 부여 금지 (최대 B+, * 병기)
  const psrGate = psr >= 0.95;
  let grade: string;

  if (sharpe >= 2.0 && winRate >= 60 && mdd < 5) grade = 'A+';
  else if (sharpe >= 1.5 && winRate >= 55 && mdd < 8) grade = 'A';
  else if (sharpe >= 1.0 && winRate >= 50 && mdd < 12) grade = 'B+';
  else if (sharpe >= 0.5 && winRate >= 45 && mdd < 15) grade = 'B';
  else grade = 'C';

  if (!psrGate && (grade === 'A+' || grade === 'A')) {
    grade = 'B+*'; // 통계 유의성 미달
  } else if (!psrGate && grade !== 'D' && grade !== 'C') {
    grade = grade + '*';
  }

  return grade;
}

// ── Helpers ──

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
