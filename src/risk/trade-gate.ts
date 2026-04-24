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
import { config } from '../config/index.js';
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
    if (config.isPaper) return { passed: true, reason: '일봉 부족 — 모의투자 통과' };
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

  // 거래량 너무 적으면 유동성 부족 (0.15x — 실전/모의 동일)
  const minVolumeRatio = 0.15;
  if (tech.volumeRatio < minVolumeRatio) {
    return { passed: false, reason: `거래량 과소: ${tech.volumeRatio.toFixed(1)}배 (유동성 부족)` };
  }

  // ── 1-3. ATR 기반 R:R (Risk:Reward) 최소 1.5 확인 ──
  const absStopLoss = Math.abs(stopLossPct);
  const riskRewardRatio = absStopLoss > 0 ? takeProfitPct / absStopLoss : 0;

  const isPaper = config.isPaper;
  const minRR = isPaper ? 1.0 : 1.5; // 모의투자: R:R 1.0 이상이면 통과
  if (riskRewardRatio < minRR) {
    return {
      passed: false,
      reason: `R:R 부족: ${riskRewardRatio.toFixed(2)} (최소 ${minRR} 필요, 익절${takeProfitPct}%/손절${absStopLoss}%)`,
      riskRewardRatio,
    };
  }

  // ── 1-4. ATR 대비 손절폭이 합리적인지 ──
  const currentPrice = candles[0]?.close ?? input.estimatedPrice;
  const atrPct = currentPrice > 0 ? (tech.atr14 / currentPrice) * 100 : 0;

  // 손절폭이 ATR의 N배 미만이면 너무 타이트 (빈번한 손절)
  // 모의투자: 0.3배 (완화), 실전: 0.5배
  const atrMultiplier = config.isPaper ? 0.3 : 0.5;
  if (atrPct > 0 && absStopLoss < atrPct * atrMultiplier) {
    return {
      passed: false,
      reason: `손절 너무 타이트: ${absStopLoss}% < ATR의 ${atrMultiplier}배(${(atrPct * atrMultiplier).toFixed(1)}%)`,
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
        AND closed_at >= NOW() - ($1 * INTERVAL '1 day')
        AND avg_buy_price > 0
    `, [days]);

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

  if (stats.totalTrades < 20) {
    // 데이터 부족 시 기본 통과 (20건 미만이면 통계적으로 의미 없음)
    return { passed: true, reason: `매매이력 부족(${stats.totalTrades}건) — 기본 통과`, expectedValue: 0 };
  }

  const winRate = stats.totalTrades > 0 ? stats.wins / stats.totalTrades : 0.5;
  const lossRate = 1 - winRate;
  const ev = winRate * stats.avgWinPct - lossRate * Math.abs(stats.avgLossPct);

  if (ev <= -2.0) {
    // EV가 -2% 이하일 때만 차단 (약간 음수는 단기 슬럼프로 허용)
    return {
      passed: false,
      reason: `기대값 심각: EV=${ev.toFixed(2)}% (승률${(winRate * 100).toFixed(0)}%, 평균익${stats.avgWinPct.toFixed(1)}%, 평균손${stats.avgLossPct.toFixed(1)}%)`,
      expectedValue: ev,
    };
  }

  // 승률 25% 미만이면 차단 (35% → 25%로 완화)
  if (winRate < 0.25) {
    return {
      passed: false,
      reason: `승률 과소: ${(winRate * 100).toFixed(0)}% (최소 25% 필요)`,
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
    // 모의투자는 최소 1주 허용 (실전 리스크 없음)
    if (config.isPaper) {
      return {
        passed: true,
        reason: `ATR 과대 → 모의투자 최소 1주 진입 (ATR=${currentATR.toLocaleString()})`,
        adjustedQuantity: 1,
      };
    }
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
//  [게이트 0] 진입 타이밍 필터 (핵심)
// ══════════════════════════════════════

/**
 * 전문 트레이더 관점의 진입 타이밍 검증
 *
 * "지금이 살 타이밍인가?" — 점수가 높아도 가격 위치가 나쁘면 차단
 *
 * 체크 항목:
 * 1. 고점 추격 방지 — 3일 고가 대비 1% 이내면 차단
 * 2. RSI 과매수 차단 — RSI 75+ 이면 조정 대기
 * 3. 연속 상승 후 조정 대기 — 3일 연속 상승 → 스윙 차단
 * 4. 캔들스틱 패턴 — V반등, 불리쉬인걸핑, 긴아래꼬리(망치형) 확인
 * 5. 오늘 캔들 내 위치 — 당일 고가 근처 종가 = 매도세 없음 (양호)
 *                         당일 저가 근처 종가 = 매도세 강함 (위험)
 */
export function entryTimingGate(input: GateInput): GateResult {
  const { candles, strategyMode } = input;

  if (candles.length < 6) {
    return { passed: true, reason: '데이터 부족 — 타이밍 게이트 스킵' };
  }

  const [c0, c1, c2, c3, c4] = candles; // c0 = 오늘(최신), 내림차순
  const current = c0.close;

  // ── 1. RSI 과매수 차단 ──
  const tech = analyzeTechnicals(candles);
  const rsi = tech?.rsi14 ?? 50;

  if (rsi >= 75) {
    return { passed: false, reason: `🔴 RSI 과매수 차단: ${rsi.toFixed(1)} ≥ 75 (과매수 구간 — 조정 대기)` };
  }

  // ── 2. 고점 추격 방지 (꼭지 매수 금지) ──
  const recent3High = Math.max(c0.high, c1.high, c2.high);
  const pctFromHigh = recent3High > 0 ? ((current - recent3High) / recent3High) * 100 : -5;

  // 3일 최고가와 동일 or 초과 = 신고가 돌파 시도 → 차단 (단순 근접은 허용)
  if (pctFromHigh >= 0) {
    return {
      passed: false,
      reason: `🔴 고점 추격 차단: 현재(${current.toLocaleString()}) ≥ 3일고가(${recent3High.toLocaleString()}) — 조정 후 재진입`,
    };
  }

  // ── 3. 3일 연속 상승 — 모멘텀 추세이므로 허용 (고점 추격은 #2에서 이미 차단) ──
  // (이전: SWING 모드 3일 연속 상승 시 차단 → 정상 상승추세도 막히는 문제 제거)

  // ── 4. 캔들스틱 패턴 분석 ──
  const body0 = Math.abs(c0.close - c0.open);
  const range0 = c0.high - c0.low;
  const bodyRatio0 = range0 > 0 ? body0 / range0 : 0;
  const lowerShadow0 = Math.min(c0.open, c0.close) - c0.low;
  const upperShadow0 = c0.high - Math.max(c0.open, c0.close);

  const isBullishCandle = c0.close >= c0.open; // 양봉
  const isHammer = range0 > 0 && lowerShadow0 / range0 > 0.5 && upperShadow0 / range0 < 0.2; // 망치형 (긴아래꼬리)
  const isBullishEngulfing = isBullishCandle && c0.open <= c1.close && c0.close >= c1.open && body0 > Math.abs(c1.close - c1.open); // 불리쉬 인걸핑
  const isVBounce = c1.close < c2.close && c0.close > c1.close; // V자 반등 (전일 하락 후 오늘 반등)

  // ── 5. 당일 캔들 내 종가 위치 ──
  // 오늘 저가 근처 종가 = 매도세 강함 → 낙하 중
  const closePositionInRange = range0 > 0 ? (c0.close - c0.low) / range0 : 0.5;
  const isFallingKnife = closePositionInRange < 0.1 && !isHammer; // 종가가 오늘 범위 하위 10% = 낙하 중

  if (isFallingKnife) {
    return {
      passed: false,
      reason: `🔴 낙하 중 매수 차단: 오늘 종가가 일중 저가 근처 (${(closePositionInRange * 100).toFixed(0)}%) — 하락 지속 위험`,
    };
  }

  // ── 6. 5일 저점 대비 위치 계산 ──
  const recent5Low = Math.min(c0.low, c1.low, c2.low, c3.low, c4.low);
  const pctFromLow = recent5Low > 0 ? ((current - recent5Low) / recent5Low) * 100 : 0;

  // 좋은 패턴 없이 저점에서 5% 이상 올라온 상태면 최적 타이밍 아님
  const hasGoodPattern = isVBounce || isBullishEngulfing || isHammer || isBullishCandle;
  const isTooFarFromLow = pctFromLow > 5 && rsi > 60;

  if (isTooFarFromLow && !hasGoodPattern) {
    if (config.isPaper) {
      // 모의투자: 경고만, 차단 안 함
      return {
        passed: true,
        reason: `⚠️ [모의투자] 최적 타이밍 아님: 5일저점+${pctFromLow.toFixed(1)}%, RSI=${rsi.toFixed(0)} — 실전에선 차단`,
      };
    }
    return {
      passed: false,
      reason: `🔴 진입 타이밍 부적합: 5일저점+${pctFromLow.toFixed(1)}%, RSI=${rsi.toFixed(0)}, 반등 패턴 없음`,
    };
  }

  // ── 통과 — 타이밍 사유 기록 ──
  const signals: string[] = [];
  if (isVBounce) signals.push('V반등');
  if (isBullishEngulfing) signals.push('인걸핑');
  if (isHammer) signals.push('망치형');
  if (isBullishCandle) signals.push('양봉');
  if (pctFromHigh < -3) signals.push(`고가대비${pctFromHigh.toFixed(1)}%`);
  if (pctFromLow < 3) signals.push(`저점근처+${pctFromLow.toFixed(1)}%`);

  return {
    passed: true,
    reason: `✅ 타이밍: ${signals.length > 0 ? signals.join('+') : `RSI=${rsi.toFixed(0)}, 고가대비${pctFromHigh.toFixed(1)}%`}`,
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

  // 고변동장: 수량 50% 축소 후 진입 허용 (실전/모의 공통 — 차단하면 거래 기회 완전 소실)
  if (regime === 'HIGH_VOLATILITY') {
    return {
      passed: true,
      reason: `고변동장: 수량 50% 축소 진입`,
      adjustedQuantity: Math.max(1, Math.floor(input.quantity * 0.5)),
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

  // 5연패 이상 + 마지막 손절 30분 이내 → 30분 쿨다운 (3연패 기준 제거 — 너무 잦은 차단)
  if (consecutive >= 5) {
    try {
      const pool = getPool();
      const { rows } = await pool.query(`
        SELECT closed_at FROM transaction_chains
        WHERE status = 'CLOSED'
        ORDER BY closed_at DESC LIMIT 1
      `);

      if (rows.length > 0) {
        const lastLoss = new Date(rows[0].closed_at);
        const cooldownMs = 30 * 60_000; // 30분 쿨다운
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

  // 0. 진입 타이밍 필터 (전문 트레이더 시야 — 고점 추격, RSI 과매수, 낙하중 매수 방지)
  const timing = entryTimingGate(input);
  if (!timing.passed) {
    logger.warn(`🚦 [타이밍] ${input.stockCode}: ${timing.reason}`, { component: 'TRADE_GATE' });
    return timing;
  }
  results.push(timing);

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
