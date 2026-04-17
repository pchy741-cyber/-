import { sma } from '../analysis/indicators.js';
import { config } from '../config/index.js';
import { getPool } from '../db/client.js';
import { getDailyChart } from '../kis/market.js';
import { logger } from '../utils/logger.js';

/**
 * 승률 기반 + ATR 동적 포지션 사이징 자동 조절
 *
 * 최근 20건의 매매 결과를 분석하여 다음 매매의 투자 비중을 조절
 * - 승률 높으면 → 투자 비중 확대 (최대 1.3배)
 * - 승률 낮으면 → 투자 비중 축소 (최소 0.5배)
 * - 연패 중이면 → 추가 축소
 *
 * Kelly Criterion 변형 적용
 * ATR 기반 변동성 조절 + Drawdown 브레이크 + 연패 패널티
 */

export interface PositionSizeResult {
  multiplier: number; // 기본 예산 대비 배수 (0.5 ~ 1.3)
  adjustedBudget: number; // 실제 투입 예산
  recentWinRate: number; // 최근 승률
  recentTrades: number; // 분석 대상 매매 수
  streak: number; // 연승(양수) / 연패(음수)
  reason: string;
}

export interface DynamicPositionResult {
  amount: number; // 최종 투자 금액
  multiplier: number; // 적용된 종합 배수
  reason: string; // 조절 사유 요약
}

// ── ATR 기반 포지션 사이징 ──

/**
 * 종목의 ATR (Average True Range) 계산
 * KIS 일봉 데이터를 가져와서 TrueRange의 SMA를 구함
 */
export async function calculateATR(stockCode: string, period: number = 14): Promise<number> {
  const candles = await getDailyChart(stockCode, 30); // 충분한 데이터 확보 (20개 + 여유)

  if (candles.length < period + 1) {
    logger.warn(`ATR 계산 불가: ${stockCode} 캔들 ${candles.length}개 (최소 ${period + 1}개 필요)`, {
      component: 'SIZER',
    });
    return 0;
  }

  // 일봉은 최신순 정렬 → 오름차순으로 변환
  const sorted = [...candles].reverse();

  // True Range 계산
  const trueRanges: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const tr = Math.max(
      sorted[i].high - sorted[i].low,
      Math.abs(sorted[i].high - sorted[i - 1].close),
      Math.abs(sorted[i].low - sorted[i - 1].close),
    );
    trueRanges.push(tr);
  }

  // ATR = SMA of TrueRange over period
  const atrValues = sma(trueRanges, period);
  if (atrValues.length === 0) return 0;

  const latestATR = atrValues[atrValues.length - 1];

  logger.info(`ATR(${period}) 계산 완료: ${stockCode} = ${latestATR.toFixed(0)}원`, {
    component: 'SIZER',
  });

  return latestATR;
}

/**
 * ATR 기반 변동성 배수 산출 (0.3 ~ 1.5)
 * - 저변동성 (ATR < 2%): 1.3x — 안정적이므로 비중 확대
 * - 보통 (ATR 2~4%): 1.0x — 표준 비중
 * - 고변동성 (ATR 4~6%): 0.6x — 노출 축소
 * - 초고변동성 (ATR > 6%): 0.3x — 최소 노출
 */
export async function getVolatilityMultiplier(stockCode: string): Promise<number> {
  const candles = await getDailyChart(stockCode, 30);

  if (candles.length === 0) {
    logger.warn(`변동성 배수 계산 불가: ${stockCode} 데이터 없음 → 기본 1.0x`, { component: 'SIZER' });
    return 1.0;
  }

  const currentPrice = candles[0].close; // 최신 종가
  if (currentPrice <= 0) return 1.0;

  const atrValue = await calculateATR(stockCode);
  if (atrValue === 0) return 1.0;

  const atrPct = (atrValue / currentPrice) * 100;

  let multiplier: number;
  let label: string;

  if (atrPct < 2) {
    multiplier = 1.3;
    label = '저변동성';
  } else if (atrPct < 4) {
    multiplier = 1.0;
    label = '보통';
  } else if (atrPct < 6) {
    multiplier = 0.6;
    label = '고변동성';
  } else {
    multiplier = 0.3;
    label = '초고변동성';
  }

  logger.info(
    `변동성 배수: ${stockCode} ATR=${atrValue.toFixed(0)}원 (${atrPct.toFixed(1)}%) → ${label} x${multiplier}`,
    { component: 'SIZER' },
  );

  return multiplier;
}

/**
 * 동적 포지션 사이즈 계산
 *
 * baseAmount에 다음 필터를 순차 적용:
 * 1. ATR 변동성 배수
 * 2. Drawdown 브레이크 (당일 P&L 기반)
 * 3. 연패 패널티 (최근 3연패 시 30% 감소)
 */
export async function getDynamicPositionSize(
  stockCode: string,
  baseAmount: number,
  _mode: string,
): Promise<DynamicPositionResult> {
  const reasons: string[] = [];
  let finalMultiplier = 1.0;

  // 1. ATR 변동성 배수
  const volMult = await getVolatilityMultiplier(stockCode);
  finalMultiplier *= volMult;
  if (volMult !== 1.0) {
    reasons.push(`변동성 x${volMult}`);
  }

  // 2. Drawdown 브레이크 (당일 손실 기반)
  try {
    const { rows: snapshotRows } = await getPool().query(
      `SELECT total_value FROM portfolio_snapshots
       WHERE created_at::date = CURRENT_DATE
       ORDER BY created_at ASC LIMIT 1`,
    );

    if (snapshotRows.length > 0) {
      const { rows: currentRows } = await getPool().query(
        `SELECT total_value FROM portfolio_snapshots
         ORDER BY created_at DESC LIMIT 1`,
      );

      if (currentRows.length > 0) {
        const startValue = Number(snapshotRows[0].total_value);
        const currentValue = Number(currentRows[0].total_value);

        if (startValue > 0) {
          const dailyPnlPct = ((currentValue - startValue) / startValue) * 100;

          if (dailyPnlPct < -4) {
            finalMultiplier *= 0.2;
            reasons.push(`당일 ${dailyPnlPct.toFixed(1)}% 손실 → 80% 감소`);
          } else if (dailyPnlPct < -2) {
            finalMultiplier *= 0.5;
            reasons.push(`당일 ${dailyPnlPct.toFixed(1)}% 손실 → 50% 감소`);
          }
        }
      }
    }
  } catch (err) {
    logger.warn('Drawdown 브레이크 계산 실패 → 스킵', { component: 'SIZER', error: err });
  }

  // 3. 연패 패널티 (최근 3연패 시 30% 감소)
  try {
    const { rows: recentTrades } = await getPool().query(
      `SELECT realized_pnl FROM transaction_chains
       WHERE status = 'CLOSED' ORDER BY closed_at DESC LIMIT 3`,
    );

    if (recentTrades.length >= 3) {
      const allLosses = recentTrades.every((t) => Number(t.realized_pnl) <= 0);
      if (allLosses) {
        finalMultiplier *= 0.7;
        reasons.push('3연패 → 30% 감소');
      }
    }
  } catch (err) {
    logger.warn('연패 패널티 계산 실패 → 스킵', { component: 'SIZER', error: err });
  }

  // 최소/최대 클램핑 (최소 0.3x — 너무 작으면 최소 주문금액 미달)
  finalMultiplier = Math.max(0.3, Math.min(1.5, finalMultiplier));

  let amount = Math.round(baseAmount * finalMultiplier);
  // 최소 주문금액 보장 (5만원 미만이면 매매 불가)
  const MIN_ORDER_KRW = 50_000;
  if (amount < MIN_ORDER_KRW && baseAmount >= MIN_ORDER_KRW) {
    amount = MIN_ORDER_KRW;
    reasons.push(`최소 주문금액 ${MIN_ORDER_KRW.toLocaleString()}원 적용`);
  }
  const reason = reasons.length > 0 ? reasons.join(' | ') : '조절 없음 (기본 비중)';

  logger.info(
    `동적 포지션: ${stockCode} 기본 ${baseAmount.toLocaleString()}원 × ${finalMultiplier.toFixed(2)} = ${amount.toLocaleString()}원 (${reason})`,
    { component: 'SIZER' },
  );

  return { amount, multiplier: finalMultiplier, reason };
}

export async function calcPositionSize(baseBudget: number): Promise<PositionSizeResult> {
  // 최근 20건 청산된 체인
  const { rows: trades } = await getPool().query(
    `SELECT realized_pnl, closed_at FROM transaction_chains
     WHERE status = 'CLOSED' ORDER BY closed_at DESC LIMIT 20`,
  );

  // 데이터 부족 시 기본값
  if (trades.length < 5) {
    return {
      multiplier: 1.0,
      adjustedBudget: baseBudget,
      recentWinRate: 0,
      recentTrades: trades.length,
      streak: 0,
      reason: '매매 이력 부족 (5건 미만) → 기본 비중',
    };
  }

  // 승률 계산 — Laplace smoothing: 소표본 과적합 방지 (wins+2)/(total+4)
  const wins = trades.filter((t) => Number(t.realized_pnl) > 0).length;
  const winRate = (wins + 2) / (trades.length + 4);

  // 연승/연패 계산
  let streak = 0;
  const isFirstWin = Number(trades[0].realized_pnl) > 0;
  for (const trade of trades) {
    const isWin = Number(trade.realized_pnl) > 0;
    if (isWin === isFirstWin) {
      streak += isWin ? 1 : -1;
    } else {
      break;
    }
  }

  // 평균 수익/손실
  const avgWin =
    trades.filter((t) => Number(t.realized_pnl) > 0).reduce((sum, t) => sum + Number(t.realized_pnl), 0) /
    Math.max(wins, 1);
  const avgLoss = Math.abs(
    trades.filter((t) => Number(t.realized_pnl) <= 0).reduce((sum, t) => sum + Number(t.realized_pnl), 0) /
      Math.max(trades.length - wins, 1),
  );

  // Kelly Criterion (보수적 1/2 Kelly)
  // f = (bp - q) / b, b = avgWin/avgLoss, p = winRate, q = 1-winRate
  const b = avgLoss > 0 ? avgWin / avgLoss : 1;
  const kellyFraction = Math.max(0, (b * winRate - (1 - winRate)) / b);
  const halfKelly = kellyFraction / 2;

  // 배수 결정 (0.5 ~ 1.3 범위)
  let multiplier = 1.0;
  let reason = '';

  if (winRate >= 0.7 && streak >= 3) {
    multiplier = Math.min(1.3, 1.0 + halfKelly);
    reason = `승률 ${(winRate * 100).toFixed(0)}% + ${streak}연승 → 비중 확대`;
  } else if (winRate >= 0.6) {
    multiplier = Math.min(1.15, 1.0 + halfKelly * 0.5);
    reason = `승률 ${(winRate * 100).toFixed(0)}% → 소폭 확대`;
  } else if (winRate < 0.4 || streak <= -3) {
    multiplier = Math.max(0.5, 0.7 + halfKelly);
    reason = `승률 ${(winRate * 100).toFixed(0)}%${streak <= -3 ? ` + ${Math.abs(streak)}연패` : ''} → 비중 축소`;
  } else {
    multiplier = 1.0;
    reason = `승률 ${(winRate * 100).toFixed(0)}% → 기본 비중 유지`;
  }

  const adjustedBudget = Math.round(baseBudget * multiplier);

  // 하드 리밋 확인
  const finalBudget = Math.min(adjustedBudget, config.risk.maxPositionKrw);

  logger.info(`포지션 사이징: x${multiplier.toFixed(2)} (${reason}) → ${finalBudget.toLocaleString()}원`, {
    component: 'SIZER',
  });

  return {
    multiplier,
    adjustedBudget: finalBudget,
    recentWinRate: winRate,
    recentTrades: trades.length,
    streak,
    reason,
  };
}

/**
 * 최적 포지션 크기 계산 (승률 + ATR 동적 사이징 통합)
 *
 * 1단계: calcPositionSize로 승률/Kelly 기반 기본 비중 결정
 * 2단계: getDynamicPositionSize로 변동성/드로다운/연패 보정
 *
 * @param baseBudget 기본 투자 예산
 * @param stockCode 종목 코드 (ATR 계산용)
 * @param mode 전략 모드 (SWING, DEFENSE, SCALPING)
 */
export async function calculateOptimalPosition(
  baseBudget: number,
  stockCode: string,
  mode: string = 'SWING',
): Promise<PositionSizeResult & { dynamic: DynamicPositionResult }> {
  // 1단계: 승률/Kelly 기반 사이징
  const baseResult = await calcPositionSize(baseBudget);

  // 2단계: ATR + 드로다운 + 연패 보정
  const dynamic = await getDynamicPositionSize(stockCode, baseResult.adjustedBudget, mode);

  // 최종 금액에 하드 리밋 적용
  const finalAmount = Math.min(dynamic.amount, config.risk.maxPositionKrw);

  const combinedReason = `${baseResult.reason} → 동적: ${dynamic.reason}`;

  logger.info(
    `최적 포지션: ${stockCode} 기본 ${baseBudget.toLocaleString()}원 → Kelly x${baseResult.multiplier.toFixed(2)} → 동적 x${dynamic.multiplier.toFixed(2)} = ${finalAmount.toLocaleString()}원`,
    { component: 'SIZER' },
  );

  return {
    ...baseResult,
    adjustedBudget: finalAmount,
    reason: combinedReason,
    dynamic,
  };
}
