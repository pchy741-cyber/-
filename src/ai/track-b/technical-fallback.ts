import type { TradeDecision } from '../../db/models.js';
import { logger } from '../../utils/logger.js';
import { generateSellDecisions } from './sell-signals.js';
import { filterBuyCandidates } from './buy-filters.js';
import { executeBuyDecisions } from './buy-execution.js';
import type { TechnicalFallbackParams } from './technical-fallback-types.js';

/**
 * AI API 없이 기술적 지표만으로 매매 판단
 * RSI + MACD + 볼린저밴드 + ADX + 골든/데드크로스 종합
 */
export async function technicalFallbackDecisions(params: TechnicalFallbackParams): Promise<TradeDecision[]> {
  // 1. 보유 종목 매도 판단 (손절/익절/강제청산/기술매도)
  const sellDecisions = await generateSellDecisions(params);

  // 장 마감 전 — 신규 매수 차단 (매도/손절 결정만 반환)
  if (params.blockNewBuys) {
    logger.info('⏰ 15:10 이후 — 신규 매수 차단 (마감 20분 전)', { component: 'TRACK_B' });
    return sellDecisions;
  }

  // 2. 매수 후보 필터링
  const candidates = await filterBuyCandidates(params);

  // 3. 매수 실행 (정렬 + 분봉 MTF + 교체매매 + 포지션사이징 + 물타기)
  const buyDecisions = await executeBuyDecisions({ ...params, candidates });

  return [...sellDecisions, ...buyDecisions];
}
