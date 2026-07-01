import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import type { TradeDecision } from '../../db/models.js';
import { logger } from '../../utils/logger.js';

/**
 * AI confidence × composite_score 연속 함수로 포지션 크기 보정
 *
 * ⚠️ pipeline.ts의 adjMaxPositionKrw를 기준으로 convMult만 적용.
 *    독자적 30% 재계산 제거 — pipeline과 일관성 유지.
 *
 * convMult 범위: 0.6x ~ 1.6x (강세장 1.8x)
 * 절대 상한: totalAssets × 25% (portfolio-guard 집중도 가드와 일치)
 */
export function adjustPositionSizes(params: {
  decisions: TradeDecision[];
  scores: Array<{ stock_code: string; composite_score?: number }>;
  mode: StrategyMode;
  totalAssets: number;
  /** pipeline에서 계산한 종목당 최대 투입금 (20% × perfMult × stressMult × earlyWarnMult) */
  adjMaxPositionKrw: number;
  /** 0=정상, 1=조정장(60%), 2=하락장(차단) */
  kospiRegimePenalty: 0 | 1 | 2;
  /** 강세장 부스터: true이면 convMult 상한 1.8x */
  kospiBoost?: boolean;
  /** Adam Khoo MA20/MA50/MA200 정배열+우상향 */
  adamKhooBullish?: boolean;
}): TradeDecision[] {
  const { decisions, scores, mode, totalAssets, adjMaxPositionKrw, kospiRegimePenalty, kospiBoost, adamKhooBullish } = params;
  const result = [...decisions];
  const _params = STRATEGY_PARAMS[mode];

  // KOSPI 레짐 보정: 조정장이면 기준금액 25% 축소 (기존 40% → 완화)
  // ※ adamKhoo 승수는 pipeline.ts에서 adjMaxPositionKrw에 이미 반영 (이중 적용 방지)
  const kospiSizingMult = kospiRegimePenalty >= 1 ? 0.75 : (kospiBoost ? 1.2 : 1.0);

  // pipeline이 계산한 adjMaxPositionKrw를 기준으로 사용 (독자 재계산 안 함)
  const maxPerPosition = Math.round(adjMaxPositionKrw * kospiSizingMult);
  const baseBudget = Math.floor(maxPerPosition / _params.splitCount);

  // 절대 상한: totalAssets × 25% (portfolio-guard 집중도와 일치)
  const absoluteCap = totalAssets > 0 ? Math.round(totalAssets * 0.25) : Infinity;

  const scoreMap = new Map<string, number>(scores.map((s) => [s.stock_code, Number(s.composite_score ?? 0)]));

  for (const d of result) {
    if ((d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && (d.limit_price ?? 0) > 0) {
      const price = d.limit_price!;
      const rawAiScore = scoreMap.get(d.stock_code) ?? 0;
      const aiScore = Number.isFinite(rawAiScore) ? rawAiScore : 0;
      const confFactor = Math.min(1, Math.max(0, d.confidence ?? 0.6));
      const scoreFactor = Math.min(1, aiScore / 100);
      const combined = confFactor * 0.55 + scoreFactor * 0.45;
      // 강세장: 상한 2.0x / 정상: 1.6x / AK강세: 1.8x
      const multCeiling = kospiBoost ? 2.0 : adamKhooBullish ? 1.8 : 1.6;
      const convMult = Math.min(multCeiling, Math.round((0.6 + combined * (multCeiling - 0.6)) * 100) / 100);
      // 예산 = baseBudget × convMult × regimeScale, 절대 상한으로 클램프
      const regimeScale = d.regime_position_scale ?? 1.0;
      const rawBudget = Math.floor(baseBudget * convMult * regimeScale);
      // 단일 캡 포인트: 절대상한(25%), 1회손실한도(1.5%÷SL), 원본예산 중 최소값
      // v10.11.2: slPct=0 시 Infinity 방지 — 최소 1% SL 가정
      const slPct = Math.max(0.01, Math.abs(_params.stopLossPct) / 100);
      const maxBudgetByLoss =
        totalAssets > 0 ? Math.floor((totalAssets * 0.015) / slPct) : Infinity;
      // floor 5만원: 곱연산 누적으로 예산이 극소화되어 수량 0주 되는 문제 방지
      const BUDGET_FLOOR = 50_000;
      const budget = Math.max(BUDGET_FLOOR, Math.min(rawBudget, absoluteCap, maxBudgetByLoss));
      const targetQty = Math.max(1, Math.floor(budget / price));
      const currentQty = d.quantity ?? 0;

      if (currentQty !== targetQty && (currentQty < targetQty || currentQty > targetQty * 2)) {
        const dir = currentQty < targetQty ? '상향' : '하향';
        logger.info(
          `📊 수량 보정(${dir} conf=${(confFactor * 100).toFixed(0)}% score=${aiScore}점 ×${convMult}${regimeScale !== 1.0 ? ` regime×${regimeScale}` : ''}): ${d.stock_code} ${currentQty}주 → ${targetQty}주 (예산 ${budget.toLocaleString()}원, 상한 ${absoluteCap.toLocaleString()}원)`,
          { component: 'SIZER' },
        );
        d.quantity = targetQty;
      }
    }
  }

  return result;
}
