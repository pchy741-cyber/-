import { describe, it, expect } from 'vitest';
import { sma, ema, rsi, macd, bollingerBands, analyzeTechnicals, type OHLCV } from '../src/analysis/indicators.js';

describe('기술적 지표 엔진', () => {
  const prices = [100, 102, 101, 103, 105, 104, 106, 108, 107, 110, 109, 111, 113, 112, 115];

  it('SMA 계산', () => {
    const result = sma(prices, 5);
    expect(result.length).toBe(prices.length - 4); // 15 - 5 + 1 = 11
    // 첫 SMA(5) = (100+102+101+103+105)/5 = 102.2
    expect(result[0]).toBeCloseTo(102.2, 1);
  });

  it('EMA 계산', () => {
    const result = ema(prices, 5);
    expect(result.length).toBeGreaterThan(0);
    // 첫 EMA = SMA(5)
    expect(result[0]).toBeCloseTo(102.2, 1);
  });

  it('RSI 범위 0~100', () => {
    const result = rsi(prices, 14);
    if (result.length > 0) {
      for (const val of result) {
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(100);
      }
    }
  });

  it('MACD 구조', () => {
    // 최소 26개 데이터 필요
    const longPrices = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const result = macd(longPrices);

    expect(result.macd.length).toBeGreaterThan(0);
    expect(result.signal.length).toBeGreaterThan(0);
    expect(result.histogram.length).toBeGreaterThan(0);
  });

  it('볼린저밴드: upper > middle > lower', () => {
    const longPrices = Array.from({ length: 30 }, (_, i) => 100 + i);
    const result = bollingerBands(longPrices, 20);

    expect(result.upper.length).toBeGreaterThan(0);
    for (let i = 0; i < result.upper.length; i++) {
      expect(result.upper[i]).toBeGreaterThan(result.middle[i]);
      expect(result.middle[i]).toBeGreaterThan(result.lower[i]);
    }
  });

  it('종합 분석 (60일 데이터 필요)', () => {
    // 60일 더미 캔들 생성
    const candles: OHLCV[] = Array.from({ length: 65 }, (_, i) => {
      const base = 10000 + Math.sin(i / 10) * 500 + i * 10;
      return {
        date: `2026-01-${String(i + 1).padStart(2, '0')}`,
        open: base - 50,
        high: base + 100,
        low: base - 100,
        close: base,
        volume: 100000 + Math.random() * 50000,
      };
    });

    const result = analyzeTechnicals(candles);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.score).toBeGreaterThanOrEqual(-100);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.rsi14).toBeGreaterThanOrEqual(0);
      expect(result.rsi14).toBeLessThanOrEqual(100);
      expect(['STRONG_BUY', 'BUY', 'NEUTRAL', 'SELL', 'STRONG_SELL']).toContain(result.overallSignal);
    }
  });

  it('데이터 부족 시 null 반환', () => {
    const shortCandles: OHLCV[] = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-01-${i + 1}`, open: 100, high: 110, low: 90, close: 100, volume: 1000,
    }));
    expect(analyzeTechnicals(shortCandles)).toBeNull();
  });
});
