export interface Trade {
  id: string;
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

export interface Chain {
  id: string;
  stock_code: string;
  stock_name?: string;
  strategy_mode?: string;
  status?: string;
  avg_buy_price: number;
  total_quantity: number;
  total_invested?: number;
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
  peak_price_since_open?: number;
  chainIds?: string[];
  _mergedCount?: number;
}

export interface Portfolio {
  unrealizedPnl?: number;
  realizedPnl?: number;
  pnl?: number;
  pnlPct?: number;
  invested?: number;
  domesticInvested?: number;
  domesticEval?: number;
  cash?: number;
  domesticCash?: number;
  totalValue?: number;
  prevDayTotalValue?: number;
  dailyChangePct?: number;
}

export interface Strategy {
  gemini_prompt?: string;
  claude_prompt?: string;
  notebooklm_prompt?: string;
  strategy_document?: string;
  risk_prompt?: string;
  [key: string]: unknown;
}

export interface EnsembleConfig {
  weights: { gemini: number; gpt: number; claude: number; rss: number };
  strategy: 'weighted_avg' | 'majority_vote' | 'conservative';
  minModels: number;
}

export interface StrategyConfig {
  mode?: string;
  buy_threshold?: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  use_dynamic_tpsl?: boolean;
  notebooklm_prompt?: string;
  gemini_prompt?: string;
  gpt_prompt?: string;
  claude_prompt?: string;
  ai_scoring_mode?: 'fallback' | 'ensemble';
  ensemble_config?: EnsembleConfig;
  [key: string]: unknown;
}

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

export interface TodayStats {
  totalTrades: number;
  krSellCount: number;
  krRealizedPnl: number;
  usSellCount: number;
  usRealizedPnlUsd: number;
}
