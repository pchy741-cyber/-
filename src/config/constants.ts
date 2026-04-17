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
  // Track B: 실시간 감시 (장중 10분 간격 — Claude API 비용 절감)
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
    buyThreshold: 60, // 매수 진입 점수 완화 (60점 — 더 많은 기회 포착)
    splitCount: 2, // 2분할 매수 (예산 절반씩 — 포지션 크기 2배)
    averageDownPct: -4, // 물타기 트리거 (-4% — 더 여유있게)
    maxAveragingCount: 1, // 최대 물타기 1회 (2분할이므로 1회면 충분)
    takeProfitPct: 8, // 익절 라인 (+8% — 스윙 큰 목표)
    takeProfitRatio: 1.0, // 익절 시 전량 매도
    stopLossPct: -4, // 손절 라인 (-4% — 스윙에 충분한 여유)
    maxHoldingDays: 5, // 최대 보유 5일 (스윙 충분한 시간)
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
    buyThreshold: 68, // 개장 5분 — 모멘텀 종목 빠른 포착, 진입 임계치 완화
    splitCount: 1, // 전액 즉시 진입 (분할 불필요, 5분 안에 끝냄)
    averageDownPct: 0, // 물타기 절대 없음
    maxAveragingCount: 0,
    takeProfitPct: 2.0, // +2% 즉시 전량 익절 (수수료 0.25% 제외 실수익 ~1.75%)
    takeProfitRatio: 1.0, // 전량 매도
    stopLossPct: -1.0, // -1% 칼손절 (수수료 포함 실손실 ~1.25%) — 손익비 2:1 유지
    maxHoldingDays: 0, // 당일 청산 필수
    forceCloseTime: '09:10', // 09:10 이후 보유 금지 — 강제 청산
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
