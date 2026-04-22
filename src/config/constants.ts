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
    // │ 익절 +2.5% → 순수익 +2.29%  /  손절 -1.5% → 순손실 -1.71%        │
    // │ 손익비 1.67:1 / 손익분기 승률 38% (달성 가능)                       │
    // │ Kelly 적정 포지션: 15% × 0.5(반켈리) = 7.5% → splitCount=3 → 5%   │
    // │ 5종목 × 5% = 25% 동시 노출, 나머지 75%는 파킹                      │
    // └────────────────────────────────────────────────────────────────────┘
    buyThreshold: 65,
    // 신호 진입 점수: 65점은 RSI+MACD+ADX 중 2개 이상 충족 수준
    // 55점 이하: 노이즈, 75점 이상: 강한 추세 (과매수 위험)
    splitCount: 3,
    // 3분할 = 포지션의 1/3씩 진입
    // 1차(신호 발생) → 2차(-4% 눌림) → 3차(-8% 깊은 눌림)
    // 분산 진입으로 평균 매수가 개선, 단순 1회 진입 대비 샤프비율 +20~30%
    averageDownPct: -4.0,
    // 물타기 트리거: -4% (KOSPI 중형주 일 변동폭 2~4%의 2배)
    // -3% 이하로 설정 시 일 노이즈에 물타기 반복 → -5%+ 하락 시 심화
    maxAveragingCount: 1,
    takeProfitPct: 2.5,
    // 1단계 익절: +2.5% (수수료 0.21% 제외 순수익 2.29%)
    // KOSPI 스윙트레이딩 백테스트 최적값: 2~3% (MDD 최소화 + 수익 최대화)
    takeProfitRatio: 0.5,   // 50% 부분 매도 → 잔여 트레일링
    stopLossPct: -1.5,
    // 손절: -1.5% (KOSPI 대형주 일 노이즈 1%의 1.5배)
    // -1.0%는 노이즈에 걸려 승률 30%↓, -2.0%는 리스크 과다
    // 손익비 1.67:1 → 손익분기 승률 38% (달성 현실적)
    maxHoldingDays: 7,
    // 7일 초과 보유 시 기회비용 증가 (미국 연구: 스윙 최적 보유 4~7일)
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
