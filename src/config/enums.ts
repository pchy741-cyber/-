// ── 주문 관련 Enum ──
export const OrderSide = {
  BUY: 'BUY',
  SELL: 'SELL',
} as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

export const OrderType = {
  MARKET: '01',
  LIMIT: '00',
  AFTER_HOURS: '06',
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export const TradeStatus = {
  PENDING: 'PENDING',
  FILLED: 'FILLED',
  PARTIAL: 'PARTIAL',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
} as const;
export type TradeStatus = (typeof TradeStatus)[keyof typeof TradeStatus];

export const ChainStatus = {
  OPEN: 'OPEN',
  AVERAGING: 'AVERAGING',
  PROFIT_TAKING: 'PROFIT_TAKING',
  CLOSED: 'CLOSED',
} as const;
export type ChainStatus = (typeof ChainStatus)[keyof typeof ChainStatus];

// ── 트레이딩 모드 (paper/live/p_arch) ──
export const TradingMode = {
  PAPER: 'paper',
  LIVE: 'live',
  PAPER_ARCHIVE: 'p_arch',
} as const;
export type TradingMode = (typeof TradingMode)[keyof typeof TradingMode];

// ── CEO 전략 모드 ──
export const StrategyMode = {
  SWING: 'SWING',
  DEFENSE: 'DEFENSE',
  SCALPING: 'SCALPING',
  DIVIDEND: 'DIVIDEND',
  SNIPER: 'SNIPER',
  BOTTOM_FISHING: 'BOTTOM_FISHING',
  EOD_BETTING: 'EOD_BETTING',
  BREAKOUT: 'BREAKOUT',
  PARKING: 'PARKING',
} as const;
export type StrategyMode = (typeof StrategyMode)[keyof typeof StrategyMode];

// ── AI 스코어 시그널 ──
export const Signal = {
  STRONG_BUY: 'STRONG_BUY',
  BUY: 'BUY',
  HOLD: 'HOLD',
  SELL: 'SELL',
  STRONG_SELL: 'STRONG_SELL',
  NO_DATA: 'NO_DATA',
} as const;
export type Signal = (typeof Signal)[keyof typeof Signal];
