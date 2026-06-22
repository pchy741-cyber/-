import { getActiveWatchlist } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

/**
 * 애널리스트 컨센서스 수집기
 *
 * 네이버 금융 모바일 API에서 애널리스트 목표가 컨센서스를 수집.
 * AI 스코어링 파이프라인에서 점수 보정용으로 사용.
 *
 * 캐시: 24시간 (컨센서스는 장중 변하지 않음)
 */

// ── Types ──

export interface AnalystConsensus {
  stockCode: string;
  targetPrice: number; // 평균 목표가
  currentPrice: number; // 현재가
  upsidePct: number; // 괴리율 (목표가 대비 상승여력 %)
  analystCount: number; // 리포트 수
  buyCount: number; // 매수 의견 수
  holdCount: number; // 중립
  sellCount: number; // 매도
  recentChange: 'UP' | 'DOWN' | 'FLAT'; // 최근 목표가 변동 방향
  consensusRating: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL';
}

// ── Cache (24h TTL) ──

const cache = new Map<string, { data: AnalystConsensus; fetchedAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24시간
const CACHE_MAX_SIZE = 200; // 메모리 누수 방지

function getCached(stockCode: string): AnalystConsensus | null {
  const entry = cache.get(stockCode);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(stockCode);
    return null;
  }
  return entry.data;
}

function setCache(stockCode: string, data: AnalystConsensus): void {
  // 캐시 크기 제한 — 만료 엔트리 먼저 정리, 그래도 초과하면 전체 리셋
  if (cache.size >= CACHE_MAX_SIZE) {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now - entry.fetchedAt > CACHE_TTL_MS) cache.delete(key);
    }
    if (cache.size >= CACHE_MAX_SIZE) cache.clear();
  }
  cache.set(stockCode, { data, fetchedAt: Date.now() });
}

// ── Helpers ──

function deriveConsensusRating(
  buyCount: number,
  holdCount: number,
  sellCount: number,
): AnalystConsensus['consensusRating'] {
  const total = buyCount + holdCount + sellCount;
  if (total === 0) return 'HOLD';

  const buyRatio = buyCount / total;
  if (buyRatio >= 0.8) return 'STRONG_BUY';
  if (buyRatio >= 0.5) return 'BUY';
  if (sellCount > buyCount) return 'SELL';
  return 'HOLD';
}

function deriveRecentChange(targetPrice: number, prevTargetPrice: number | null): AnalystConsensus['recentChange'] {
  if (prevTargetPrice == null || prevTargetPrice === 0) return 'FLAT';
  const diff = (targetPrice - prevTargetPrice) / prevTargetPrice;
  if (diff > 0.01) return 'UP';
  if (diff < -0.01) return 'DOWN';
  return 'FLAT';
}

// ── Fetch from Naver Mobile API ──

/**
 * 네이버 모바일 주식 API에서 애널리스트 컨센서스 데이터 수집
 */
export async function fetchAnalystConsensus(stockCode: string): Promise<AnalystConsensus | null> {
  // 캐시 확인
  const cached = getCached(stockCode);
  if (cached) return cached;

  try {
    // 1차: integration API
    const data = await tryIntegrationApi(stockCode);
    if (data) {
      setCache(stockCode, data);
      return data;
    }

    // 2차: analyst API
    const data2 = await tryAnalystApi(stockCode);
    if (data2) {
      setCache(stockCode, data2);
      return data2;
    }

    logger.warn(`컨센서스 데이터 없음: ${stockCode}`, { component: 'CONSENSUS' });
    return null;
  } catch (error) {
    logger.warn(`컨센서스 수집 실패 (${stockCode}): ${error}`, { component: 'CONSENSUS' });
    return null;
  }
}

async function tryIntegrationApi(stockCode: string): Promise<AnalystConsensus | null> {
  try {
    const url = `https://m.stock.naver.com/api/stock/${stockCode}/integration`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'AIBot/0.2.0',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as Record<string, unknown>;

    // integration API 응답에서 컨센서스 관련 필드 추출
    const dealTrendInfo = json.dealTrendInfo as Record<string, unknown> | undefined;
    const consensusInfo = json.consensusInfo as Record<string, unknown> | undefined;
    const stockEndPrice = json.stockEndPrice as Record<string, unknown> | undefined;

    // 현재가 추출
    const currentPrice = Number(
      (stockEndPrice as Record<string, unknown>)?.closePrice ?? (json as Record<string, unknown>).closePrice ?? 0,
    );

    if (!consensusInfo && !dealTrendInfo) return null;

    const source = consensusInfo ?? dealTrendInfo ?? {};
    const targetPrice = Number((source as Record<string, unknown>).targetPrice ?? 0);
    const analystCount = Number((source as Record<string, unknown>).analystCount ?? 0);

    if (targetPrice === 0 || currentPrice === 0) return null;

    const buyCount = Number((source as Record<string, unknown>).buyCount ?? 0);
    const holdCount = Number((source as Record<string, unknown>).holdCount ?? 0);
    const sellCount = Number((source as Record<string, unknown>).sellCount ?? 0);
    const prevTargetPrice = Number((source as Record<string, unknown>).prevTargetPrice ?? 0) || null;

    const upsidePct = ((targetPrice - currentPrice) / currentPrice) * 100;

    const consensus: AnalystConsensus = {
      stockCode,
      targetPrice,
      currentPrice,
      upsidePct: Math.round(upsidePct * 100) / 100,
      analystCount,
      buyCount,
      holdCount,
      sellCount,
      recentChange: deriveRecentChange(targetPrice, prevTargetPrice),
      consensusRating: deriveConsensusRating(buyCount, holdCount, sellCount),
    };

    return consensus;
  } catch (err) {
    logger.debug(`컨센서스 integration API 실패 (${stockCode}): ${err}`, { component: 'CONSENSUS' });
    return null;
  }
}

async function tryAnalystApi(stockCode: string): Promise<AnalystConsensus | null> {
  try {
    const url = `https://m.stock.naver.com/api/stock/${stockCode}/analyst`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'AIBot/0.2.0',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as Record<string, unknown>;

    // analyst API에서 리포트 목록 기반 집계
    const reports =
      ((json as Record<string, unknown>).reports as Array<Record<string, unknown>> | undefined) ??
      ((json as Record<string, unknown>).items as Array<Record<string, unknown>> | undefined) ??
      [];

    if (reports.length === 0) return null;

    // 리포트에서 목표가, 투자의견 집계
    let totalTarget = 0;
    let targetCount = 0;
    let buyCount = 0;
    let holdCount = 0;
    let sellCount = 0;
    let latestTarget = 0;
    let prevTarget = 0;

    for (const report of reports) {
      const tp = Number(report.targetPrice ?? report.target_price ?? 0);
      if (tp > 0) {
        totalTarget += tp;
        targetCount++;

        if (targetCount === 1) latestTarget = tp;
        if (targetCount === 2) prevTarget = tp;
      }

      const opinion = String(report.investmentOpinion ?? report.opinion ?? '').toUpperCase();
      if (opinion.includes('매수') || opinion.includes('BUY') || opinion.includes('OUTPERFORM')) {
        buyCount++;
      } else if (opinion.includes('매도') || opinion.includes('SELL') || opinion.includes('UNDERPERFORM')) {
        sellCount++;
      } else {
        holdCount++;
      }
    }

    if (targetCount === 0) return null;

    const targetPrice = Math.round(totalTarget / targetCount);

    // 현재가는 별도 요청
    const currentPrice = await fetchCurrentPrice(stockCode);
    if (currentPrice === 0) return null;

    const upsidePct = ((targetPrice - currentPrice) / currentPrice) * 100;

    const consensus: AnalystConsensus = {
      stockCode,
      targetPrice,
      currentPrice,
      upsidePct: Math.round(upsidePct * 100) / 100,
      analystCount: targetCount,
      buyCount,
      holdCount,
      sellCount,
      recentChange: deriveRecentChange(latestTarget, prevTarget || null),
      consensusRating: deriveConsensusRating(buyCount, holdCount, sellCount),
    };

    return consensus;
  } catch (err) {
    logger.debug(`컨센서스 analyst API 실패 (${stockCode}): ${err}`, { component: 'CONSENSUS' });
    return null;
  }
}

async function fetchCurrentPrice(stockCode: string): Promise<number> {
  try {
    const url = `https://m.stock.naver.com/api/stock/${stockCode}/basic`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'AIBot/0.2.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 0;

    const json = (await res.json()) as Record<string, unknown>;
    return Number((json as Record<string, unknown>).closePrice ?? (json as Record<string, unknown>).nowVal ?? 0);
  } catch (err) {
    logger.debug(`현재가 조회 실패 (${stockCode}): ${err}`, { component: 'CONSENSUS' });
    return 0;
  }
}

// ── Score Adjustment ──

/**
 * 컨센서스 기반 점수 보정값 반환
 *
 * - Upside > 30% + BUY 다수: +15
 * - Upside > 15% + BUY 과반: +10
 * - Upside > 0%: +5
 * - Upside < -10%: -10 (고평가)
 * - Upside < -20%: -15
 * - 데이터 없음: 0
 */
export async function getConsensusScoreAdjustment(stockCode: string): Promise<number> {
  const consensus = await fetchAnalystConsensus(stockCode);
  if (!consensus) return 0;

  const { upsidePct, consensusRating } = consensus;
  const isBuyMajority = consensusRating === 'STRONG_BUY' || consensusRating === 'BUY';

  if (upsidePct < -20) return -15;
  if (upsidePct < -10) return -10;
  if (upsidePct > 30 && isBuyMajority) return 15;
  if (upsidePct > 15 && isBuyMajority) return 10;
  if (upsidePct > 0) return 5;

  return 0;
}

// ── Batch: Watchlist Consensus ──

/**
 * 감시 종목 전체 컨센서스 일괄 수집
 *
 * 3개씩 배치, 500ms 딜레이 (rate limit 대응)
 */
export async function analyzeWatchlistConsensus(): Promise<Map<string, AnalystConsensus>> {
  const watchlist = await getActiveWatchlist();
  if (watchlist.length === 0) {
    logger.info('감시 종목 없음 — 컨센서스 수집 스킵', { component: 'CONSENSUS' });
    return new Map();
  }

  const results = new Map<string, AnalystConsensus>();
  const batchSize = 3;

  for (let i = 0; i < watchlist.length; i += batchSize) {
    const batch = watchlist.slice(i, i + batchSize);

    const settled = await Promise.allSettled(batch.map((stock) => fetchAnalystConsensus(stock.stock_code)));

    settled.forEach((result, idx) => {
      const stockCode = batch[idx].stock_code;
      if (result.status === 'fulfilled' && result.value) {
        results.set(stockCode, result.value);
      }
    });

    // rate limit 딜레이
    if (i + batchSize < watchlist.length) {
      await sleep(500);
    }
  }

  // 요약 로그
  const withData = results.size;
  const strongBuy = [...results.values()].filter((c) => c.consensusRating === 'STRONG_BUY').length;
  const avgUpside =
    results.size > 0
      ? Math.round(([...results.values()].reduce((sum, c) => sum + c.upsidePct, 0) / results.size) * 100) / 100
      : 0;

  logger.info(
    `📊 컨센서스 수집 완료: ${withData}/${watchlist.length}종목 | ` +
      `평균 상승여력 ${avgUpside}% | STRONG_BUY ${strongBuy}종목`,
    { component: 'CONSENSUS' },
  );

  return results;
}
