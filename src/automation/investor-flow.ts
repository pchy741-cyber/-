import { KIS_TR_ID } from '../config/constants.js';
import { getActiveWatchlist } from '../db/client.js';
import { kisRequest, marketDataRateLimiter } from '../kis/client.js';
import { logger } from '../utils/logger.js';

// ── 투자자별 매매동향 (외국인/기관/개인) ──

const COMPONENT = 'INVESTOR_FLOW';

// ── 30분 캐시 (Track B 5분 사이클마다 KIS 호출 방지) ──
const _flowCache = new Map<string, { data: InvestorFlowResult; fetchedAt: number }>();
const FLOW_CACHE_TTL_MS = 30 * 60 * 1000;

export type InvestorTrend = 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL';

export interface InvestorFlowResult {
  foreignNet: number; // 외국인 순매수 수량 (합산)
  institutionNet: number; // 기관 순매수 수량 (합산)
  retailNet: number; // 개인 순매수 수량 (합산)
  foreignStreak: number; // 외국인 연속 순매수 일수 (음수 = 연속 순매도)
  trend: InvestorTrend;
}

interface DailyInvestorData {
  date: string;
  foreignNet: number;
  institutionNet: number;
  retailNet: number;
}

/**
 * KIS API에서 투자자별 매매동향 원시 데이터 조회
 */
async function fetchInvestorRawData(stockCode: string, days: number): Promise<DailyInvestorData[]> {
  const endDate = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const startDate = new Date(Date.now() - days * 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0].replace(/-/g, '');

  await marketDataRateLimiter.acquire();
  const res = await kisRequest<Record<string, string>[]>({
    path: '/uapi/domestic-stock/v1/quotations/inquire-investor',
    trId: KIS_TR_ID.QUOTE.INVESTOR_FLOW,
    params: {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: stockCode,
      FID_INPUT_DATE_1: startDate,
      FID_INPUT_DATE_2: endDate,
    },
    useRealUrl: true,
    skipRateLimiter: true,
  });

  const items = (res.output ?? []) as Record<string, string>[];

  return items
    .map((item) => ({
      date: item.stck_bsop_date ?? '',
      foreignNet: Number(item.frgn_ntby_qty ?? 0),
      institutionNet: Number(item.orgn_ntby_qty ?? 0),
      retailNet: Number(item.prsn_ntby_qty ?? 0),
    }))
    .filter((d) => d.date !== '')
    .slice(0, days); // 최신 N일만
}

/**
 * 외국인 연속 순매수/순매도 일수 계산
 * 양수 = 연속 순매수, 음수 = 연속 순매도
 */
function calcForeignStreak(dailyData: DailyInvestorData[]): number {
  if (dailyData.length === 0) return 0;

  const firstDirection = dailyData[0].foreignNet >= 0 ? 1 : -1;
  let streak = 0;

  for (const day of dailyData) {
    const direction = day.foreignNet >= 0 ? 1 : -1;
    if (direction === firstDirection) {
      streak++;
    } else {
      break;
    }
  }

  return streak * firstDirection;
}

/**
 * 투자자 흐름 기반 트렌드 판정
 */
function determineTrend(dailyData: DailyInvestorData[]): InvestorTrend {
  if (dailyData.length < 2) return 'NEUTRAL';

  // 최근 N일 기준으로 외국인/기관 동시 순매수/순매도 연속일 체크
  let bothBuyStreak = 0;
  let bothSellStreak = 0;

  for (const day of dailyData) {
    if (day.foreignNet > 0 && day.institutionNet > 0) {
      bothBuyStreak++;
    } else {
      break;
    }
  }

  for (const day of dailyData) {
    if (day.foreignNet < 0 && day.institutionNet < 0) {
      bothSellStreak++;
    } else {
      break;
    }
  }

  if (bothBuyStreak >= 3) return 'STRONG_BUY';
  if (bothSellStreak >= 3) return 'STRONG_SELL';

  // 외국인 OR 기관 단독 연속 매수/매도
  let foreignBuyStreak = 0;
  let institutionBuyStreak = 0;
  let foreignSellStreak = 0;
  let institutionSellStreak = 0;

  for (const day of dailyData) {
    if (day.foreignNet > 0) foreignBuyStreak++;
    else break;
  }
  for (const day of dailyData) {
    if (day.institutionNet > 0) institutionBuyStreak++;
    else break;
  }
  for (const day of dailyData) {
    if (day.foreignNet < 0) foreignSellStreak++;
    else break;
  }
  for (const day of dailyData) {
    if (day.institutionNet < 0) institutionSellStreak++;
    else break;
  }

  if (foreignBuyStreak >= 2 || institutionBuyStreak >= 2) return 'BUY';
  if (bothSellStreak >= 2) return 'SELL';
  if (foreignSellStreak >= 2 && institutionSellStreak >= 2) return 'SELL';

  return 'NEUTRAL';
}

/**
 * 투자자별 매매동향 조회
 *
 * @param stockCode - 종목코드 (6자리)
 * @param days - 조회 일수 (기본 5일)
 * @returns 외국인/기관/개인 순매수 합산 + 트렌드
 */
export async function getInvestorFlow(stockCode: string, days: number = 5): Promise<InvestorFlowResult> {
  const cached = _flowCache.get(stockCode);
  if (cached && Date.now() - cached.fetchedAt < FLOW_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const dailyData = await fetchInvestorRawData(stockCode, days);

    if (dailyData.length === 0) {
      logger.warn(`투자자 매매동향 데이터 없음: ${stockCode}`, { component: COMPONENT });
      return {
        foreignNet: 0,
        institutionNet: 0,
        retailNet: 0,
        foreignStreak: 0,
        trend: 'NEUTRAL',
      };
    }

    const foreignNet = dailyData.reduce((sum, d) => sum + d.foreignNet, 0);
    const institutionNet = dailyData.reduce((sum, d) => sum + d.institutionNet, 0);
    const retailNet = dailyData.reduce((sum, d) => sum + d.retailNet, 0);
    const foreignStreak = calcForeignStreak(dailyData);
    const trend = determineTrend(dailyData);

    logger.info(
      `📊 ${stockCode} 투자자동향 (${days}일): 외국인 ${foreignNet > 0 ? '+' : ''}${foreignNet.toLocaleString()}, ` +
        `기관 ${institutionNet > 0 ? '+' : ''}${institutionNet.toLocaleString()}, ` +
        `트렌드=${trend}, 외국인연속=${foreignStreak}일`,
      { component: COMPONENT },
    );

    const result: InvestorFlowResult = { foreignNet, institutionNet, retailNet, foreignStreak, trend };
    _flowCache.set(stockCode, { data: result, fetchedAt: Date.now() });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`투자자 매매동향 조회 실패 (${stockCode}): ${message}`, { component: COMPONENT });
    const fallback: InvestorFlowResult = { foreignNet: 0, institutionNet: 0, retailNet: 0, foreignStreak: 0, trend: 'NEUTRAL' };
    _flowCache.set(stockCode, { data: fallback, fetchedAt: Date.now() });
    return fallback;
  }
}

/**
 * 투자자 흐름 기반 AI 스코어 보정값 산출 (-20 ~ +20)
 *
 * - STRONG_BUY: +15
 * - BUY: +8
 * - NEUTRAL: 0
 * - SELL: -10
 * - STRONG_SELL: -20
 */
export async function getFlowScoreAdjustment(stockCode: string): Promise<number> {
  const flow = await getInvestorFlow(stockCode);

  const adjustmentMap: Record<InvestorTrend, number> = {
    STRONG_BUY: 15,
    BUY: 8,
    NEUTRAL: 0,
    SELL: -10,
    STRONG_SELL: -20,
  };

  const adjustment = adjustmentMap[flow.trend];

  logger.info(`📊 ${stockCode} 투자자흐름 스코어 보정: ${adjustment > 0 ? '+' : ''}${adjustment} (${flow.trend})`, {
    component: COMPONENT,
  });

  return adjustment;
}

/**
 * 감시목록 전체 종목의 투자자 매매동향 일괄 분석
 *
 * @returns Map<stockCode, InvestorFlowResult>
 */
export async function analyzeWatchlistFlows(): Promise<Map<string, InvestorFlowResult>> {
  const watchlist = await getActiveWatchlist();
  const results = new Map<string, InvestorFlowResult>();

  if (watchlist.length === 0) {
    logger.info('감시목록이 비어있어 투자자흐름 분석 스킵', { component: COMPONENT });
    return results;
  }

  logger.info(`📊 감시목록 ${watchlist.length}개 종목 투자자흐름 분석 시작`, { component: COMPONENT });

  // KIS rate limit 대응: 2개씩 배치, 1초 대기 (장전/장후 실행이므로 여유있게)
  const batchSize = 2;
  for (let i = 0; i < watchlist.length; i += batchSize) {
    const batch = watchlist.slice(i, i + batchSize);
    const flows = await Promise.all(batch.map((item) => getInvestorFlow(item.stock_code)));

    for (let j = 0; j < batch.length; j++) {
      results.set(batch[j].stock_code, flows[j]);
    }

    if (i + batchSize < watchlist.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // 요약 로그
  const allFlows = Array.from(results.values());
  const strongBuy = allFlows.filter((r) => r.trend === 'STRONG_BUY').length;
  const buy = allFlows.filter((r) => r.trend === 'BUY').length;
  const sell = allFlows.filter((r) => r.trend === 'SELL').length;
  const strongSell = allFlows.filter((r) => r.trend === 'STRONG_SELL').length;

  logger.info(`📊 투자자흐름 분석 완료: STRONG_BUY=${strongBuy}, BUY=${buy}, SELL=${sell}, STRONG_SELL=${strongSell}`, {
    component: COMPONENT,
  });

  return results;
}
