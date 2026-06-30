export interface UsHolding {
  stock_code: string;
  avg_price: number;
  quantity: number;
  last_price?: number;
  bought_at?: string;
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

export interface UsDashboard {
  watchlist?: UsWatchlistItem[];
  holdings?: UsHolding[];
  [key: string]: unknown;
}

export interface OverseasSummary {
  totalInvestedUsd?: number;
  totalInvestedKrw?: number;
  totalMarketValueUsd?: number;
  totalMarketValueKrw?: number;
  unrealizedPnlUsd?: number;
  unrealizedPnlKrw?: number;
  unrealizedPnlPct?: number;
  realizedPnlUsd?: number;
  realizedPnlKrw?: number;
  cashUsd?: number;
  cashKrw?: number;
  fxRate?: number;
  scores?: { code: string; name?: string; score: number; signal?: string }[];
  holdings?: UsHolding[];
}

export interface AllocConfig {
  [key: string]: unknown;
}

export interface WithdrawConfig {
  is_active?: boolean;
  withdraw_ratio_pct?: number;
  min_profit?: number;
  todayReserved?: number;
  todayAmount?: number;
  monthlyTotal?: number;
  monthlyCap?: number;
  [key: string]: unknown;
}
