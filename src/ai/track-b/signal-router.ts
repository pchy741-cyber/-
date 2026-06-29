/**
 * Signal Router — 종목 성격 분류기
 *
 * 진입 전 종목을 두 궤도로 분류:
 *   TREND_LEADER  : 60일 신고가 + 폭발적 거래량 주도주 → 트레일링 스탑 홀딩, 1% 조기청산 금지
 *   SCALP_TARGET  : 거래대금 1000억+ + 박스권 순환 → 1% 단기익절 + 꺾인포인트 재진입
 *   STANDARD      : 나머지 → 기존 SWING/BREAKOUT 로직
 *
 * CEO 지시 (2026-06-17): 추세추종 vs 역추세 이중궤도로 수익 극대화
 */

import { sma } from '../../analysis/moving-averages.js';
import { rsi } from '../../analysis/oscillators.js';
import { TRADING_VALUE } from '../../config/constants.js';
import type { DailyCandle } from '../../kis/market.js';

// ── 박스권(SCALP_TARGET) 판별 임계값 ──
const RANGE_RATIO_MAX = 0.14;  // 20일 고-저 범위 / 중심가 (14% 초과 = 방향성 종목)
const RSI_RANGE_LOW = 25;      // RSI 하한 (이 아래 = 극단 과매도, 박스권 아님)
const RSI_RANGE_HIGH = 75;     // RSI 상한 (이 위 = 극단 과매수, 박스권 아님)

export type StockClass = 'TREND_LEADER' | 'SCALP_TARGET' | 'STANDARD';

export interface SignalRouterResult {
  class: StockClass;
  reason: string;
  /** TREND_LEADER: TP% 유지 / SCALP_TARGET: 1% 인트라데이 익절 */
  suggestedTp: number;
  /** TREND_LEADER: 트레일링 스탑 / SCALP_TARGET: -0.5% 타이트 */
  suggestedSl: number;
}

/**
 * 60일 신고가 돌파 + 거래량 폭발 주도주 판별
 * — detect5MABreakout과 동일 기준 (60D high + vol 3x)
 */
function isTrendLeader(candles: DailyCandle[], tradingValue: number): boolean {
  if (candles.length < 62) return false;
  const highs = candles.map((c) => c.high);
  const volumes = candles.map((c) => c.volume);
  const closes = candles.map((c) => c.close);

  // 60일 최고가 (최근 2일 제외)
  const high60 = Math.max(...highs.slice(-62, -2));
  // 최근 5일 이내에 60일 신고가 달성
  const recentHighs = highs.slice(-5);
  const isNew60High = recentHighs.some((h) => h >= high60 * 0.99);
  if (!isNew60High) return false;

  // v16.1: 거래량 폭발 기준 완화 (2.5→2.0, 더 많은 주도주 포착)
  const avgVol20 = volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
  const todayVol = volumes[volumes.length - 1];
  const isVolExplosion = avgVol20 > 0 && todayVol / avgVol20 >= 2.0;

  // 20MA 상승추세
  const sma20Arr = sma(closes, 20);
  const sma20Now = sma20Arr[sma20Arr.length - 1];
  const sma20Prev = sma20Arr.length >= 6 ? sma20Arr[sma20Arr.length - 6] : sma20Now;
  const ma20Rising = sma20Now > sma20Prev;

  // 거래대금 500억+ (슬리피지 방지)
  const bigEnough = tradingValue >= TRADING_VALUE.SURGE_MIN;

  return isNew60High && isVolExplosion && ma20Rising && bigEnough;
}

/**
 * 박스권 순환 종목 판별
 * — 60일 신고가 없음 + 거래대금 1000억+ + ATR% 좁음 + 고가/저가 범위 타이트
 */
function isScalpTarget(candles: DailyCandle[], tradingValue: number): boolean {
  if (candles.length < 22) return false;

  // 거래대금 1000억 이상 — 슬리피지 극복 (1% 짧게 먹으려면 호가창 두꺼워야)
  if (tradingValue < 100_000_000_000) return false;

  // 60일 신고가 달성 이력 없음 (최근 10일)
  if (candles.length >= 62) {
    const highs = candles.map((c) => c.high);
    const high60 = Math.max(...highs.slice(-62, -2));
    const recentHighs = highs.slice(-10);
    if (recentHighs.some((h) => h >= high60 * 0.99)) return false; // 신고가 = TREND_LEADER 후보
  }

  // 박스권 판단: 최근 20일 고-저 범위가 중심가 ±7% 이내
  const recent20 = candles.slice(-20);
  const recent20High = Math.max(...recent20.map((c) => c.high));
  const recent20Low = Math.min(...recent20.map((c) => c.low));
  const midPrice = (recent20High + recent20Low) / 2;
  const rangeRatio = midPrice > 0 ? (recent20High - recent20Low) / midPrice : 0.2;
  if (rangeRatio > RANGE_RATIO_MAX) return false; // 범위 초과 = 방향성 있는 종목

  // RSI 과매도/과매수 범위 내 순환 중 (30~70 사이에서 반복)
  const closes = candles.map((c) => c.close).reverse();
  const rsiArr = rsi([...closes].reverse(), 14);
  if (rsiArr.length === 0) return false;
  const rsiNow = rsiArr[rsiArr.length - 1];
  // 박스권 종목: RSI가 30~70 내에서 진동하는 게 특징 (극단값 아님)
  if (rsiNow < RSI_RANGE_LOW || rsiNow > RSI_RANGE_HIGH) return false; // 이미 극단 = 방향성 발생 중

  return true;
}

/**
 * 종목 성격 분류
 *
 * @param candles 일봉 데이터 (최근 순 or 오래된 순 — 자동 감지)
 * @param tradingValue 당일 거래대금 (원)
 */
export function classifyStock(candles: DailyCandle[], tradingValue: number): SignalRouterResult {
  if (candles.length < 22) {
    return { class: 'STANDARD', reason: '데이터 부족', suggestedTp: 5, suggestedSl: -2.5 };
  }

  if (isTrendLeader(candles, tradingValue)) {
    return {
      class: 'TREND_LEADER',
      reason: '60일 신고가+거래량폭발+MA상승 주도주 — 트레일링 스탑 홀딩',
      suggestedTp: 10, // 트레일링으로 최대한 홀딩
      suggestedSl: -5,
    };
  }

  if (isScalpTarget(candles, tradingValue)) {
    return {
      class: 'SCALP_TARGET',
      reason: '박스권 순환+거래대금1000억+ — 1% 단기익절 + 꺾인포인트 재진입',
      suggestedTp: 1.0,
      suggestedSl: -0.5,
    };
  }

  return { class: 'STANDARD', reason: '일반 종목', suggestedTp: 5, suggestedSl: -2.5 };
}
