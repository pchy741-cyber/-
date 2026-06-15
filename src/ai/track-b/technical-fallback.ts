import type { TradeDecision } from '../../db/models.js';
import { logger } from '../../utils/logger.js';
import { executeBuyDecisions } from './buy-execution.js';
import { filterBuyCandidates } from './buy-filters.js';
import { generateSellDecisions } from './sell-signals.js';
import type { TechnicalFallbackParams } from './technical-fallback-types.js';

/**
 * AI API 없이 기술적 지표만으로 매매 판단
 * RSI + MACD + 볼린저밴드 + ADX + 골든/데드크로스 종합
 */
export async function technicalFallbackDecisions(params: TechnicalFallbackParams): Promise<TradeDecision[]> {
  // 1. 보유 종목 매도 판단 (손절/익절/강제청산/기술매도)
  const sellDecisions = await generateSellDecisions(params);

  // 장 마감 전 — 신규 매수 차단 (매도/손절 결정만 반환)
  // v10.5: 고확신 종목(AI 85+)은 blockNewBuys 무시 — 기존 90+ 오버라이드는 실제로 작동 안했음
  if (params.blockNewBuys) {
    const topScore = params.aiScores?.[0]?.score ?? 0;
    const hasHighConviction = (params.aiScores ?? []).some((s) => s.score >= 85);
    if (!hasHighConviction) {
      logger.info('⏰ 신규 매수 차단 (blockNewBuys 활성)', { component: 'TRACK_B' });
      return sellDecisions;
    }
    // 고확신 종목만 통과 — 나머지는 필터에서 컷 (buyThreshold 최소 85로 상향)
    logger.info(`🔥 blockNewBuys 활성이나 고확신(top=${topScore}) 존재 → 85+점만 매수 허용`, { component: 'TRACK_B' });
    params = { ...params, blockNewBuys: false, buyThreshold: Math.max(params.buyThreshold ?? 65, 85) };
  }

  // 2. 매수 후보 필터링
  const candidates = await filterBuyCandidates(params);

  // 3. 매수 실행 (정렬 + 분봉 MTF + 교체매매 + 포지션사이징 + 물타기)
  const buyDecisions = await executeBuyDecisions({ ...params, candidates });

  return [...sellDecisions, ...buyDecisions];
}
