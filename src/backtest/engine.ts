import { analyzeTechnicals, type OHLCV } from '../analysis/indicators.js';
import { STRATEGY_PARAMS, type StrategyMode } from '../config/constants.js';
import { calcAvgPrice, calcPnlPct, roundKrw } from '../utils/money.js';

/**
 * 📈 백테스팅 엔진
 *
 * 과거 차트 데이터로 CEO 전략(3분할 매수, 물타기, 익절/손절)을 시뮬레이션
 * → 전략 변경 전 "이 설정이면 과거에 얼마를 벌었을까?" 검증
 *
 * 사용법:
 *   const result = runBacktest(chartData, 'SWING', 1000000);
 *   // → { totalReturn: 15.3%, winRate: 68%, sharpe: 1.42, ... }
 */

export interface BacktestConfig {
  mode: StrategyMode;
  initialCapital: number;
  maxPositionPct?: number; // 종목당 최대 비중 (%)
  buyThreshold?: number; // 기술 점수 진입 기준
  commissionPct?: number; // 증권사 수수료 (매수+매도 각각, 기본 0.015%)
  taxPct?: number; // 증권거래세 (매도 시에만, 기본 0.20%)
}

// ── 거래 비용 계산 ──
// 매수: 수수료만 (commissionPct)
// 매도: 수수료 + 증권거래세 (commissionPct + taxPct)
function calcBuyCost(amount: number, commissionPct: number): number {
  return roundKrw(amount * (commissionPct / 100));
}
function calcSellCost(amount: number, commissionPct: number, taxPct: number): number {
  return roundKrw(amount * ((commissionPct + taxPct) / 100));
}

interface SimPosition {
  stockCode: string;
  entries: Array<{ price: number; quantity: number; date: string }>;
  avgPrice: number;
  totalQty: number;
  totalInvested: number;
  averagingCount: number;
  openedAt: string;
}

interface SimTrade {
  stockCode: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  date: string;
  reason: string;
  pnl: number;
  pnlPct: number;
}

export interface BacktestResult {
  // 성과 지표
  totalReturnPct: number;
  totalReturnKrw: number;
  annualizedReturn: number;
  maxDrawdownPct: number;
  sharpeRatio: number;

  // 매매 통계
  totalTrades: number;
  winRate: number;
  wins: number;
  losses: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number; // 총 수익 / 총 손실
  avgHoldingDays: number;

  // 상세
  trades: SimTrade[];
  dailyPnl: Array<{ date: string; equity: number; drawdown: number }>;
  finalCapital: number;
}

/**
 * 단일 종목 백테스트 실행
 */
export function runBacktest(candles: OHLCV[], stockCode: string, backtestConfig: BacktestConfig): BacktestResult {
  const { mode, initialCapital, buyThreshold, commissionPct = 0.015, taxPct = 0.20 } = backtestConfig;
  const params = STRATEGY_PARAMS[mode];
  let totalCommissions = 0; // 총 거래비용 추적
  // 백테스트 기술 점수 임계치 (AI 스코어 75점과 다름)
  // 기술 지표 종합 점수는 -100~+100 범위이므로 모드별 임계치를 분리해 과매매를 줄입니다.
  const defaultThresholdByMode: Record<StrategyMode, number> = {
    SWING: 15,
    DEFENSE: 24,
    SCALPING: 35,
  };
  const threshold = buyThreshold ?? defaultThresholdByMode[mode];
  const isForceEntryMode = buyThreshold !== undefined && buyThreshold <= -50;

  // 시간순 정렬 (오래된 것부터)
  const sorted = [...candles].sort((a, b) => a.date.localeCompare(b.date));

  let capital = initialCapital;
  let position: SimPosition | null = null;
  const trades: SimTrade[] = [];
  const dailyPnl: Array<{ date: string; equity: number; drawdown: number }> = [];
  let peakEquity = initialCapital;

  for (let i = 60; i < sorted.length; i++) {
    const window = sorted.slice(Math.max(0, i - 59), i + 1).reverse(); // 최신이 [0]
    const today = sorted[i];
    const technicals = analyzeTechnicals(window);

    if (!technicals) continue;

    const currentEquity = capital + (position ? position.totalQty * today.close : 0);
    peakEquity = Math.max(peakEquity, currentEquity);
    const drawdown = peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0;

    dailyPnl.push({ date: today.date, equity: currentEquity, drawdown });

    // ── 포지션이 있을 때: 단계별 익절 + ATR 트레일링 스톱 + 시간손절 ──
    if (position) {
      const pnlPct = calcPnlPct(position.avgPrice, today.close);
      const holdingDays = countDaysBetween(position.openedAt, today.date);

      // ATR 기반 트레일링 스톱 (논문 근거: 고정 손절보다 승률 15~20% 개선)
      const windowForATR = sorted.slice(Math.max(0, i - 14), i + 1).reverse();
      let atrStop = Math.abs(params.stopLossPct);
      if (windowForATR.length >= 2) {
        const trueRanges = windowForATR
          .slice(0, -1)
          .map((c, idx) =>
            Math.max(
              c.high - c.low,
              Math.abs(c.high - windowForATR[idx + 1].close),
              Math.abs(c.low - windowForATR[idx + 1].close),
            ),
          );
        const avgTR = trueRanges.reduce((s, t) => s + t, 0) / trueRanges.length;
        const atrPct = position.avgPrice > 0 ? ((avgTR * 2) / position.avgPrice) * 100 : atrStop;
        atrStop = Math.max(2, Math.min(atrPct, 8)); // 최소 2%, 최대 8%
      }
      if (mode === 'DEFENSE') {
        // 방어 모드는 손절을 더 타이트하게 운영해 급락장 노출을 줄입니다.
        atrStop = Math.max(1.5, Math.min(atrStop * 0.85, 5));
      }

      // 방어 모드 조기 청산: 추세 훼손 시 손실/무수익 포지션을 빠르게 종료
      if (
        mode === 'DEFENSE' &&
        (technicals.overallSignal === 'STRONG_SELL' ||
          technicals.deathCross ||
          (technicals.overallSignal === 'SELL' && technicals.trendStrength === 'WEAK')) &&
        pnlPct <= 0.3
      ) {
        const sellAmount = today.close * position.totalQty;
        const sellCost = calcSellCost(sellAmount, commissionPct, taxPct);
        totalCommissions += sellCost;
        const pnl = roundKrw((today.close - position.avgPrice) * position.totalQty - sellCost);
        capital += sellAmount - sellCost;
        trades.push({
          stockCode,
          side: 'SELL',
          price: today.close,
          quantity: position.totalQty,
          date: today.date,
          reason: `방어모드 약세 청산 ${pnlPct.toFixed(1)}%`,
          pnl,
          pnlPct,
        });
        position = null;
        continue;
      }

      // SWING 조기 이탈: 횡보/약세 전환 구간의 작은 손실을 빠르게 차단
      if (
        mode === 'SWING' &&
        holdingDays >= 2 &&
        technicals.trendStrength === 'WEAK' &&
        (technicals.overallSignal === 'SELL' || technicals.overallSignal === 'STRONG_SELL') &&
        pnlPct <= -0.7
      ) {
        const sellAmount2 = today.close * position.totalQty;
        const sellCost2 = calcSellCost(sellAmount2, commissionPct, taxPct);
        totalCommissions += sellCost2;
        const pnl = roundKrw((today.close - position.avgPrice) * position.totalQty - sellCost2);
        capital += sellAmount2 - sellCost2;
        trades.push({
          stockCode,
          side: 'SELL',
          price: today.close,
          quantity: position.totalQty,
          date: today.date,
          reason: `스윙 횡보 이탈 ${pnlPct.toFixed(1)}%`,
          pnl,
          pnlPct,
        });
        position = null;
        continue;
      }

      // 단계별 익절 (연구 기반: 한 번에 전량 익절보다 단계별이 총수익 20~30% 높음)
      // 1단계: +3%에 1/3 매도
      if (pnlPct >= 3 && position.totalQty > 1) {
        const sellQty = Math.max(1, Math.ceil(position.totalQty / 3));
        const sa1 = today.close * sellQty;
        const sc1 = calcSellCost(sa1, commissionPct, taxPct);
        totalCommissions += sc1;
        const pnl = roundKrw((today.close - position.avgPrice) * sellQty - sc1);
        capital += sa1 - sc1;
        trades.push({
          stockCode,
          side: 'SELL',
          price: today.close,
          quantity: sellQty,
          date: today.date,
          reason: `1단계 익절 +${pnlPct.toFixed(1)}%`,
          pnl,
          pnlPct,
        });
        position.totalQty -= sellQty;
        if (position.totalQty <= 0) {
          position = null;
          continue;
        }
      }

      // 2단계: +6%에 1/2 매도 (원래 포지션의 1/3)
      if (pnlPct >= 6 && position.totalQty > 1) {
        const sellQty = Math.max(1, Math.ceil(position.totalQty / 2));
        const sa2 = today.close * sellQty;
        const sc2 = calcSellCost(sa2, commissionPct, taxPct);
        totalCommissions += sc2;
        const pnl = roundKrw((today.close - position.avgPrice) * sellQty - sc2);
        capital += sa2 - sc2;
        trades.push({
          stockCode,
          side: 'SELL',
          price: today.close,
          quantity: sellQty,
          date: today.date,
          reason: `2단계 익절 +${pnlPct.toFixed(1)}%`,
          pnl,
          pnlPct,
        });
        position.totalQty -= sellQty;
        if (position.totalQty <= 0) {
          position = null;
          continue;
        }
      }

      // 3단계: +10% 이상이면 나머지 전량 (트레일링으로 더 가도 됨)
      if (pnlPct >= 10) {
        const sa3 = today.close * position.totalQty;
        const sc3 = calcSellCost(sa3, commissionPct, taxPct);
        totalCommissions += sc3;
        const pnl = roundKrw((today.close - position.avgPrice) * position.totalQty - sc3);
        capital += sa3 - sc3;
        trades.push({
          stockCode,
          side: 'SELL',
          price: today.close,
          quantity: position.totalQty,
          date: today.date,
          reason: `전량 익절 +${pnlPct.toFixed(1)}%`,
          pnl,
          pnlPct,
        });
        position = null;
        continue;
      }

      // ATR 트레일링 손절 (고정 -5% 대신 변동성 기반)
      if (pnlPct <= -atrStop) {
        const saATR = today.close * position.totalQty;
        const scATR = calcSellCost(saATR, commissionPct, taxPct);
        totalCommissions += scATR;
        const pnl = roundKrw((today.close - position.avgPrice) * position.totalQty - scATR);
        capital += saATR - scATR;

        trades.push({
          stockCode,
          side: 'SELL',
          price: today.close,
          quantity: position.totalQty,
          date: today.date,
          reason: `ATR손절 ${pnlPct.toFixed(1)}% (한도 -${atrStop.toFixed(1)}%)`,
          pnl,
          pnlPct,
        });
        position = null;
        continue;
      }

      // 시간 손절 (변경: 수익 0% 이하일 때만, 소폭이라도 수익이면 유지)
      if (params.maxHoldingDays > 0 && holdingDays >= params.maxHoldingDays && pnlPct <= 0) {
        const saTime = today.close * position.totalQty;
        const scTime = calcSellCost(saTime, commissionPct, taxPct);
        totalCommissions += scTime;
        const pnl = roundKrw((today.close - position.avgPrice) * position.totalQty - scTime);
        capital += saTime - scTime;

        trades.push({
          stockCode,
          side: 'SELL',
          price: today.close,
          quantity: position.totalQty,
          date: today.date,
          reason: `시간손절 ${holdingDays}일`,
          pnl,
          pnlPct,
        });
        position = null;
        continue;
      }

      // 물타기
      if (
        params.maxAveragingCount > 0 &&
        position.averagingCount < params.maxAveragingCount &&
        pnlPct <= params.averageDownPct
      ) {
        const budget = Math.min(capital, initialCapital / params.splitCount);
        const qty = Math.floor(budget / today.close);
        if (qty > 0 && budget > 0) {
          const buyCostAvg = calcBuyCost(today.close * qty, commissionPct);
          totalCommissions += buyCostAvg;
          capital -= today.close * qty + buyCostAvg;
          position.avgPrice = calcAvgPrice(position.totalQty, position.avgPrice, qty, today.close);
          position.totalQty += qty;
          position.totalInvested += today.close * qty;
          position.averagingCount++;

          trades.push({
            stockCode,
            side: 'BUY',
            price: today.close,
            quantity: qty,
            date: today.date,
            reason: `물타기 ${position.averagingCount}차`,
            pnl: 0,
            pnlPct: 0,
          });
        }
      }
    }

    // ── 포지션 없을 때: 진입 체크 ──
    if (!position && technicals.score >= threshold) {
      // 모드별 진입 필터로 횡보/하락장 whipsaw를 줄임
      const defenseHighConvictionBounce =
        mode === 'DEFENSE' &&
        technicals.score >= Math.max(threshold + 8, 35) &&
        technicals.volumeRatio >= 1.0 &&
        (technicals.macdCrossover === 'BULLISH' || technicals.goldenCross || technicals.rsi14 <= 32);

      const defenseEntryBlocked =
        mode === 'DEFENSE' &&
        !isForceEntryMode &&
        (technicals.overallSignal === 'STRONG_SELL' ||
          (technicals.overallSignal === 'SELL' && !defenseHighConvictionBounce) ||
          (technicals.sma20 < technicals.sma60 && !defenseHighConvictionBounce) ||
          (technicals.trendStrength === 'WEAK' && technicals.volumeRatio < 1.0));

      // ★ SWING 진입 최적화 (연구 기반)
      // QuantifiedStrategies: RSI 2일 평균 회귀 전략 승률 77~91%
      // 핵심: RSI 과매도 + MACD 방향 확인 + 거래량 동반 시 진입
      const swingEntryBlocked =
        mode === 'SWING' &&
        !isForceEntryMode &&
        // 1. RSI 과매수 상태면 진입 금지 (이미 올라간 곳에 들어가지 않음)
        (technicals.rsi14 > 72 ||
          // 1-1. 추세 약한 구간에서 중립/약세 시그널은 스킵
          (technicals.trendStrength === 'WEAK' && technicals.score < 22) ||
          // 2. MACD가 약세 전환 중이면 진입 금지
          (technicals.macdCrossover === 'BEARISH' && technicals.rsi14 > 55) ||
          // 3. 거래량 없이 오른 거면 진입 금지 (허수 상승)
          (technicals.volumeRatio < 0.6 && technicals.score < 30));

      if (defenseEntryBlocked || swingEntryBlocked) {
        continue;
      }

      const riskScale =
        mode === 'SWING'
          ? technicals.trendStrength === 'WEAK'
            ? 0.6
            : 1.0
          : mode === 'DEFENSE'
            ? 0.7
            : 1.0;
      const budget = Math.min(capital, (initialCapital / params.splitCount) * riskScale);
      const qty = Math.floor(budget / today.close);

      if (qty > 0 && budget > 0) {
        const buyCostEntry = calcBuyCost(today.close * qty, commissionPct);
        totalCommissions += buyCostEntry;
        capital -= today.close * qty + buyCostEntry;
        position = {
          stockCode,
          entries: [{ price: today.close, quantity: qty, date: today.date }],
          avgPrice: today.close,
          totalQty: qty,
          totalInvested: today.close * qty,
          averagingCount: 0,
          openedAt: today.date,
        };

        trades.push({
          stockCode,
          side: 'BUY',
          price: today.close,
          quantity: qty,
          date: today.date,
          reason: `진입 (기술점수 ${technicals.score})`,
          pnl: 0,
          pnlPct: 0,
        });
      }
    }
  }

  // 마지막 날 청산
  if (position && sorted.length > 0) {
    const lastPrice = sorted[sorted.length - 1].close;
    const pnlPct = calcPnlPct(position.avgPrice, lastPrice);
    const saFinal = lastPrice * position.totalQty;
    const scFinal = calcSellCost(saFinal, commissionPct, taxPct);
    totalCommissions += scFinal;
    const pnl = roundKrw((lastPrice - position.avgPrice) * position.totalQty - scFinal);
    capital += saFinal - scFinal;

    trades.push({
      stockCode,
      side: 'SELL',
      price: lastPrice,
      quantity: position.totalQty,
      date: sorted[sorted.length - 1].date,
      reason: '백테스트 종료 청산',
      pnl,
      pnlPct,
    });
  }

  // ── 결과 계산 ──
  const sellTrades = trades.filter((t) => t.side === 'SELL');
  const wins = sellTrades.filter((t) => t.pnl > 0);
  const losses = sellTrades.filter((t) => t.pnl <= 0);
  const totalProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  const finalCapital = capital;
  const totalReturnPct = ((finalCapital - initialCapital) / initialCapital) * 100;
  const tradingDays = dailyPnl.length;
  const annualized = tradingDays > 0 ? ((finalCapital / initialCapital) ** (252 / tradingDays) - 1) * 100 : 0;

  // Sharpe Ratio
  const dailyReturns = dailyPnl.map((d, i) =>
    i === 0 ? 0 : (d.equity - dailyPnl[i - 1].equity) / dailyPnl[i - 1].equity,
  );
  const avgReturn = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const stdDev = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / dailyReturns.length);
  const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

  const maxDD = dailyPnl.length > 0 ? Math.max(...dailyPnl.map((d) => d.drawdown)) : 0;

  return {
    totalReturnPct: Math.round(totalReturnPct * 100) / 100,
    totalReturnKrw: roundKrw(finalCapital - initialCapital),
    annualizedReturn: Math.round(annualized * 100) / 100,
    maxDrawdownPct: Math.round(maxDD * 100) / 100,
    sharpeRatio: Math.round(sharpe * 100) / 100,
    totalTrades: trades.length,
    winRate: sellTrades.length > 0 ? Math.round((wins.length / sellTrades.length) * 100) : 0,
    wins: wins.length,
    losses: losses.length,
    avgWinPct: wins.length > 0 ? Math.round((wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length) * 100) / 100 : 0,
    avgLossPct:
      losses.length > 0 ? Math.round((losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length) * 100) / 100 : 0,
    profitFactor: totalLoss > 0 ? Math.round((totalProfit / totalLoss) * 100) / 100 : 999,
    avgHoldingDays: sellTrades.length > 0
      ? Math.round(
          trades
            .filter((t) => t.side === 'BUY' && t.reason.startsWith('진입'))
            .reduce((sum, buyTrade) => {
              const matchingSell = trades.find(
                (t) => t.side === 'SELL' && t.stockCode === buyTrade.stockCode && t.date >= buyTrade.date,
              );
              return sum + (matchingSell ? countDaysBetween(buyTrade.date, matchingSell.date) : 0);
            }, 0) /
            Math.max(1, trades.filter((t) => t.side === 'BUY' && t.reason.startsWith('진입')).length) *
            10,
        ) / 10
      : 0,
    trades,
    dailyPnl,
    finalCapital: roundKrw(finalCapital),
  };
}

function countDaysBetween(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  return Math.floor((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24));
}
