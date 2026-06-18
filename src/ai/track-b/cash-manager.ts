/**
 * 유휴 현금 파킹 관리자 v2 — 퍼센트 기반 동적 파킹
 *
 * v1 문제:
 *   - 30분 최소보유 → 삼성 3회 회전 발생, 매번 손실
 *   - 손실 상태에서 무조건 해제 → 한화오션 -5.5% 확정
 *   - 고정 50% 파킹 → 현금잔고/시장 상황 무시
 *
 * v2 혁신:
 *   - 100% 퍼센트 기반: 고정형 금액 0개, 총자산×동적비율
 *   - 현금잔고 연동: 현금 많을수록 파킹 비율 ↑, 적으면 ↓
 *   - 타이밍 품질 반영: 기술점수 높으면 더 큰 포지션
 *   - 손실 보호: -1.5% 이하면 해제 금지 (회복 대기)
 *   - 2시간 최소 보유: 단타 회전 원천 차단
 *   - 1종목 집중: 2종목 분산 폐지 (회전 줄이고 관리 단순화)
 *   - 수익 자동실현: +2% 이상이면 매수신호 없어도 익절
 *   - Paper 최적화: 연습모드는 쿨다운 짧게 (학습 가속)
 *
 * DEFENSE 모드는 defense-park.ts가 담당
 */

import { analyzeTechnicals } from '../../analysis/indicators.js';
import type { StrategyMode } from '../../config/constants.js';
import { config } from '../../config/index.js';
import type { TradeDecision, TransactionChain } from '../../db/models.js';
import type { CurrentPrice, DailyCandle } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';

// ── 총자산 대비 최소 현금 보유 비율 (defense-park.ts도 임포트) ──
export const CASH_RESERVE_RATIO = 0.2;

/** 모드별 현금 보유 비율: Paper 3% / Live 20% */
export function getCashReserveRatio(isPaper?: boolean): number {
  return isPaper ? config.paperRisk.cashReserveRatio : CASH_RESERVE_RATIO;
}

// ── v2 핵심 상수: 전부 비율(%) 기반, 고정 금액 없음 ──

/** 파킹 검토 시작 현금 비율 — 이 이상이면 파킹 시작 */
const PARK_TRIGGER_RATIO = 0.3;

/** 파킹 최소 금액: 총자산의 2% (절대 최소 1만원은 소자산 폴백) */
const MIN_PARK_RATIO = 0.02;

/** 파킹 최대 비중: 총자산의 30% live / 40% paper (positionCapRatio와 정렬) */
const MAX_PARK_RATIO_LIVE = 0.3;
const MAX_PARK_RATIO_PAPER = 0.4;

/** 최소 보유 시간 (ms) — 1시간 (v1: 30분→v2: 2시간→v3: 1시간, 시장 반전 대응력 개선) */
const MIN_PARK_HOLD_MS = 1 * 60 * 60_000;

/** Paper 모드 최소 보유 — 1시간 (실전과 유사하게 테스트) */
const MIN_PARK_HOLD_MS_PAPER = 60 * 60_000;

/** 해제 손실 보호: 손실이면 해제 금지 (파킹은 무조건 본전 이상에서만 해제) */
const UNPARK_MAX_LOSS_PCT = 0;

/** 해제 강제 타임아웃: 6시간 넘으면 손실이어도 해제 (묶이지 않게) */
const UNPARK_FORCE_TIMEOUT_MS = 6 * 60 * 60_000;

/** 수익 자동실현: +2% 이상 수익이면 매수신호 없어도 익절 */
const PARK_PROFIT_TAKE_PCT = 2.0;

/** 최대 파킹 종목 수 — v2는 1종목 집중 (회전 방지) */
const MAX_PARK_POSITIONS = 1;

// KOSPI 시가총액 Top 5 — 파킹 후보 (2026년 6월 기준)
export const MEGA_CAP_PARK_CANDIDATES: Array<{ code: string; name: string }> = [
  { code: '005930', name: '삼성전자' },        // 1위
  { code: '000660', name: 'SK하이닉스' },      // 2위
  { code: '012450', name: '한화에어로스페이스' }, // 방산 랠리
  { code: '005380', name: '현대차' },           // 자동차
  { code: '005490', name: 'POSCO홀딩스' },      // 철강/소재
];

// 레거시 호환 (pipeline.ts에서 참조)
export const IDLE_PARK_STOCK_CODE = MEGA_CAP_PARK_CANDIDATES[0].code;

export interface CashManagerParams {
  orderableCash: number;
  totalAssets: number;
  hasBuyCandidates: boolean;
  /** 실제 BUY 액션이 존재하는 결정 수 (trade-gate 통과한 것만) */
  confirmedBuyCount?: number;
  openChains: TransactionChain[];
  livePrices: Map<string, CurrentPrice>;
  chartData?: Map<string, DailyCandle[]>;
  mode: StrategyMode;
  blockNewBuys: boolean;
  /** RISK_OFF 조정장 — 대형주 파킹 중단, 현금 유지 */
  macroRiskOff?: boolean;
  /** Paper 모드 여부 (쿨다운/파라미터 분리) */
  isPaper?: boolean;
}

// ── 동적 파킹 비율 산출: 현금잔고 + 타이밍 품질 → 총자산 대비 % ──
// Paper: 황금비율 — 유휴현금 적극 배치 (학습 가속, 모의자금이므로 리스크 허용 상향)
// Live: 보수적 — 실자금 보호 우선
function getDynamicParkPct(cashRatio: number, timingScore: number, isPaper = false): number {
  let basePct: number;
  if (isPaper) {
    // Paper 황금비율: 현금 많을수록 공격적으로 배치
    if (cashRatio >= 0.8)
      basePct = 0.35; // 80%+ → 35%
    else if (cashRatio >= 0.65)
      basePct = 0.28; // 65-80% → 28%
    else if (cashRatio >= 0.5)
      basePct = 0.2; // 50-65% → 20%
    else if (cashRatio >= 0.4)
      basePct = 0.13; // 40-50% → 13%
    else if (cashRatio >= PARK_TRIGGER_RATIO)
      basePct = 0.08; // 30-40% → 8%
    else return 0;
  } else {
    // Live 보수적 유지
    if (cashRatio >= 0.8) basePct = 0.22;
    else if (cashRatio >= 0.65) basePct = 0.16;
    else if (cashRatio >= 0.5) basePct = 0.12;
    else if (cashRatio >= 0.4) basePct = 0.08;
    else if (cashRatio >= PARK_TRIGGER_RATIO) basePct = 0.05;
    else return 0;
  }

  // 타이밍 품질 승수 (0.6x ~ 1.4x)
  const timingMult =
    timingScore >= 35 ? 1.4 : timingScore >= 20 ? 1.2 : timingScore >= 10 ? 1.0 : timingScore >= 0 ? 0.8 : 0.6;

  const maxRatio = isPaper ? MAX_PARK_RATIO_PAPER : MAX_PARK_RATIO_LIVE;
  const rawPct = basePct * timingMult;
  return Math.min(rawPct, maxRatio);
}

/**
 * 유휴 현금 파킹 결정 생성 v2
 * 반환값: SELL(파킹 해제) 결정은 decisions 앞에, BUY(파킹) 결정은 뒤에 추가할 것
 */
export function manageCashParking(params: CashManagerParams): TradeDecision[] {
  const {
    orderableCash,
    totalAssets,
    hasBuyCandidates,
    confirmedBuyCount,
    openChains,
    livePrices,
    chartData,
    mode,
    blockNewBuys,
    macroRiskOff,
    isPaper,
  } = params;

  if (mode === 'DEFENSE') return [];

  const decisions: TradeDecision[] = [];
  const minHoldMs = isPaper ? MIN_PARK_HOLD_MS_PAPER : MIN_PARK_HOLD_MS;

  // 현재 파킹 중인 대형주 체인 확인
  const parkingCodes = new Set(MEGA_CAP_PARK_CANDIDATES.map((c) => c.code));
  const parkChains = openChains.filter((c) => parkingCodes.has(c.stock_code));

  // ── 파킹 해제 로직 v2 ──
  if (parkChains.length > 0) {
    for (const parkChain of parkChains) {
      const qty = Number(parkChain.total_quantity ?? 0);
      if (qty <= 0) continue;

      const holdMs = parkChain.opened_at ? Date.now() - new Date(parkChain.opened_at).getTime() : 0;
      const avgPrice = Number(parkChain.avg_buy_price ?? 0);
      const currentPrice = livePrices.get(parkChain.stock_code)?.currentPrice ?? 0;
      const pnlPct = avgPrice > 0 && currentPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : 0;
      const name = MEGA_CAP_PARK_CANDIDATES.find((c) => c.code === parkChain.stock_code)?.name ?? parkChain.stock_code;

      // ── 수익 자동실현: +2% 이상이면 매수신호 없어도 익절 ──
      if (pnlPct >= PARK_PROFIT_TAKE_PCT && holdMs >= minHoldMs) {
        logger.info(`🎉 파킹 익절: ${name} +${pnlPct.toFixed(1)}% (${qty}주) — 수익 자동실현`, {
          component: 'CASH_MANAGER',
        });
        decisions.push({
          action: 'SELL',
          stock_code: parkChain.stock_code,
          quantity: qty,
          price_type: 'MARKET',
          reasoning: `🎉 파킹 익절: ${name} +${pnlPct.toFixed(1)}% — 수익 자동실현 (목표 ${PARK_PROFIT_TAKE_PCT}%+)`,
          confidence: 0.92,
        });
        continue;
      }

      // ── 타임아웃 강제 해제: confirmedBuyCount 관계없이 묶임 방지 ──
      const forceTimeout = holdMs >= UNPARK_FORCE_TIMEOUT_MS;
      if (forceTimeout) {
        const reason = `⏰ 파킹 타임아웃 해제: ${name} ${pnlPct.toFixed(1)}% (${Math.round(holdMs / 3600_000)}h 초과) — 묶임 방지`;
        logger.info(reason, { component: 'CASH_MANAGER' });
        decisions.push({
          action: 'SELL',
          stock_code: parkChain.stock_code,
          quantity: qty,
          price_type: 'MARKET',
          reasoning: reason,
          confidence: 0.9,
        });
        continue;
      }

      // ── 확정 매수 신호에 의한 해제 ──
      if ((confirmedBuyCount ?? 0) > 0) {
        // 최소 보유 시간 체크
        if (holdMs < minHoldMs) {
          const remainMin = Math.ceil((minHoldMs - holdMs) / 60_000);
          logger.info(
            `⏳ 파킹 유지: ${name} ${remainMin}분 남음 (PnL ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
            { component: 'CASH_MANAGER' },
          );
          continue;
        }

        // ── 손실 보호: 큰 손실이면 해제 금지 (회복 대기) ──
        if (pnlPct < UNPARK_MAX_LOSS_PCT) {
          logger.info(
            `🛡️ 파킹 손실보호: ${name} ${pnlPct.toFixed(1)}% — 손실 중 해제 금지, 본전 이상 대기 (${Math.round(holdMs / 60_000)}분 보유)`,
            { component: 'CASH_MANAGER' },
          );
          continue;
        }

        // 해제 승인
        const reason = `🔄 파킹 해제: ${name} +${pnlPct.toFixed(1)}% — 확정 매수 ${confirmedBuyCount}건 (본전↑ 확인)`;
        logger.info(reason, { component: 'CASH_MANAGER' });
        decisions.push({
          action: 'SELL',
          stock_code: parkChain.stock_code,
          quantity: qty,
          price_type: 'MARKET',
          reasoning: reason,
          confidence: 0.9,
        });
      }
    }
    if (decisions.length > 0) return decisions;
  }

  // ── 파킹 매수 조건 v2 ──
  // RISK_OFF: 조정장 파킹 전면 중단
  if (macroRiskOff) {
    logger.info(`💤 파킹 중단 — 조정장(RISK_OFF) 현금 유지`, { component: 'CASH_MANAGER' });
    return decisions;
  }

  // 이미 최대 파킹 포지션 보유
  if (parkChains.length >= MAX_PARK_POSITIONS) return decisions;

  const cashRatio = totalAssets > 0 ? orderableCash / totalAssets : 0;
  if (cashRatio < PARK_TRIGGER_RATIO) return decisions;

  // 매수 후보 있으면 현금 확보 (단, 현금 60% 이상이면 일부 파킹)
  if (hasBuyCandidates && cashRatio < 0.6) return decisions;

  // 최소 파킹 금액: 총자산의 2%
  const minParkAmount = Math.max(totalAssets * MIN_PARK_RATIO, 10_000);
  if (orderableCash < minParkAmount) return decisions;

  // 이미 파킹 중인 종목 + 보유 중인 종목 제외
  const alreadyHeld = new Set(openChains.map((c) => c.stock_code));

  // ── 대형주 선택: 기술분석 타이밍 기반 ──
  const scored = MEGA_CAP_PARK_CANDIDATES.filter((c) => !alreadyHeld.has(c.code))
    .map((c) => {
      const price = livePrices.get(c.code);
      const candles = chartData?.get(c.code);
      const tech = candles && candles.length >= 30 ? analyzeTechnicals(candles) : null;
      let timingScore = 0;
      if (tech) {
        // RSI 눌림목
        if (tech.rsi14 < 30) timingScore += 10;
        else if (tech.rsi14 < 50) timingScore += 15;
        else if (tech.rsi14 < 60) timingScore += 5;
        else if (tech.rsi14 > 70) timingScore -= 10;
        // MACD
        if (tech.macdCrossover === 'BULLISH') timingScore += 12;
        else if (tech.macdHistogram > 0) timingScore += 5;
        else if (tech.macdCrossover === 'BEARISH') timingScore -= 8;
        // 볼린저
        if (tech.bollingerBreakout === 'DOWN') timingScore += 8;
        if (tech.bollingerSqueeze) timingScore += 5;
        // VWAP
        if (tech.vwapPullback) timingScore += 8;
        if (tech.vwapCross === 'JUST_ABOVE') timingScore += 6;
        // 캔들 패턴
        if (tech.candlePatterns.some((p) => p.bullish && p.strength === 'STRONG')) timingScore += 10;
        else if (tech.candlePatterns.some((p) => p.bullish)) timingScore += 4;
      }
      return { ...c, price, tech, timingScore };
    })
    // 당일 급락 종목 제외 (칼잡이 방지), 과열 종목도 제외
    // paper는 -3% 허용 (대형주 일시 조정도 파킹 학습 기회)
    .filter((c) => c.price && c.price.changePct >= (isPaper ? -3.0 : -2.0) && c.price.changePct <= 5.0);

  // 타이밍 점수 정렬
  const candidates = scored.sort((a, b) => b.timingScore - a.timingScore);

  if (candidates.length === 0) {
    logger.info(`💤 파킹 후보 없음 (현금 ${(cashRatio * 100).toFixed(0)}%)`, { component: 'CASH_MANAGER' });
    return decisions;
  }

  const best = candidates[0];

  // 타이밍 점수 하한: live=0, paper=-5 (대형주 소폭 눌림도 파킹 허용)
  const timingFloor = isPaper ? -5 : 0;
  if (best.timingScore < timingFloor) {
    logger.info(`💤 파킹 보류 — 타이밍 부적합 (최고=${best.timingScore}점, 기준=${timingFloor})`, {
      component: 'CASH_MANAGER',
    });
    return decisions;
  }

  // ── 동적 파킹 비율 산출 (황금비율) ──
  const parkPct = getDynamicParkPct(cashRatio, best.timingScore, isPaper);
  if (parkPct <= 0) return decisions;

  const targetBudget = totalAssets * parkPct;
  // 현금 사용 한도: paper=60% (유휴현금 적극 배치), live=40% (나머지 자동매매용)
  const cashCeilRatio = isPaper ? 0.6 : 0.4;
  const parkBudget = Math.min(targetBudget, orderableCash * cashCeilRatio);
  if (parkBudget < minParkAmount) return decisions;

  const targetPrice = best.price!.currentPrice;
  const quantity = Math.floor(parkBudget / targetPrice);
  if (quantity < 1) return decisions;

  const actualAmount = quantity * targetPrice;
  const actualPctOfAssets = totalAssets > 0 ? ((actualAmount / totalAssets) * 100).toFixed(1) : '?';

  logger.info(
    `💰 파킹 v2: ${best.name}(${best.code}) ${quantity}주 @${targetPrice.toLocaleString()} ` +
      `(총자산 ${actualPctOfAssets}%, 현금비중 ${(cashRatio * 100).toFixed(0)}%, ` +
      `타이밍 ${best.timingScore}점, 당일 ${best.price!.changePct >= 0 ? '+' : ''}${best.price!.changePct.toFixed(2)}%)`,
    { component: 'CASH_MANAGER' },
  );

  decisions.push({
    action: 'BUY',
    stock_code: best.code,
    quantity,
    limit_price: targetPrice,
    price_type: 'MARKET',
    reasoning: `💰 파킹 v2: ${best.name} — 총자산 ${actualPctOfAssets}% | 현금 ${(cashRatio * 100).toFixed(0)}% | 타이밍 ${best.timingScore}점`,
    confidence: 0.7,
    ai_score: 75,
    trigger_source: 'CASH_PARKING',
  });

  return decisions;
}
