/**
 * 🚦 Trade Gate 타입 정의
 */

import type { OHLCV } from '../analysis/indicators.js';

export interface GateResult {
  passed: boolean;
  reason: string;
  adjustedQuantity?: number;
  riskRewardRatio?: number;
  expectedValue?: number;
  regime?: string;
}

export interface GateInput {
  stockCode: string;
  action: string;
  quantity: number;
  estimatedPrice: number;
  candles: OHLCV[];
  candles60m?: OHLCV[];
  candles15m?: OHLCV[];
  strategyMode: string;
  stopLossPct: number;
  takeProfitPct: number;
  budgetKrw: number;
}

export interface CooldownStatus {
  active: boolean;
  consecutive: number;
  remainingMinutes: number;
  reason: string;
}

export interface WinRateStats {
  totalTrades: number;
  wins: number;
  losses: number;
  avgWinPct: number;
  avgLossPct: number;
}
