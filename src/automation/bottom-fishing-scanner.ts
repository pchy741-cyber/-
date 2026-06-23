import { rsi } from '../analysis/indicators.js';
import { getBatchPrices, getChangeRankingStocks, getDailyChart, getVolumeRankingStocks } from '../kis/market.js';
import { logger } from '../utils/logger.js';

export interface BottomFishingCandidate {
  stock_code: string;
  stock_name: string;
  changePct: number;
  rsi14: number;
  marketCapEok: number;
  score: number; // (40 - rsi14) + abs(changePct)
}

/** 하락장 공격성 옵션 — CRASH/PANIC 시 필터 완화 */
export interface CrashAggressiveOptions {
  minMarketCapEok?: number; // 기본 500 → 하락장 300
  minChangePct?: number; // 기본 -1.5 → 하락장 -1.0
  maxRsi?: number; // 기본 45 → 하락장 50
  maxResults?: number; // 기본 4 → 하락장 6
}

/**
 * 시장 전체 바닥낚시 스캐너
 *
 * 1. 거래량 + 등락률 랭킹 → ~100개 후보 수집
 * 2. 시총 필터 + 당일 하락 필터
 * 3. RSI(14) 과매도 필터
 * 4. score 정렬 → 상위 N종목 반환
 *
 * crashOptions: CRASH/PANIC 시 필터 완화 (더 많은 후보, 더 넓은 RSI)
 */
export async function runBottomFishingScanner(
  crashOptions?: CrashAggressiveOptions,
): Promise<BottomFishingCandidate[]> {
  const minCap = crashOptions?.minMarketCapEok ?? 500;
  const minChange = crashOptions?.minChangePct ?? -1.5;
  const maxRsi = crashOptions?.maxRsi ?? 45;
  const maxResults = crashOptions?.maxResults ?? 4;
  // 1. 랭킹 API 4개 병렬 호출
  const [volJ, volQ, chgJ, chgQ] = await Promise.all([
    getVolumeRankingStocks('J', 50).catch(() => []),
    getVolumeRankingStocks('Q', 30).catch(() => []),
    getChangeRankingStocks(30, 'J').catch(() => []),
    getChangeRankingStocks(20, 'Q').catch(() => []),
  ]);

  // 2. 합집합 + 중복 제거
  const codeMap = new Map<string, string>(); // code → name
  for (const s of [...volJ, ...volQ, ...chgJ, ...chgQ]) {
    if (!codeMap.has(s.stock_code)) codeMap.set(s.stock_code, s.stock_name);
  }

  const allCodes = [...codeMap.keys()];
  logger.info(
    `🎣 바닥낚시 스캐너: ${allCodes.length}종목 수집 (KOSPI ${volJ.length}+${chgJ.length}, KOSDAQ ${volQ.length}+${chgQ.length})`,
    { component: 'BOTTOM_FISHING' },
  );

  if (allCodes.length === 0) return [];

  // 3. 시세 일괄 조회 → 시총 + 하락폭 필터
  const prices = await getBatchPrices(allCodes);
  const priceFiltered = allCodes.filter((code) => {
    const p = prices.get(code);
    return p && p.marketCapEok >= minCap && p.changePct <= minChange;
  });

  logger.info(`🎣 바닥낚시 가격 필터: ${priceFiltered.length}종목 (시총 ${minCap}억↑, 당일 ${minChange}%↓)`, {
    component: 'BOTTOM_FISHING',
  });

  if (priceFiltered.length === 0) return [];

  // 4. 일봉 → RSI(14) 과매도 필터 (병렬 — getDailyChart 내부 rate limiter 의존)
  const chartResults = await Promise.allSettled(
    priceFiltered.map(async (code) => ({ code, candles: await getDailyChart(code, 30) })),
  );
  const candidates: BottomFishingCandidate[] = [];
  for (const r of chartResults) {
    if (r.status !== 'fulfilled') continue;
    const { code, candles } = r.value;
    if (candles.length < 15) continue; // RSI 계산에 최소 15일 필요

    // getDailyChart는 최신→과거 순서 → RSI 계산은 과거→최신 필요
    const closes = candles.map((c) => c.close).reverse();
    const rsiValues = rsi(closes, 14);
    const rsi14 = rsiValues[rsiValues.length - 1] ?? 50;

    if (!Number.isFinite(rsi14) || rsi14 >= maxRsi) continue;

    const p = prices.get(code)!;
    candidates.push({
      stock_code: code,
      stock_name: codeMap.get(code) ?? code,
      changePct: p.changePct,
      rsi14,
      marketCapEok: p.marketCapEok,
      score: 40 - rsi14 + Math.abs(p.changePct),
    });
  }

  // 5. 스코어 내림차순 → 상위 N종목
  candidates.sort((a, b) => b.score - a.score);
  const result = candidates.slice(0, maxResults);

  if (result.length > 0) {
    logger.info(
      `🎣 바닥낚시 최종 후보 ${result.length}종목: ${result.map((c) => `${c.stock_name}(${c.stock_code}) RSI=${c.rsi14.toFixed(0)} 당일${c.changePct.toFixed(1)}%`).join(', ')}`,
      { component: 'BOTTOM_FISHING' },
    );
  }

  return result;
}
