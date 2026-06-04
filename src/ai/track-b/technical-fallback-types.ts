import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import type { StockWinRate } from '../../analysis/win-rate.js';
import type { TransactionChain } from '../../db/models.js';
import type { CurrentPrice, DailyCandle } from '../../kis/market.js';
import type { TechnicalSummary } from '../../analysis/indicators.js';
import type { StockSignals } from '../../kis/market-signals.js';

export interface TechnicalFallbackParams {
  mode: StrategyMode;
  watchlist: Array<{ stock_code: string; stock_name: string }>;
  livePrices: Map<string, CurrentPrice>;
  chartData: Map<string, DailyCandle[]>;
  openChains: TransactionChain[];
  orderableCash: number;
  maxPositionKrw: number;
  aiScores?: Array<{ stock_code: string; score: number }>;
  /** 손절 쿨다운 종목 코드 — 재진입 금지 (14일) */
  lossBlockedCodes?: Set<string>;
  /** -5% 초과 손실 매도 종목 — 30일 절대 차단 (allowRebuy override만 해제) */
  bigLossBlockedCodes?: Set<string>;
  /** 24시간 이내 CEO 수동 매도 종목 코드 — 재진입 금지 */
  manuallySoldCodes?: Set<string>;
  /** 최근 2시간 매도 종목 코드 — 재진입 쿨다운 (반복매수 방지) */
  recentlySoldCodes?: Set<string>;
  /** 전체 자산 규모 (포지션 크기 동적 계산용) */
  totalAssets?: number;
  /** DB 전략 설정값 — 있으면 STRATEGY_PARAMS 하드코딩 대신 사용 */
  takeProfitPct?: number;
  stopLossPct?: number;
  buyThreshold?: number;
  /** 종목별 과거 승률 — AI 없이도 진입 임계값 동적 조정 */
  winRates?: Map<string, StockWinRate>;
  /** 장 마감 30분 전(14:30~) — 신규 매수 차단 */
  blockNewBuys?: boolean;
  /** 강세장 부스터: true이면 TP +1.5% 상향 */
  kospiBoost?: boolean;
  /** 황금비율 배분 목표 — 주식 비중 초과 시 매수 기준 상향 (더 선택적 진입) */
  allocationTarget?: { stock_pct: number; rebalance_threshold_pct: number; is_active: boolean } | null;
  /** 현재 주식 포지션 가치 (황금비율 계산용) */
  currentStockValue?: number;
  /** 잡주 필터: 외국인/기관 동반 이탈(STRONG_SELL) 종목 코드 — 신규 매수 차단 */
  junkStockCodes?: Set<string>;
  /** 승률피드백: 눌림목 패턴 없으면 스킵 (연속 손절 시 자동 강화) */
  requirePullback?: boolean;
  /** 승률피드백: 최소 거래량 배율 하한 (기본 1.0, 저확신 구간 1.5/2.0) */
  minVolumeRatio?: number;
  /** 호가 매도벽 차단: bid/ask ≤ 0.5인 종목 — 진입 완전 차단 (hard gate) */
  orderbookBlockedCodes?: Set<string>;
  /** opening-bell-job 전용: SCALPING 신규 매수 허용 (line 742 continue 우회) */
  allowScalpingBuys?: boolean;
  /** KIS 시장 시그널 (체결강도, 공매도, 수급 등) — pipeline에서 한 번 수집 후 전달 */
  marketSignals?: Map<string, StockSignals>;
  /** 매크로/레짐 기반 포지션 축소 배율 (RISK_OFF=0.5, 하락장=0.5, 조정=0.7, 정상=1.0) */
  macroSizingMult?: number;
}

export interface BuyCandidate {
  stock_code: string;
  tech: TechnicalSummary;
  price: CurrentPrice;
  candleBonus: number;
  regimeRoute?: import('./strategy-router.js').RouteResult;
  /** ScalpingRadar가 감지한 모멘텀 종목 → SCALPING 파라미터로 진입 */
  isScalpOverride?: boolean;
}

/** STRATEGY_PARAMS[mode] + DB 오버라이드 병합 */
export function resolveStrategyParams(mode: StrategyMode, params: TechnicalFallbackParams) {
  const base = STRATEGY_PARAMS[mode];
  return {
    ...base,
    takeProfitPct: params.takeProfitPct ?? base.takeProfitPct,
    stopLossPct: params.stopLossPct ?? base.stopLossPct,
    buyThreshold: params.buyThreshold ?? base.buyThreshold,
  };
}

export type ResolvedStrategyParams = ReturnType<typeof resolveStrategyParams>;

/** KST 시간 계산 (매도/매수 양쪽 사용) — SCALPING forceCloseTime(constants.ts) 참조 */
const _scalpDeadline = (() => {
  const t = STRATEGY_PARAMS.SCALPING.forceCloseTime; // '10:00'
  const [h, m] = t.split(':').map(Number);
  return { h, m };
})();

export function getKstScalpTime() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  return { h, m, isPastScalpDeadline: h > _scalpDeadline.h || (h === _scalpDeadline.h && m >= _scalpDeadline.m) };
}

/** aiScores 배열 → Map 변환 */
export function buildAiScoreMap(aiScores?: Array<{ stock_code: string; score: number }>): Map<string, number> {
  return new Map((aiScores ?? []).map((s) => [s.stock_code, s.score]));
}

/** AI 스코어 전체 부재 여부 */
export function hasNoAiScores(aiScores?: Array<{ stock_code: string; score: number }>): boolean {
  return (aiScores ?? []).length === 0 || (aiScores ?? []).every((s) => s.score === 0);
}
