import { z } from 'zod';

// ── 감시 목록 ──
export const WatchlistItemSchema = z.object({
  id: z.string().uuid(),
  stock_code: z.string().length(6),
  stock_name: z.string(),
  market: z.enum(['KOSPI', 'KOSDAQ']),
  is_active: z.boolean(),
  added_at: z.string(),
  notes: z.string().nullable(),
});
export type WatchlistItem = z.infer<typeof WatchlistItemSchema>;

// ── AI 스코어 (Track A 산출물) ──
export const AIScoreSchema = z.object({
  id: z.string().uuid(),
  stock_code: z.string(),
  score_date: z.string(),
  gemini_summary: z.any().nullable(),
  composite_score: z.number().nullable(),
  fundamental_score: z.number().nullable(),
  technical_score: z.number().nullable(),
  sentiment_score: z.number().nullable(),
  confidence: z.number().nullable(),
  reasoning: z.string().nullable(),
  signal: z.string().nullable(),
  target_price: z.number().nullable(),
  stop_loss_price: z.number().nullable(),
  created_at: z.string(),
});
export type AIScore = z.infer<typeof AIScoreSchema>;

// ── 트랜잭션 체인 ──
export const TransactionChainSchema = z.object({
  id: z.string().uuid(),
  stock_code: z.string(),
  status: z.enum(['OPEN', 'AVERAGING', 'PROFIT_TAKING', 'CLOSED']),
  strategy_mode: z.enum(['SWING', 'DEFENSE', 'SCALPING']),
  avg_buy_price: z.number().nullable(),
  total_quantity: z.number(),
  total_invested: z.number(),
  realized_pnl: z.number(),
  target_profit_pct: z.number().nullable(),
  stop_loss_pct: z.number().nullable(),
  max_averaging_count: z.number(),
  current_averaging_count: z.number(),
  opened_at: z.string(),
  closed_at: z.string().nullable(),
  close_reason: z.string().nullable(),
});
export type TransactionChain = z.infer<typeof TransactionChainSchema>;

// ── 주문 ──
export const OrderSchema = z.object({
  id: z.string().uuid(),
  chain_id: z.string().uuid().nullable(),
  stock_code: z.string(),
  side: z.enum(['BUY', 'SELL']),
  order_type: z.string(),
  quantity: z.number().int().positive(),
  price: z.number().nullable(),
  kis_order_no: z.string().nullable(),
  kis_status: z.string().nullable(),
  filled_quantity: z.number(),
  filled_price: z.number().nullable(),
  status: z.enum(['PENDING', 'FILLED', 'PARTIAL', 'CANCELLED', 'FAILED']),
  trading_mode: z.enum(['paper', 'live']),
  trigger_source: z.string().nullable(),
  ai_reasoning: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Order = z.infer<typeof OrderSchema>;

// ── 포트폴리오 스냅샷 ──
export const PortfolioSnapshotSchema = z.object({
  id: z.string().uuid(),
  snapshot_at: z.string(),
  total_value: z.number().nullable(),
  cash_balance: z.number().nullable(),
  invested_value: z.number().nullable(),
  unrealized_pnl: z.number().nullable(),
  daily_pnl: z.number().nullable(),
  daily_pnl_pct: z.number().nullable(),
  positions: z.any().nullable(),
});
export type PortfolioSnapshot = z.infer<typeof PortfolioSnapshotSchema>;

// ── CEO 전략 설정 ──
export const StrategyConfigSchema = z.object({
  id: z.string().uuid(),
  mode: z.enum(['SWING', 'DEFENSE', 'SCALPING']),
  is_active: z.boolean(),
  gemini_prompt: z.string(),
  gpt_prompt: z.string(),
  claude_prompt: z.string(),
  buy_threshold: z.number(),
  stop_loss_pct: z.number(),
  take_profit_pct: z.number(),
  updated_at: z.string(),
});
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

// ── AI 파이프라인 출력 스키마 (Claude 응답 검증용) ──
export const TradeDecisionSchema = z.object({
  action: z.enum(['BUY', 'SELL', 'HOLD', 'AVERAGE_DOWN', 'PARTIAL_SELL', 'FORCE_CLOSE']),
  stock_code: z.string(),
  quantity: z.number().int().nonnegative(),
  price_type: z.enum(['MARKET', 'LIMIT']),
  limit_price: z.number().optional(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});
export type TradeDecision = z.infer<typeof TradeDecisionSchema>;

// ── GPT 스코어링 출력 스키마 ──
export const ScoringResultSchema = z.object({
  stock_code: z.string(),
  composite_score: z.number().min(-100).max(100),
  fundamental_score: z.number().min(-100).max(100),
  technical_score: z.number().min(-100).max(100),
  sentiment_score: z.number().min(-100).max(100),
  confidence: z.number().min(0).max(1),
  signal: z.enum(['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL', 'NO_DATA']),
  target_price: z.number().optional(),
  stop_loss_price: z.number().optional(),
  reasoning: z.string(),
});
export type ScoringResult = z.infer<typeof ScoringResultSchema>;
