export interface RiskLimits {
  maxDailyDrawdownKrw?: number;
  dailyDrawdownPct?: number;
  basis?: number;
  overseasLimitUsd?: number;
  overseasWarnUsd?: number;
  overseasBlockUsd?: number;
  overseasKillPct?: number;
  overseasBasisUsd?: number;
  targetCashRatio?: number;
}

export interface DefensePark {
  active?: boolean;
  isActive?: boolean;
  reason?: string;
  parkStockName?: string;
  entryReason?: string;
}

export interface Cooldown {
  active?: boolean;
  reason?: string;
  consecutive?: number;
  eodOnly?: boolean;
}

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

export interface CorrelationWarning {
  sector: string;
  count: number;
  stocks: string[];
}

export interface ShortSellingItem {
  stock_code: string;
  stock_name: string;
  shortRatio: number;
  riskLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  isIncreasing?: boolean;
}
