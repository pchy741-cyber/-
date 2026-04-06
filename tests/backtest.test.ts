import { describe, it, expect } from 'vitest';
import { runBacktest } from '../src/backtest/engine.js';
import type { OHLCV } from '../src/analysis/indicators.js';

describe('백테스팅 엔진', () => {
  // 상승 추세 더미 데이터 (100일)
  function generateUptrend(days: number): OHLCV[] {
    return Array.from({ length: days }, (_, i) => {
      const base = 10000 + i * 50 + (Math.random() - 0.3) * 200;
      return {
        date: `2026-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 30) + 1).padStart(2, '0')}`,
        open: base - 30,
        high: base + 80,
        low: base - 80,
        close: base,
        volume: 100000 + Math.random() * 50000,
      };
    });
  }

  // 하락 추세
  function generateDowntrend(days: number): OHLCV[] {
    return Array.from({ length: days }, (_, i) => {
      const base = 15000 - i * 40 + (Math.random() - 0.5) * 200;
      return {
        date: `2026-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 30) + 1).padStart(2, '0')}`,
        open: base + 30,
        high: base + 80,
        low: base - 80,
        close: base,
        volume: 100000 + Math.random() * 50000,
      };
    });
  }

  it('상승장에서 수익', () => {
    const candles = generateUptrend(100);
    const result = runBacktest(candles, '005930', {
      mode: 'SWING',
      initialCapital: 1000000,
      buyThreshold: -100, // 항상 진입 (테스트용: 모든 시그널 수용)
    });

    expect(result.totalTrades).toBeGreaterThan(0);
    expect(result.finalCapital).toBeGreaterThan(0);
    // 상승장이므로 대체로 수익
    expect(result.totalReturnPct).toBeGreaterThan(-50); // 폭락은 아닌지
  });

  it('하락장에서 손실 제한', () => {
    const candles = generateDowntrend(100);
    const result = runBacktest(candles, '005930', {
      mode: 'DEFENSE',
      initialCapital: 1000000,
      buyThreshold: 30,
    });

    // DEFENSE 모드: 손절이 빠르므로 MDD가 제한되어야 함
    expect(result.maxDrawdownPct).toBeLessThan(50); // 50% 이상 안 빠짐
  });

  it('결과 필드 무결성', () => {
    const candles = generateUptrend(80);
    const result = runBacktest(candles, '005930', {
      mode: 'SWING',
      initialCapital: 1000000,
    });

    expect(result.wins + result.losses).toBeLessThanOrEqual(result.totalTrades);
    expect(result.winRate).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeLessThanOrEqual(100);
    expect(result.finalCapital).toBeGreaterThan(0);
    expect(result.dailyPnl.length).toBeGreaterThan(0);

    if (result.wins > 0) {
      expect(result.avgWinPct).toBeGreaterThan(0);
    }
    if (result.losses > 0) {
      expect(result.avgLossPct).toBeLessThanOrEqual(0);
    }
  });

  it('자본금 0 이하 불가', () => {
    const candles = generateDowntrend(100);
    const result = runBacktest(candles, '005930', {
      mode: 'SWING',
      initialCapital: 1000000,
    });

    // 어떤 상황에서도 자본금이 음수가 되면 안 됨
    for (const day of result.dailyPnl) {
      expect(day.equity).toBeGreaterThanOrEqual(0);
    }
  });
});
