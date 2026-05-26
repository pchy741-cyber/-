import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import { config } from '../../config/index.js';
import type { TradeDecision } from '../../db/models.js';
import { logger } from '../../utils/logger.js';

/**
 * AI confidence × composite_score 연속 함수로 포지션 크기 보정
 *
 * multiplier 공식: confFactor×0.55 + scoreFactor×0.45 → 0.6x ~ 1.8x
 * KOSPI 조정장(penalty=1): 최대 포지션 60% 축소
 */
export function adjustPositionSizes(params: {
  decisions: TradeDecision[];
  scores: Array<{ stock_code: string; composite_score?: number }>;
  mode: StrategyMode;
  totalAssets: number;
  /** 0=정상, 1=조정장(60%), 2=하락장(차단) */
  kospiRegimePenalty: 0 | 1 | 2;
  /** 강세장 부스터: true이면 포지션 1.3x + convMult 상한 2.0 */
  kospiBoost?: boolean;
  /** 일일 -2% 조기경고 시 신규 매수 포지션 50% 축소 */
  dailyLossEarlyWarning?: boolean;
}): TradeDecision[] {
  const { decisions, scores, mode, totalAssets, kospiRegimePenalty, kospiBoost, dailyLossEarlyWarning } = params;
  const result = [...decisions];
  const _params = STRATEGY_PARAMS[mode];

  // KOSPI 조정장이면 60%, 강세장이면 1.3x, 정상이면 1.0x; 일일손실 조기경고 추가 50% 축소
  const kospiSizingMult = kospiRegimePenalty >= 1 ? 0.6 : (kospiBoost ? 1.3 : 1.0);
  const earlyWarnMult = dailyLossEarlyWarning ? 0.5 : 1.0;
  // 복리 포지션 사이징: totalAssets × 30% 기반 (황금비율 상향 — 확신 종목 과감 투입)
  const maxPerPosition = Math.round(totalAssets * 0.30 * kospiSizingMult * earlyWarnMult);
  const baseBudget = Math.floor(maxPerPosition / _params.splitCount);

  const scoreMap = new Map<string, number>(
    scores.map((s) => [s.stock_code, Number(s.composite_score ?? 0)]),
  );

  for (const d of result) {
    if (
      (d.action === 'BUY' || d.action === 'AVERAGE_DOWN') &&
      (d.limit_price ?? 0) > 0
    ) {
      const price = d.limit_price!;
      const aiScore = scoreMap.get(d.stock_code) ?? 0;
      const confFactor = Math.min(1, Math.max(0, d.confidence ?? 0.6));
      const scoreFactor = Math.min(1, aiScore / 100);
      const combined = confFactor * 0.55 + scoreFactor * 0.45;
      // 강세장: 상한 2.0x / 정상: 1.5x (황금비율 상향)
      const multCeiling = kospiBoost ? 1.6 : 1.4;
      const convMult = Math.round((0.6 + combined * multCeiling) * 100) / 100;
      const budget = Math.floor(baseBudget * convMult);
      const targetQty = Math.max(1, Math.floor(budget / price));
      const currentQty = d.quantity ?? 0;

      if (currentQty !== targetQty && (currentQty < targetQty || currentQty > targetQty * 2)) {
        const dir = currentQty < targetQty ? '상향' : '하향';
        logger.info(
          `📊 수량 보정(${dir} conf=${(confFactor * 100).toFixed(0)}% score=${aiScore}점 ×${convMult}): ${d.stock_code} ${currentQty}주 → ${targetQty}주 (예산 ${budget.toLocaleString()}원)`,
          { component: 'SIZER' },
        );
        d.quantity = targetQty;
      }
    }
  }

  return result;
}
