// ── 한국 주식시장 (KRX) 시간 ──
export const MARKET = {
  OPEN_HOUR: 9,
  OPEN_MINUTE: 0,
  CLOSE_HOUR: 15,
  CLOSE_MINUTE: 30,
  // 단타모드 강제청산 시간 (장 마감 10분 전)
  FORCE_SELL_HOUR: 15,
  FORCE_SELL_MINUTE: 20,
  TIMEZONE: 'Asia/Seoul',
} as const;

// ── 스케줄러 ──
export const SCHEDULE = {
  // Track A: 무거운 분석 (하루 2회)
  TRACK_A_CRON: ['30 7 * * 1-5', '0 18 * * 1-5'], // 07:30, 18:00 KST 평일
  // Track B: 실시간 감시 (장중 10분 간격 — 모의투자 rate limit 대응)
  TRACK_B_INTERVAL_MINUTES: 10,
} as const;

// ── 주문 관련 Enum ──
export const OrderSide = {
  BUY: 'BUY',
  SELL: 'SELL',
} as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

export const OrderType = {
  MARKET: '01', // 시장가
  LIMIT: '00', // 지정가
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

// ── CEO 전략 모드 ──
export const StrategyMode = {
  SWING: 'SWING', // 🟢 평상시 스윙
  DEFENSE: 'DEFENSE', // 🔴 폭락장 방어
  SCALPING: 'SCALPING', // 🔥 초단타
} as const;
export type StrategyMode = (typeof StrategyMode)[keyof typeof StrategyMode];

// ── 전략별 파라미터 ──
export const STRATEGY_PARAMS = {
  SWING: {
    buyThreshold: 70, // 매수 진입 점수
    splitCount: 3, // 3분할 매수
    averageDownPct: -3, // 물타기 트리거 (-3%)
    maxAveragingCount: 3, // 최대 물타기 횟수
    takeProfitPct: 8, // 익절 라인 (+8%)
    takeProfitRatio: 0.5, // 익절 시 50% 매도
    stopLossPct: -5, // 손절 라인 (-5%)
    maxHoldingDays: 3, // 최대 보유일
  },
  DEFENSE: {
    buyThreshold: 85, // 매수 임계치 상향
    splitCount: 3, // 예산의 1/3만 1차 매수
    averageDownPct: 0, // 물타기 금지
    maxAveragingCount: 0, // 물타기 금지
    takeProfitPct: 8,
    takeProfitRatio: 0.5,
    stopLossPct: -3, // 손절 타이트하게 (-3%)
    maxHoldingDays: 3,
    marketPenalty: -30, // 하락장 감점
  },
  SCALPING: {
    buyThreshold: 55, // 단타 적극 매수 (모의투자 실험)
    splitCount: 1, // 100% 몰빵
    averageDownPct: 0, // 물타기 없음
    maxAveragingCount: 0,
    takeProfitPct: 4, // +4% 즉시 익절 (R:R = 2.0)
    takeProfitRatio: 1.0, // 전량 매도
    stopLossPct: -2, // -2% 칼손절
    maxHoldingDays: 0, // 당일 청산 필수
    forceCloseTime: '15:20', // 오버나잇 금지
  },
} as const;

// ── KIS API Transaction IDs ──
export const KIS_TR_ID = {
  // 실거래
  LIVE: {
    BUY: 'TTTC0802U',
    SELL: 'TTTC0801U',
    BALANCE: 'TTTC8434R',
    ORDER_STATUS: 'TTTC8001R',
  },
  // 모의투자
  PAPER: {
    BUY: 'VTTC0802U',
    SELL: 'VTTC0801U',
    BALANCE: 'VTTC8434R',
    ORDER_STATUS: 'VTTC8001R',
  },
  // 시세 조회 (공통)
  QUOTE: {
    CURRENT_PRICE: 'FHKST01010100',
    ORDERBOOK: 'FHKST01010200',
    DAILY_CHART: 'FHKST01010400',
    MINUTE_CHART: 'FHKST01010500',
    INVESTOR_FLOW: 'FHKST01010900',
  },
} as const;

// ── AI 스코어 시그널 ──
export const Signal = {
  STRONG_BUY: 'STRONG_BUY',
  BUY: 'BUY',
  HOLD: 'HOLD',
  SELL: 'SELL',
  STRONG_SELL: 'STRONG_SELL',
  NO_DATA: 'NO_DATA', // 소스 부족 → 분석 불가
} as const;
export type Signal = (typeof Signal)[keyof typeof Signal];
