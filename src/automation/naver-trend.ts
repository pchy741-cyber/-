/**
 * Naver DataLab 검색 트렌드 — 종목 검색량 급등/급감 감지
 *
 * 한국 검색 60% 점유. 종목 검색량 급등 = 리테일 관심 선행 지표
 * community-sentinel.ts(토론방 감성)와 별개 — 이것은 순수 검색량 지표
 *
 * Score Adjustment:
 *   - 검색량 급등 (Z > 2.0): +5
 *   - 검색량 소폭 증가 (Z 1.0~2.0): +3
 *   - 검색량 급감 (Z < -1.5): -3
 *   - 보통: 0
 */

import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

const COMPONENT = 'NAVER_TREND';

// ── 캐시 (6시간 TTL — 검색 트렌드는 느리게 변동) ──

interface TrendCacheEntry {
  zScore: number;
  fetchedAt: number;
}

const _trendCache = new Map<string, TrendCacheEntry>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6시간
const CACHE_MAX_ENTRIES = 200;

// 만료 엔트리 자동 정리 (6시간 주기)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _trendCache) {
    if (now - entry.fetchedAt >= CACHE_TTL_MS) _trendCache.delete(key);
  }
  if (_trendCache.size > CACHE_MAX_ENTRIES) _trendCache.clear();
}, CACHE_TTL_MS).unref();

// ── Naver DataLab API 응답 타입 ──

interface DataLabResponse {
  startDate: string;
  endDate: string;
  timeUnit: string;
  results?: Array<{
    title: string;
    keywords: string[];
    data: Array<{
      period: string;
      ratio: number;
    }>;
  }>;
}

// ── 종목코드 → 종목명 매핑 (pipeline에서 전달) ──

const _stockNameMap = new Map<string, string>();

/**
 * 종목코드-종목명 매핑 등록 (pipeline에서 호출)
 */
export function registerStockNames(mapping: Array<{ code: string; name: string }>): void {
  for (const { code, name } of mapping) {
    _stockNameMap.set(code, name);
  }
}

// ── 핵심 로직 ──

/**
 * Naver DataLab API를 통해 검색 트렌드 Z-score 계산
 * 최근 3일 평균 ratio vs 이전 25일 평균 ratio 비교
 */
async function fetchTrendZScore(keywords: string[]): Promise<Map<string, number>> {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return new Map();

  // 날짜 범위: 최근 28일
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 28 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const keywordGroups = keywords.map((kw) => ({
    groupName: kw,
    keywords: [kw],
  }));

  const body = {
    startDate: fmt(startDate),
    endDate: fmt(endDate),
    timeUnit: 'date',
    keywordGroups,
  };

  const res = await fetch('https://openapi.naver.com/v1/datalab/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) return new Map();

  const data = (await res.json()) as DataLabResponse;
  if (!data.results) return new Map();

  const result = new Map<string, number>();

  for (const group of data.results) {
    const ratios = group.data.map((d) => d.ratio).filter((r) => r > 0);
    if (ratios.length < 7) {
      result.set(group.title, 0);
      continue;
    }

    // 최근 3일 vs 이전 기간
    const recentDays = ratios.slice(-3);
    const previousDays = ratios.slice(0, -3);

    const recentAvg = recentDays.reduce((a, b) => a + b, 0) / recentDays.length;
    const prevAvg = previousDays.reduce((a, b) => a + b, 0) / previousDays.length;

    // 표준편차 계산
    const variance = previousDays.reduce((sum, v) => sum + (v - prevAvg) ** 2, 0) / previousDays.length;
    const stddev = Math.sqrt(variance);

    // Z-score (stddev가 0이면 변동 없음 → 0)
    const zScore = stddev > 0.01 ? (recentAvg - prevAvg) / stddev : 0;
    result.set(group.title, zScore);
  }

  return result;
}

/**
 * 감시 종목 일괄 트렌드 갱신 (5개씩 배치 — API 제한 + 300ms 딜레이)
 */
export async function refreshNaverTrends(stockCodes: string[]): Promise<void> {
  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) return;

  const codesToFetch = stockCodes.filter((code) => {
    const cached = _trendCache.get(code);
    return !cached || Date.now() - cached.fetchedAt >= CACHE_TTL_MS;
  });

  if (codesToFetch.length === 0) return;

  // 종목명으로 변환 (매핑 없으면 skip)
  const codeNamePairs = codesToFetch
    .map((code) => ({ code, name: _stockNameMap.get(code) }))
    .filter((p): p is { code: string; name: string } => !!p.name);

  if (codeNamePairs.length === 0) return;

  const BATCH_SIZE = 5; // Naver DataLab API 제한: 한 번에 5개 키워드 그룹
  for (let i = 0; i < codeNamePairs.length; i += BATCH_SIZE) {
    const batch = codeNamePairs.slice(i, i + BATCH_SIZE);
    const keywords = batch.map((p) => p.name);

    try {
      const zScores = await fetchTrendZScore(keywords);

      for (const pair of batch) {
        const z = zScores.get(pair.name) ?? 0;
        _trendCache.set(pair.code, { zScore: z, fetchedAt: Date.now() });

        if (z > 2.0) {
          logger.info(`🔍 검색 트렌드 급등: ${pair.name}(${pair.code}) Z=${z.toFixed(2)}`, { component: COMPONENT });
        } else if (z < -1.5) {
          logger.info(`🔍 검색 트렌드 급감: ${pair.name}(${pair.code}) Z=${z.toFixed(2)}`, { component: COMPONENT });
        }
      }
    } catch (err) {
      logger.debug(`Naver 트렌드 조회 실패: ${err}`, { component: COMPONENT });
      // fail-open: 에러 시 해당 배치 skip
    }

    // 마지막 배치가 아니면 딜레이
    if (i + BATCH_SIZE < codeNamePairs.length) {
      await sleep(300);
    }
  }
}

/**
 * Pipeline Score Adjustment 반환
 * Range: -3 ~ +5
 */
export function getNaverTrendScoreAdjustment(stockCode: string): number {
  try {
    const cached = _trendCache.get(stockCode);
    if (!cached || Date.now() - cached.fetchedAt > CACHE_TTL_MS) return 0;

    const z = cached.zScore;
    if (!Number.isFinite(z)) return 0;

    if (z > 2.0) return 5;      // 검색량 급등 → 리테일 관심 급증
    if (z > 1.0) return 3;      // 소폭 증가
    if (z < -1.5) return -3;    // 검색량 급감 → 관심 이탈

    return 0;
  } catch (err) {
    logger.debug(`Naver 트렌드 스코어 조회 실패 (${stockCode}): ${err}`, { component: COMPONENT });
    return 0;
  }
}
