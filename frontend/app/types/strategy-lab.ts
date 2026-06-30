export interface StrategyPerformance {
  mode: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  totalPnlKrw: number;
  totalPnlPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  avgHoldingDays: number;
  bestTrade: { stockCode: string; pnlPct: number } | null;
  worstTrade: { stockCode: string; pnlPct: number } | null;
}

export interface StrategyGraduation {
  id: number;
  strategy_mode: string;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'PENDING' | 'AUTO_APPLIED' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'REVOKED';
  trades: number;
  win_rate: number;
  profit_factor: number;
  mdd: number;
  total_pnl_krw: number;
  avg_holding_days: number;
  criteria_margin: Record<string, string>;
  auto_applied: boolean;
  decided_by: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface StrategyInsightRow {
  id: number;
  strategy_mode: string;
  condition_key: string;
  condition_label: string;
  win_rate: number;
  profit_factor: number;
  sample_count: number;
  avg_pnl_pct: number;
  insight_text: string;
  is_actionable: boolean;
}

export interface StrategyLabOverview {
  mode: string;
  paper: StrategyPerformance | null;
  live: StrategyPerformance | null;
  graduation: StrategyGraduation | null;
}

export interface OptimizerResult {
  mode: string;
  currentTp: number;
  currentSl: number;
  bestTp: number;
  bestSl: number;
  currentSharpe: number;
  bestSharpe: number;
  bestPF: number;
  bestWinRate: number;
  improved: boolean;
  applied: boolean;
  paperTrades?: number;
  runAt: string;
  updatedAt: string;
}

export interface OptimizerConfig {
  mode: string;
  tp: number;
  sl: number;
  buyThreshold: number;
  isActive: boolean;
  isPaper: boolean;
  updatedAt: string;
}

export interface AppliedInsight {
  id: number;
  strategy_mode: string;
  condition_label: string;
  suggested_action: string | null;
  applied_at: string;
}

export interface TuningStatus {
  optimizers: OptimizerResult[];
  configs: OptimizerConfig[];
  insightStats: { approved?: number; pending_actionable?: number; total_actionable?: number; total?: number };
  appliedInsights: AppliedInsight[];
}
