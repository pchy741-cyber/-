import type { Portfolio, Chain } from './trading';
import type { RiskLimits, DefensePark, Cooldown } from './risk';
import type { OverseasSummary } from './overseas';

export interface TradingStatusBlock {
  reason: string;
  detail: string;
  severity?: string;
}

export interface TradingStatus {
  overallStatus?: string;
  mode?: string;
  buyThreshold?: number;
  topScore?: number;
  candidateCount?: number;
  blocks?: TradingStatusBlock[];
  kospiRegime?: { penalty: number; todayDown: boolean; flashCrash: boolean; boost: boolean };
  eodOnly?: boolean;
  consecutiveLosses?: number;
  marketOpen?: boolean;
  [key: string]: unknown;
}

export interface AiStatus {
  claude?: string;
  gemini?: string;
  activeEngine?: string;
  [key: string]: unknown;
}

export interface StockScore {
  stock_code: string;
  stock_name?: string;
  composite_score: number;
  confidence?: number;
  technical_score?: number;
  ai_score?: number;
  combined_score?: number;
  fundamental_score?: number;
  sentiment_score?: number;
  signal?: string;
  reasoning?: string;
  updated_at?: string;
  currentPrice?: number;
  target_price?: number;
  stop_loss_price?: number;
}

export interface Insight {
  id: number | string;
  content: string;
  insight?: string;
  category?: string;
  confidence?: number;
  sample_count?: number;
  source?: string;
  source_mode?: string;
  created_at?: string;
  applied?: boolean;
  is_applied?: boolean;
  recommendation?: string;
  param_change?: { field: string; value: unknown };
  live_validation_status?: string;
}

export interface SuggestedAction {
  type: string;
  action?: string;
  stock_code?: string;
  stock_name?: string;
  reason?: string;
  priority: 'high' | 'medium' | 'low';
  message: string;
  detail?: string;
}

export interface MonthlyGoal {
  targetPct: number;
  targetAmount: number;
  currentPnl: number;
  progressPct: number;
  remaining: number;
}

export interface FxImpact {
  fxRate: number;
  exposureUsd: number;
  exposureKrw: number;
  impactPer10Won: number;
  overseasPnlUsd: number;
  overseasPnlKrw: number;
}

export interface Dashboard {
  portfolio?: Portfolio;
  chains?: Chain[];
  overseas?: OverseasSummary;
  scores?: StockScore[];
  tradingMode?: string;
  viewMode?: string;
  cashSource?: string;
  activeChains?: number;
  riskLimits?: RiskLimits;
  insights?: Insight[];
  suggestedActions?: SuggestedAction[];
  monthlyGoal?: MonthlyGoal;
  fxImpact?: FxImpact;
  defensePark?: DefensePark;
  cooldown?: Cooldown;
}

export interface SystemEvent {
  timestamp: string;
  component: string;
  message: string;
  status: 'success' | 'error' | 'info';
}

export interface Health {
  marketOpen?: boolean;
  usMarketOpen?: boolean;
  recentEvents?: SystemEvent[];
  [key: string]: unknown;
}

export interface SecretEntry {
  exists: boolean;
  masked?: string;
}

export interface Secrets {
  gemini?: SecretEntry;
  openai?: SecretEntry;
  anthropic?: SecretEntry;
  kis_appkey?: SecretEntry;
  kis_appsecret?: SecretEntry;
  kis_account?: SecretEntry;
  [key: string]: SecretEntry | undefined;
}

export interface WatchlistItem {
  stock_code: string;
  stock_name?: string;
  market?: string;
  last_sell_at?: string;
  [key: string]: unknown;
}

export interface LoopStatus {
  active: boolean;
  phase: 'REVIEWING' | 'TRADING' | 'PAUSED' | 'STOPPED';
  totalRuns: number;
  lastRunAt: string | null;
  lastRunResult: 'ok' | 'error' | 'skipped' | null;
  startedAt: string | null;
  adaptiveIntervalMs: number;
  consecutiveErrors: number;
  marketPhase: 'PREMARKET' | 'OPEN_VOLATILE' | 'PRIME' | 'MIDDAY' | 'LUNCH' | 'POWER_HOUR' | 'CLOSED';
  brief: { regime: string; risk: string; narrative: string } | null;
  openMarkets: string[];
  anyMarketOpen: boolean;
  autoPilot?: { overridesSet: number; decisions: string[]; lastRunAt: string | null } | null;
}

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

export interface StockTechnicals {
  rsi14?: number;
  macdHistogram?: number;
  macdCrossover?: string;
  bollingerPosition?: number;
  adx14?: number;
  score?: number;
  sma5?: number;
  sma20?: number;
  sma60?: number;
  volumeRatio?: number;
  stochasticK?: number;
  atr14?: number;
  goldenCross?: boolean;
  deathCross?: boolean;
  [key: string]: unknown;
}

export interface StockFlow {
  foreignNet: number;
  institutionNet: number;
  foreignStreak?: number;
  trend?: string;
}

export interface StockShorts {
  shortRatio?: number;
  isIncreasing?: boolean;
  riskLevel?: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface StockConsensus {
  targetPrice?: number;
  upsidePct?: number;
  buyCount?: number;
  holdCount?: number;
  sellCount?: number;
  consensusRating?: string;
}

export interface StockAnalysis {
  technicals?: StockTechnicals;
  flow?: StockFlow;
  shorts?: StockShorts;
  consensus?: StockConsensus;
}

export interface MpDividend {
  currentValueUsd?: number;
  returnPct?: number;
  investedKrw?: number;
  holdings?: unknown[];
  monthlyDivUsd?: number;
  [key: string]: unknown;
}

export interface MpData {
  dividend?: MpDividend;
  fx?: number;
  [key: string]: unknown;
}

export interface AiProviderStats {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  calls: number;
}

export interface AiCostSummary {
  today: Record<string, AiProviderStats>;
  todayTotalUsd: number;
  todayTotalKrw: number;
  todayTotalCalls: number;
  todayTotalTokens: number;
  monthTotalUsd: number;
  monthTotalKrw: number;
  exchangeRate: number;
}

export interface AiCostDailyEntry {
  day: string;
  providers: Record<string, AiProviderStats>;
  totalUsd: number;
  totalKrw: number;
}

export interface AiCostHistory {
  daily: AiCostDailyEntry[];
  exchangeRate: number;
}
