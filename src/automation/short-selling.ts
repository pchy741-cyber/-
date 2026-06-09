import { getActiveWatchlist } from '../db/client.js';
import { kisRequest, marketDataRateLimiter } from '../kis/client.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

// ── 공매도 현황 분석 ──

const COMPONENT = 'SHORT_SELLING';

const _shortCache = new Map<string, { data: ShortSellingData; fetchedAt: number; isError?: boolean }>();
const SHORT_CACHE_TTL_MS = 60 * 60 * 1000;       // 60분 — 성공 응답
const SHORT_ERROR_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6시간 — 404/오류 (재시작 후 재폭발 방지)

/** 공매도 TR ID (일별 공매도 현황) */
const TR_SHORT_SELLING = 'FHKST03010400';

export type ShortRiskLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ShortSellingData {
  stockCode: string;
  shortVolume: number; // 오늘 공매도 수량
  shortRatio: number; // 공매도 비율 (%)
  shortTrend: number[]; // 최근 5일 공매도 비율 추세
  isIncreasing: boolean; // 공매도 증가 추세인가
  riskLevel: ShortRiskLevel;
}

interface DailyShortData {
  date: string;
  shortVolume: number; // 공매도 수량
  totalVolume: number; // 총 거래량
  shortRatio: number; // 공매도 비율 (%)
  avgPrice: number; // 공매도 평균가
  currentPrice: number; // 현재가
}

/**
 * KIS API에서 일별 공매도 원시 데이터 조회
 */
async function fetchShortSellingRawData(stockCode: string, days: number): Promise<DailyShortData[]> {
  const endDate = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const startDate = new Date(Date.now() - days * 2 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0]
    .replace(/-/g, '');

  await marketDataRateLimiter.acquire();
  const res = await kisRequest<Record<string, string>[]>({
    path: '/uapi/domestic-stock/v1/quotations/inquire-daily-shortselling',
    trId: TR_SHORT_SELLING,
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
      shortVolume: Number(item.shsl_qty ?? 0),
      totalVolume: Number(item.acml_vol ?? 0),
      shortRatio: Number(item.shsl_ratio ?? 0),
      avgPrice: Number(item.shsl_avg_prc ?? 0),
      currentPrice: Number(item.stck_prpr ?? 0),
    }))
    .filter((d) => d.date !== '')
    .slice(0, days);
}

/**
 * 공매도 비율 추세가 증가세인지 판별
 * 최근 3일 이동평균 vs 이전 구간 비교
 */
function isShortIncreasing(trend: number[]): boolean {
  if (trend.length < 3) return false;

  const recentAvg = trend.slice(0, Math.min(3, trend.length)).reduce((a, b) => a + b, 0) / Math.min(3, trend.length);
  const olderAvg =
    trend.slice(Math.min(3, trend.length)).reduce((a, b) => a + b, 0) /
    Math.max(1, trend.length - Math.min(3, trend.length));

  return recentAvg > olderAvg * 1.1; // 10% 이상 증가시 증가 추세
}

/**
 * 공매도 위험도 판정
 * HIGH: 비율 > 10% && 증가 추세
 * MEDIUM: 비율 > 5%
 * LOW: 그 외
 */
function determineRiskLevel(ratio: number, increasing: boolean): ShortRiskLevel {
  if (ratio > 10 && increasing) return 'HIGH';
  if (ratio > 5) return 'MEDIUM';
  return 'LOW';
}

/**
 * 일별 공매도 현황 조회
 *
 * @param stockCode - 종목코드 (6자리)
 * @param days - 조회 일수 (기본 5일)
 * @returns 공매도 수량, 비율, 추세, 위험도
 */
export async function fetchShortSellingData(stockCode: string, days: number = 5): Promise<ShortSellingData> {
  const cached = _shortCache.get(stockCode);
  const ttl = cached?.isError ? SHORT_ERROR_CACHE_TTL_MS : SHORT_CACHE_TTL_MS;
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    return cached.data;
  }

  try {
    const dailyData = await fetchShortSellingRawData(stockCode, days);

    if (dailyData.length === 0) {
      logger.warn(`공매도 데이터 없음: ${stockCode}`, { component: COMPONENT });
      return {
        stockCode,
        shortVolume: 0,
        shortRatio: 0,
        shortTrend: [],
        isIncreasing: false,
        riskLevel: 'LOW',
      };
    }

    const shortVolume = dailyData[0].shortVolume;
    const shortRatio = dailyData[0].shortRatio;
    const shortTrend = dailyData.map((d) => d.shortRatio);
    const increasing = isShortIncreasing(shortTrend);
    const riskLevel = determineRiskLevel(shortRatio, increasing);

    logger.info(
      `📉 ${stockCode} 공매도 (${days}일): 수량=${shortVolume.toLocaleString()}, ` +
        `비율=${shortRatio.toFixed(1)}%, 추세=${increasing ? '증가' : '감소/횡보'}, 위험=${riskLevel}`,
      { component: COMPONENT },
    );

    const result: ShortSellingData = { stockCode, shortVolume, shortRatio, shortTrend, isIncreasing: increasing, riskLevel };
    _shortCache.set(stockCode, { data: result, fetchedAt: Date.now() });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // HTTP404 = 공매도 불가 종목 (모의투자 또는 비대상 — 정상적 미지원, ERROR 아님)
    const isUnsupported = message.includes('HTTP404') || message.includes('데이터 없음');
    if (isUnsupported) {
      logger.warn(`공매도 미지원 종목 스킵 (${stockCode}) — 6시간 캐시`, { component: COMPONENT });
    } else {
      logger.warn(`공매도 조회 실패 (${stockCode}): ${message}`, { component: COMPONENT });
    }
    const fallback: ShortSellingData = { stockCode, shortVolume: 0, shortRatio: 0, shortTrend: [], isIncreasing: false, riskLevel: 'LOW' };
    _shortCache.set(stockCode, { data: fallback, fetchedAt: Date.now(), isError: true });
    return fallback;
  }
}

/**
 * 공매도 기반 AI 스코어 보정값 산출 (-15 ~ +5)
 *
 * - HIGH (대량 공매도 + 증가): -15 (위험 신호)
 * - MEDIUM: -5
 * - LOW + 감소 추세: +5 (숏커버 랠리 가능성)
 * - 데이터 없음: 0
 */
export async function getShortSellingScoreAdjustment(stockCode: string): Promise<number> {
  const data = await fetchShortSellingData(stockCode);

  if (data.shortTrend.length === 0) return 0;

  let adjustment: number;

  if (data.riskLevel === 'HIGH') {
    adjustment = -15;
  } else if (data.riskLevel === 'MEDIUM') {
    adjustment = -5;
  } else if (!data.isIncreasing && data.shortTrend.length >= 2) {
    // LOW risk + 감소 추세 → 숏커버 랠리 가능성
    adjustment = 5;
  } else {
    adjustment = 0;
  }

  logger.info(
    `📉 ${stockCode} 공매도 스코어 보정: ${adjustment > 0 ? '+' : ''}${adjustment} (${data.riskLevel}, ${data.isIncreasing ? '증가' : '감소'})`,
    { component: COMPONENT },
  );

  return adjustment;
}

/**
 * 감시목록 전체 종목의 공매도 현황 일괄 분석
 *
 * @returns Map<stockCode, ShortSellingData>
 */
export async function analyzeWatchlistShortSelling(): Promise<Map<string, ShortSellingData>> {
  const watchlist = await getActiveWatchlist();
  const results = new Map<string, ShortSellingData>();

  if (watchlist.length === 0) {
    logger.info('감시목록이 비어있어 공매도 분석 스킵', { component: COMPONENT });
    return results;
  }

  logger.info(`📉 감시목록 ${watchlist.length}개 종목 공매도 분석 시작`, { component: COMPONENT });

  // KIS rate limit 대응: 3개씩 배치 처리 (marketDataRateLimiter 4/sec 공유)
  const batchSize = 3;
  for (let i = 0; i < watchlist.length; i += batchSize) {
    const batch = watchlist.slice(i, i + batchSize);
    const flows = await Promise.all(batch.map((item) => fetchShortSellingData(item.stock_code)));

    for (let j = 0; j < batch.length; j++) {
      results.set(batch[j].stock_code, flows[j]);
    }

    // 배치 사이 500ms 대기 (다른 모듈과의 rate limit 충돌 방지)
    if (i + batchSize < watchlist.length) {
      await sleep(500);
    }
  }

  // 요약 로그
  const allData = Array.from(results.values());
  const high = allData.filter((r) => r.riskLevel === 'HIGH').length;
  const medium = allData.filter((r) => r.riskLevel === 'MEDIUM').length;
  const low = allData.filter((r) => r.riskLevel === 'LOW').length;

  logger.info(`📉 공매도 분석 완료: HIGH=${high}, MEDIUM=${medium}, LOW=${low}`, {
    component: COMPONENT,
  });

  return results;
}
