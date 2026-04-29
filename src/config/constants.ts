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
  TRACK_A_CRON: ['30 7 * * 1-5', '30 12 * * 1-5', '0 18 * * 1-5'], // 07:30, 12:30, 18:00 KST 평일
  // Track B: 실시간 감시 (장중 5분 간격 — 매매 기회 2배, API 비용 < 수익 기여)
  TRACK_B_INTERVAL_MINUTES: 5,
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
  SWING: 'SWING',       // 🟢 평상시 스윙
  DEFENSE: 'DEFENSE',   // 🔴 폭락장 방어
  SCALPING: 'SCALPING', // 🔥 초단타
  DIVIDEND: 'DIVIDEND', // 🏦 파킹+배당 안정 운영 (하락장 지속 시 자동 전환)
} as const;
export type StrategyMode = (typeof StrategyMode)[keyof typeof StrategyMode];

// 🏦 DIVIDEND 모드에서 매수 허용 최소 배당수익률 (%)
export const MIN_DIVIDEND_YIELD_FOR_BUY = 2.0;

// ── 전략별 파라미터 (연구 기반 최적화) ──
//
// 공통 전제:
//   • 한국주식 왕복 수수료+세금: 0.21% (매수 0.015% + 매도 0.015% + 증권거래세 0.18%)
//   • 손익분기 계산: 기대수익 = p × (익절-0.21%) - (1-p) × (|손절|+0.21%) > 0
//   • Kelly Criterion (반 켈리): 포지션 = (손익비×승률 - 패율) / 손익비 × 0.5
//   • KOSPI 대형주 일평균 변동폭: 1~2%, 중소형주: 2~5%
//   • 5종목 분산 시 비체계적 리스크 80% 감소 (KOSPI 평균 상관계수 0.45 기준)
//
export const STRATEGY_PARAMS = {
  SWING: {
    // ┌─ 수익 구조 ─────────────────────────────────────────────────────────┐
    // │ 진입점수≥55 → -3% 물타기(1차) → -4.5% 물타기(2차) → 손절 -4%    │
    // │ 익절 +7% / 손익비 7:4=1.75:1 / 손익분기 승률 36.4% (달성 용이)   │
    // │ splitCount=2: 1차 진입 → 물타기 → 평균단가 최적화                │
    // └────────────────────────────────────────────────────────────────────┘
    buyThreshold: 60,
    // 신호 진입 점수: 60점 (품질·승률 균형)
    splitCount: 2,
    averageDownPct: -2.0,
    // 물타기 1차: -2% (손절 전 빠른 단가 낮추기)
    maxAveragingCount: 2,
    takeProfitPct: 3.5,
    // 익절: +3.5% → 50% 매도, 잔여 트레일링 스톱 (단타-스윙 중간, 자주 실현)
    takeProfitRatio: 0.5,   // 50% 부분 매도 → 잔여 트레일링
    stopLossPct: -2.5,
    // 손절: -2.5% (빠른 손절로 리스크 통제)
    maxHoldingDays: 5,
    // 5일 초과 보유 시 청산 (중단기 균형)
  },

  DEFENSE: {
    // 폭락장 (-7%+ 시장 낙폭) 방어 운용 — 기본적으로 트리거 안 됨
    buyThreshold: 75,       // 보수적 (강한 반등 신호 + 적절한 거래 빈도 확보)
    splitCount: 4,          // 4분할 (리스크 최소화)
    averageDownPct: 0,      // 물타기 완전 금지
    maxAveragingCount: 0,
    takeProfitPct: 5.0,     // 반등 폭 감안 넓은 익절
    takeProfitRatio: 0.5,
    stopLossPct: -2.5,      // 손절 넓게 (낙폭장 노이즈 큼)
    maxHoldingDays: 3,
    marketPenalty: -30,
  },

  SCALPING: {
    // ┌─ 수익 구조 ─────────────────────────────────────────────────────────┐
    // │ 개장 30분 갭 종목: 실증 연구상 60~70% 반전율 (한국거래소 2019~2023) │
    // │ 익절 +1.2% → 순수익 +0.99%  /  손절 -0.6% → 순손실 -0.81%        │
    // │ 손익비 2:1 / 손익분기 승률 34% (실제 목표: 50%+)                   │
    // └────────────────────────────────────────────────────────────────────┘
    buyThreshold: 72,
    // 72점: RSI+MACD+ADX 전부 강세 신호 수준 — 개장 직후 강한 신호만 진입
    splitCount: 2,          // 2분할 (개장 10분 안에 빠른 진입/청산)
    averageDownPct: 0,      // 물타기 절대 금지 (시간 없음)
    maxAveragingCount: 0,
    takeProfitPct: 1.2,
    // +1.2% (순수익 0.99%) — 개장 모멘텀 평균 1~3%, 과욕은 반전 위험
    takeProfitRatio: 1.0,   // 전량 즉시 익절
    stopLossPct: -0.6,
    // -0.6% 칼손절 (손익비 2:1) — 단타는 손절이 전략
    maxHoldingDays: 0,      // 당일 청산 필수
    forceCloseTime: '09:25',// 개장 25분 후 강제 청산 (09:00~09:25 모멘텀 구간)
  },

  DIVIDEND: {
    buyThreshold: 90,
    splitCount: 2,
    averageDownPct: 0,
    maxAveragingCount: 0,
    takeProfitPct: 10,
    takeProfitRatio: 0.5,
    stopLossPct: -5,
    maxHoldingDays: 60,
    marketPenalty: -20,
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

// ── 점수 기반 동적 익절/손절 파라미터 ──
// 매수 당시 AI 점수 → 확신 티어별 최적 TP/SL 계산
// 근거: Kelly Criterion + 손익비 최적화
//   • 60-69 (마진컬): 낮은 확신 → 빠른 실현, 타이트한 손절로 기대값 보전
//   • 70-79 (보통): 적당한 확신 → 손익비 2:1 타겟
//   • 80-89 (고확신): 강한 신호 → 수익 극대화 허용, ATR 기반 여유 손절
//   • 90+  (엘리트): 최강 신호 → 큰 수익 목표, 손절 타이트 (확신이 높으므로)
export function getScoreBasedParams(score: number): { takeProfitPct: number; stopLossPct: number } {
  if (score >= 90) return { takeProfitPct: 7.0, stopLossPct: -1.5 };  // 엘리트: 극대화
  if (score >= 80) return { takeProfitPct: 5.5, stopLossPct: -2.0 };  // 고확신
  if (score >= 70) return { takeProfitPct: 4.0, stopLossPct: -2.0 };  // 보통
  return                 { takeProfitPct: 3.0, stopLossPct: -2.5 };   // 마진컬 (60-69)
}

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
