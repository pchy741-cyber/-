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
  taxPct?: number; // 증권거래세 (매도 시에만, 기본 0.18% — 2025~)
  slippagePct?: number; // 슬리피지 (매수 +, 매도 -, 기본 0.1%)
  overrideTp?: number; // 전역 파라미터 변이 없이 TP 오버라이드 (optimizer용)
  overrideSl?: number; // 전역 파라미터 변이 없이 SL 오버라이드 (optimizer용)
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
  peakPrice: number; // 최고가 추적 (트레일링 스톱용)
  profitTaking: boolean; // 1단계 익절 완료 → 트레일링 대기 중
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
  const {
    mode,
    initialCapital,
    buyThreshold,
    commissionPct = 0.015,
    taxPct = 0.18,
    slippagePct = 0.1,
  } = backtestConfig;
  // 슬리피지 적용 헬퍼: 매수는 불리하게(높게), 매도는 불리하게(낮게)
  const buyPrice = (close: number) => Math.round(close * (1 + slippagePct / 100));
  const sellPrice = (close: number) => Math.round(close * (1 - slippagePct / 100));
  const baseParams = STRATEGY_PARAMS[mode];
  const params = backtestConfig.overrideTp != null || backtestConfig.overrideSl != null
    ? { ...baseParams, takeProfitPct: backtestConfig.overrideTp ?? baseParams.takeProfitPct, stopLossPct: backtestConfig.overrideSl ?? baseParams.stopLossPct }
    : baseParams;
  let _totalCommissions = 0; // 총 거래비용 추적
  // 백테스트 기술 점수 임계치
  // 실전 minTechScore(SWING=55, DEFENSE=65) 기준이나, 합성 데이터는 지표 분산이 적으므로
  // SWING은 45로 완화해 충분한 거래 횟수 확보 (과매매 방지 vs 표본 부족 균형)
  const defaultThresholdByMode: Record<StrategyMode, number> = {
    SWING: 45,
    DEFENSE: 55,
    SCALPING: 45,
    DIVIDEND: 99,
    SNIPER: 88,
    BOTTOM_FISHING: 0,
    EOD_BETTING: 0,
    BREAKOUT: 0,
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

    // ── 포지션이 있을 때: 2단계 익절 (실전과 동일) + 고정 손절 + 시간손절 ──
    if (position) {
      const pnlPct = calcPnlPct(position.avgPrice, today.close);
      const holdingDays = countDaysBetween(position.openedAt, today.date);

      // 최고가 업데이트 (트레일링 스톱 기준)
      position.peakPrice = Math.max(position.peakPrice, today.close);

      // 고정 손절 — 일봉에서 low가 손절가 이하면 손절가에 체결 (갭다운 방지)
      const stopPrice = position.avgPrice * (1 + params.stopLossPct / 100);
      const stopTriggered = !position.profitTaking && today.low <= stopPrice;
      const stopExitPrice = stopTriggered ? Math.max(today.low, stopPrice) : today.close;
      const stopPnlPct = stopTriggered ? calcPnlPct(position.avgPrice, stopExitPrice) : pnlPct;
      if (stopTriggered) {
        const saStop = stopExitPrice * position.totalQty;
        const scStop = calcSellCost(saStop, commissionPct, taxPct);
        _totalCommissions += scStop;
        const pnl = roundKrw((stopExitPrice - position.avgPrice) * position.totalQty - scStop);
        capital += saStop - scStop;
        trades.push({
          stockCode,
          side: 'SELL',
          price: stopExitPrice,
          quantity: position.totalQty,
          date: today.date,
          reason: `손절 ${stopPnlPct.toFixed(1)}% (한도 ${params.stopLossPct}%)`,
          pnl,
          pnlPct: stopPnlPct,
        });
        position = null;
        continue;
      }

      // 방어 모드 조기 청산: 추세 훼손 시 손실/무수익 포지션을 빠르게 종료
      if (
        mode === 'DEFENSE' &&
        (technicals.overallSignal === 'STRONG_SELL' ||
          technicals.deathCross ||
          (technicals.overallSignal === 'SELL' && technicals.trendStrength === 'WEAK')) &&
        pnlPct <= 0.3
      ) {
        const exitP = sellPrice(today.close);
        const sellAmount = exitP * position.totalQty;
        const sellCost = calcSellCost(sellAmount, commissionPct, taxPct);
        _totalCommissions += sellCost;
        const realPnlPct = calcPnlPct(position.avgPrice, exitP);
        const pnl = roundKrw((exitP - position.avgPrice) * position.totalQty - sellCost);
        capital += sellAmount - sellCost;
        trades.push({
          stockCode,
          side: 'SELL',
          price: exitP,
          quantity: position.totalQty,
          date: today.date,
          reason: `방어모드 약세 청산 ${realPnlPct.toFixed(1)}%`,
          pnl,
          pnlPct: realPnlPct,
        });
        position = null;
        continue;
      }

      // SWING 조기 이탈: 횡보/약세 전환 구간 손실 차단 (-0.7% ~ stopLoss 사이에서만 발동)
      if (
        mode === 'SWING' &&
        holdingDays >= 2 &&
        technicals.trendStrength === 'WEAK' &&
        (technicals.overallSignal === 'SELL' || technicals.overallSignal === 'STRONG_SELL') &&
        pnlPct <= -0.7
      ) {
        const exitP2 = sellPrice(today.close);
        const sellAmount2 = exitP2 * position.totalQty;
        const sellCost2 = calcSellCost(sellAmount2, commissionPct, taxPct);
        _totalCommissions += sellCost2;
        const realPnlPct2 = calcPnlPct(position.avgPrice, exitP2);
        const pnl = roundKrw((exitP2 - position.avgPrice) * position.totalQty - sellCost2);
        capital += sellAmount2 - sellCost2;
        trades.push({
          stockCode,
          side: 'SELL',
          price: exitP2,
          quantity: position.totalQty,
          date: today.date,
          reason: `스윙 횡보 이탈 ${realPnlPct2.toFixed(1)}%`,
          pnl,
          pnlPct: realPnlPct2,
        });
        position = null;
        continue;
      }

      // 2단계 익절 (실전 technical-fallback.ts와 동일한 로직)
      // 1단계: takeProfitPct(2.5%) → 50% 부분 매도
      if (!position.profitTaking && pnlPct >= params.takeProfitPct && position.totalQty > 1) {
        const sellQty = Math.max(1, Math.ceil(position.totalQty * 0.5));
        const ep1 = sellPrice(today.close);
        const sa1 = ep1 * sellQty;
        const sc1 = calcSellCost(sa1, commissionPct, taxPct);
        _totalCommissions += sc1;
        const real1Pct = calcPnlPct(position.avgPrice, ep1);
        const pnl = roundKrw((ep1 - position.avgPrice) * sellQty - sc1);
        capital += sa1 - sc1;
        trades.push({
          stockCode,
          side: 'SELL',
          price: ep1,
          quantity: sellQty,
          date: today.date,
          reason: `1단계 익절(50%) +${real1Pct.toFixed(1)}%`,
          pnl,
          pnlPct: real1Pct,
        });
        position.totalQty -= sellQty;
        position.profitTaking = true;
        if (position.totalQty <= 0) {
          position = null;
          continue;
        }
      } else if (!position.profitTaking && pnlPct >= params.takeProfitPct) {
        // 1주 등 분할 불가 → 전량 익절
        const ep1f = sellPrice(today.close);
        const sa1 = ep1f * position.totalQty;
        const sc1 = calcSellCost(sa1, commissionPct, taxPct);
        _totalCommissions += sc1;
        const real1fPct = calcPnlPct(position.avgPrice, ep1f);
        const pnl = roundKrw((ep1f - position.avgPrice) * position.totalQty - sc1);
        capital += sa1 - sc1;
        trades.push({
          stockCode,
          side: 'SELL',
          price: ep1f,
          quantity: position.totalQty,
          date: today.date,
          reason: `익절(전량-분할불가) +${real1fPct.toFixed(1)}%`,
          pnl,
          pnlPct: real1fPct,
        });
        position = null;
        continue;
      }

      // 2단계: PROFIT_TAKING 상태에서 트레일링 또는 +4.0% 목표
      // 일봉 백테스트는 -2.0% 트레일 (일 노이즈 1.5% 감안, 실전 -0.8%는 5분봉 기준)
      if (position?.profitTaking) {
        const trailDropPct =
          position.peakPrice > 0 ? ((today.close - position.peakPrice) / position.peakPrice) * 100 : 0;
        const isBreakevenStop = pnlPct <= 0.2; // 1단계 익절 후 원금 하회 방지
        const isTrailTriggered = trailDropPct <= -2.0;
        const isTargetReached = pnlPct >= 4.0;
        if (isBreakevenStop || isTrailTriggered || isTargetReached) {
          const ep2 = sellPrice(today.close);
          const sa2 = ep2 * position.totalQty;
          const sc2 = calcSellCost(sa2, commissionPct, taxPct);
          _totalCommissions += sc2;
          const real2Pct = calcPnlPct(position.avgPrice, ep2);
          const pnl = roundKrw((ep2 - position.avgPrice) * position.totalQty - sc2);
          capital += sa2 - sc2;
          trades.push({
            stockCode,
            side: 'SELL',
            price: ep2,
            quantity: position.totalQty,
            date: today.date,
            reason: isTargetReached
              ? `2단계 익절(+4%) +${real2Pct.toFixed(1)}%`
              : isBreakevenStop
                ? `브레이크이븐스톱 ${real2Pct.toFixed(1)}%`
                : `트레일링스톱 peak대비${trailDropPct.toFixed(1)}%`,
            pnl,
            pnlPct: real2Pct,
          });
          position = null;
          continue;
        }
      }

      // 시간 손절 (변경: 수익 0% 이하일 때만, 소폭이라도 수익이면 유지)
      if (params.maxHoldingDays > 0 && holdingDays >= params.maxHoldingDays && pnlPct <= 0) {
        const epTime = sellPrice(today.close);
        const saTime = epTime * position.totalQty;
        const scTime = calcSellCost(saTime, commissionPct, taxPct);
        _totalCommissions += scTime;
        const realTimePct = calcPnlPct(position.avgPrice, epTime);
        const pnl = roundKrw((epTime - position.avgPrice) * position.totalQty - scTime);
        capital += saTime - scTime;

        trades.push({
          stockCode,
          side: 'SELL',
          price: epTime,
          quantity: position.totalQty,
          date: today.date,
          reason: `시간손절 ${holdingDays}일`,
          pnl,
          pnlPct: realTimePct,
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
        const avgBp = buyPrice(today.close);
        const budget = Math.min(capital, initialCapital / params.splitCount);
        const qty = Math.floor(budget / avgBp);
        if (qty > 0 && budget > 0) {
          const buyCostAvg = calcBuyCost(avgBp * qty, commissionPct);
          _totalCommissions += buyCostAvg;
          capital -= avgBp * qty + buyCostAvg;
          position.avgPrice = calcAvgPrice(position.totalQty, position.avgPrice, qty, avgBp);
          position.totalQty += qty;
          position.totalInvested += avgBp * qty;
          position.averagingCount++;

          trades.push({
            stockCode,
            side: 'BUY',
            price: avgBp,
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
          // 2. MACD가 약세 전환 중이고 RSI 과열권이면 진입 금지
          (technicals.macdCrossover === 'BEARISH' && technicals.rsi14 > 65) ||
          // 3. 거래량 없이 오른 거면 진입 금지 (허수 상승)
          (technicals.volumeRatio < 0.6 && technicals.score < 30));

      if (defenseEntryBlocked || swingEntryBlocked) {
        continue;
      }

      const riskScale =
        mode === 'SWING' ? (technicals.trendStrength === 'WEAK' ? 0.6 : 1.0) : mode === 'DEFENSE' ? 0.7 : 1.0;
      const entryBp = buyPrice(today.close);
      const budget = Math.min(capital, (initialCapital / params.splitCount) * riskScale);
      const qty = Math.floor(budget / entryBp);

      if (qty > 0 && budget > 0) {
        const buyCostEntry = calcBuyCost(entryBp * qty, commissionPct);
        _totalCommissions += buyCostEntry;
        capital -= entryBp * qty + buyCostEntry;
        position = {
          stockCode,
          entries: [{ price: entryBp, quantity: qty, date: today.date }],
          avgPrice: entryBp,
          totalQty: qty,
          totalInvested: entryBp * qty,
          averagingCount: 0,
          openedAt: today.date,
          peakPrice: entryBp,
          profitTaking: false,
        };

        trades.push({
          stockCode,
          side: 'BUY',
          price: entryBp,
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
    const lastClose = sorted[sorted.length - 1].close;
    const lastPrice = sellPrice(lastClose);
    const pnlPct = calcPnlPct(position.avgPrice, lastPrice);
    const saFinal = lastPrice * position.totalQty;
    const scFinal = calcSellCost(saFinal, commissionPct, taxPct);
    _totalCommissions += scFinal;
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

  // Sharpe Ratio (sample stdDev — N-1 분모)
  const dailyReturns = dailyPnl.map((d, i) =>
    i === 0 ? 0 : (d.equity - dailyPnl[i - 1].equity) / dailyPnl[i - 1].equity,
  );
  const avgReturn = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const stdDev = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (dailyReturns.length - 1))
    : 0;
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
    avgHoldingDays:
      sellTrades.length > 0
        ? Math.round(
            (trades
              .filter((t) => t.side === 'BUY' && t.reason.startsWith('진입'))
              .reduce((sum, buyTrade) => {
                // 마지막 매도(전량 청산)를 기준으로 보유일수 계산 (부분매도 아닌 최종 청산)
                const sellsAfter = trades.filter(
                  (t) => t.side === 'SELL' && t.stockCode === buyTrade.stockCode && t.date >= buyTrade.date,
                );
                const lastSell = sellsAfter.length > 0 ? sellsAfter[sellsAfter.length - 1] : null;
                return sum + (lastSell ? countDaysBetween(buyTrade.date, lastSell.date) : 0);
              }, 0) /
              Math.max(1, trades.filter((t) => t.side === 'BUY' && t.reason.startsWith('진입')).length)) *
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

// ═══════════════════════════════════════════
//  Walk-Forward 검증 — 데이터스누핑 방지
// ═══════════════════════════════════════════

export interface WalkForwardResult {
  folds: Array<{
    trainPeriod: string;
    testPeriod: string;
    trainResult: Pick<BacktestResult, 'winRate' | 'totalReturnPct' | 'profitFactor' | 'totalTrades'>;
    testResult: Pick<BacktestResult, 'winRate' | 'totalReturnPct' | 'profitFactor' | 'totalTrades'>;
  }>;
  /** OOS 수익률 / IS 수익률 — 1.0에 가까울수록 과적합 아님, 낮을수록 과적합 */
  walkForwardEfficiency: number;
  avgOosWinRate: number;
  avgOosReturn: number;
  isOverfit: boolean;
}

/**
 * Walk-Forward 백테스트 (시계열 Anchored Rolling Window)
 *
 * ⚠️ v10.11.3: K-Fold → Anchored Rolling Window 전환
 * 기존 K-Fold는 test 이후 데이터를 train에 포함하여 미래 데이터 유출 발생.
 * Rolling Window는 항상 과거→미래 순서로 train/test 분리 — 시계열 무결성 보장.
 *
 * 구조: [===== train (70%) =====][= test (30%) =]
 *        → 윈도우가 전체 데이터를 앞에서 뒤로 슬라이딩
 *        → train은 항상 test 이전 시간대만 포함
 *
 * @param folds 슬라이딩 횟수 (기본 5)
 */
export function runWalkForward(
  candles: OHLCV[],
  stockCode: string,
  config: BacktestConfig,
  folds = 5,
): WalkForwardResult {
  const sorted = [...candles].sort((a, b) => a.date.localeCompare(b.date));
  const totalCandles = sorted.length;

  if (totalCandles < 200) {
    return {
      folds: [],
      walkForwardEfficiency: 0,
      avgOosWinRate: 0,
      avgOosReturn: 0,
      isOverfit: true,
    };
  }

  // Anchored Rolling Window: train 70%, test 30%
  // 최소 train 120봉, 최소 test 40봉
  const minTrainSize = 120;
  const minTestSize = 40;
  const trainRatio = 0.7;

  // 스텝 계산: folds만큼 균등 분배
  const usableCandles = totalCandles - minTrainSize - minTestSize;
  if (usableCandles < 0) {
    return { folds: [], walkForwardEfficiency: 0, avgOosWinRate: 0, avgOosReturn: 0, isOverfit: true };
  }
  const step = Math.max(1, Math.floor(usableCandles / Math.max(1, folds - 1)));

  const results: WalkForwardResult['folds'] = [];

  for (let i = 0; i < folds; i++) {
    // 윈도우 크기: 시작점에서 끝까지 가용 데이터
    const windowStart = 0; // anchored: 항상 처음부터
    const windowEnd = Math.min(totalCandles, minTrainSize + minTestSize + i * step);
    const windowSize = windowEnd - windowStart;
    if (windowSize < minTrainSize + minTestSize) continue;

    const trainEnd = windowStart + Math.max(minTrainSize, Math.floor(windowSize * trainRatio));
    const testStart = trainEnd; // train 직후부터 test 시작 (갭 없음)

    // Train: 과거 데이터만 (test 이전)
    const trainCandles = sorted.slice(windowStart, trainEnd);
    // Test: train 직후 데이터 (미래 유출 없음)
    const testCandles = sorted.slice(testStart, windowEnd);

    if (trainCandles.length < minTrainSize || testCandles.length < minTestSize) continue;

    const trainResult = runBacktest(trainCandles, stockCode, config);
    const testResult = runBacktest(testCandles, stockCode, config);

    const pick = (r: BacktestResult) => ({
      winRate: r.winRate,
      totalReturnPct: r.totalReturnPct,
      profitFactor: r.profitFactor,
      totalTrades: r.totalTrades,
    });

    results.push({
      trainPeriod: `${trainCandles[0]?.date ?? '?'}~${trainCandles[trainCandles.length - 1]?.date ?? '?'}`,
      testPeriod: `${testCandles[0]?.date ?? '?'}~${testCandles[testCandles.length - 1]?.date ?? '?'}`,
      trainResult: pick(trainResult),
      testResult: pick(testResult),
    });
  }

  if (results.length === 0) {
    return { folds: [], walkForwardEfficiency: 0, avgOosWinRate: 0, avgOosReturn: 0, isOverfit: true };
  }

  const avgIsReturn = results.reduce((s, f) => s + f.trainResult.totalReturnPct, 0) / results.length;
  const avgOosReturn = results.reduce((s, f) => s + f.testResult.totalReturnPct, 0) / results.length;
  const avgOosWinRate = results.reduce((s, f) => s + f.testResult.winRate, 0) / results.length;
  const wfe = avgIsReturn !== 0 ? avgOosReturn / avgIsReturn : 0;

  return {
    folds: results,
    walkForwardEfficiency: Math.round(wfe * 100) / 100,
    avgOosWinRate: Math.round(avgOosWinRate * 10) / 10,
    avgOosReturn: Math.round(avgOosReturn * 100) / 100,
    // WFE < 0.5 = OOS 성과가 IS의 절반 미만 → 과적합 의심
    isOverfit: wfe < 0.5 || avgOosReturn < 0,
  };
}
