/**
 * 📊 전략 종합 성과 평가 (Strategy Health) — v26 거래 기반 재작성
 *
 * v26 변경점:
 *   - portfolio_snapshots(입출금 오염) → score_accuracy(거래별 정확 데이터) 기반
 *   - 국내(KR)/해외(US) 시장 분리 지원
 *   - 합성 에퀴티 커브: 일별 거래 수익률로 구축 (캐시플로우 무관)
 *   - PSR/MinTRL, 벤치마크(SPY), 목표 추적 유지
 */

import { getPool } from '../db/client.js';
import { getKSTNow } from '../utils/time.js';
import { sampleSkewness, sampleKurtosis, computePSR, computeMinTRL } from './statistics.js';

// ── Types ──

/** score_accuracy + orders 조인 결과 */
interface TradeRow {
  date: string;           // 거래 확정일 (KST date)
  outcome: string;        // WIN | LOSS | BREAK_EVEN
  realized_pnl_pct: string;
  pnl_krw: string;       // KRW 환산 실현손익
  market: string;         // KR | US
  strategy_mode: string;
}

interface BenchmarkRow {
  date: string;
  close_price: string;
}

export type MarketFilter = 'KR' | 'US' | 'ALL';

export interface StrategyHealthResult {
  period: { startDate: string; endDate: string; tradingDays: number; totalTrades: number };
  returns: {
    cumulativePct: number;
    cagr: number;
    monthlyAvgPct: number;
    dailyAvgPct: number;
    bestTradePct: number;
    worstTradePct: number;
    totalPnlKrw: number;
  };
  risk: {
    maxDrawdownPct: number;
    maxDrawdownTrades: number;
    currentDrawdownPct: number;
    volatilityTrade: number;      // 거래별 수익률 표준편차
    volatilityAnnual: number;
  };
  efficiency: {
    sharpeRatio: number;
    sortinoRatio: number;
    calmarRatio: number;
    profitFactor: number;
    payoffRatio: number;
    psr: number;
    minTRL: number;
    psrSignificant: boolean;
  };
  consistency: {
    winRate: number;
    profitDaysRate: number;
    maxConsecutiveWins: number;
    maxConsecutiveLosses: number;
    recoveryFactor: number;
  };
  benchmark: {
    alpha: number;
    beta: number;
    informationRatio: number;
    trackingError: number;
    benchmarkCagr: number;
    available: boolean;
  };
  goal: {
    monthlyTargetPct: number;
    currentMonthPct: number;
    onTrack: boolean;
    onTrackLongTerm: 'ON_TRACK' | 'NEUTRAL' | 'OFF_TRACK';
    projectedMonthlyPct: number;
    daysRemaining: number;
    requiredSharpe: number;
    goalRealistic: boolean;
  };
  grade: string;
  mode: string;
  market: MarketFilter;
}

/** 무위험 수익률 (한국 국채 기준 ~3.5%) */
const RF_ANNUAL_PCT = 3.5;
const RF_ANNUAL = RF_ANNUAL_PCT / 100;
const RF_DAILY = (1 + RF_ANNUAL) ** (1 / 252) - 1;
/** 왕복 수수료: 국내 0.21%, 해외 0.70% */
const FEE_KR = 0.21;
const FEE_US = 0.70;

// ── Main ──

export async function computeStrategyHealth(
  isPaper: boolean,
  days = 90,
  monthlyTarget = 5.0,
  market: MarketFilter = 'ALL',
): Promise<StrategyHealthResult> {
  const pool = getPool();

  // 시장 필터 SQL 조건
  const marketCond =
    market === 'ALL' ? '' : `AND sa.market = '${market === 'KR' ? 'KR' : 'US'}'`;

  // 2개 쿼리 병렬: 거래기록 + 벤치마크
  const [{ rows: trades }, { rows: benchmarkRows }] = await Promise.all([
    pool.query<TradeRow>(
      `SELECT
         (sa.recorded_at AT TIME ZONE 'Asia/Seoul')::date::text AS date,
         sa.outcome,
         sa.realized_pnl_pct,
         sa.market,
         COALESCE(sa.strategy_mode, 'UNKNOWN') AS strategy_mode,
         COALESCE(
           (SELECT tc.realized_pnl FROM transaction_chains tc WHERE tc.id = sa.chain_id),
           (SELECT o.filled_price * o.filled_quantity FROM orders o WHERE o.id = sa.order_id LIMIT 1) * sa.realized_pnl_pct / 100,
           0
         )::text AS pnl_krw
       FROM score_accuracy sa
       WHERE sa.is_paper = $1
         AND sa.recorded_at >= NOW() - ($2 || ' days')::INTERVAL
         AND ($1 = true OR COALESCE(sa.trading_profile, 'LIVE') != 'EXPLORE')
         ${marketCond}
       ORDER BY sa.recorded_at ASC`,
      [isPaper, days],
    ),
    // 벤치마크: 해외(US) 또는 ALL일 때만 SPY 조회
    market === 'KR'
      ? Promise.resolve({ rows: [] as BenchmarkRow[] })
      : pool
          .query<BenchmarkRow>(
            `SELECT price_date::text AS date, close_price
             FROM benchmark_prices
             WHERE symbol = 'SPY'
               AND price_date >= (NOW() - ($1 || ' days')::INTERVAL)::date
             ORDER BY price_date ASC`,
            [days],
          )
          .catch(() => ({ rows: [] as BenchmarkRow[] })),
  ]);

  const totalTrades = trades.length;

  // ── 거래별 수익률 (수수료 차감) ──
  const tradeReturns: number[] = []; // 소수 비율
  const tradePnlKrw: number[] = [];
  for (const t of trades) {
    const rawPct = Number(t.realized_pnl_pct ?? 0);
    const fee = t.market === 'US' ? FEE_US : FEE_KR;
    const netPct = rawPct - fee; // 수수료 차감
    tradeReturns.push(netPct / 100);
    tradePnlKrw.push(Number(t.pnl_krw ?? 0));
  }

  // ── 일별 합산 수익률 (같은 날 여러 거래 → 복리 합산) ──
  const dailyMap = new Map<string, number[]>();
  for (let i = 0; i < trades.length; i++) {
    const d = trades[i].date;
    if (!dailyMap.has(d)) dailyMap.set(d, []);
    dailyMap.get(d)!.push(tradeReturns[i]);
  }

  const sortedDates = [...dailyMap.keys()].sort();
  const dailyReturns: number[] = []; // 일별 합산 수익률 (소수)
  for (const d of sortedDates) {
    const dayTrades = dailyMap.get(d)!;
    // 같은 날 거래들을 평균 (포지션 사이징이 동일하다는 가정)
    const dayAvg = dayTrades.reduce((s, v) => s + v, 0) / dayTrades.length;
    dailyReturns.push(dayAvg);
  }
  const tradingDays = dailyReturns.length;

  // ── 에퀴티 커브 (합성) ──
  let cumReturn = 1;
  const equityCurve: number[] = [1];
  for (const r of dailyReturns) {
    cumReturn *= 1 + r;
    equityCurve.push(cumReturn);
  }
  const cumulativePct = (cumReturn - 1) * 100;

  // CAGR — 20일 미만: 선형 추정
  let cagr = 0;
  if (tradingDays >= 20) {
    cagr = (cumReturn ** (252 / tradingDays) - 1) * 100;
  } else if (tradingDays > 0) {
    const dailyMean = dailyReturns.reduce((s, v) => s + v, 0) / tradingDays;
    cagr = dailyMean * 252 * 100;
  }

  const dailyReturnsPct = dailyReturns.map((r) => r * 100);
  const dailyAvgPct =
    tradingDays > 0 ? dailyReturnsPct.reduce((s, v) => s + v, 0) / tradingDays : 0;
  const months = Math.max(1, tradingDays / 21);
  const monthlyAvgPct = cumulativePct / months;

  const totalPnlKrw = tradePnlKrw.reduce((s, v) => s + v, 0);

  // 최고/최저 거래
  let bestTradePct = 0;
  let worstTradePct = 0;
  for (const r of tradeReturns) {
    const pct = r * 100;
    if (pct > bestTradePct) bestTradePct = pct;
    if (pct < worstTradePct) worstTradePct = pct;
  }

  // ── MDD (에퀴티 커브 기반) ──
  let peak = 0;
  let maxDd = 0;
  let maxDdTrades = 0;
  let peakIdx = 0;
  let currentDd = 0;

  for (let i = 0; i < equityCurve.length; i++) {
    const val = equityCurve[i];
    if (val >= peak) {
      peak = val;
      peakIdx = i;
    }
    const dd = peak > 0 ? ((peak - val) / peak) * 100 : 0;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdTrades = i - peakIdx;
    }
    currentDd = dd;
  }

  // ── Volatility ──
  const mean =
    dailyReturns.length > 0 ? dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length : 0;
  const variance =
    dailyReturns.length > 1
      ? dailyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyReturns.length - 1)
      : 0;
  const volatilityTrade = Math.sqrt(variance) * 100;
  const volatilityAnnual = volatilityTrade * Math.sqrt(252);

  // ── Sortino (TDD) ──
  const downsideSquaredSum = dailyReturns.reduce((s, r) => {
    const downside = Math.min(0, r - RF_DAILY);
    return s + downside * downside;
  }, 0);
  const tdd = dailyReturns.length > 0 ? Math.sqrt(downsideSquaredSum / dailyReturns.length) : 0;
  const tddAnnual = tdd * Math.sqrt(252) * 100;

  // ── Efficiency ──
  const sharpeRatio = volatilityAnnual > 0 ? (cagr - RF_ANNUAL_PCT) / volatilityAnnual : 0;
  const sortinoRatio = tddAnnual > 0 ? (cagr - RF_ANNUAL_PCT) / tddAnnual : 0;
  const calmarRatio = maxDd > 0 ? cagr / maxDd : 0;

  // ── PSR + MinTRL ──
  const dailySR =
    dailyReturns.length > 1 && Math.sqrt(variance) > 0 ? mean / Math.sqrt(variance) : 0;
  const skew = sampleSkewness(dailyReturns);
  const kurt = sampleKurtosis(dailyReturns);
  const n = dailyReturns.length;
  const psr = computePSR(dailySR, 0, n, skew, kurt);
  const minTRL = computeMinTRL(dailySR, 0, skew, kurt);
  const psrSignificant = psr >= 0.95;

  // ── Consistency ──
  const wins = trades.filter((t) => t.outcome === 'WIN');
  const losses = trades.filter((t) => t.outcome === 'LOSS');
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
  for (const t of trades) {
    if (t.outcome === 'WIN') {
      curWins++;
      curLosses = 0;
      if (curWins > maxConsWins) maxConsWins = curWins;
    } else if (t.outcome === 'LOSS') {
      curLosses++;
      curWins = 0;
      if (curLosses > maxConsLosses) maxConsLosses = curLosses;
    } else {
      curWins = 0;
      curLosses = 0;
    }
  }

  // 수익일 비율 (거래가 있는 날 중 합산 수익인 날)
  let profitDaysCount = 0;
  for (const d of sortedDates) {
    const dayTrades = dailyMap.get(d)!;
    const daySum = dayTrades.reduce((s, v) => s + v, 0);
    if (daySum > 0) profitDaysCount++;
  }
  const profitDaysRate = tradingDays > 0 ? (profitDaysCount / tradingDays) * 100 : 0;

  const recoveryFactor = maxDd > 0 ? cumulativePct / maxDd : 0;

  // ── 벤치마크 (SPY) ──
  const benchmark = computeBenchmark(dailyReturns, sortedDates, benchmarkRows);

  // ── Goal (이번 달 + 장기 궤도) ──
  const kstNow = getKSTNow();
  const year = kstNow.getUTCFullYear();
  const month = kstNow.getUTCMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const currentDay = kstNow.getUTCDate();
  const daysRemaining = daysInMonth - currentDay;

  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  // 이번 달 거래들의 합산 수익률
  let currentMonthCum = 1;
  let thisMonthDays = 0;
  for (const d of sortedDates) {
    if (!d.startsWith(monthPrefix)) continue;
    thisMonthDays++;
    const dayTrades = dailyMap.get(d)!;
    const dayAvg = dayTrades.reduce((s, v) => s + v, 0) / dayTrades.length;
    currentMonthCum *= 1 + dayAvg;
  }
  const currentMonthPct = (currentMonthCum - 1) * 100;

  const returnDays = Math.max(1, thisMonthDays);
  const tradingDaysInMonth = Math.round((daysInMonth * 5) / 7);
  const projectedMonthlyPct =
    tradingDaysInMonth > 0 ? (currentMonthPct / returnDays) * tradingDaysInMonth : 0;

  // 장기 궤도 판정
  const goalAnnual = (1 + monthlyTarget / 100) ** 12 - 1;
  const goalDaily = (1 + goalAnnual) ** (1 / 252) - 1;
  const sigmaDaily = dailyReturns.length > 0 ? Math.sqrt(variance) : 0;

  let onTrackLongTerm: 'ON_TRACK' | 'NEUTRAL' | 'OFF_TRACK' = 'NEUTRAL';
  if (dailyReturns.length >= 10 && sigmaDaily > 0) {
    const expectedCum = (1 + goalDaily) ** dailyReturns.length - 1;
    const oneSigmaBand = sigmaDaily * Math.sqrt(dailyReturns.length);
    const actualCum = cumReturn - 1;
    if (actualCum < expectedCum - oneSigmaBand) onTrackLongTerm = 'OFF_TRACK';
    else if (actualCum > expectedCum + oneSigmaBand) onTrackLongTerm = 'ON_TRACK';
    else onTrackLongTerm = 'NEUTRAL';
  }

  const requiredSharpe =
    volatilityAnnual > 0 ? (goalAnnual * 100 - RF_ANNUAL_PCT) / volatilityAnnual : 0;
  const goalRealistic = requiredSharpe <= 3.0;

  // ── Grade ──
  const grade = computeGrade(sharpeRatio, winRate, maxDd, psr);

  const startDate = sortedDates.length > 0 ? sortedDates[0] : '';
  const endDate = sortedDates.length > 0 ? sortedDates[sortedDates.length - 1] : '';

  return {
    period: { startDate, endDate, tradingDays, totalTrades },
    returns: {
      cumulativePct: r2(cumulativePct),
      cagr: r2(cagr),
      monthlyAvgPct: r2(monthlyAvgPct),
      dailyAvgPct: r2(dailyAvgPct),
      bestTradePct: r2(bestTradePct),
      worstTradePct: r2(worstTradePct),
      totalPnlKrw: Math.round(totalPnlKrw),
    },
    risk: {
      maxDrawdownPct: r2(maxDd),
      maxDrawdownTrades: maxDdTrades,
      currentDrawdownPct: r2(currentDd),
      volatilityTrade: r2(volatilityTrade),
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
    market,
  };
}

// ── Benchmark ──

function computeBenchmark(
  portfolioDailyReturns: number[],
  portfolioDates: string[],
  benchmarkRows: BenchmarkRow[],
): StrategyHealthResult['benchmark'] {
  const empty: StrategyHealthResult['benchmark'] = {
    alpha: 0,
    beta: 0,
    informationRatio: 0,
    trackingError: 0,
    benchmarkCagr: 0,
    available: false,
  };

  if (benchmarkRows.length < 10 || portfolioDailyReturns.length < 10) return empty;

  // 벤치마크 일별 수익률
  const bmMap = new Map<string, number>();
  for (let i = 1; i < benchmarkRows.length; i++) {
    const prev = Number(benchmarkRows[i - 1].close_price);
    const cur = Number(benchmarkRows[i].close_price);
    if (prev > 0) bmMap.set(benchmarkRows[i].date, cur / prev - 1);
  }

  // 포트폴리오 날짜와 벤치마크 날짜 매칭
  const pRets: number[] = [];
  const bRets: number[] = [];
  for (let i = 0; i < portfolioDates.length; i++) {
    const bmRet = bmMap.get(portfolioDates[i]);
    if (bmRet !== undefined) {
      pRets.push(portfolioDailyReturns[i]);
      bRets.push(bmRet);
    }
  }

  const len = pRets.length;
  if (len < 10) return empty;

  // Beta = Cov(r_p, r_b) / Var(r_b)
  const pMean = pRets.reduce((s, v) => s + v, 0) / len;
  const bMean = bRets.reduce((s, v) => s + v, 0) / len;
  let cov = 0,
    varB = 0;
  for (let i = 0; i < len; i++) {
    cov += (pRets[i] - pMean) * (bRets[i] - bMean);
    varB += (bRets[i] - bMean) ** 2;
  }
  cov /= len - 1;
  varB /= len - 1;
  const beta = varB > 0 ? cov / varB : 0;

  // CAGR
  let cumP = 1,
    cumB = 1;
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

function computeGrade(sharpe: number, winRate: number, mdd: number, psr: number): string {
  if (sharpe < 0 || mdd > 20) return 'D';

  const psrGate = psr >= 0.95;
  let grade: string;

  if (sharpe >= 2.0 && winRate >= 60 && mdd < 5) grade = 'A+';
  else if (sharpe >= 1.5 && winRate >= 55 && mdd < 8) grade = 'A';
  else if (sharpe >= 1.0 && winRate >= 50 && mdd < 12) grade = 'B+';
  else if (sharpe >= 0.5 && winRate >= 45 && mdd < 15) grade = 'B';
  else grade = 'C';

  if (!psrGate && (grade === 'A+' || grade === 'A')) {
    grade = 'B+*';
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
