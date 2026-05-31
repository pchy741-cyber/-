/**
 * 터틀 트레이딩 (Donchian Channel) — 해외주식 전용
 * System 1: 20일 고점 돌파 진입 / 10일 저점 이탈 탈출
 */
import { OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { modePrefix } from './utils.js';
import { updateTradeState, cleanupPositionState } from './state.js';
import { executeOverseasOrder } from './executor.js';
import type { TechResult, Holding } from './sell-logic.js';

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

/**
 * 터틀 탈출 체크: 보유 종목이 10일 저점 이탈 시 전량 매도
 * overseas-job.ts에서 추출
 */
export async function processTurtleExits(params: {
  holdings: Map<string, Holding>;
  pendingOrderStocks: Set<string>;
  sellOrders: string[];
  techResults: TechResult[];
  cash: number;
  isPaper: boolean;
}): Promise<{ cash: number }> {
  const { holdings, pendingOrderStocks, sellOrders, techResults, isPaper } = params;
  let { cash } = params;
  const pfx = modePrefix(isPaper);

  for (const [code, holding] of holdings) {
    if (pendingOrderStocks.has(code)) continue;
    if (sellOrders.some(s => s.includes(code))) continue;
    const turtleTrailKey = `${pfx}turtle_trail_${code}`;
    const { rows: trailRows } = await getPool().query(
      'SELECT value FROM overseas_state WHERE key = $1', [turtleTrailKey]
    ).catch(() => ({ rows: [] as { value: string }[] }));
    if (trailRows.length === 0) continue;
    const trailLow = Number(trailRows[0].value);
    const tech = techResults.find(t => t.code === code);
    if (!tech || trailLow <= 0) continue;
    if (isTurtleExit(tech.price.currentPrice, trailLow)) {
      logger.info(`🐢 터틀 탈출: ${code} $${tech.price.currentPrice.toFixed(2)} < 10일저점$${trailLow.toFixed(2)}`, { component: 'OVERSEAS' });
      const exec = await executeOverseasOrder(code, 'SELL', holding.qty, tech.price.currentPrice, tech.exchange,
        `터틀 탈출: 10일 저점($${trailLow.toFixed(2)}) 이탈`, holding.qty, holding.avgPrice, { isPaper });
      if (exec.submitted && exec.filledQty > 0) {
        const proceeds = exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
        cash += proceeds;
        await updateTradeState({ code, exchange: tech.exchange, qty: exec.finalQty, avgPrice: exec.finalAvgPrice, newCash: cash, isPaper });
        if (exec.finalQty <= 0) await cleanupPositionState(code, isPaper);
        const pnlPct = holding.avgPrice > 0 ? ((exec.filledPrice - holding.avgPrice) / holding.avgPrice * 100) : 0;
        sellOrders.push(`🐢 터틀탈출 ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`);
      }
    } else {
      const latestTrail = Math.max(trailLow, tech.price.dayLow);
      if (latestTrail > trailLow) {
        getPool().query(`INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
          [turtleTrailKey, latestTrail.toString()]).catch(() => {});
      }
    }
  }
  return { cash };
}
