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
  SNIPER: 'SNIPER',     // 🎯 저격수 (AI 88점+ 2종목만, 대형 포지션)
} as const;
export type StrategyMode = (typeof StrategyMode)[keyof typeof StrategyMode];

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
    // ┌─ 실거래 데이터 기반 최적화 (92건 분석) ────────────────────────────┐
    // │ 실 승률 46.7% / 평균 수익 +3.91% / 평균 손실 -1.59%              │
    // │ Half-Kelly 포지션 12.5% / 손익비 2.46:1 / 월 40~50건 목표        │
    // │ buyThreshold 68: 75~84 구간 회피 (실데이터 해당 구간 -0.77% 손실) │
    // │ TP 5.5%: 실 수익 평균 3.91% 기준 → 조기 청산 방지                │
    // └────────────────────────────────────────────────────────────────────┘
    buyThreshold: 68,
    splitCount: 2,
    averageDownPct: -3.0,
    // 물타기: -3% (의미있는 눌림목 확인 후 진입, 노이즈 물타기 차단)
    maxAveragingCount: 2,
    takeProfitPct: 5.5,
    // 익절: +5.5% → 실 수익 평균(+3.91%) 초과 → 승자를 더 오래 보유
    takeProfitRatio: 0.5,   // 50% 부분 매도 → 잔여 트레일링
    stopLossPct: -4.0,
    // 손절: -4% (실 손실 평균 -1.59%, -5%까지 버티는 건 손실 키우는 행위)
    maxHoldingDays: 12,
    // 12일: TP 5.5% 달성 시간 확보 (기존 10일에서 소폭 연장)
  },

  DEFENSE: {
    // 폭락장 (-7%+ 시장 낙폭) 방어 운용 — 기본적으로 트리거 안 됨
    buyThreshold: 75,       // 보수적 (강한 반등 신호 + 적절한 거래 빈도 확보)
    splitCount: 4,          // 4분할 (리스크 최소화)
    averageDownPct: 0,      // 물타기 완전 금지
    maxAveragingCount: 0,
    takeProfitPct: 5.0,     // 반등 폭 감안 넓은 익절
    takeProfitRatio: 0.5,
    stopLossPct: -2.0,      // 손절 타이트 (하락장 추가 낙폭 차단)
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
    // 공황장 자산 파킹 모드 — 신규 매수 사실상 금지, ETF 파킹만
    buyThreshold: 99,       // 99점 이상만 매수 (사실상 진입 없음)
    splitCount: 1,
    averageDownPct: 0,
    maxAveragingCount: 0,
    takeProfitPct: 3.0,
    takeProfitRatio: 1.0,
    stopLossPct: -1.5,      // 타이트한 손절 (파킹 중 손실 최소화)
    maxHoldingDays: 1,
  },

  SNIPER: {
    // ┌─ 수익 구조 ─────────────────────────────────────────────────────────┐
    // │ AI 88점+ 극고확신 종목만 2개 — 총자산 40%씩 집중 투자              │
    // │ 잡주 분산 대신 최고 점수 종목에 대형 포지션 (저격수 전략)          │
    // │ 익절 +8% (엘리트 4:1 R:R) / 손절 -2% (확신 높으니 타이트)         │
    // └────────────────────────────────────────────────────────────────────┘
    buyThreshold: 88,
    // 88점+: AI 최상위 확신 구간만 진입 (상위 ~5% 신호)
    splitCount: 1,          // 분할 없음 — 단번에 풀 포지션
    averageDownPct: -3.0,   // -3% 물타기 1회 허용 (단가 낮추기)
    maxAveragingCount: 1,
    takeProfitPct: 8.0,     // +8% 익절 (엘리트 4:1 R:R)
    takeProfitRatio: 0.5,   // 50% 부분 매도 → 잔여 트레일링
    stopLossPct: -4.0,      // -4% 손절 (노이즈 제거 후 진짜 반전 확인)
    maxHoldingDays: 7,      // 1주일 내 청산
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
  if (score >= 90) return { takeProfitPct: 8.0, stopLossPct: -2.0 };  // 엘리트: 4:1 R:R
  if (score >= 80) return { takeProfitPct: 6.0, stopLossPct: -2.5 };  // 고확신: 2.4:1 R:R
  if (score >= 70) return { takeProfitPct: 5.0, stopLossPct: -2.5 };  // 보통: 2:1 R:R
  return                 { takeProfitPct: 5.0, stopLossPct: -2.5 };   // 마진컬(60-69): 2:1 R:R (최소 기준)
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
