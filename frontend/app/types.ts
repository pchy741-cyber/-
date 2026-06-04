// ═══════════════════════════════════════
// ai-auto-bot 프론트엔드 공유 타입 정의
// ═══════════════════════════════════════

export type ViewMode = 'live' | 'paper';
export type MarketTab = 'KR' | 'US';
export type ToastFn = (msg: string, type?: 'ok' | 'err' | 'info') => void;

// ConfirmFn 은 hooks.tsx 의 ConfirmOptions 과 동일
export { type ConfirmOptions } from './lib/hooks';
export type ConfirmFn = (opts: import('./lib/hooks').ConfirmOptions) => Promise<boolean>;

// ── Trading Status (dashboard 실시간 매매 상태) ──
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
  [key: string]: unknown;
}

// ── AI Engine Status ──
export interface AiStatus {
  claude?: string;
  gemini?: string;
  activeEngine?: string;
  [key: string]: unknown;
}

// ── Trade ──
export interface Trade {
  id: number | string;
  stock_code: string;
  stock_name?: string;
  side: 'BUY' | 'SELL';
  status: 'FILLED' | 'PENDING' | 'FAILED' | 'CANCELLED';
  quantity: number;
  filled_quantity?: number;
  filled_price?: number;
  avg_buy_price?: number;
  created_at: string;
  ai_reasoning?: string;
  trigger_source?: string;
  realized_pnl?: number;
  realized_pnl_pct?: number;
  realized_pnl_usd?: number;
  kis_order_no?: string;
  transaction_chains?: {
    avg_buy_price?: number;
    strategy_mode?: string;
    status?: string;
  };
  [key: string]: unknown;
}

// ── Chain (보유 포지션) ──
export interface Chain {
  id: number | string;
  stock_code: string;
  stock_name?: string;
  strategy_mode?: string;
  status?: string;
  avg_buy_price: number;
  total_quantity: number;
  invested?: number;
  current_averaging_count?: number;
  max_averaging_count?: number;
  target_profit_pct?: number;
  stop_loss_pct?: number;
  unrealizedPnl?: number;
  unrealizedPnlPct?: number;
  currentPrice?: number;
  isParking?: boolean;
  weight?: number;
  trigger_source?: string;
  escape_target_price?: number;
}

// ── Portfolio ──
export interface Portfolio {
  unrealizedPnl?: number;
  realizedPnl?: number;
  pnl?: number;
  pnlPct?: number;
  invested?: number;
  domesticInvested?: number;
  domesticEval?: number;
  cash?: number;
  totalValue?: number;
}

// ── Overseas data inside Dashboard ──
export interface OverseasSummary {
  totalInvestedUsd?: number;
  totalInvestedKrw?: number;
  totalMarketValueKrw?: number;
  cashUsd?: number;
  cashKrw?: number;
  fxRate?: number;
  holdings?: UsHolding[];
}

// ── Score ──
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

// ── Risk Limits ──
export interface RiskLimits {
  maxDailyDrawdownKrw?: number;
  overseasLimitUsd?: number;
  targetCashRatio?: number;
}

// ── Defense Park ──
export interface DefensePark {
  active?: boolean;
  isActive?: boolean;
  reason?: string;
  parkStockName?: string;
  entryReason?: string;
}

// ── Monthly Goal ──
export interface MonthlyGoal {
  targetPct: number;
  targetAmount: number;
  currentPnl: number;
  progressPct: number;
  remaining: number;
}

// ── FX Impact ──
export interface FxImpact {
  fxRate: number;
  exposureUsd: number;
  exposureKrw: number;
  impactPer10Won: number;
  overseasPnlUsd: number;
  overseasPnlKrw: number;
}

// ── Suggested Action ──
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

// ── Insight ──
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

// ── Cooldown ──
export interface Cooldown {
  active?: boolean;
  reason?: string;
  consecutive?: number;
  eodOnly?: boolean;
}

// ── Dashboard (메인 대시보드 응답) ──
export interface Dashboard {
  portfolio?: Portfolio;
  chains?: Chain[];
  overseas?: OverseasSummary;
  scores?: StockScore[];
  tradingMode?: string;
  riskLimits?: RiskLimits;
  insights?: Insight[];
  suggestedActions?: SuggestedAction[];
  monthlyGoal?: MonthlyGoal;
  fxImpact?: FxImpact;
  defensePark?: DefensePark;
  cooldown?: Cooldown;
}

// ── Health ──
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

// ── KillSwitch ──
export interface KillSwitchScope {
  active: boolean;
  reason?: string;
  activated_at?: string;
}

export interface KillSwitch {
  kr?: KillSwitchScope;
  overseas?: KillSwitchScope;
  [key: string]: KillSwitchScope | undefined;
}

// ── Strategy ──
export interface Strategy {
  gemini_prompt?: string;
  claude_prompt?: string;
  notebooklm_prompt?: string;
  strategy_document?: string;
  risk_prompt?: string;
  [key: string]: unknown;
}

// ── Secrets ──
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

// ── Watchlist Item (국내) ──
export interface WatchlistItem {
  stock_code: string;
  stock_name?: string;
  market?: string;
  last_sell_at?: string;
  [key: string]: unknown;
}

// ── US Holdings ──
export interface UsHolding {
  stock_code: string;
  avg_price: number;
  quantity: number;
  last_price?: number;
  tp_pct?: number;
  sl_pct?: number;
  is_scalp?: boolean;
  scalp_tp?: number;
  scalp_sl?: number;
  trail_pct?: number;
  trail_active?: boolean;
  trail_stop_pct?: number;
  max_pnl_pct?: number;
  partial_tp_stage?: number;
  next_partial_tp_pct?: number;
  sector?: string;
}

// ── US Watchlist Item ──
export interface UsWatchlistItem {
  code: string;
  name?: string;
  price?: number;
  changePct?: number;
  exchange?: string;
  score?: number;
  ai_score?: number;
  signal?: string;
  confidence?: number;
  reason?: string;
  rsi?: number;
  [key: string]: unknown;
}

// ── US Dashboard ──
export interface UsDashboard {
  watchlist?: UsWatchlistItem[];
  holdings?: UsHolding[];
  [key: string]: unknown;
}

// ── Withdraw Config ──
export interface WithdrawConfig {
  totalReserved?: number;
  [key: string]: unknown;
}

// ── Alloc Config ──
export interface AllocConfig {
  [key: string]: unknown;
}

// ── Loop Status ──
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

// ── Feature Flag ──
export interface FeatureFlag {
  key: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

// ── Money Printer Dividend ──
export interface MpDividend {
  currentValueUsd?: number;
  returnPct?: number;
  investedKrw?: number;
  holdings?: unknown[];
  monthlyDivUsd?: number;
  [key: string]: unknown;
}

// ── Money Printer Futures ──
export interface MpFutures {
  currentValueKrw?: number;
  investedKrw?: number;
  trades?: number;
  winRate?: number;
  [key: string]: unknown;
}

// ── Money Printer Data ──
export interface MpData {
  dividend?: MpDividend;
  futures?: MpFutures;
  fx?: number;
  [key: string]: unknown;
}

// ── Theme ──
export interface DashTheme {
  bg: string;
  side: string;
  main1: string;
  main2: string;
  accent: string;
  border: string;
  bar: string;
}

// ── Correlation Warning ──
export interface CorrelationWarning {
  sector: string;
  count: number;
  stocks: string[];
}

// ── Short Selling Item ──
export interface ShortSellingItem {
  stock_code: string;
  stock_name: string;
  shortRatio: number;
  riskLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  isIncreasing?: boolean;
}

// ── DaySummary (TradesView) ──
export interface DaySummary {
  date: string;
  label: string;
  trades: Trade[];
  buys: number;
  sells: number;
  realizedPnl: number;
  realizedPnlUsd: number;
  wins: number;
  losses: number;
  winRate: number;
}

// ── Strategy Config (설정 패널용) ──
export interface StrategyConfig {
  mode?: string;
  buy_threshold?: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  use_dynamic_tpsl?: boolean;
  [key: string]: unknown;
}

// ── Stock Analysis (종목 분석 패널용) ──
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
