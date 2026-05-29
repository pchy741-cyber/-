/**
 * 터틀 트레이딩 (Donchian Channel) — 해외주식 전용
 *
 * System 1 (단기): 20일 고점 돌파 진입 / 10일 저점 이탈 탈출
 * - 원리: 추세 초입 포착 → 고정 TP 없이 트렌드 끝까지 보유
 * - SL: 2×ATR (진입 시 확정, 이후 10일 저점으로 자동 추적)
 * - 포지션 크기: 포트폴리오 1% 리스크 / (2×ATR)
 *
 * 현재 눌림매매와 차별점:
 *  눌림매매: 이미 오른 종목에서 눌림 기다림 → 고점 진입 위험
 *  터틀:     신고점 돌파 확인 후 진입 → 추세 초입 진입
 */

export interface TurtleSignal {
  code: string;
  breakoutPct: number;    // 20일 고점 대비 돌파 %
  donchian20High: number; // 20일 최고가
  donchian10Low: number;  // 10일 최저가 (초기 SL 기준)
  atr: number;            // 절대값 ATR (달러)
  slPrice: number;        // 2×ATR SL 가격
  unitSize: number;       // 포트폴리오 1% / (2×ATR) = 주수
  isBreakout: boolean;    // 진입 신호 여부
}

interface OHLCV {
  high: number;
  low: number;
  close: number;
}

/**
 * 20일 Donchian Channel 계산 + 터틀 진입 신호 판단
 *
 * @param candles - 일봉 배열 (최신이 마지막, candles[len-1] = 가장 최근)
 * @param currentPrice - 현재 가격
 * @param portfolioUsd - 포트폴리오 총자산 (USD)
 */
export function calcTurtleSignal(
  candles: OHLCV[],
  currentPrice: number,
  portfolioUsd: number,
): TurtleSignal | null {
  if (candles.length < 21) return null;

  // 최신 캔들이 마지막 — 직전 20일 고점 (오늘 제외)
  const prev20 = candles.slice(-21, -1); // 오늘 제외 최근 20일
  const prev10 = candles.slice(-11, -1); // 오늘 제외 최근 10일

  if (prev20.length < 20 || prev10.length < 10) return null;

  const donchian20High = Math.max(...prev20.map(c => c.high));
  const donchian10Low = Math.min(...prev10.map(c => c.low));

  // ATR(14) 계산 (True Range 평균)
  const trs: number[] = [];
  for (let i = Math.max(1, candles.length - 15); i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    ));
  }
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;

  // 진입 신호: 현재가가 20일 고점 초과
  const isBreakout = currentPrice > donchian20High;
  const breakoutPct = ((currentPrice - donchian20High) / donchian20High) * 100;

  // SL: 진입가 기준 2×ATR 아래
  const slPrice = currentPrice - atr * 2;

  // 포지션 크기: 포트폴리오 1% 리스크 / (2×ATR)
  const riskPerUnit = portfolioUsd * 0.01; // 1% 리스크
  const unitSize = atr > 0 ? Math.floor(riskPerUnit / (atr * 2)) : 0;

  return {
    code: '',
    breakoutPct,
    donchian20High,
    donchian10Low,
    atr,
    slPrice,
    unitSize,
    isBreakout,
  };
}

/**
 * 터틀 탈출 신호: 현재가가 10일 최저가 이탈 시 탈출
 * (이후 보유 중 매 사이클 업데이트)
 */
export function isTurtleExit(
  currentPrice: number,
  donchian10Low: number,
): boolean {
  return currentPrice < donchian10Low;
}

/**
 * 터틀 트레일 스탑 업데이트: 10일 저점이 올라가면 스탑도 올림
 */
export function updateTurtleTrail(
  candles: OHLCV[],
  entryPrice: number,
): { trail10Low: number; isProfit: boolean } {
  if (candles.length < 11) return { trail10Low: entryPrice * 0.92, isProfit: false };
  const prev10 = candles.slice(-11, -1);
  const trail10Low = Math.min(...prev10.map(c => c.low));
  return { trail10Low, isProfit: trail10Low > entryPrice };
}
