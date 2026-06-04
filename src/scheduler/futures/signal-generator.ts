/**
 * 선물 기술적 신호 생성 — RSI/MACD + ATR (oscillators.ts 재사용)
 * MES(S&P), MNQ(Nasdaq) 마이크로 선물 대상
 */
import { analyzeTechnicals, type OHLCV } from '../../analysis/indicators.js';
import { getFuturesDailyChart, getFuturesPrice, MICRO_FUTURES, getActiveSymbol } from '../../kis/futures.js';
import { fetchExchangeRate } from '../../automation/macro-data.js';
import { getCtxIsPaper } from '../../config/context.js';
import { logger } from '../../utils/logger.js';
import { loadTunerParams } from './futures-tuner.js';
import type { FuturesSignal, FuturesTPSL } from './types.js';

const COMP = 'FUTURES';

/** MES/MNQ 2종목 스캔 → 유효 신호만 반환 */
export async function scanFuturesSignals(): Promise<FuturesSignal[]> {
  const signals: FuturesSignal[] = [];
  const tuner = await loadTunerParams(getCtxIsPaper());
  // 유동성 높은 2종목만 (MES=S&P, MNQ=Nasdaq)
  const targets = MICRO_FUTURES.filter(p => ['MES', 'MNQ'].includes(p.product));

  for (const product of targets) {
    try {
      const symbol = getActiveSymbol(product.product);
      const [price, chart] = await Promise.all([
        getFuturesPrice(symbol),
        getFuturesDailyChart(symbol, 40),
      ]);
      if (!price || chart.length < 30) continue;

      const candles: OHLCV[] = chart.map(c => ({
        date: c.date, open: c.open, high: c.high,
        low: c.low, close: c.close, volume: c.volume,
      }));
      const tech = analyzeTechnicals(candles);
      if (!tech) continue;

      // ── 진입 신호 판단 ──
      let direction: 'LONG' | 'SHORT' | null = null;
      let confidence = 0;
      const reasons: string[] = [];

      // LONG: RSI<40 + MACD히스토그램 양 + ADX>20 (추세 존재)
      if (tech.rsi14 < 40 && tech.macdHistogram > 0 && tech.adx14 > 20) {
        direction = 'LONG';
        confidence = 50;
        reasons.push(`RSI과매도(${tech.rsi14.toFixed(0)})`);
        if (tech.macdCrossover === 'BULLISH') { confidence += 15; reasons.push('MACD골든'); }
        if (tech.bollingerBreakout === 'UP') { confidence += 10; reasons.push('BB↑'); }
        if (tech.goldenCross) { confidence += 10; reasons.push('골든크로스'); }
        if (tech.trendStrength === 'STRONG') { confidence += 10; reasons.push('강추세'); }
      }
      // SHORT: RSI>60 + MACD히스토그램 음 + ADX>20
      else if (tech.rsi14 > 60 && tech.macdHistogram < 0 && tech.adx14 > 20) {
        direction = 'SHORT';
        confidence = 50;
        reasons.push(`RSI과매수(${tech.rsi14.toFixed(0)})`);
        if (tech.macdCrossover === 'BEARISH') { confidence += 15; reasons.push('MACD데드'); }
        if (tech.bollingerBreakout === 'DOWN') { confidence += 10; reasons.push('BB↓'); }
        if (tech.deathCross) { confidence += 10; reasons.push('데드크로스'); }
        if (tech.trendStrength === 'STRONG') { confidence += 10; reasons.push('강추세'); }
      }

      if (direction && confidence >= tuner.minConfidence) {
        signals.push({
          symbol, product: product.product, direction, confidence,
          rsi: tech.rsi14, macdHist: tech.macdHistogram, atrPct: tech.atrPct,
          reason: reasons.join('+'),
        });
        logger.info(
          `📈 선물신호: ${symbol} ${direction} conf=${confidence} — ${reasons.join(', ')}`,
          { component: COMP },
        );
      }
    } catch (e: any) {
      logger.warn(`선물 스캔 실패 ${product.product}: ${e.message}`, { component: COMP });
    }
  }
  return signals;
}

/** ATR 기반 동적 TP/SL 계산 — 튜너 배수 적용 */
export function calcFuturesTPSL(params: {
  entryPrice: number;
  direction: 'LONG' | 'SHORT';
  atrPct: number;
  tpMultiplier?: number;
  slMultiplier?: number;
}): FuturesTPSL {
  const { entryPrice, direction, atrPct, tpMultiplier = 2.0, slMultiplier = 1.5 } = params;
  const tpPct = Math.max(0.5, atrPct * tpMultiplier);
  const slPct = Math.max(0.3, atrPct * slMultiplier);

  const sign = direction === 'LONG' ? 1 : -1;
  return {
    tpPrice: +(entryPrice * (1 + sign * tpPct / 100)).toFixed(2),
    slPrice: +(entryPrice * (1 - sign * slPct / 100)).toFixed(2),
    tpPct, slPct,
  };
}

/** Kelly 기반 포지션 사이징 (1~5계약) */
export async function calcFuturesQty(params: {
  allocatedKrw: number;
  marginPerContract: number;
  winRate?: number;
  payoffRatio?: number;
}): Promise<number> {
  const { allocatedKrw, marginPerContract, winRate = 0.5, payoffRatio = 1.5 } = params;
  const fxRate = await fetchExchangeRate();
  const availableUsd = allocatedKrw / fxRate;
  if (availableUsd < marginPerContract) return 0;

  // Half-Kelly
  const kelly = ((payoffRatio * winRate) - (1 - winRate)) / payoffRatio;
  const halfKelly = Math.max(0, kelly * 0.5);
  const kellyContracts = Math.floor((availableUsd * halfKelly) / marginPerContract);

  return Math.min(5, Math.max(1, kellyContracts)); // 1~5계약
}
