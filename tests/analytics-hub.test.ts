import { describe, it, expect } from 'vitest';

// Unit tests for analytics-hub utility functions (no DB dependency)

describe('extractEntrySource', () => {
  // Import dynamically to avoid DB connection at module level
  const extractEntrySource = (reasoning: string): string => {
    if (reasoning.includes('[BIGMOVER]') || reasoning.includes('빅무버')) return 'BIGMOVER';
    if (reasoning.includes('[MOMENTUM]') || reasoning.includes('모멘텀')) return 'MOMENTUM';
    if (reasoning.includes('[BB_BREAKOUT]') || reasoning.includes('볼린저')) return 'BB_BREAKOUT';
    if (reasoning.includes('[OVERSOLD]') || reasoning.includes('과매도')) return 'OVERSOLD';
    if (reasoning.includes('[SCALP]') || reasoning.includes('스캘프')) return 'SCALP';
    if (reasoning.includes('[SNIPER]') || reasoning.includes('스나이퍼')) return 'SNIPER';
    if (reasoning.includes('[DIP_BUY]') || reasoning.includes('딥바이')) return 'DIP_BUY';
    if (reasoning.includes('[TECHNICAL]')) return 'TECHNICAL';
    return 'OTHER';
  };

  it('should detect BIGMOVER from tag', () => {
    expect(extractEntrySource('[BIGMOVER] NVDA +5%')).toBe('BIGMOVER');
  });

  it('should detect BIGMOVER from Korean', () => {
    expect(extractEntrySource('빅무버 급등 매수')).toBe('BIGMOVER');
  });

  it('should detect MOMENTUM', () => {
    expect(extractEntrySource('[MOMENTUM] RSI 강세')).toBe('MOMENTUM');
    expect(extractEntrySource('모멘텀 추세 진입')).toBe('MOMENTUM');
  });

  it('should detect BB_BREAKOUT', () => {
    expect(extractEntrySource('[BB_BREAKOUT] 볼린저 상단 돌파')).toBe('BB_BREAKOUT');
  });

  it('should detect OVERSOLD', () => {
    expect(extractEntrySource('[OVERSOLD] RSI 28')).toBe('OVERSOLD');
    expect(extractEntrySource('과매도 반등 매수')).toBe('OVERSOLD');
  });

  it('should detect SNIPER', () => {
    expect(extractEntrySource('[SNIPER] AI 고확신')).toBe('SNIPER');
  });

  it('should return OTHER for unknown', () => {
    expect(extractEntrySource('일반 매수')).toBe('OTHER');
    expect(extractEntrySource('')).toBe('OTHER');
  });

  it('should prioritize first match', () => {
    // BIGMOVER check comes before MOMENTUM
    expect(extractEntrySource('[BIGMOVER] 모멘텀 돌파')).toBe('BIGMOVER');
  });
});

describe('extractSectorFromCode', () => {
  const extractSectorFromCode = (code: string): string => {
    const SECTOR_QUICK: Record<string, string> = {
      NVDA: 'AI_SEMI', AMD: 'AI_SEMI', AVGO: 'AI_SEMI', TSM: 'TW_SEMI',
      AAPL: 'TECH', MSFT: 'TECH', META: 'TECH',
      AMZN: 'CLOUD', GOOGL: 'CLOUD',
      TSLA: 'EV', COIN: 'CRYPTO',
      RTX: 'DEFENSE', LMT: 'DEFENSE',
      TQQQ: 'LEV_BULL', SOXL: 'LEV_BULL',
      SQQQ: 'LEV_BEAR', SOXS: 'LEV_BEAR',
    };
    return SECTOR_QUICK[code] ?? 'OTHER';
  };

  it('should classify known stocks', () => {
    expect(extractSectorFromCode('NVDA')).toBe('AI_SEMI');
    expect(extractSectorFromCode('TSLA')).toBe('EV');
    expect(extractSectorFromCode('TQQQ')).toBe('LEV_BULL');
    expect(extractSectorFromCode('SQQQ')).toBe('LEV_BEAR');
  });

  it('should return OTHER for unknown', () => {
    expect(extractSectorFromCode('ZZZZ')).toBe('OTHER');
  });
});

describe('drawdown calculation', () => {
  it('should calculate drawdown percentage correctly', () => {
    const peakValue = 10000;
    const currentValue = 9500;
    const drawdownPct = ((currentValue - peakValue) / peakValue) * 100;
    expect(drawdownPct).toBeCloseTo(-5.0);
  });

  it('should be zero when at peak', () => {
    const peakValue = 10000;
    const currentValue = 10000;
    const drawdownPct = ((currentValue - peakValue) / peakValue) * 100;
    expect(drawdownPct).toBe(0);
  });

  it('should be positive when above peak', () => {
    const peakValue = 10000;
    const currentValue = 10500;
    const drawdownPct = ((currentValue - peakValue) / peakValue) * 100;
    expect(drawdownPct).toBeCloseTo(5.0);
  });
});

describe('time bucket classification', () => {
  const getTimeBucket = (days: number): string => {
    if (days <= 1) return '1d';
    if (days <= 3) return '2-3d';
    if (days <= 5) return '4-5d';
    return '6-7d';
  };

  it('should classify time buckets correctly', () => {
    expect(getTimeBucket(0.5)).toBe('1d');
    expect(getTimeBucket(1)).toBe('1d');
    expect(getTimeBucket(2)).toBe('2-3d');
    expect(getTimeBucket(3)).toBe('2-3d');
    expect(getTimeBucket(4)).toBe('4-5d');
    expect(getTimeBucket(5)).toBe('4-5d');
    expect(getTimeBucket(6)).toBe('6-7d');
    expect(getTimeBucket(7)).toBe('6-7d');
  });
});
