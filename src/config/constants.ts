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
  BUY_FEE_PCT: 0.00015, // 매수 수수료 0.015%
  SELL_FEE_PCT: 0.00195, // 매도 수수료 0.015% + 거래세 0.18% = 0.195%
  TRANSACTION_TAX_PCT: 0.0018, // 거래세 0.18% (2025 기준 — KOSPI: 증거세 0.03%+농특세 0.15%, KOSDAQ: 증거세 0.18%)
  ROUND_TRIP_PCT: 0.0021, // 왕복 합계 0.21%
} as const;

// ── 환율 비상 폴백 (실시간 API 전체 실패 시만 사용) ──
// fetchExchangeRate()가 내부 폴백으로 이 값을 사용 — 하드코딩 1380/1370 대신 이 상수 참조
export const FALLBACK_FX_RATE = Number(process.env.FALLBACK_FX_RATE) || 1_520; // USD/KRW (실시간 API 장애 시만 사용, env로 조정 가능)

// ── 스케줄러 ──
export const SCHEDULE = {
  // Track A: 무거운 분석 (하루 4회 — 파워풀 모드)
  TRACK_A_CRON: ['30 7 * * 1-5', '0 9 * * 1-5', '30 9 * * 1-5', '0 10 * * 1-5', '30 12 * * 1-5', '0 18 * * 1-5'], // 07:30, 09:00, 09:30, 10:00, 12:30, 18:00 KST 평일
  // Track B: 실시간 감시 (장중 3분 간격 — 트레일링 반응 속도 개선)
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
  SWING: 'SWING', // 🟢 평상시 스윙
  DEFENSE: 'DEFENSE', // 🔴 폭락장 방어
  SCALPING: 'SCALPING', // 🔥 초단타
  DIVIDEND: 'DIVIDEND', // 🏦 배당 자산 파킹 (매수 차단, 장기 보유)
  SNIPER: 'SNIPER', // 🎯 저격수 (AI 88점+ 2종목만, 대형 포지션)
  BOTTOM_FISHING: 'BOTTOM_FISHING', // 🎣 바닥낚시 (시간외 RSI 과매도 우량주)
  EOD_BETTING: 'EOD_BETTING', // 🎰 종가베팅 (15:15 매수 → 익일 09:00 매도)
  BREAKOUT: 'BREAKOUT', // 📈 돌파매매 (5일선/Williams/SEPA/Darvas)
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
    // ┌─ 전략 최적화 v11 (2026-06: 손익분기 WR 인하 — 구조적 흑자 전환) ────┐
    // │ buyThreshold 83: 78→83 (진입 추가 축소, SNIPER급 확신만 진입)        │
    // │ takeProfitPct 7.0%: 5.0%→7.0% (핵심 — 손익분기 WR 36.8%→29.1%)    │
    // │   p×(7.0-0.26)=(1-p)×(2.5+0.26) → p=29.1% — 실전WR30% 흑자구간    │
    // │ splitCount 1: 분할매수 제거 (고확신 일괄진입)                         │
    // │ maxDailyTrades 2: 3→2 (양보다 질)                                    │
    // └─────────────────────────────────────────────────────────────────────┘
    buyThreshold: 80, // v12.1: 83→80 (기존 95% 후보 차단 → 진입 기회 +20%)
    splitCount: 1, // v11: 2→1 (분할 제거, 일괄 진입)
    averageDownPct: 0,
    maxAveragingCount: 0,
    earlyTpPct: 0,
    takeProfitPct: 7.0, // v11: 5.0%→7.0% (손익분기 WR 29.1% — 실전WR30% 초과 → 흑자)
    takeProfitRatio: 0.5,
    stopLossPct: -2.5, // v10.7: -3.5%→-2.5% (손실 빨리 차단, 소액계좌 드로다운 축소)
    maxHoldingDays: 20, // v12.1: 15→20 (21바 사이클 완주 허용, 15일은 사이클 직전 조기 청산)
    maxDailyTrades: 3, // v10.3: 5→3 (과잉거래=구조적 적자의 주범, 수수료 절감)
  },

  DEFENSE: {
    // 폭락장 (-7%+ 시장 낙폭) 방어 운용 — 기본적으로 트리거 안 됨
    buyThreshold: 75, // 보수적 (강한 반등 신호 + 적절한 거래 빈도 확보)
    splitCount: 4, // 4분할 (리스크 최소화)
    averageDownPct: 0, // 물타기 완전 금지
    maxAveragingCount: 0,
    takeProfitPct: 5.0, // 반등 폭 감안 넓은 익절
    takeProfitRatio: 0.5,
    stopLossPct: -2.0, // 손절 타이트 (하락장 추가 낙폭 차단)
    maxHoldingDays: 3,
    marketPenalty: -15,
  },

  SCALPING: {
    // ┌─ 수익 구조 v2 ───────────────────────────────────────────────────────┐
    // │ 진입: 09:00~09:14 (14분 윈도우) / 강제청산: 10:00 (최대 60분 보유)  │
    // │ 익절 +2.0% → 순수익 +1.74% / 손절 -1.2% → 순손실 -1.46%           │
    // │ R:R = 1.19:1 / 손익분기 승률 45.6% — 수수료 반영 후에도 양의 기대값 │
    // └────────────────────────────────────────────────────────────────────┘
    buyThreshold: 87,
    // 87점: 최고확신 종목만 진입 — 상위 ~5% 신호만
    splitCount: 1, // 분할 없이 한 번에 전량 진입 (개장 직후 속도 최우선)
    averageDownPct: 0, // 물타기 절대 금지 (시간 없음)
    maxAveragingCount: 0,
    takeProfitPct: 2.0,
    // +2.0% — 수수료(0.26%) 반영 순수익 +1.74%, R:R 1.19:1 (v1 0.85:1→역전 해소)
    takeProfitRatio: 1.0, // 전량 즉시 익절
    stopLossPct: -1.2,
    // -1.2% 손절 (개장 노이즈 필터)
    maxHoldingDays: 0, // 당일 청산 필수
    forceCloseTime: '10:00', // 10:00 강제청산 (여유 60분 윈도우)
  },

  DIVIDEND: {
    // 배당 자산 파킹 모드 — 신규 매수 decision-flow에서 차단, 보유종목 장기 유지
    buyThreshold: 99, // 99점 이상만 매수 (이중안전장치)
    splitCount: 1,
    averageDownPct: 0,
    maxAveragingCount: 0,
    takeProfitPct: 5.0, // 배당주 TP 여유있게 (장기 보유)
    takeProfitRatio: 0.5, // 반만 익절 (나머지 배당 수령)
    stopLossPct: -3.0, // 배당주 SL 넓게 (배당으로 만회)
    maxHoldingDays: 90, // 최대 90일 (분기 배당 수령)
  },

  SNIPER: {
    // ┌─ 수익 구조 ─────────────────────────────────────────────────────────┐
    // │ AI 85점+ 고확신 종목 집중 투자 — 저격수 전략                       │
    // │ 익절 +8% / 손절 -3% (고확신 = 틀리면 빠르게 손절)                 │
    // │ v13: 물타기 제거 — averageDown -3% = SL -3% 충돌 버그 수정         │
    // └────────────────────────────────────────────────────────────────────┘
    buyThreshold: 85, // v11: 88→85 (진입 소폭 확장, 실전 유지)
    splitCount: 1, // 분할 없음 — 단번에 풀 포지션
    averageDownPct: 0, // v13: 물타기 제거 (averageDown -3% = SL -3% 동일 트리거 충돌)
    maxAveragingCount: 0,
    takeProfitPct: 8.0, // +8% 익절
    takeProfitRatio: 0.5, // 50% 부분 매도 → 잔여 트레일링
    stopLossPct: -3.0, // v7: -4%→-3% (고확신 종목은 타이트 SL로 손실 제한)
    maxHoldingDays: 14, // v11.0: 7→14 (고확신 종목 TP까지 충분한 시간 확보)
  },

  BOTTOM_FISHING: {
    // ┌─ 시간외 바닥낚시 ─────────────────────────────────────────────────────┐
    // │ 시장 전체 RSI과매도 우량주 자동 발굴 → TP/SL 기계적 청산             │
    // │ R:R = 6:2.5 = 2.4:1 / 손익분기 승률 29.4% (보수적)                   │
    // │ 익일 강제청산 없음 — 최대 5영업일 보유 후 시간손절                    │
    // └────────────────────────────────────────────────────────────────────────┘
    buyThreshold: 99, // v10.8: 0→99 — 메인 파이프라인 차단 (사이드채널 주입 전용: closing-bell-job, eod-bluechip)
    splitCount: 1, // 분할 없음 — 시간외 단일가 1회
    averageDownPct: 0,
    maxAveragingCount: 0,
    takeProfitPct: 6.0, // +6% 익절 → 전량 매도 (단기 반등 실현)
    takeProfitRatio: 1.0, // 전량 즉시 익절 (트레일링 없음)
    stopLossPct: -2.5, // -2.5% 손절
    maxHoldingDays: 5, // 5영업일 → 반등 못 하면 퇴장
  },

  EOD_BETTING: {
    // ┌─ 종가베팅 (15:15~15:20 매수 → 익일 09:00~09:10 기계적 매도) ────────┐
    // │ 당일 거래대금 1,000억+ 주도주, 종가 부근(캔들 상단 20%)만 진입       │
    // │ 재탕 종목(전일 급등주) 제외, 최대 12종목, 시드 12%/포지션            │
    // │ 익일 장시작 기계적 매도 — 갭수익 or 손절, 무조건 청산               │
    // └────────────────────────────────────────────────────────────────────────┘
    buyThreshold: 0, // 스캐너 자체 필터 (AI 점수 불필요)
    splitCount: 1, // 분할 없음 — 종가 1회 진입
    averageDownPct: 0,
    maxAveragingCount: 0,
    takeProfitPct: 5.0, // +5% 갭업 시 즉시 익절
    takeProfitRatio: 1.0, // 전량 매도
    stopLossPct: -3.0, // -3% 갭다운 시 즉시 손절
    maxHoldingDays: 1, // 1일 (익일 강제청산)
  },

  BREAKOUT: {
    // ┌─ 돌파매매 전략 (4가지 서브패턴 통합) ──────────────────────────────┐
    // │ A. 차트박사 5일선 돌파: 60일 신고가→20MA 눌림→5MA 상향돌파        │
    // │ B. 래리 윌리엄스 변동성 돌파: 당일시가+전일range×K, 익일 시가매도  │
    // │ C. 미너비니 SEPA: 150>200MA 상승, 52주저+25%, 횡보후 돌파          │
    // │ D. 다바스 박스 돌파: 박스 상단 돌파 + 거래량 1.5x 확인             │
    // │                                                                    │
    // │ 공통: 거래량 1.5x+ 확인 필수 (가짜돌파 필터)                       │
    // │ TP +8% (돌파 모멘텀 확장) / SL -5% (차트박사 기준 기계적 손절)     │
    // │ R:R = 8:5 = 1.6:1 / 손익분기 승률 38.5%                           │
    // │ 1등 주도주 + 강한 거래대금 쏠림 종목만 진입 (미모사 원칙)          │
    // └────────────────────────────────────────────────────────────────────┘
    buyThreshold: 70, // v11: 0→70 (AI 품질 필터 추가 — 기술적 신호+AI 최저선)
    splitCount: 2, // 돌파확인 + 2차 진입
    averageDownPct: 0, // v11: -3.0→0 (물타기 제거 — 돌파 실패 시 손실 확대 방지)
    maxAveragingCount: 0, // v11: 1→0
    earlyTpPct: 0,
    takeProfitPct: 8.0, // 돌파 모멘텀 타겟
    takeProfitRatio: 0.5, // 50% 부분익절 → 잔여 트레일링
    stopLossPct: -3.5, // v10.8: -5.0%→-3.5% (WR35% 구조적 손실 축소, R:R 2.29:1→손익분기 30.4%)
    maxHoldingDays: 10, // 최대 10일 (Williams는 1일 — sell-signals에서 별도 처리)
  },
} as const;

// ── KIS API Transaction IDs ──
export const KIS_TR_ID = {
  // 실거래
  LIVE: {
    BUY: 'TTTC0802U',
    SELL: 'TTTC0801U',
    CANCEL: 'TTTC0803U',
    BALANCE: 'TTTC8434R',
    BUYABLE: 'TTTC8908R', // 매수가능조회 — nrcvb_buy_amt = 실제 주문가능원화
    ORDER_STATUS: 'TTTC8001R',
  },
  // 모의투자
  PAPER: {
    BUY: 'VTTC0802U',
    SELL: 'VTTC0801U',
    CANCEL: 'VTTC0803U',
    BALANCE: 'VTTC8434R',
    BUYABLE: 'VTTC8908R', // 매수가능조회 (모의)
    ORDER_STATUS: 'VTTC8001R',
  },
  // 시세 조회 (공통)
  QUOTE: {
    CURRENT_PRICE: 'FHKST01010100',
    ORDERBOOK: 'FHKST01010200',
    DAILY_CHART: 'FHKST01010400',
    MINUTE_CHART: 'FHKST01010500',
    INVESTOR_FLOW: 'FHKST01010900',
    BROKER_INFO: 'FHKST01010600', // 거래원(회원사) 정보
  },
  // 시장 시그널 (market-signals.ts 전용)
  SIGNAL: {
    TRADING_INTENSITY: 'FHPST01680000', // 체결강도
    SHORT_SELLING: 'FHPST04830000', // 공매도 일별추이
    PROGRAM_TRADING: 'FHPPG04650101', // 프로그램매매 종합
    ORDERBOOK_RANKING: 'FHPST01720000', // 호가잔량 순위
    SECTOR_INDEX: 'FHPUP02100000', // 업종별 지수
    INTRADAY_INVESTOR: 'HHPTJ04160200', // 투자자별 추정가집계 (장중)
    FOREIGN_INST_TOP: 'FHPTJ04400000', // 외국인/기관 매매종목 가집계
    EXPECTED_FILL: 'FHPST01820000', // 예상체결 상승/하락 순위
    CREDIT_BALANCE: 'FHKST17010000', // 신용잔고 순위
    STOCK_LENDING: 'HHPST074500C0', // 대차거래추이
    NEAR_52W_HIGH_LOW: 'FHPST01870000', // 신고가/신저가 근접
  },
} as const;

// ── 점수 기반 동적 익절/손절 파라미터 (v13: 5단계 + R:R guard) ──
// getDynamicDomesticTpSl 5단계 베이스 + R:R 1.5:1~4:1 검증 통합
//   • <80  (저확신):  5.0% TP / -4.0% SL → R:R 1.25→1.5 조정
//   • 80-82 (중확신): 6.0% TP / -3.8% SL → R:R 1.58:1
//   • 83-87 (고확신): 7.0% TP / -3.5% SL → R:R 2.0:1
//   • 88-92 (초고확신): 8.0% TP / -3.3% SL → R:R 2.42:1
//   • 93+  (최고확신): 9.0% TP / -3.0% SL → R:R 3.0:1
// 핵심: 저점수도 SL 넓혀 노이즈 손절 방지 + R:R guard로 비현실적 비율 차단
export function getScoreBasedParams(score: number): { takeProfitPct: number; stopLossPct: number } {
  let tp: number;
  let sl: number;
  if (score >= 93) { tp = 9.0; sl = -3.0; }
  else if (score >= 88) { tp = 8.0; sl = -3.3; }
  else if (score >= 83) { tp = 7.0; sl = -3.5; }
  else if (score >= 80) { tp = 6.0; sl = -3.8; }
  else { tp = 5.0; sl = -4.0; }

  // R:R guard (1.5:1 ~ 4:1)
  const rr = tp / Math.abs(sl);
  if (rr > 4.0) tp = Math.round(Math.abs(sl) * 4.0 * 10) / 10;
  else if (rr < 1.5) tp = Math.round(Math.abs(sl) * 1.5 * 10) / 10;

  return { takeProfitPct: tp, stopLossPct: sl };
}

// ── 동적 포지션 사이징 — 황금비율: 장이 나쁘면 매수 없고, 매수하면 그만큼 확실한 것 ──
// 고확신 대형주 눌림 → 최대 35%, 평범한 매수 → 25%, 고변동 소형주 → 최소 8%
// 장이 안 좋으면 매수 자체가 안 나오므로 매수 발생 = 상위 필터 통과 = 비중 확대 정당
export interface PositionSizeHints {
  score: number;
  confidence?: number;
  isMegaCap?: boolean; // 시총 상위 10 대형주
  isHighBeta?: boolean; // 고변동성 (반도체장비, 바이오 등)
  pullbackSignal?: boolean;
  nearHigh52w?: boolean; // 52주 고점 5% 이내 (저항선 위험)
}

export function getDynamicPositionSizePct(p: PositionSizeHints): number {
  let pct = 25; // 기본 25% (조건 충족 매수 = 이미 검증된 기회)

  // 점수 — 확신 강할수록 더 투자 (황금비율 핵심)
  if (p.score >= 93)
    pct += 8; // 최고확신 → 33%
  else if (p.score >= 88)
    pct += 5; // 고확신 → 30%
  else if (p.score >= 83)
    pct += 3; // 중확신 → 28%
  else if (p.score < 78) pct -= 5; // 저확신 → 20%

  // 기업 규모 — 대형주는 유동성·안정성 우위
  if (p.isMegaCap) pct += 4;

  // 확신도
  const conf = p.confidence ?? 0.65;
  if (conf >= 0.85) pct += 3;
  else if (conf < 0.6) pct -= 4;

  // 기술적 품질 — 눌림매매는 최적 진입점
  if (p.pullbackSignal) pct += 3;
  if (p.nearHigh52w) pct -= 3;

  // 리스크 — 고변동 종목은 비중 축소
  if (p.isHighBeta) pct -= 5;

  // Hard Cap 35% — 황금비율 상한 (일일손실 35%×SL-3.5%=-1.2% 허용 범위)
  // 실제 캐시 잔고·동시포지션 한도가 2차 방어선으로 작동
  return Math.max(8, Math.min(35, Math.round(pct)));
}

// ── 완전 동적 TP/SL — 해외주식 calcDynamicTpSl과 동등한 다팩터 엔진 ──
// 진입 + 보유 중 모두 사용. use_dynamic_tpsl 플래그 폐지 → 항상 동적
// 팩터: AI score + ADX(추세) + ATR%(변동성) + RSI + 거래량 + 시장레짐 + 수급
export interface DomesticTpSlHints {
  score: number;
  confidence?: number; // 0~1
  rsi?: number;
  adx?: number; // 추세 강도 (해외의 ADX 대응)
  // 자기학습 피드백 — strategy_config에서 읽은 학습된 TP/SL
  learnedTp?: number; // 양수 (e.g. 6.5) — 학습 결과 최적 TP
  learnedSl?: number; // 음수 (e.g. -2.8) — 학습 결과 최적 SL
  atrPct?: number; // ATR/가격 % (변동성)
  volumeRatio?: number;
  pullbackSignal?: boolean;
  envelopePos?: string; // 'BELOW_LOWER' | 'NEAR_LOWER' | 'MIDDLE' | ...
  isMomentum?: boolean; // SMA5 > SMA20 + ADX > 22
  marketRegime?: 'BULL' | 'NORMAL' | 'CORRECTION' | 'CRASH'; // KOSPI 레짐
  foreignNetBuy?: boolean; // 외국인 순매수
  institutionNetBuy?: boolean; // 기관 순매수
}

export function getDynamicDomesticTpSl(h: DomesticTpSlHints): {
  takeProfitPct: number;
  stopLossPct: number;
  label: string;
} {
  // ── 1. AI 점수 베이스 (5단계) ──
  let tp: number;
  let sl: number;
  // v12.1: TP 상향 — buyThreshold 80 하향에 맞춰 수익 여유 확대
  if (h.score >= 93) {
    tp = 10.5;
    sl = -3.0;
  } // 최고확신: 3.5:1 R:R (러너 확률 높음, 충분한 여유)
  else if (h.score >= 88) {
    tp = 9.0;
    sl = -3.0;
  } // 초고확신: 3.0:1 R:R
  else if (h.score >= 83) {
    tp = 8.0;
    sl = -3.5;
  } // 고확신: 2.29:1 R:R
  else if (h.score >= 80) {
    tp = 7.0;
    sl = -3.5;
  } // 중확신: 2.0:1 R:R (기존 진입 기준선)
  else {
    tp = 6.0;
    sl = -4.0;
  } // 저확신: 1.5:1 R:R

  // ── 1b. 자기학습 피드백 블렌딩 (30% 학습 + 70% 점수기반) ──
  // 확률싸움: 내역 쌓일수록 학습된 최적 TP/SL이 점수기반을 점진 보정
  if (h.learnedTp != null && h.learnedTp > 0) {
    tp = tp * 0.7 + h.learnedTp * 0.3;
  }
  if (h.learnedSl != null && h.learnedSl < 0) {
    sl = sl * 0.7 + h.learnedSl * 0.3;
  }

  const parts: string[] = [`s${h.score}`];

  // ── 2. ADX 추세 강도 (해외 calcDynamicTpSl 대응) ──
  const adx = h.adx ?? 25;
  if (adx >= 35) {
    // 강한 추세 → 소폭 TP 확장 (v10.7: 1.4→1.15, 역전 위험 감소)
    tp *= 1.15; // +15% TP (40%→15% 축소: 강추세=피크 임박, 욕심 자제)
    sl -= 0.2;
    parts.push('ADX35+');
  } else if (adx >= 25) {
    // 중간 추세 → 약간 확장
    tp *= 1.15;
    parts.push('ADX25+');
  } else if (adx < 18) {
    // 횡보장 (추세 없음) → TP 축소 (빠른 수익 확정)
    tp *= 0.85;
    sl += 0.3; // SL 타이트 (방향 없으면 빠르게 탈출)
    parts.push('ADX<18');
  }

  // ── 3. ATR% 변동성 반영 (해외의 VIX 레짐 대응) ──
  const atrPct = h.atrPct ?? 2.0; // KOSPI 대형주 평균 1~2%
  if (atrPct >= 4.0) {
    // 고변동: SL 넓히고 TP도 넓힘 (노이즈에 안 걸리게)
    sl -= 1.0;
    tp += 1.5;
    parts.push('히변동');
  } else if (atrPct >= 3.0) {
    sl -= 0.5;
    tp += 0.5;
    parts.push('중변동');
  } else if (atrPct < 1.5) {
    // 저변동: SL 타이트, TP도 현실적
    sl += 0.3;
    parts.push('저변동');
  }

  // ── 4. 모멘텀 (SMA5>SMA20 + ADX>22) ──
  if (h.isMomentum) {
    tp += 1.0; // 모멘텀 상승 중 → TP 확장 (추세 타기)
    parts.push('MTM+1');
  }

  // ── 5. RSI — 과매도 반등 / 과매수 주의 ──
  const rsi = h.rsi ?? 50;
  if (rsi < 30) {
    tp += 1.0;
    sl -= 0.3;
    parts.push('rsiOS30');
  } else if (rsi < 40) {
    tp += 0.5;
    parts.push('rsiOS40');
  } else if (rsi > 70) {
    tp -= 1.0;
    sl += 0.5;
    parts.push('rsiOB70');
  } else if (rsi > 60) {
    tp -= 0.3;
    parts.push('rsiOB60');
  }

  // ── 6. 거래량 급증 ──
  const vol = h.volumeRatio ?? 1;
  if (vol >= 3.0) {
    tp += 1.0;
    parts.push('v3x');
  } else if (vol >= 2.0) {
    tp += 0.5;
    parts.push('v2x');
  }

  // ── 7. 확신도 ──
  const conf = h.confidence ?? 0.65;
  if (conf >= 0.9) {
    tp += 1.0;
    parts.push('c90+');
  } else if (conf >= 0.8) {
    tp += 0.5;
    parts.push('c80+');
  }

  // ── 8. 눌림매매 신호 ──
  if (h.pullbackSignal) {
    tp += 0.5;
    sl -= 0.3;
    parts.push('PB');
  }

  // ── 9. 엔벨로프 위치 ──
  if (h.envelopePos === 'BELOW_LOWER') {
    tp += 0.5;
    parts.push('env↓');
  }

  // ── 10. 시장 레짐 (해외 VIX 대응) ──
  const regime = h.marketRegime ?? 'NORMAL';
  if (regime === 'CRASH') {
    tp -= 1.5;
    sl += 0.8; // 폭락장: TP 낮추고 SL 타이트 (빠른 탈출)
    parts.push('CRASH');
  } else if (regime === 'CORRECTION') {
    tp -= 0.5;
    sl += 0.3;
    parts.push('CORR');
  } else if (regime === 'BULL') {
    tp += 1.0; // 강세장: TP 확장 (상승 여력 큼)
    parts.push('BULL');
  }

  // ── 11. 수급 (외국인/기관 순매수 → 안정적 상승 확률) ──
  if (h.foreignNetBuy && h.institutionNetBuy) {
    tp += 1.0;
    sl -= 0.3; // 동반 순매수 → 강한 지지
    parts.push('쌍수급');
  } else if (h.foreignNetBuy) {
    tp += 0.5;
    parts.push('외인+');
  } else if (h.institutionNetBuy) {
    tp += 0.3;
    parts.push('기관+');
  }

  // ── ATR 바닥 보장 (overseas calcDynamicTpSl 포팅) ──
  // SL이 1.5×ATR보다 타이트하면 노이즈에 걸림 → ATR×1.5를 최소 SL로 강제
  if (atrPct > 0) {
    const atrFloor = -(atrPct * 1.5);
    if (sl > atrFloor) {
      sl = Math.max(atrFloor, -8.0); // ATR 바닥 적용 (최대 -8% 유지)
      parts.push('ATR바닥');
    }
  }

  // ── 범위 제한 ──
  tp = Math.round(Math.min(Math.max(tp, 3.0), 15.0) * 10) / 10;
  sl = Math.round(Math.max(Math.min(sl, -1.5), -8.0) * 10) / 10;

  // ── R:R 비율 검증 — 확률싸움에서 비현실적 비율 방지 ──
  // R:R = TP / |SL|, 1.5:1 ~ 4:1 범위 강제
  const rr = tp / Math.abs(sl);
  if (rr > 4.0) {
    // R:R 너무 높음 → TP를 |SL|×4로 줄임 (SL 유지, TP 축소 — 손실 확대 방지)
    tp = Math.round(Math.abs(sl) * 4.0 * 10) / 10;
    parts.push('RR>4→TP축소');
  } else if (rr < 1.5) {
    // R:R 너무 낮음 → TP를 |SL|×1.5로 올림
    tp = Math.round(Math.abs(sl) * 1.5 * 10) / 10;
    parts.push('RR<1.5→조정');
  }

  return { takeProfitPct: tp, stopLossPct: sl, label: parts.join('/') };
}

// ── 캐시 & 갱신 주기 ──
export const REFRESH = {
  DART_INTERVAL_MS: 60 * 60_000, // DART 공시 캐시 갱신: 1시간
  EARNINGS_CACHE_TTL_MS: 4 * 60 * 60_000, // 실적발표 캐시 TTL: 4시간
  EARNINGS_WINDOW_DAYS: 7, // 실적발표 매수 차단 윈도우: 7일
  EARNINGS_FETCH_TIMEOUT_MS: 5_000, // 실적발표 API 타임아웃: 5초
} as const;

// ── 매매 게이트 ──
export const GATE = {
  SLIPPAGE_PCT: 0.26, // 국내 왕복 마찰비용: 수수료 0.21% + 슬리피지 0.05%
  US_SLIPPAGE_PCT: 0.7, // 미국 왕복 마찰비용: KIS수수료 0.50% + 슬리피지 0.20%
  FX_SAFETY_MARGIN: 0.02, // 통합증거금 FX 안전마진 2% (환율 급변 미수 방지, 5%→2% 적극 운용)
  REENTRY_COOLDOWN_MS: 30 * 60_000, // 동일 종목 재진입 쿨다운 (SCALPING, 30분)
  CONSECUTIVE_LOSS_HALT_MS: 30 * 60_000, // 5연패 → 30분 쿨다운 (60→30분, 반등 타이밍 확보)
  CONSECUTIVE_LOSS_WARN_MS: 20 * 60_000, // 3연패 → 20분 쿨다운 (45→20분)
  COOLDOWN_NOTIFY_MS: 30 * 60_000, // 쿨다운 알림 최소 간격
} as const;

// ── 섹터 분류 (매수/매도/트레일링 전역 공유) ──
export const SECTOR_CLASS = {
  /** 고변동: EV, 암호화폐, AI반도체, 성장주 */
  HIGH_BETA: ['EV', 'CRYPTO', 'AI_SEMI', 'GROWTH'] as readonly string[],
  /** 중변동: 빅테크, 인프라, 산업재, 클라우드, 헬스, 금융, 일본/대만 */
  MEDIUM_BETA: [
    'TECH',
    'INFRA',
    'INDUSTRIAL',
    'CLOUD',
    'HEALTH',
    'FINANCE',
    'JP_AUTO',
    'JP_TECH',
    'JP_BANK',
    'TW_SEMI',
  ] as readonly string[],
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

// ── 황금비율 자금배분 (해외) — 피보나치 기반 ──
// SWING 50% + CORE 30% + TACTICAL 5% + CASH 15% = 100%
// SWING 38.2→50% 완화 (2~3종목만 보유해도 38% 초과하여 매수 차단 방지)
export const ALLOCATION_GOLDEN = {
  SWING_PCT: 0.5, // 중타 (TP +7~25%, 보유 3~14일)
  CORE_PCT: 0.3, // 장타 우량주 (TP +15~30%, 보유 14~30일)
  TACTICAL_PCT: 0.05, // 단타 장중매매 (TP +3.5~5%, 당일~1일)
  CASH_PCT: 0.15, // 현금 유보 (폭락장 방어 + 기회 대기)
} as const;

export type StrategyBucket = 'SWING' | 'CORE' | 'TACTICAL';

// ── 미국주식 해외 (통합증거금: 원화→해외주식 직접 주문) ──
export const OVERSEAS = {
  UNIFIED_MARGIN: true, // 통합증거금 모드 (별도 USD 환전 불필요)
  TOP_COUNT: 20, // 세션 캐시 상위 종목 수 (35종목 풀 → 상위 20 AI 분석)
  ASIA_TOP_COUNT: 6, // 아시아장 세션 캐시 상위 종목 수
  AI_INTERVAL_MS: 15 * 60_000, // AI 호출 최소 간격: 15분 (GPT-4o-mini 전환으로 비용↓ → 간격 단축)
  PARKING_MIN_ORDER: 20, // 파킹 최소 주문 금액 ($)
  CONCENTRATION_MIN_PNL_PCT: 4.0, // 집중 대상 최소 수익률 (위너에 일찍 집중)
  // 고정형 상수 제거 완료 — 모든 동적 파라미터는 getOverseasDynamic() 사용
} as const;

/** 포트폴리오 규모 기반 동적 파라미터 — 고정형 상수 대체
 *  히스테리시스(deadband) 적용: 경계값 ±15% 범위에서 급변 방지
 *  예: $2000 경계 → $1700 이하에서야 소액 tier, $2300 이상에서야 중형 tier
 *  posCapPct: portfolio_allocation_config.position_cap_pct / 100 (live=0.25, paper=0.40)
 *  — alloc-risk-cache.getAllocRisk(isPaper).positionCapPct / 100 을 caller에서 주입
 */
let _lastTier: 'micro' | 'small' | 'large' = 'small';
let _tierInitialized = false; // v10.8: 첫 호출 시 포트폴리오에서 직접 결정 (restart 후 stale 방지)
export function getOverseasDynamic(portfolioUsd: number, isPaper = false, posCapPct = 0.25) {
  const p = Math.max(100, portfolioUsd);

  // 히스테리시스 tier 결정 — 경계값 왕복 whipsaw 방지
  // 상승 시 높은 경계, 하락 시 낮은 경계 (deadband ±15%)
  // v10.8: 첫 live 호출 시 포트폴리오에서 직접 결정 (서버 재시작 후 잘못된 'small' 기본값 방지)
  if (!isPaper) {
    if (!_tierInitialized) {
      _lastTier = p < 2000 ? 'micro' : p < 10000 ? 'small' : 'large';
      _tierInitialized = true;
    } else if (_lastTier === 'micro') {
      if (p >= 2300) _lastTier = 'small'; // 2000 * 1.15
      if (p >= 11500) _lastTier = 'large'; // 10000 * 1.15
    } else if (_lastTier === 'small') {
      if (p < 1700) _lastTier = 'micro'; // 2000 * 0.85
      if (p >= 11500) _lastTier = 'large';
    } else {
      // large
      if (p < 8500) _lastTier = 'small'; // 10000 * 0.85
      if (p < 1700) _lastTier = 'micro';
    }
  }

  // Paper/Live 동일 tier 기반 (Paper 10종목 고정은 과다 분산 → 56% 손실 원인)
  // Paper도 포트폴리오 규모에 맞춰 동적 조정
  const tier = isPaper ? (p < 2000 ? 'micro' : p < 10000 ? 'small' : 'large') : _lastTier;
  // large 포트폴리오는 분산 강화 (0.18 고정), 그 외는 DB posCapPct 사용
  const posPct = tier === 'large' ? Math.min(0.18, posCapPct) : posCapPct;
  const holdDays = tier === 'micro' ? 14 : tier === 'small' ? 21 : 30;

  // v10.11: Paper 15 → 8 (과다 분산 → 70% 현금 잠금 해결)
  const maxPos = isPaper
    ? Math.max(3, Math.min(8, Math.floor(1 / posPct)))     // Paper: Live와 동일 로직 (기존 15 고정)
    : Math.max(2, Math.min(8, Math.floor(1 / posPct)));
  // v10.11: $5k 하드캡 → $10k (수천만원 계좌에서 소액만 매수하는 문제 해결)
  const positionCap = isPaper ? 10000 : 5000;
  return {
    maxPositions: maxPos,
    positionSizeUsd: Math.round(Math.min(p * posCapPct, positionCap)),
    positionPct: posPct,
    parkingCashBuffer: Math.round(p * 0.05), // 포트폴리오 5%
    maxHoldDays: holdDays,
    concentrationCashBuffer: Math.round(p * 0.04), // 포트폴리오 4%
    concentrationMinInvest: Math.round(p * 0.01), // 포트폴리오 1%
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

// ── 국내주식 섹터 맵 (Single Source of Truth) ──
// risk-engine, risk-guard, market-data에서 공유 — 추가/변경 시 이 상수만 수정
export const SECTOR_MAP_KR: Readonly<Record<string, string>> = {
  '000660': '반도체', '005930': '반도체', '042700': '반도체',
  '005290': '반도체', '357780': '반도체', '403870': '반도체',
  '051910': '배터리', '006400': '배터리', '247540': '배터리',
  '373220': '배터리', '336260': '배터리', '003670': '배터리',
  '012450': '방산', '079550': '방산', '034020': '방산',
  '035420': '인터넷', '035720': '인터넷', '377300': '인터넷',
  '207940': '바이오', '068270': '바이오', '328130': '바이오',
  '196170': '바이오', '028300': '바이오',
  '055550': '금융', '105560': '금융', '316140': '금융',
  '267260': '전력', '009540': '조선', '066570': '가전',
};

// ── 거래대금 임계값 (Single Source of Truth) ──
// 여러 파일에 분산된 하드코딩 제거 — surge-detector, signal-router, opening-bell-job 공유
export const TRADING_VALUE = {
  SURGE_MIN: 50_000_000_000,          // 500억: 일반 급등 최소 거래대금 (유동성 확보)
  MEGA_CAP_SURGE_MIN: 300_000_000_000, // 3000억: 초대형주(시총 50조+) 급등 최소 거래대금
} as const;

// ── 월간 MDD 한도 (Single Source of Truth) ──
export const MDD_LIMIT = {
  LIVE: 8,   // 실전: 월간 최대 낙폭 8%
  PAPER: 40, // 연습: 월간 최대 낙폭 40%
} as const;
