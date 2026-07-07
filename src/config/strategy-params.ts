// ── 하락장 적응형 모드 ──
export const BEAR_ADAPTIVE = {
  TAKE_PROFIT_PCT: 2.5,
  STOP_LOSS_PCT: -1.5,
  PARTIAL_TP_STAGES: [] as readonly { stage: number; triggerPct: number; sellRatio: number }[],
  MAX_POSITION_COUNT: 2,
  POSITION_SIZE_MULT: 0.3,
  MAX_HOLDING_DAYS: 2,
  TRAILING_ACTIVATE_PCT: 1.0,
} as const;

export const STRATEGY_PARAMS = {
  SWING: {
    buyThreshold: 80,
    splitCount: 1,
    averageDownPct: 0,
    maxAveragingCount: 0,
    earlyTpPct: 0,
    takeProfitPct: 6.0,
    takeProfitRatio: 0.5,
    stopLossPct: -2.2,
    maxHoldingDays: 15,
    maxDailyTrades: 3,
  },

  DEFENSE: {
    buyThreshold: 75,
    splitCount: 4,
    averageDownPct: 0,
    maxAveragingCount: 0,
    takeProfitPct: 5.0,
    takeProfitRatio: 0.5,
    stopLossPct: -2.0,
    maxHoldingDays: 3,
    marketPenalty: -15,
  },

  SCALPING: {
    buyThreshold: 75, // v28: 87→75 (Paper 부활 — 실질 점수범위 50~85에서 트리거 가능)
    splitCount: 1,
    averageDownPct: 0,
    maxAveragingCount: 0,
    takeProfitPct: 2.0,
    takeProfitRatio: 1.0,
    stopLossPct: -1.2,
    maxHoldingDays: 0,
    forceCloseTime: '10:00',
  },

  DIVIDEND: {
    buyThreshold: 99,
    splitCount: 1,
    averageDownPct: 0,
    maxAveragingCount: 0,
    takeProfitPct: 5.0,
    takeProfitRatio: 0.5,
    stopLossPct: -3.0,
    maxHoldingDays: 90,
  },

  SNIPER: {
    buyThreshold: 82,
    splitCount: 1,
    averageDownPct: 0,
    maxAveragingCount: 0,
    takeProfitPct: 8.0,
    takeProfitRatio: 0.5,
    stopLossPct: -3.0,
    maxHoldingDays: 14,
  },

  BOTTOM_FISHING: {
    buyThreshold: 99,
    splitCount: 1,
    averageDownPct: 0,
    maxAveragingCount: 0,
    takeProfitPct: 6.0,
    takeProfitRatio: 1.0,
    stopLossPct: -2.5,
    maxHoldingDays: 5,
  },

  EOD_BETTING: {
    buyThreshold: 0,
    splitCount: 1,
    averageDownPct: 0,
    maxAveragingCount: 0,
    takeProfitPct: 5.0,
    takeProfitRatio: 1.0,
    stopLossPct: -3.0,
    maxHoldingDays: 1,
  },

  BREAKOUT: {
    buyThreshold: 72,
    splitCount: 2,
    averageDownPct: 0,
    maxAveragingCount: 0,
    earlyTpPct: 0,
    takeProfitPct: 8.0,
    takeProfitRatio: 0.5,
    stopLossPct: -3.5,
    maxHoldingDays: 10,
  },

  PARKING: {
    buyThreshold: 95,
    splitCount: 1,
    averageDownPct: 0,
    maxAveragingCount: 0,
    takeProfitPct: 3.0,
    takeProfitRatio: 1.0,
    stopLossPct: -2.0,
    maxHoldingDays: 1,
  },
} as const;

// ── 점수 기반 동적 익절/손절 파라미터 ──
export function getScoreBasedParams(score: number): { takeProfitPct: number; stopLossPct: number } {
  let tp: number;
  let sl: number;
  if (score >= 93) { tp = 9.0; sl = -3.0; }
  else if (score >= 88) { tp = 8.0; sl = -3.3; }
  else if (score >= 83) { tp = 7.0; sl = -3.5; }
  else if (score >= 80) { tp = 6.0; sl = -3.8; }
  else { tp = 5.0; sl = -4.0; }

  const rr = tp / Math.abs(sl);
  if (rr > 5.0) tp = Math.round(Math.abs(sl) * 5.0 * 10) / 10;

  return { takeProfitPct: tp, stopLossPct: sl };
}

// ── 동적 포지션 사이징 ──
export interface PositionSizeHints {
  score: number;
  confidence?: number;
  isMegaCap?: boolean;
  isHighBeta?: boolean;
  pullbackSignal?: boolean;
  nearHigh52w?: boolean;
}

export function getDynamicPositionSizePct(p: PositionSizeHints): number {
  let pct = 25;

  if (p.score >= 93) pct += 8;
  else if (p.score >= 88) pct += 5;
  else if (p.score >= 83) pct += 3;
  else if (p.score < 78) pct -= 5;

  if (p.isMegaCap) pct += 4;

  const conf = p.confidence ?? 0.65;
  if (conf >= 0.85) pct += 3;
  else if (conf < 0.6) pct -= 4;

  if (p.pullbackSignal) pct += 3;
  if (p.nearHigh52w) pct -= 3;

  if (p.isHighBeta) pct -= 5;

  return Math.max(8, Math.min(35, Math.round(pct)));
}

// ── 완전 동적 TP/SL — 국내주식 다팩터 엔진 ──
export interface DomesticTpSlHints {
  score: number;
  confidence?: number;
  rsi?: number;
  adx?: number;
  learnedTp?: number;
  learnedSl?: number;
  atrPct?: number;
  volumeRatio?: number;
  pullbackSignal?: boolean;
  envelopePos?: string;
  isMomentum?: boolean;
  marketRegime?: 'BULL' | 'NORMAL' | 'CORRECTION' | 'CRASH';
  foreignNetBuy?: boolean;
  institutionNetBuy?: boolean;
}

export function getDynamicDomesticTpSl(h: DomesticTpSlHints): {
  takeProfitPct: number;
  stopLossPct: number;
  label: string;
} {
  let tp: number;
  let sl: number;
  if (h.score >= 93) { tp = 10.5; sl = -3.0; }
  else if (h.score >= 88) { tp = 9.0; sl = -3.0; }
  else if (h.score >= 83) { tp = 8.0; sl = -5.5; }
  else if (h.score >= 80) { tp = 7.0; sl = -5.0; }
  else { tp = 6.0; sl = -4.5; }

  if (h.learnedTp != null && h.learnedTp > 0) {
    tp = tp * 0.7 + h.learnedTp * 0.3;
  }
  if (h.learnedSl != null && h.learnedSl < 0) {
    sl = sl * 0.7 + h.learnedSl * 0.3;
  }

  const parts: string[] = [`s${h.score}`];

  const adx = h.adx ?? 25;
  if (adx >= 35) { tp *= 1.15; sl -= 0.2; parts.push('ADX35+'); }
  else if (adx >= 25) { tp *= 1.15; parts.push('ADX25+'); }
  else if (adx < 18) { tp *= 0.85; sl += 0.3; parts.push('ADX<18'); }

  const atrPct = h.atrPct ?? 2.0;
  if (atrPct >= 4.0) { sl -= 1.0; tp += 1.5; parts.push('히변동'); }
  else if (atrPct >= 3.0) { sl -= 0.5; tp += 0.5; parts.push('중변동'); }
  else if (atrPct < 1.5) { sl += 0.3; parts.push('저변동'); }

  if (h.isMomentum) { tp += 1.0; parts.push('MTM+1'); }

  const rsi = h.rsi ?? 50;
  if (rsi < 30) { tp += 1.0; sl -= 0.3; parts.push('rsiOS30'); }
  else if (rsi < 40) { tp += 0.5; parts.push('rsiOS40'); }
  else if (rsi > 70) { tp -= 1.0; sl += 0.5; parts.push('rsiOB70'); }
  else if (rsi > 60) { tp -= 0.3; parts.push('rsiOB60'); }

  const vol = h.volumeRatio ?? 1;
  if (vol >= 3.0) { tp += 1.0; parts.push('v3x'); }
  else if (vol >= 2.0) { tp += 0.5; parts.push('v2x'); }

  const conf = h.confidence ?? 0.65;
  if (conf >= 0.9) { tp += 1.0; parts.push('c90+'); }
  else if (conf >= 0.8) { tp += 0.5; parts.push('c80+'); }

  if (h.pullbackSignal) { tp += 0.5; sl -= 0.3; parts.push('PB'); }

  if (h.envelopePos === 'BELOW_LOWER') { tp += 0.5; parts.push('env↓'); }

  const regime = h.marketRegime ?? 'NORMAL';
  if (regime === 'CRASH') { tp -= 2.5; sl += 0.8; parts.push('CRASH'); }
  else if (regime === 'CORRECTION') { tp -= 1.5; sl += 0.3; parts.push('CORR'); }
  else if (regime === 'BULL') { tp += 1.0; parts.push('BULL'); }

  if (h.foreignNetBuy && h.institutionNetBuy) { tp += 1.0; sl -= 0.3; parts.push('쌍수급'); }
  else if (h.foreignNetBuy) { tp += 0.5; parts.push('외인+'); }
  else if (h.institutionNetBuy) { tp += 0.3; parts.push('기관+'); }

  if (atrPct > 0) {
    const atrFloor = -(atrPct * 1.5);
    if (sl > atrFloor) { sl = Math.max(atrFloor, -8.0); parts.push('ATR바닥'); }
  }

  tp = Math.round(Math.min(Math.max(tp, 3.0), 15.0) * 10) / 10;
  sl = Math.round(Math.max(Math.min(sl, -1.5), -8.0) * 10) / 10;

  const rr = tp / Math.abs(sl);
  if (rr > 5.0) { tp = Math.round(Math.abs(sl) * 5.0 * 10) / 10; parts.push('RR>5→TP축소'); }

  return { takeProfitPct: tp, stopLossPct: sl, label: parts.join('/') };
}
