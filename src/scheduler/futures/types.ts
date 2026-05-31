/**
 * 선물 자동매매 공통 타입
 */

export interface FuturesSignal {
  symbol: string;
  product: string;
  direction: 'LONG' | 'SHORT';
  confidence: number;     // 0-100
  rsi: number;
  macdHist: number;
  atrPct: number;
  reason: string;
}

export interface FuturesAutoConfig {
  enabled: boolean;
  maxContracts: number;     // 1-5
  maxBudgetKrw: number;
  allocatedKrw: number;
  totalPnlUsd: number;
}

export interface FuturesTPSL {
  tpPrice: number;
  slPrice: number;
  tpPct: number;
  slPct: number;
}
