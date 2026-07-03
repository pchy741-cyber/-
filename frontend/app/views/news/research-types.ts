export interface DartFinancial {
  revenue: number;
  revenueYoy: number;
  operatingIncome: number;
  operatingIncomeYoy: number;
  operatingMargin: number;
  netIncome: number;
  totalAssets: number;
  totalDebt: number;
  debtRatio: number;
  year: string;
  quarter: string;
}

export interface DartResult {
  stockCode: string;
  corpName: string;
  financial?: DartFinancial;
  aiAnalysis?: string;
  fundamentalScore?: number;
  piotroskiScore?: number;
  keyRisks: string[];
  keyStrengths: string[];
  analyzedAt: string;
  earningsDate?: string;
  earningsDaysLeft?: number;
}
