/**
 * 🚦 매매 게이트 시스템 (Trade Gate)
 *
 * AI가 BUY 결정을 해도, 이 게이트를 통과해야만 실제 주문 진행.
 * 3개의 독립 게이트:
 *  1. 차트 검수 게이트 — 다중 타임프레임 정렬, 거래량 이상치, R:R 체크
 *  2. 확률 교정 + 기대값 필터 — 과거 승률 기반 진입 가치 판단
 *  3. 변동성 기반 포지션 사이징 — ATR 기반 적정 수량 계산
 *
 * + 레짐 필터 — 횡보/고변동 시 진입 자체 축소
 * + 연속손실 쿨다운 — N회 연속 손절 시 자동 대기
 */

import { analyzeTechnicals, atr, sma, type OHLCV, type TechnicalSummary } from '../analysis/indicators.js';
import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

// ══════════════════════════════════════
//  타입 정의
// ══════════════════════════════════════

export interface GateResult {
  passed: boolean;
  reason: string;
  adjustedQuantity?: number;  // 변동성 사이징으로 조정된 수량
  riskRewardRatio?: number;
  expectedValue?: number;
  regime?: string;
}

export interface GateInput {
  stockCode: string;
  action: string;
  quantity: number;
  estimatedPrice: number;
  candles: OHLCV[];           // 일봉 (최소 60개)
  candles60m?: OHLCV[];       // 60분봉 (있으면)
  candles15m?: OHLCV[];       // 15분봉 (있으면)
  strategyMode: string;
  stopLossPct: number;        // 전략의 손절 % (음수: -5, -3 등)
  takeProfitPct: number;      // 전략의 익절 %
  budgetKrw: number;          // 이번 매수에 할당 가능한 예산
}

// ══════════════════════════════════════
//  [게이트 1] 차트 검수 게이트
// ══════════════════════════════════════

/**
 * 다중 타임프레임 정렬, 거래량 이상치 제거, R:R 최소 1.5 확인
 */
export function chartVerificationGate(input: GateInput): GateResult {
  const { candles, stopLossPct, takeProfitPct } = input;

  if (candles.length < 30) {
    return { passed: false, reason: '일봉 데이터 부족 (30일 미만)' };
  }

  const tech = analyzeTechnicals(candles);
  if (!tech) {
    return { passed: false, reason: '기술적 분석 실패' };
  }

  // ── 1-1. 다중 타임프레임 정렬 체크 ──
  // 일봉 추세 방향 판단
  const dailyBullish = tech.sma5 > tech.sma20 && tech.sma20 > tech.sma60;
  const dailyBearish = tech.sma5 < tech.sma20 && tech.sma20 < tech.sma60;

  // 60분봉이 있으면 교차 확인
  if (input.candles60m && input.candles60m.length >= 30) {
    const tech60 = analyzeTechnicals(input.candles60m);
    if (tech60) {
      const hourlyBullish = tech60.sma5 > tech60.sma20;
      // 일봉 상승인데 60분봉 하락 → 방향 불일치
      if (dailyBullish && !hourlyBullish) {
        return { passed: false, reason: '다중TF 불일치: 일봉↑ 60분봉↓' };
      }
    }
  }

  // 15분봉이 있으면 추가 확인
  if (input.candles15m && input.candles15m.length >= 30) {
    const tech15 = analyzeTechnicals(input.candles15m);
    if (tech15) {
      // 일봉 하락 + 15분봉 상승 → 단기 반등일 뿐, 매수 위험
      if (dailyBearish && tech15.score > 15) {
        return { passed: false, reason: '다중TF 불일치: 일봉↓ 단기 반등' };
      }
    }
  }

  // ── 1-2. 거래량 이상치/허수 급등 제외 ──
  if (tech.volumeRatio > 5.0) {
    return { passed: false, reason: `거래량 이상치: ${tech.volumeRatio.toFixed(1)}배 (허수/작전 의심)` };
  }

  // 거래량 너무 적으면 유동성 부족
  if (tech.volumeRatio < 0.3) {
    return { passed: false, reason: `거래량 과소: ${tech.volumeRatio.toFixed(1)}배 (유동성 부족)` };
  }

  // ── 1-3. ATR 기반 R:R (Risk:Reward) 최소 1.5 확인 ──
  const absStopLoss = Math.abs(stopLossPct);
  const riskRewardRatio = absStopLoss > 0 ? takeProfitPct / absStopLoss : 0;

  if (riskRewardRatio < 1.5) {
    return {
      passed: false,
      reason: `R:R 부족: ${riskRewardRatio.toFixed(2)} (최소 1.5 필요, 익절${takeProfitPct}%/손절${absStopLoss}%)`,
      riskRewardRatio,
    };
  }

  // ── 1-4. ATR 대비 손절폭이 합리적인지 ──
  const currentPrice = candles[0]?.close ?? input.estimatedPrice;
  const atrPct = currentPrice > 0 ? (tech.atr14 / currentPrice) * 100 : 0;

  // 손절폭이 ATR의 0.5배 미만이면 너무 타이트 (빈번한 손절)
  if (atrPct > 0 && absStopLoss < atrPct * 0.5) {
    return {
      passed: false,
      reason: `손절 너무 타이트: ${absStopLoss}% < ATR의 0.5배(${(atrPct * 0.5).toFixed(1)}%)`,
      riskRewardRatio,
    };
  }

  return { passed: true, reason: '차트 검수 통과', riskRewardRatio };
}

// ══════════════════════════════════════
//  [게이트 2] 확률 교정 + 기대값 필터
// ══════════════════════════════════════

interface WinRateStats {
  totalTrades: number;
  wins: number;
  losses: number;
  avgWinPct: number;
  avgLossPct: number;
}

/**
 * 최근 매매 이력에서 승률/평균손익 산출
 */
async function getWinRateStats(days: number = 30): Promise<WinRateStats> {
  const defaultStats: WinRateStats = { totalTrades: 0, wins: 0, losses: 0, avgWinPct: 3.0, avgLossPct: -3.0 };

  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT
        close_reason,
        avg_buy_price,
        (SELECT filled_price FROM orders WHERE chain_id = tc.id AND side = 'SELL' ORDER BY created_at DESC LIMIT 1) as sell_price
      FROM transaction_chains tc
      WHERE status = 'CLOSED'
        AND closed_at >= NOW() - INTERVAL '${days} days'
        AND avg_buy_price > 0
    `);

    if (rows.length < 5) return defaultStats; // 데이터 부족 시 기본값

    let wins = 0, losses = 0;
    let totalWinPct = 0, totalLossPct = 0;

    for (const r of rows) {
      const buyPrice = Number(r.avg_buy_price);
      const sellPrice = Number(r.sell_price ?? buyPrice);
      const pnlPct = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;

      if (pnlPct > 0) {
        wins++;
        totalWinPct += pnlPct;
      } else {
        losses++;
        totalLossPct += pnlPct;
      }
    }

    return {
      totalTrades: rows.length,
      wins,
      losses,
      avgWinPct: wins > 0 ? totalWinPct / wins : 3.0,
      avgLossPct: losses > 0 ? totalLossPct / losses : -3.0,
    };
  } catch {
    return defaultStats;
  }
}

/**
 * 기대값(Expected Value) 계산
 * EV = 승률 × 평균이익 - 패율 × 평균손실
 * EV > 0 이어야 진입 가치 있음
 */
export async function expectedValueGate(_input: GateInput): Promise<GateResult> {
  const stats = await getWinRateStats(30);

  if (stats.totalTrades < 5) {
    // 데이터 부족 시 기본 R:R만 체크하고 통과
    return { passed: true, reason: '매매이력 부족(5건 미만) — 기본 통과', expectedValue: 0 };
  }

  const winRate = stats.totalTrades > 0 ? stats.wins / stats.totalTrades : 0.5;
  const lossRate = 1 - winRate;
  const ev = winRate * stats.avgWinPct - lossRate * Math.abs(stats.avgLossPct);

  if (ev <= 0) {
    return {
      passed: false,
      reason: `기대값 음수: EV=${ev.toFixed(2)}% (승률${(winRate * 100).toFixed(0)}%, 평균익${stats.avgWinPct.toFixed(1)}%, 평균손${stats.avgLossPct.toFixed(1)}%)`,
      expectedValue: ev,
    };
  }

  // 승률 35% 미만이면 추가 경고
  if (winRate < 0.35) {
    return {
      passed: false,
      reason: `승률 과소: ${(winRate * 100).toFixed(0)}% (최소 35% 필요)`,
      expectedValue: ev,
    };
  }

  return {
    passed: true,
    reason: `EV=${ev.toFixed(2)}% (승률${(winRate * 100).toFixed(0)}%, ${stats.totalTrades}건)`,
    expectedValue: ev,
  };
}

// ══════════════════════════════════════
//  [게이트 3] 변동성 기반 포지션 사이징
// ══════════════════════════════════════

/**
 * ATR 기반 적정 수량 계산
 *
 * 원리: 1회 손절 시 총 자산의 1~2%만 잃도록 수량 조절
 * 수량 = (자산 × 리스크비율) / (ATR × ATR배수)
 */
export function volatilitySizing(input: GateInput): GateResult {
  const { candles, estimatedPrice, budgetKrw } = input;

  if (candles.length < 30 || estimatedPrice <= 0) {
    return { passed: true, reason: '데이터 부족 — 기본 수량 유지', adjustedQuantity: input.quantity };
  }

  const candlesAsc = [...candles].reverse();
  const atrValues = atr(candlesAsc, 14);
  const currentATR = atrValues[atrValues.length - 1] ?? 0;

  if (currentATR <= 0) {
    return { passed: true, reason: 'ATR 계산 불가 — 기본 수량 유지', adjustedQuantity: input.quantity };
  }

  // 1회 매매 리스크: 총 예산의 2%
  const riskPerTrade = budgetKrw * 0.02;

  // ATR 1.5배를 손절폭으로 가정
  const stopDistance = currentATR * 1.5;

  // 적정 수량 = 리스크금액 / 손절폭
  const optimalQty = Math.floor(riskPerTrade / stopDistance);

  // 예산 한도 내 수량
  const maxQtyByBudget = Math.floor(budgetKrw / estimatedPrice);
  const adjustedQty = Math.min(optimalQty, maxQtyByBudget, input.quantity);

  if (adjustedQty <= 0) {
    return {
      passed: false,
      reason: `변동성 과대: ATR=${currentATR.toLocaleString()}원 → 적정수량 0 (리스크 과다)`,
      adjustedQuantity: 0,
    };
  }

  // 원래 수량 대비 50% 이상 축소되면 로그
  const reductionPct = input.quantity > 0 ? ((input.quantity - adjustedQty) / input.quantity) * 100 : 0;

  return {
    passed: true,
    reason: `ATR사이징: ${input.quantity}→${adjustedQty}주 (ATR=${currentATR.toLocaleString()}, ${reductionPct > 0 ? `-${reductionPct.toFixed(0)}%` : '유지'})`,
    adjustedQuantity: adjustedQty,
  };
}

// ══════════════════════════════════════
//  [게이트 4] 레짐 우선 필터
// ══════════════════════════════════════

export type MarketRegime = 'BULLISH' | 'BEARISH' | 'SIDEWAYS' | 'HIGH_VOLATILITY';

/**
 * 시장 레짐 판단 (일봉 기반)
 */
export function detectRegime(candles: OHLCV[]): MarketRegime {
  if (candles.length < 30) return 'SIDEWAYS';

  const candlesAsc = [...candles].reverse();
  const closes = candlesAsc.map(c => c.close);

  // SMA 20/60으로 추세 판단
  const sma20 = sma(closes, 20);
  const sma60 = closes.length >= 60 ? sma(closes, 60) : sma20;
  const s20 = sma20[sma20.length - 1] ?? 0;
  const s60 = sma60[sma60.length - 1] ?? s20;
  const current = closes[closes.length - 1] ?? 0;

  // 볼린저 밴드 폭으로 변동성 판단
  const atrValues = atr(candlesAsc, 14);
  const currentATR = atrValues[atrValues.length - 1] ?? 0;
  const atrPct = current > 0 ? (currentATR / current) * 100 : 0;

  // 고변동 (ATR > 가격의 3%)
  if (atrPct > 3.0) return 'HIGH_VOLATILITY';

  // 추세 판단
  if (current > s20 && s20 > s60) return 'BULLISH';
  if (current < s20 && s20 < s60) return 'BEARISH';

  return 'SIDEWAYS';
}

/**
 * 레짐별 진입 허용 판단
 */
export function regimeGate(input: GateInput): GateResult {
  const regime = detectRegime(input.candles);
  const mode = input.strategyMode;

  // DEFENSE 모드는 이미 보수적 → 레짐 게이트 완화
  if (mode === 'DEFENSE') {
    if (regime === 'BEARISH') {
      return { passed: true, reason: `방어모드+하락장: 소량 진입 허용`, regime };
    }
  }

  // 횡보장: 매수 시그널 신뢰도 낮음 → 진입 축소
  if (regime === 'SIDEWAYS') {
    return {
      passed: true,
      reason: `횡보장: 진입 수량 50% 축소`,
      adjustedQuantity: Math.max(1, Math.floor(input.quantity * 0.5)),
      regime,
    };
  }

  // 고변동장: 신규진입 위험
  if (regime === 'HIGH_VOLATILITY') {
    return {
      passed: false,
      reason: `고변동장: ATR 과대 — 신규진입 차단`,
      regime,
    };
  }

  // 하락장 + SWING 모드: 진입 축소
  if (regime === 'BEARISH' && mode === 'SWING') {
    return {
      passed: true,
      reason: `하락장+스윙: 진입 수량 30% 축소`,
      adjustedQuantity: Math.max(1, Math.floor(input.quantity * 0.3)),
      regime,
    };
  }

  return { passed: true, reason: `상승장: 정상 진입`, regime };
}

// ══════════════════════════════════════
//  [게이트 5] 연속손실 쿨다운
// ══════════════════════════════════════

/**
 * 최근 연속 손절 횟수 조회
 */
async function getConsecutiveLosses(): Promise<number> {
  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT close_reason, avg_buy_price,
        (SELECT filled_price FROM orders WHERE chain_id = tc.id AND side = 'SELL' ORDER BY created_at DESC LIMIT 1) as sell_price
      FROM transaction_chains tc
      WHERE status = 'CLOSED'
      ORDER BY closed_at DESC
      LIMIT 10
    `);

    let consecutive = 0;
    for (const r of rows) {
      const buyPrice = Number(r.avg_buy_price);
      const sellPrice = Number(r.sell_price ?? buyPrice);
      if (sellPrice < buyPrice) {
        consecutive++;
      } else {
        break; // 이익 나온 거래 만나면 중단
      }
    }
    return consecutive;
  } catch {
    return 0;
  }
}

export async function cooldownGate(): Promise<GateResult> {
  const consecutive = await getConsecutiveLosses();

  // 3회 연속 손절 → 60분 쿨다운
  if (consecutive >= 3) {
    // 마지막 손절 시간 확인
    try {
      const pool = getPool();
      const { rows } = await pool.query(`
        SELECT closed_at FROM transaction_chains
        WHERE status = 'CLOSED'
        ORDER BY closed_at DESC LIMIT 1
      `);

      if (rows.length > 0) {
        const lastLoss = new Date(rows[0].closed_at);
        const cooldownMs = consecutive >= 5 ? 60 * 60_000 : 30 * 60_000; // 5연패: 1시간, 3연패: 30분
        const elapsed = Date.now() - lastLoss.getTime();

        if (elapsed < cooldownMs) {
          const remaining = Math.ceil((cooldownMs - elapsed) / 60_000);
          return {
            passed: false,
            reason: `연속손실 쿨다운: ${consecutive}연패 → ${remaining}분 후 재진입 가능`,
          };
        }
      }
    } catch { /* pass through */ }
  }

  return { passed: true, reason: consecutive > 0 ? `최근 ${consecutive}연패 (쿨다운 미해당)` : '연속손실 없음' };
}

// ══════════════════════════════════════
//  통합 게이트 실행
// ══════════════════════════════════════

/**
 * 모든 게이트를 순서대로 실행
 * 하나라도 실패하면 매수 차단
 * 통과 시 adjustedQuantity로 수량 조정
 */
export async function runTradeGates(input: GateInput): Promise<GateResult> {
  const results: GateResult[] = [];

  // 매수(BUY/AVERAGE_DOWN)만 게이트 적용, 매도는 항상 통과
  if (input.action !== 'BUY' && input.action !== 'AVERAGE_DOWN') {
    return { passed: true, reason: '매도 — 게이트 생략' };
  }

  // 1. 연속손실 쿨다운 (가장 먼저 — DB 1회 조회)
  const cooldown = await cooldownGate();
  if (!cooldown.passed) {
    logger.warn(`🚦 [쿨다운] ${input.stockCode}: ${cooldown.reason}`, { component: 'TRADE_GATE' });
    return cooldown;
  }
  results.push(cooldown);

  // 2. 레짐 필터
  const regime = regimeGate(input);
  if (!regime.passed) {
    logger.warn(`🚦 [레짐] ${input.stockCode}: ${regime.reason}`, { component: 'TRADE_GATE' });
    return regime;
  }
  // 레짐에서 수량 조정이 있으면 반영
  if (regime.adjustedQuantity !== undefined) {
    input = { ...input, quantity: regime.adjustedQuantity };
  }
  results.push(regime);

  // 3. 차트 검수
  const chart = chartVerificationGate(input);
  if (!chart.passed) {
    logger.warn(`🚦 [차트검수] ${input.stockCode}: ${chart.reason}`, { component: 'TRADE_GATE' });
    return chart;
  }
  results.push(chart);

  // 4. 기대값 필터
  const ev = await expectedValueGate(input);
  if (!ev.passed) {
    logger.warn(`🚦 [기대값] ${input.stockCode}: ${ev.reason}`, { component: 'TRADE_GATE' });
    return ev;
  }
  results.push(ev);

  // 5. 변동성 사이징 (마지막 — 최종 수량 결정)
  const sizing = volatilitySizing(input);
  if (!sizing.passed) {
    logger.warn(`🚦 [사이징] ${input.stockCode}: ${sizing.reason}`, { component: 'TRADE_GATE' });
    return sizing;
  }

  // 최종 수량: 레짐 조정 + 변동성 사이징 중 작은 쪽
  const finalQty = Math.min(
    input.quantity,
    sizing.adjustedQuantity ?? input.quantity,
  );

  const summary = results.map(r => r.reason).join(' | ');
  logger.info(`✅ [게이트통과] ${input.stockCode}: ${finalQty}주 (${summary})`, { component: 'TRADE_GATE' });

  return {
    passed: true,
    reason: summary,
    adjustedQuantity: finalQty,
    riskRewardRatio: chart.riskRewardRatio,
    expectedValue: ev.expectedValue,
    regime: regime.regime,
  };
}
