/**
 * 매수 필터 파이프라인 공유 타입
 *
 * 각 모듈(hard-gates, scoring, quality-gates, risk-gates, entry-decision)이
 * 독립적으로 동작하면서 FilterContext 를 통해 데이터를 주고받는다.
 * 모듈 간 직접 import 금지 → 크로스오염 방지.
 */

import type { TechnicalSummary } from '../../../analysis/indicators.js';
import type { CurrentPrice, DailyCandle } from '../../../kis/market.js';
import type { StockSignals } from '../../../kis/market-signals.js';
import type { StockWinRate } from '../../../analysis/win-rate.js';
import type { RouteResult } from '../strategy-router.js';
import type { StrategyMode } from '../../../config/constants.js';

// ── 기본 종목 정보 ──
export interface StockItem {
  stock_code: string;
  stock_name: string;
}

export interface MegaCapInfo {
  name: string;
  bonus: number;
  thresholdReduction: number;
}

// ── 하드 게이트 입력 ──
export interface HardGateInput {
  stock: StockItem;
  openStockCodes: Set<string>;
  lossBlockedCodes?: Set<string>;
  bigLossBlockedCodes?: Set<string>;
  manuallySoldCodes?: Set<string>;
  recentlySoldCodes?: Set<string>;
  junkStockCodes?: Set<string>;
  winRates?: Map<string, StockWinRate>;
  livePrices: Map<string, CurrentPrice>;
  aiScoreMap: Map<string, number>;
}

// ── KIS 시그널 추출 결과 ──
export interface SignalData {
  raw: StockSignals | undefined;
  intensity: number;
  shortRatio: number;
  bidAskRatio: number;
  foreignNetEst: number;
  instNetEst: number;
  foreignBrokerBuy: boolean;
  lendingRatio: number;
}

// ── 스코어링 결과 ──
export interface ScoringResult {
  candleBonus: number;
  hasBullishCandle: boolean;
  structBonus: number;
  vpBonus: number;
  pullbackBonus: number;
  fibBonus: number;
  signalBonus: number;
  rsiDivBonus: number;
  bbSqueezeBonus: number;
  priorityBonus: number;
  effectiveTechScore: number;
  isFibSupport: boolean;
  nearSupport: boolean;
  nearResistance: boolean;
  atMultiDayHigh: boolean;
  todayChangePct: number;
  adjustedVolRatio: number;
  minTechScore: number;
  truePullbackPattern: boolean;
  signalData: SignalData;
}

export interface ScoringInput {
  stock: StockItem;
  tech: TechnicalSummary;
  candles: DailyCandle[];
  price: CurrentPrice;
  signals: StockSignals | undefined;
  mode: StrategyMode;
  megaCap: MegaCapInfo | undefined;
  aiScore: number;
  feedbackMinVolRatio: number;
}

// ── 품질 게이트 입력/결과 ──
export interface QualityGateInput {
  tech: TechnicalSummary;
  scoring: ScoringResult;
  mode: StrategyMode;
  aiScore: number;
  buyThreshold: number;
  megaCap: MegaCapInfo | undefined;
  noAiForStock: boolean;
  feedbackMinVolRatio: number;
  curPrice: number;
}

export interface GateResult {
  passed: boolean;
  count: number;
  min: number;
  details: Record<string, boolean>;
}

// ── 리스크 게이트 입력 ──
export interface RiskGateInput {
  stockCode: string;
  tech: TechnicalSummary;
  candles: DailyCandle[];
  scoring: ScoringResult;
  aiScore: number;
  signals: StockSignals | undefined;
  regimeRoute: RouteResult;
  curPrice: number;
}

// ── 진입 판정 입력 ──
export interface EntryInput {
  stockCode: string;
  tech: TechnicalSummary;
  price: CurrentPrice;
  scoring: ScoringResult;
  regimeRoute: RouteResult;
  aiScore: number;
  buyThreshold: number;
  mode: StrategyMode;
  allowScalpingBuys?: boolean;
  winRates?: Map<string, StockWinRate>;
}

export type EntryVerdict =
  | { action: 'BUY'; reason: string; isScalpOverride?: boolean }
  | { action: 'SKIP'; reason: string }
  | { action: 'CONTINUE' };  // 다음 단계로 진행 (fallthrough)
