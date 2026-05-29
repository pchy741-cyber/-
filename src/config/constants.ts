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

// ── 국내주식 수수료/세금 (2025 기준 — 전 코드에서 이 상수 사용) ──
export const KR_FEE = {
  BUY_FEE_PCT: 0.00015,    // 매수 수수료 0.015%
  SELL_FEE_PCT: 0.00195,    // 매도 수수료 0.015% + 거래세 0.18% = 0.195%
  ROUND_TRIP_PCT: 0.0021,   // 왕복 합계 0.21%
} as const;

// ── 스케줄러 ──
export const SCHEDULE = {
  // Track A: 무거운 분석 (하루 4회 — 파워풀 모드)
  TRACK_A_CRON: ['30 7 * * 1-5', '0 10 * * 1-5', '30 12 * * 1-5', '0 18 * * 1-5'], // 07:30, 10:00, 12:30, 18:00 KST 평일
  // Track B: 실시간 감시 (장중 3분 간격 — 반응 속도 최적화)
  TRACK_B_INTERVAL_MINUTES: 3,
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
  AFTER_HOURS: '06', // 장후 시간외 (15:40~16:00 단일가)
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
  BOTTOM_FISHING: 'BOTTOM_FISHING', // 🎣 바닥낚시 (시간외 RSI 과매도 우량주)
} as const;
export type StrategyMode = (typeof StrategyMode)[keyof typeof StrategyMode];

// ── 전략별 파라미터 (연구 기반 최적화) ──
//
// 공통 전제:
//   • 한국주식 왕복 수수료+세금: 0.21% (매수 수수료 0.015% + 매도 수수료 0.015% + 거래세 0.18%) — KR_FEE 참조
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
    // │ earlyTpPct 2.5%: 50% 조기 해제 → 현금 회전율 2배 향상             │
    // └────────────────────────────────────────────────────────────────────┘
    buyThreshold: 83,
    splitCount: 2,
    averageDownPct: 0,
    maxAveragingCount: 0,
    earlyTpPct: 2.5,        // 조기 부분익절: +2.5% 도달 시 50% 즉시 매도 → 현금 재배치
    takeProfitPct: 5.5,     // 잔여 50% 트레일링 최종 목표 (+5.5% 또는 트레일링 발동)
    takeProfitRatio: 0.5,   // 50% 부분 매도 → 잔여 트레일링
    stopLossPct: -3.0,
    maxHoldingDays: 12,
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
    marketPenalty: -15,
  },

  SCALPING: {
    // ┌─ 수익 구조 ─────────────────────────────────────────────────────────┐
    // │ 진입: 09:00~09:14 (14분 윈도우) / 강제청산: 10:00 (최대 60분 보유) │
    // │ 익절 +1.5% → 순수익 +1.29% / 손절 -1.2% → 순손실 -1.41%          │
    // │ 손익비 1.08:1 / 손익분기 승률 48% — 여유로운 TP 달성 기회 확보     │
    // └────────────────────────────────────────────────────────────────────┘
    buyThreshold: 87,
    // 87점: 최고확신 종목만 진입 — 상위 ~5% 신호만
    splitCount: 1,          // 분할 없이 한 번에 전량 진입 (개장 직후 속도 최우선)
    averageDownPct: 0,      // 물타기 절대 금지 (시간 없음)
    maxAveragingCount: 0,
    takeProfitPct: 1.5,
    // +1.5% — 수수료(0.21%) 제해도 순수익 +1.29%, 60분 윈도우로 달성 가능
    takeProfitRatio: 1.0,   // 전량 즉시 익절
    stopLossPct: -1.2,
    // -1.2% 손절 (개장 노이즈 필터, TP:SL 비율 개선)
    maxHoldingDays: 0,      // 당일 청산 필수
    forceCloseTime: '10:00',// 10:00 강제청산 (여유 60분 윈도우)
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

  BOTTOM_FISHING: {
    // ┌─ 시간외 바닥낚시 ─────────────────────────────────────────────────────┐
    // │ 시장 전체 RSI과매도 우량주 자동 발굴 → TP/SL 기계적 청산             │
    // │ R:R = 6:2.5 = 2.4:1 / 손익분기 승률 29.4% (보수적)                   │
    // │ 익일 강제청산 없음 — 최대 5영업일 보유 후 시간손절                    │
    // └────────────────────────────────────────────────────────────────────────┘
    buyThreshold: 0,        // 스캐너 자체 필터 (AI 점수 불필요)
    splitCount: 1,          // 분할 없음 — 시간외 단일가 1회
    averageDownPct: 0,
    maxAveragingCount: 0,
    takeProfitPct: 6.0,     // +6% 익절 → 전량 매도 (단기 반등 실현)
    takeProfitRatio: 1.0,   // 전량 즉시 익절 (트레일링 없음)
    stopLossPct: -2.5,      // -2.5% 손절
    maxHoldingDays: 5,      // 5영업일 → 반등 못 하면 퇴장
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

// ── 동적 포지션 사이징 — 기업 규모 × 수익률 × 리스크 복합 ──
// 국내주식 매수 시 종목 품질에 따라 투자 비중 자동 조절
// 고확신 대형주 → 최대 35%, 고변동 소형주 → 최소 8%
export interface PositionSizeHints {
  score: number;
  confidence?: number;
  isMegaCap?: boolean;    // 시총 상위 10 대형주
  isHighBeta?: boolean;   // 고변동성 (반도체장비, 바이오 등)
  pullbackSignal?: boolean;
  nearHigh52w?: boolean;  // 52주 고점 5% 이내 (저항선 위험)
}

export function getDynamicPositionSizePct(p: PositionSizeHints): number {
  let pct = 25; // 기본 25% (파워풀 모드 — 이전 20%에서 상향)

  // 점수 — 확신 강할수록 더 투자
  if (p.score >= 93)      pct += 6;
  else if (p.score >= 88) pct += 4;
  else if (p.score >= 83) pct += 2;
  else if (p.score < 78)  pct -= 5;

  // 기업 규모 — 대형주는 유동성·안정성 우위
  if (p.isMegaCap) pct += 4;

  // 확신도
  const conf = p.confidence ?? 0.65;
  if (conf >= 0.85)      pct += 3;
  else if (conf < 0.60)  pct -= 4;

  // 기술적 품질
  if (p.pullbackSignal) pct += 2;
  if (p.nearHigh52w)    pct -= 3;

  // 리스크 — 고변동 종목은 비중 축소
  if (p.isHighBeta) pct -= 5;

  return Math.max(8, Math.min(35, Math.round(pct)));
}

// ── 완전 동적 TP/SL — score + 기술지표 복합 계산 ──
// use_dynamic_tpsl=true 시 고정값 대신 이 함수 사용
// 진입 품질(눌림/거래량/RSI/확신도)에 따라 TP/SL 자동 최적화
export interface DomesticTpSlHints {
  score: number;
  confidence?: number;  // 0~1
  rsi?: number;
  volumeRatio?: number;
  pullbackSignal?: boolean;
  envelopePos?: string; // 'BELOW_LOWER' | 'NEAR_LOWER' | 'MIDDLE' | ...
}

export function getDynamicDomesticTpSl(h: DomesticTpSlHints): { takeProfitPct: number; stopLossPct: number; label: string } {
  // 1. 점수 베이스
  let tp: number;
  let sl: number;
  if (h.score >= 93)      { tp = 8.5; sl = -2.5; }
  else if (h.score >= 88) { tp = 7.5; sl = -2.8; }
  else if (h.score >= 83) { tp = 6.5; sl = -3.0; }
  else if (h.score >= 80) { tp = 5.5; sl = -3.0; }
  else                    { tp = 5.0; sl = -3.2; }

  const parts: string[] = [`s${h.score}`];

  // 2. 눌림매매 신호 — 반등 여지 더 넓음
  if (h.pullbackSignal) {
    tp += 0.5;
    sl = Math.min(sl + 0.3, -1.5); // 손절 타이트 (진입 좋으면 빨리 확인)
    parts.push('pb+0.5');
  }

  // 3. 거래량 급증 — 강한 모멘텀
  const vol = h.volumeRatio ?? 1;
  if (vol >= 3.0)      { tp += 1.0; parts.push('v3x+1'); }
  else if (vol >= 2.0) { tp += 0.5; parts.push('v2x+0.5'); }

  // 4. RSI — 과매도는 반등 여지, 과매수는 목표 줄임
  const rsi = h.rsi ?? 50;
  if (rsi < 35)      { tp += 0.5; parts.push('rsiOS+0.5'); }
  else if (rsi > 65) { tp -= 0.5; parts.push('rsiOB-0.5'); }

  // 5. 확신도 높으면 보너스
  const conf = h.confidence ?? 0.65;
  if (conf >= 0.85) { tp += 0.5; parts.push('c+0.5'); }

  // 6. 엔벨로프 하단 이탈 — 반등 여지 극대
  if (h.envelopePos === 'BELOW_LOWER') { tp += 0.5; parts.push('env+0.5'); }

  // 7. 범위 제한
  tp = Math.round(Math.min(tp, 12.0) * 10) / 10;
  sl = Math.round(Math.max(sl, -5.0) * 10) / 10;

  return { takeProfitPct: tp, stopLossPct: sl, label: parts.join('/') };
}

// ── 캐시 & 갱신 주기 ──
export const REFRESH = {
  DART_INTERVAL_MS: 60 * 60_000,           // DART 공시 캐시 갱신: 1시간
  EARNINGS_CACHE_TTL_MS: 4 * 60 * 60_000,  // 실적발표 캐시 TTL: 4시간
  EARNINGS_WINDOW_DAYS: 7,                  // 실적발표 매수 차단 윈도우: 7일
  EARNINGS_FETCH_TIMEOUT_MS: 5_000,         // 실적발표 API 타임아웃: 5초
} as const;

// ── 매매 게이트 ──
export const GATE = {
  SLIPPAGE_PCT: 0.26,                      // 왕복 수수료 0.21% + 슬리피지 0.05% = 실질 거래비용
  REENTRY_COOLDOWN_MS: 30 * 60_000,        // 동일 종목 재진입 쿨다운 (SCALPING, 30분)
  CONSECUTIVE_LOSS_HALT_MS: 60 * 60_000,   // 5연패 → 1시간 쿨다운
  CONSECUTIVE_LOSS_WARN_MS: 45 * 60_000,   // 3연패 → 45분 쿨다운
  COOLDOWN_NOTIFY_MS: 30 * 60_000,         // 쿨다운 알림 최소 간격
} as const;

// ── 섹터 분류 (매수/매도/트레일링 전역 공유) ──
export const SECTOR_CLASS = {
  /** 고변동: EV, 암호화폐, AI반도체, 성장주 */
  HIGH_BETA: ['EV', 'CRYPTO', 'AI_SEMI', 'GROWTH'] as readonly string[],
  /** 중변동: 빅테크, 인프라, 산업재, 클라우드, 헬스, 금융, 일본/대만 */
  MEDIUM_BETA: ['TECH', 'INFRA', 'INDUSTRIAL', 'CLOUD', 'HEALTH', 'FINANCE', 'JP_AUTO', 'JP_TECH', 'JP_BANK', 'TW_SEMI'] as readonly string[],
  /** 방어: 방위산업 */
  DEFENSE: ['DEFENSE'] as readonly string[],
  /** DANGER 장세에서 추가 고베타 취급 (JP_AUTO/JP_TECH 포함) */
  DANGER_HIGH_BETA: ['AI_SEMI', 'GROWTH', 'EV', 'CRYPTO', 'JP_AUTO', 'JP_TECH'] as readonly string[],
} as const;

/**
 * 해외주식 편도 수수료율 (매수/매도 각각 적용)
 * - 매매 수수료: 0.25% (한투 온라인)
 * - 환전 스프레드: ~0.10% (통합증거금 원화→USD)
 * - SEC Fee (매도만): 0.00206% → 편의상 편도에 통합
 * 합계: ~0.36% → 반올림 0.35%
 */
export const OVERSEAS_FEE_PCT = 0.0035;


// ── 미국주식 해외 (통합증거금: 원화→해외주식 직접 주문) ──
export const OVERSEAS = {
  UNIFIED_MARGIN: true,                     // 통합증거금 모드 (별도 USD 환전 불필요)
  TOP_COUNT: 20,                            // 세션 캐시 상위 종목 수 (35종목 풀 → 상위 20 AI 분석)
  ASIA_TOP_COUNT: 6,                        // 아시아장 세션 캐시 상위 종목 수
  AI_INTERVAL_MS: 15 * 60_000,             // AI 호출 최소 간격: 15분 (비용 절감)
  PARKING_MIN_ORDER: 20,                    // 파킹 최소 주문 금액 ($)
  CONCENTRATION_MIN_PNL_PCT: 6.0,           // 집중 대상 최소 수익률 (확실한 승자만 추가매수)
  // 아래 값들은 레거시 폴백 — 실제 사용은 getOverseasDynamic() 동적 함수
  MAX_POSITIONS: 8,
  POSITION_SIZE_USD: 3000,
  POSITION_PCT: 0.25,
  PARKING_CASH_BUFFER: 500,
  MAX_HOLD_DAYS: 21,
  CONCENTRATION_CASH_BUFFER: 400,
  CONCENTRATION_MIN_INVEST: 60,
} as const;

/** 포트폴리오 규모 기반 동적 파라미터 — 고정형 상수 대체 */
export function getOverseasDynamic(portfolioUsd: number, isPaper = false) {
  const p = Math.max(100, portfolioUsd);
  // Paper: 더 많은 종목 허용 ($400당 1종목, 최대 15), Live: $1000당 1종목, 최대 12
  const maxPos = isPaper
    ? Math.max(5, Math.min(15, Math.floor(p / 400)))
    : Math.max(3, Math.min(12, Math.floor(p / 1000)));
  return {
    maxPositions:       maxPos,
    positionSizeUsd:    Math.max(50, Math.min(p * 0.20, 5000)),             // 포트폴리오 20% 캡, 최대 $5k
    positionPct:        p < 2000 ? 0.35 : p < 10000 ? 0.25 : 0.18,         // 소액→35%, 중형→25%, 대형→18%
    parkingCashBuffer:  Math.max(50, Math.round(p * 0.05)),                 // 포트폴리오 5% 현금 유지
    maxHoldDays:        p < 2000 ? 14 : p < 10000 ? 21 : 30,               // 소액→14일, 중형→21일, 대형→30일
    concentrationCashBuffer: Math.max(30, Math.round(p * 0.04)),            // 4% 집중전략 현금
    concentrationMinInvest:  Math.max(30, Math.round(p * 0.01)),            // 1% 최소 집중투자
  };
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
