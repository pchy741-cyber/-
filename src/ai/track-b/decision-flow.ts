import { getConcentrationSellTargets } from '../../automation/portfolio-guard.js';
import type { StrategyMode } from '../../config/constants.js';
import type { TradeDecision, TransactionChain } from '../../db/models.js';
import type { CurrentPrice } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { applyEodBluechipStrategy } from './eod-bluechip.js';
import { adjustPositionSizes } from './position-sizer.js';
import { applyHardRules, deduplicateSells, filterEarlySells, filterManualCooldown, filterSectorConcentration } from './risk-guard.js';

/**
 * 매매 결정 필터 체인 — 우선순위 순서 절대 고정
 *
 * ❌ 이 파일의 실행 순서를 변경하지 말 것. 각 단계는 이전 단계 결과에 의존함.
 *
 *  1. 집중도 부분매도 주입  — portfolio-guard 25%↑ 비중 강제 조정 (선점형 매도)
 *  2. 조기 매도 방지        — 손절선 미도달 AI 매도 신호 차단 (수익 구간 포지션 보호)
 *  3. 섹터 집중 차단        — 같은 섹터 2종목↑ 신규매수 차단 (분산 강제)
 *  4. 유휴현금 파킹         — idle cash → ETF 파킹/해제 (기회비용 최소화)
 *  5. 하드룰 강제 실행      — 트레일링 스탑 + 고정 손절 (AI 무관 강제 청산, 최강 우선)
 *  5b. 현재가 주입          — BUY/AVERAGE_DOWN limit_price 보정 (executor 재조회 실패 방지)
 *  6. 수동매도 쿨다운       — CEO 수동매도 후 24시간 재진입 금지 (CEO 의사 존중)
 *  7. 포지션 크기 보정      — KOSPI 레짐 반영 수량 조정 (시장 상황 적응)
 *  8. 중복 매도 제거        — FORCE_CLOSE > SELL > PARTIAL_SELL 우선순위
 *  9. EOD 블루칩 줍줍       — 하락장 14:50 매수 / 익일 09:05 청산 (오버나잇 갭 전략)
 * 10. 최종 필터 + 정렬      — HOLD 제거, 가격 검증, 매도→매수 순
 */

export interface DecisionFlowParams {
  rawDecisions: TradeDecision[];
  openChains: TransactionChain[];
  livePrices: Map<string, CurrentPrice>;
  mode: StrategyMode;
  manuallySoldCodes: Set<string>;
  scores: Array<{ stock_code: string; composite_score?: number }>;
  totalAssets: number;
  kospiRegime: { penalty: number; boost: boolean; todayDown: boolean };
  resolvedSl: number | undefined | null;
  resolvedTp: number | undefined | null;
  orderableCash: number;
  hasBuyCandidates: boolean;
  blockNewBuys: boolean;
  adjMaxPositionKrw: number;
  kstH: number;
  kstM: number;
}

export async function applyDecisionFlow(params: DecisionFlowParams): Promise<TradeDecision[]> {
  const {
    rawDecisions, openChains, livePrices, mode, manuallySoldCodes, scores,
    totalAssets, kospiRegime, resolvedSl, resolvedTp, orderableCash,
    hasBuyCandidates, blockNewBuys, adjMaxPositionKrw, kstH, kstM,
  } = params;

  let decisions = [...rawDecisions];

  // ── 1. 집중도 부분매도 주입 ─────────────────────────────────────────
  const concentrationTargets = getConcentrationSellTargets(openChains, livePrices, totalAssets);
  for (const code of concentrationTargets) {
    const chain = openChains.find((c) => c.stock_code === code);
    if (!chain || chain.total_quantity < 3) continue;
    const sellQty = Math.floor(chain.total_quantity / 3);
    if (sellQty < 1) continue;
    const alreadySelling = decisions.some(
      (d) => d.stock_code === code && ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action),
    );
    if (!alreadySelling) {
      decisions.unshift({
        action: 'PARTIAL_SELL',
        stock_code: code,
        quantity: sellQty,
        price_type: 'MARKET',
        reasoning: '집중도 자동조정: 포트폴리오 25% 초과 + 수익구간 → 1/3 비중 축소',
        confidence: 0.9,
      });
    }
  }

  // ── 2. 조기 매도 방지 필터 ──────────────────────────────────────────
  decisions = filterEarlySells({
    decisions, openChains, livePrices, mode,
    stopLossPct: resolvedSl ?? null,
    takeProfitPct: resolvedTp ?? null,
  });

  // ── 3. 섹터 집중 매수 차단 ──────────────────────────────────────────
  decisions = filterSectorConcentration(decisions, openChains);

  // ── 4. 유휴 현금 파킹 해제 (SELL만 먼저 — BUY는 포지션사이저 이후 step 7.5에서 추가) ──
  let _parkingBuyDecisions: import('../../db/models.js').TradeDecision[] = [];
  {
    const { manageCashParking } = await import('./cash-manager.js');
    const cashDecisions = manageCashParking({
      orderableCash, totalAssets, hasBuyCandidates,
      openChains, livePrices, mode, blockNewBuys,
    });
    for (const d of cashDecisions) {
      if (d.action === 'SELL') decisions.unshift(d);  // 파킹 해제 즉시
      else _parkingBuyDecisions.push(d);               // 파킹 매수는 보류
    }
  }

  // ── 5. 하드룰: 트레일링 스탑 + 고정 손절 (AI 결정 무관 강제 실행) ──
  decisions = await applyHardRules({
    decisions, openChains, livePrices, mode,
    stopLossPct: resolvedSl ?? null,
  });

  // ── 5b. BUY/AVERAGE_DOWN 현재가 주입 ────────────────────────────────
  for (const d of decisions) {
    if ((d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && !d.limit_price) {
      const livePrice = livePrices.get(d.stock_code)?.currentPrice ?? 0;
      if (livePrice > 0) d.limit_price = livePrice;
    }
  }

  // ── 6. CEO 수동 매도 쿨다운 필터 ────────────────────────────────────
  decisions = filterManualCooldown(decisions, manuallySoldCodes);

  // ── 7. 포지션 크기 보정 (KOSPI 레짐 반영) ────────────────────────────
  // adjMaxPositionKrw는 pipeline에서 totalAssets×20%×perfMult×stressMult×earlyWarnMult로 계산
  // position-sizer는 이 값을 기준으로 convMult만 적용 (독자 재계산 안 함)
  decisions = adjustPositionSizes({
    decisions,
    scores: scores.map((s) => ({ stock_code: s.stock_code, composite_score: s.composite_score })),
    mode,
    totalAssets,
    adjMaxPositionKrw,
    kospiRegimePenalty: (Math.min(2, Math.max(0, Math.round(kospiRegime.penalty))) as 0 | 1 | 2),
    kospiBoost: kospiRegime.boost,
  });

  // ── 7.5. 파킹 매수 추가 (포지션사이저 이후 — 사이저가 파킹 수량 줄이지 않게) ──
  // 파킹은 cash-manager가 이미 적정 수량 계산했으므로 사이저 우회
  for (const d of _parkingBuyDecisions) decisions.push(d);

  // ── 8. 중복 매도 신호 제거 (FORCE_CLOSE > SELL > PARTIAL_SELL) ───────
  decisions = deduplicateSells(decisions);

  // ── 9. EOD 블루칩 줍줍 + 익일 장시작 청산 ────────────────────────────
  decisions = applyEodBluechipStrategy(decisions, {
    kstH, kstM, openChains, livePrices,
    todayDown: kospiRegime.todayDown,
    kospiPenalty: kospiRegime.penalty,
    adjMaxPositionKrw,
    blockNewBuys,
    watchlistCodes: scores.map((s) => s.stock_code),
  });

  // ── 10. 최종 필터: HOLD 제거 + 가격 검증 + 실행 순서 정렬 ──────────
  const filtered = decisions.filter((d) => {
    if (d.action === 'HOLD') return false;
    if (d.action === 'BUY' || d.action === 'AVERAGE_DOWN') {
      const hasPrice = (d.limit_price ?? 0) > 0;
      if (!hasPrice) logger.warn(`가격 없는 BUY 제외: ${d.stock_code}`, { component: 'DECISION_FLOW' });
      return hasPrice;
    }
    return true;
  });

  const scoreMap = new Map(scores.map((s) => [s.stock_code, Number(s.composite_score ?? 0)]));
  const actionOrder = (d: TradeDecision) =>
    d.action === 'SELL' ? 0 : d.action === 'AVERAGE_DOWN' ? 1 : 2;
  filtered.sort((a, b) => {
    const orderDiff = actionOrder(a) - actionOrder(b);
    if (orderDiff !== 0) return orderDiff;
    return (scoreMap.get(b.stock_code) ?? 0) - (scoreMap.get(a.stock_code) ?? 0);
  });

  return filtered;
}
