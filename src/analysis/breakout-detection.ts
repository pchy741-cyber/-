/**
 * 돌파매매 감지 엔진 — 4가지 서브전략
 *
 * A. 차트박사 5일선 돌파: 60일 신고가 → 20MA 눌림 → 5MA 상향돌파
 * B. 래리 윌리엄스 변동성 돌파: 당일시가 + 전일range × K
 * C. 미너비니 SEPA: 150>200MA 상승, 52주저+25%, 횡보후 돌파
 * D. 다바스 박스 돌파: 박스 상단 돌파 + 거래량 확인
 *
 * 크로스오염 방지: indicators.ts 직접 import 없음.
 * 순수 수학 함수(sma, atr)만 사용.
 */

import type { DailyCandle } from '../kis/market.js';
import { sma } from './moving-averages.js';
import { cmf, obv } from './oscillators.js';

// ── 타입 정의 ──────────────────────────────────────────────────────────

export type BreakoutSubStrategy =
  | 'CHART_DOCTOR_5MA' // 차트박사 5일선 돌파
  | 'WILLIAMS_VOLATILITY' // 래리 윌리엄스 변동성 돌파
  | 'MINERVINI_SEPA' // 마크 미너비니 SEPA
  | 'DARVAS_BOX'; // 다바스 박스 돌파

export interface BreakoutSignal {
  detected: boolean;
  subStrategy: BreakoutSubStrategy | null;
  confidence: number; // 0-1
  volumeConfirmed: boolean; // 거래량 1.5x+ 확인
  details: BreakoutDetails;
  reason: string;
}

export interface BreakoutDetails {
  breakoutPrice: number; // 돌파 기준가
  currentPrice: number;
  volumeRatio: number;

  // Chart Doctor (5MA)
  isNew60DayHigh?: boolean;
  pullbackTo20MA?: boolean;
  above5MA?: boolean;

  // Williams
  kFactor?: number;
  prevDayRange?: number;
  entryPrice?: number; // open + range * K

  // Minervini SEPA
  above150MA?: boolean;
  above200MA?: boolean;
  ma150Above200?: boolean;
  ma200Uptrend?: boolean;
  from52WeekLow?: number; // % above 52-week low
  from52WeekHigh?: number; // % below 52-week high

  // Darvas Box
  boxHigh?: number;
  boxLow?: number;
  boxDays?: number;
}

// ── 헬퍼 ────────────────────────────────────────────────────────────────

const VOLUME_CONFIRM_RATIO = 1.5;

function avgVolume(candles: DailyCandle[], days: number): number {
  if (days <= 0) return 0;
  const slice = candles.slice(-days);
  if (slice.length === 0) return 0;
  return slice.reduce((s, c) => s + c.volume, 0) / slice.length;
}

function emptySignal(): BreakoutSignal {
  return {
    detected: false,
    subStrategy: null,
    confidence: 0,
    volumeConfirmed: false,
    details: { breakoutPrice: 0, currentPrice: 0, volumeRatio: 0 },
    reason: '',
  };
}

// ── A. 차트박사 5일선 돌파 ──────────────────────────────────────────────
//
// 규칙:
// 1. 최근 10일 내 60일 신고가 달성 이력
// 2. 현재가가 우상향 20MA 부근까지 눌림 (±3%)
// 3. 현재가 > 5일 SMA (상향 돌파)
// 4. 거래량 ≥ 1.5x (20일 평균)
// 5. SL: -5% 기계적 손절

export function detect5MABreakout(candles: DailyCandle[]): BreakoutSignal {
  if (candles.length < 62) return emptySignal();

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const currentPrice = closes[closes.length - 1];
  const currentVolume = candles[candles.length - 1].volume;

  // 5일/20일 SMA
  const sma5Arr = sma(closes, 5);
  const sma20Arr = sma(closes, 20);
  if (sma5Arr.length === 0 || sma20Arr.length === 0) return emptySignal();
  const sma5Now = sma5Arr[sma5Arr.length - 1];
  const sma20Now = sma20Arr[sma20Arr.length - 1];
  const sma20Prev = sma20Arr[sma20Arr.length - 6] ?? sma20Now; // 5일 전

  // 1. 60일 신고가 — 최근 10일 내 달성
  const lookback60 = highs.slice(-62, -2); // 2일 전까지의 60일
  const high60 = Math.max(...lookback60);
  const recentHighs = highs.slice(-10);
  const isNew60DayHigh = recentHighs.some((h) => h >= high60 * 0.99);

  // 2. 20MA 눌림 (현재가가 20MA ±3% 이내 OR 최근 5일 내 20MA 터치)
  const pullbackTo20MA = sma20Now > 0 && (
    Math.abs(currentPrice - sma20Now) / sma20Now <= 0.03 ||
    closes.slice(-5).some((c) => Math.abs(c - sma20Now) / sma20Now <= 0.02));

  // 20MA 우상향 확인
  const ma20Rising = sma20Now > sma20Prev;

  // 3. 5MA 상향 돌파
  const above5MA = currentPrice > sma5Now;
  const prevClose = closes[closes.length - 2] ?? currentPrice;
  const prevSma5 = sma5Arr[sma5Arr.length - 2] ?? sma5Now;
  const crossedAbove5MA = above5MA && prevClose <= prevSma5 * 1.002;

  // 4. 거래량 확인
  const avg20Vol = avgVolume(candles.slice(-21, -1), 20);
  const volumeRatio = avg20Vol > 0 ? currentVolume / avg20Vol : 0;
  const volumeConfirmed = volumeRatio >= VOLUME_CONFIRM_RATIO;

  // 종합 판정
  const detected = isNew60DayHigh && pullbackTo20MA && ma20Rising && (above5MA || crossedAbove5MA) && volumeConfirmed;

  // 신뢰도 계산
  let confidence = 0;
  if (detected) {
    confidence = 0.5;
    if (crossedAbove5MA) confidence += 0.1; // 크로스 시점 가산
    if (volumeRatio >= 2.0) confidence += 0.1; // 거래량 폭증
    if (ma20Rising) confidence += 0.1; // 추세 확인
    if (currentPrice > sma20Now * 1.01) confidence += 0.1; // 눌림 반등
    confidence = Math.min(1.0, confidence);
  }

  return {
    detected,
    subStrategy: detected ? 'CHART_DOCTOR_5MA' : null,
    confidence,
    volumeConfirmed,
    details: {
      breakoutPrice: sma5Now,
      currentPrice,
      volumeRatio,
      isNew60DayHigh,
      pullbackTo20MA,
      above5MA,
    },
    reason: detected
      ? `5MA breakout: 60d-high=${isNew60DayHigh} pullback20MA=${pullbackTo20MA} above5MA=${above5MA} vol=${volumeRatio.toFixed(1)}x`
      : '',
  };
}

// ── B. 래리 윌리엄스 변동성 돌파 ────────────────────────────────────────
//
// 규칙:
// 1. 전일 range = high - low
// 2. K-factor = 적응형 (최근 20일 돌파 성공률 기반, 0.4~0.8)
// 3. 진입: 현재가 ≥ 당일시가 + range × K
// 4. 청산: 익일 장시작 매도 (sell-signals에서 처리)

export function detectWilliamsBreakout(candles: DailyCandle[]): BreakoutSignal {
  if (candles.length < 20) return emptySignal();

  const today = candles[candles.length - 1];
  const yesterday = candles[candles.length - 2];
  const currentPrice = today.close;

  // 전일 range
  const prevDayRange = yesterday.high - yesterday.low;
  if (prevDayRange <= 0) return emptySignal();

  // K-factor 적응형 계산 (최근 20일 기반)
  const kFactor = computeAdaptiveK(candles.slice(-21, -1));

  // 돌파 기준가
  const entryPrice = today.open + prevDayRange * kFactor;

  // 현재가가 돌파 기준 이상
  const breakoutDetected = currentPrice >= entryPrice && currentPrice > today.open;

  // 추가 안전장치: 당일 하락 캔들이면 제외 (시가 대비 너무 낮으면)
  const dayReturn = today.open > 0 ? (currentPrice - today.open) / today.open : 0;
  if (dayReturn < 0) return emptySignal();

  // 거래량 (선택적이지만 확인)
  const avg20Vol = avgVolume(candles.slice(-21, -1), 20);
  const volumeRatio = avg20Vol > 0 ? today.volume / avg20Vol : 0;
  const volumeConfirmed = volumeRatio >= 1.2; // Williams는 1.2x로 완화

  // 종합
  const detected = breakoutDetected && volumeConfirmed;

  let confidence = 0;
  if (detected) {
    confidence = 0.5;
    const breakoutStrength = (currentPrice - entryPrice) / entryPrice;
    if (breakoutStrength > 0.005) confidence += 0.1;
    if (breakoutStrength > 0.01) confidence += 0.1;
    if (volumeRatio >= 1.5) confidence += 0.1;
    if (volumeRatio >= 2.0) confidence += 0.1;
    confidence = Math.min(1.0, confidence);
  }

  return {
    detected,
    subStrategy: detected ? 'WILLIAMS_VOLATILITY' : null,
    confidence,
    volumeConfirmed,
    details: {
      breakoutPrice: entryPrice,
      currentPrice,
      volumeRatio,
      kFactor,
      prevDayRange,
      entryPrice,
    },
    reason: detected
      ? `Williams VB: entry=${entryPrice.toFixed(0)} K=${kFactor.toFixed(2)} range=${prevDayRange.toFixed(0)} vol=${volumeRatio.toFixed(1)}x`
      : '',
  };
}

/** K-factor 적응형 (최근 20일 돌파 성공률 기반 0.4~0.8) */
function computeAdaptiveK(candles: DailyCandle[]): number {
  if (candles.length < 10) return 0.6;

  let bestK = 0.6;
  let bestWinRate = 0;

  for (const k of [0.4, 0.5, 0.6, 0.7, 0.8]) {
    let wins = 0;
    let total = 0;

    for (let i = 1; i < candles.length; i++) {
      const prevRange = candles[i - 1].high - candles[i - 1].low;
      const entry = candles[i].open + prevRange * k;

      if (candles[i].high >= entry) {
        total++;
        // 익일 시가 매도 기준 수익 확인
        if (i + 1 < candles.length) {
          const sellPrice = candles[i + 1].open;
          if (sellPrice > entry * 1.002) wins++; // 수수료 감안 0.2%+
        }
      }
    }

    const winRate = total > 0 ? wins / total : 0;
    if (winRate > bestWinRate) {
      bestWinRate = winRate;
      bestK = k;
    }
  }

  return bestK;
}

// ── C. 미너비니 SEPA ────────────────────────────────────────────────────
//
// 8가지 기준 (Mark Minervini):
// 1. 현재가 > 150일 SMA
// 2. 현재가 > 200일 SMA
// 3. 150일 SMA > 200일 SMA
// 4. 200일 SMA 최소 1개월 상승 추세
// 5. 52주 저점 대비 +25% 이상
// 6. 52주 고점 대비 -25% 이내 (신고점 근처)
// 7. RS(상대강도) > 70 — RSI + 모멘텀으로 대체
// 8. 최근 횡보 후 돌파 (20일 고점 돌파)

export function detectMinerviniSEPA(candles: DailyCandle[]): BreakoutSignal {
  if (candles.length < 200) return emptySignal();

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const currentPrice = closes[closes.length - 1];
  const currentVolume = candles[candles.length - 1].volume;

  // SMA 계산
  const sma150Arr = sma(closes, 150);
  const sma200Arr = sma(closes, 200);
  if (sma150Arr.length === 0 || sma200Arr.length === 0) return emptySignal();
  const sma150Now = sma150Arr[sma150Arr.length - 1];
  const sma200Now = sma200Arr[sma200Arr.length - 1];

  // 기준 1-3
  const above150MA = currentPrice > sma150Now;
  const above200MA = currentPrice > sma200Now;
  const ma150Above200 = sma150Now > sma200Now;

  // 기준 4: 200MA 1개월(22거래일) 상승 추세
  const sma200OneMonthAgo = sma200Arr[sma200Arr.length - 23] ?? sma200Now;
  const ma200Uptrend = sma200Now > sma200OneMonthAgo;

  // 기준 5-6: 52주(252거래일) 고저
  const lookback = Math.min(252, candles.length);
  const low52Week = Math.min(...lows.slice(-lookback));
  const high52Week = Math.max(...highs.slice(-lookback));

  const from52WeekLow = low52Week > 0 ? ((currentPrice - low52Week) / low52Week) * 100 : 0;
  const from52WeekHigh = high52Week > 0 ? ((currentPrice - high52Week) / high52Week) * 100 : 0;

  const above25FromLow = from52WeekLow >= 25;
  const within25FromHigh = from52WeekHigh >= -25;

  // 기준 7: 상대강도 (모멘텀으로 대체 — 60일 수익률 상위)
  const price60DaysAgo = closes[closes.length - 61] ?? closes[0];
  const momentum60d = price60DaysAgo > 0 ? ((currentPrice - price60DaysAgo) / price60DaysAgo) * 100 : 0;
  const strongMomentum = momentum60d > 10; // 60일간 +10% 이상

  // 기준 8: 최근 20일 고점 돌파 (횡보 후 돌파)
  const recent20Highs = highs.slice(-21, -1);
  const high20d = Math.max(...recent20Highs);
  const breakingOut = currentPrice > high20d;

  // 거래량 확인
  const avg20Vol = avgVolume(candles.slice(-21, -1), 20);
  const volumeRatio = avg20Vol > 0 ? currentVolume / avg20Vol : 0;
  const volumeConfirmed = volumeRatio >= VOLUME_CONFIRM_RATIO;

  // 통과 기준 수 계산 (8개 중 6개 이상)
  const criteria = [
    above150MA,
    above200MA,
    ma150Above200,
    ma200Uptrend,
    above25FromLow,
    within25FromHigh,
    strongMomentum,
    breakingOut,
  ];
  const passedCount = criteria.filter(Boolean).length;

  // 최소 핵심 6개 + 돌파 확인 + 거래량
  const detected = passedCount >= 6 && breakingOut && volumeConfirmed;

  let confidence = 0;
  if (detected) {
    confidence = 0.4 + passedCount * 0.075; // 6개=0.85, 7개=0.925, 8개=1.0
    if (volumeRatio >= 2.0) confidence += 0.05;
    confidence = Math.min(1.0, confidence);
  }

  return {
    detected,
    subStrategy: detected ? 'MINERVINI_SEPA' : null,
    confidence,
    volumeConfirmed,
    details: {
      breakoutPrice: high20d,
      currentPrice,
      volumeRatio,
      above150MA,
      above200MA,
      ma150Above200,
      ma200Uptrend,
      from52WeekLow,
      from52WeekHigh,
    },
    reason: detected
      ? `SEPA: ${passedCount}/8 criteria, 52wk-low+${from52WeekLow.toFixed(0)}% high${from52WeekHigh.toFixed(0)}% 20d-break=${breakingOut} vol=${volumeRatio.toFixed(1)}x`
      : '',
  };
}

// ── D. 다바스 박스 돌파 ─────────────────────────────────────────────────
//
// 규칙:
// 1. 박스 형성: 최근 N일(최소 5일) 고점이 3일 연속 비초과
// 2. 박스 하단: 박스 고점 확립 후 최저점
// 3. 돌파: 현재가 > 박스 상단
// 4. 거래량 ≥ 1.5x

export function detectDarvasBox(candles: DailyCandle[]): BreakoutSignal {
  if (candles.length < 30) return emptySignal();

  const currentPrice = candles[candles.length - 1].close;
  const currentVolume = candles[candles.length - 1].volume;

  // 박스 상단 찾기: 최근 30일 내에서 고점 → 3일 연속 비초과
  let boxHigh = 0;
  let boxHighIdx = -1;

  // 5~25일 전 범위에서 박스 상단 탐색
  for (let i = candles.length - 6; i >= Math.max(0, candles.length - 26); i--) {
    const candidateHigh = candles[i].high;
    let confirmed = true;

    // 이후 3일간 이 고점을 초과하지 않아야 함
    for (let j = i + 1; j <= Math.min(i + 3, candles.length - 2); j++) {
      if (candles[j].high > candidateHigh * 1.002) {
        confirmed = false;
        break;
      }
    }

    if (confirmed && candidateHigh > boxHigh) {
      boxHigh = candidateHigh;
      boxHighIdx = i;
    }
  }

  if (boxHighIdx < 0 || boxHigh <= 0) return emptySignal();

  // 박스 하단: 박스 고점 확립 후 ~ 오늘 전날까지의 최저점
  const boxLows = candles.slice(boxHighIdx, -1).map((c) => c.low);
  const boxLow = boxLows.length > 0 ? Math.min(...boxLows) : 0;

  // 박스 기간 (최소 5일)
  const boxDays = candles.length - 1 - boxHighIdx;
  if (boxDays < 5) return emptySignal();

  // 박스 폭 검증 (너무 넓으면 의미 없음 — 10% 이내)
  const boxWidth = boxHigh > 0 ? ((boxHigh - boxLow) / boxHigh) * 100 : 100;
  if (boxWidth > 12) return emptySignal();

  // 돌파 확인: 현재가 > 박스 상단
  const breakoutDetected = currentPrice > boxHigh;

  // 거래량 확인
  const avg20Vol = avgVolume(candles.slice(-21, -1), 20);
  const volumeRatio = avg20Vol > 0 ? currentVolume / avg20Vol : 0;
  const volumeConfirmed = volumeRatio >= VOLUME_CONFIRM_RATIO;

  const detected = breakoutDetected && volumeConfirmed;

  let confidence = 0;
  if (detected) {
    confidence = 0.5;
    // 박스 기간이 길수록 신뢰도 높음 (압축 에너지)
    if (boxDays >= 10) confidence += 0.1;
    if (boxDays >= 15) confidence += 0.1;
    // 돌파 강도
    const breakoutStrength = (currentPrice - boxHigh) / boxHigh;
    if (breakoutStrength > 0.01) confidence += 0.1;
    // 거래량
    if (volumeRatio >= 2.0) confidence += 0.1;
    // 박스 폭이 좁을수록 신뢰도 높음 (타이트 압축)
    if (boxWidth <= 5) confidence += 0.1;
    confidence = Math.min(1.0, confidence);
  }

  return {
    detected,
    subStrategy: detected ? 'DARVAS_BOX' : null,
    confidence,
    volumeConfirmed,
    details: {
      breakoutPrice: boxHigh,
      currentPrice,
      volumeRatio,
      boxHigh,
      boxLow,
      boxDays,
    },
    reason: detected
      ? `Darvas: box=${boxDays}d [${boxLow.toFixed(0)}~${boxHigh.toFixed(0)}] width=${boxWidth.toFixed(1)}% break=${currentPrice.toFixed(0)} vol=${volumeRatio.toFixed(1)}x`
      : '',
  };
}

// ── 마스터 함수 ─────────────────────────────────────────────────────────
//
// 우선순위: MINERVINI > DARVAS > CHART_DOCTOR_5MA > WILLIAMS
// - SEPA: 장기 추세 + 펀더멘털 기반 — 가장 높은 기대수익
// - Darvas: 중기 박스 돌파 — 명확한 구조
// - 5MA: 단기 눌림목 돌파 — 높은 승률
// - Williams: 당일 변동성 — 빠르지만 노이즈 많음

export function analyzeBreakoutSignals(candles: DailyCandle[]): BreakoutSignal {
  let result: BreakoutSignal | null = null;

  // 1. 미너비니 SEPA (200일+ 필요)
  if (!result && candles.length >= 200) {
    const sepa = detectMinerviniSEPA(candles);
    if (sepa.detected) result = sepa;
  }

  // 2. 다바스 박스 (30일+ 필요)
  if (!result && candles.length >= 30) {
    const darvas = detectDarvasBox(candles);
    if (darvas.detected) result = darvas;
  }

  // 3. 차트박사 5일선 (62일+ 필요)
  if (!result && candles.length >= 62) {
    const chart5ma = detect5MABreakout(candles);
    if (chart5ma.detected) result = chart5ma;
  }

  // 4. 래리 윌리엄스 (20일+ 필요)
  if (!result && candles.length >= 20) {
    const williams = detectWilliamsBreakout(candles);
    if (williams.detected) result = williams;
  }

  if (!result) return emptySignal();

  // v11: OBV + CMF 가짜 돌파 필터
  // 돌파 감지 후 OBV/CMF로 매집/분산 검증 — 불일치 시 신뢰도 감점
  if (candles.length >= 20) {
    const ohlcvAsc = [...candles].reverse().map(c => ({
      date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    }));
    const obvRes = obv(ohlcvAsc);
    const cmfRes = cmf(ohlcvAsc, 20);

    // OBV 하락 + CMF 유출 = 가짜 돌파 가능성 높음 → 신뢰도 대폭 감점
    if (obvRes.trend === 'FALLING' && cmfRes.signal === 'OUTFLOW') {
      result.confidence = Math.max(0, result.confidence - 0.25);
      result.reason += ` [⚠️ OBV↓+CMF유출: 가짜돌파 위험, 신뢰도 -25%p]`;
    }
    // OBV 하락만 = 약한 경고
    else if (obvRes.trend === 'FALLING') {
      result.confidence = Math.max(0, result.confidence - 0.10);
      result.reason += ` [OBV↓: 매집 약화 -10%p]`;
    }
    // CMF 유출만 = 약한 경고
    else if (cmfRes.signal === 'OUTFLOW' && cmfRes.strength >= 0.5) {
      result.confidence = Math.max(0, result.confidence - 0.10);
      result.reason += ` [CMF유출: 자금이탈 -10%p]`;
    }
    // OBV 상승 + CMF 유입 = 진짜 돌파 확인 → 신뢰도 소폭 가점
    else if (obvRes.trend === 'RISING' && cmfRes.signal === 'INFLOW') {
      result.confidence = Math.min(1.0, result.confidence + 0.05);
      result.reason += ` [OBV↑+CMF유입: 매집 확인 +5%p]`;
    }

    // 신뢰도가 감점으로 0.5 미만이면 돌파 무효화
    if (result.confidence < 0.5) {
      return emptySignal();
    }
  }

  return result;
}
