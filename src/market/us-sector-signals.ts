/**
 * US 섹터 ETF 시그널 수집
 *
 * Yahoo Finance API로 S&P 섹터 ETF 11종 + 주요 지수 ETF 일간 등락률 수집.
 * 해외 세션 전략(session-strategy)에 주입하여 AI가 실제 섹터 데이터 기반으로
 * focusSectors/avoidSectors 결정.
 *
 * 30분 캐시 (macro-data.ts 패턴 재사용).
 */

import { logger } from '../utils/logger.js';

// ── Types ──

export interface SectorSignal {
  symbol: string;
  name: string;
  changePct: number; // 일간 등락률 (%)
  sector: string;    // 분류 라벨
}

export interface USSectorSnapshot {
  sectors: SectorSignal[];
  indices: SectorSignal[];      // SPY, QQQ, IWM
  breadth: number;              // 상승 섹터 수 / 전체 (0~1)
  bullishCount: number;         // 상승 섹터 수
  totalCount: number;           // 전체 섹터 수
  marketTrend: 'STRONG_BULL' | 'BULL' | 'MIXED' | 'BEAR' | 'STRONG_BEAR';
  timestamp: string;
}

// ── Constants ──

const SECTOR_ETFS: { symbol: string; name: string; sector: string }[] = [
  { symbol: 'XLK', name: 'Technology', sector: 'TECH' },
  { symbol: 'XLF', name: 'Financials', sector: 'FINANCE' },
  { symbol: 'XLE', name: 'Energy', sector: 'ENERGY' },
  { symbol: 'XLV', name: 'Healthcare', sector: 'HEALTHCARE' },
  { symbol: 'XLY', name: 'Consumer Discretionary', sector: 'CONSUMER' },
  { symbol: 'XLI', name: 'Industrials', sector: 'INDUSTRIAL' },
  { symbol: 'XLC', name: 'Communication', sector: 'COMMUNICATION' },
  { symbol: 'XLU', name: 'Utilities', sector: 'UTILITIES' },
  { symbol: 'XLP', name: 'Consumer Staples', sector: 'STAPLES' },
  { symbol: 'XLRE', name: 'Real Estate', sector: 'REAL_ESTATE' },
  { symbol: 'XLB', name: 'Materials', sector: 'MATERIALS' },
];

const INDEX_ETFS: { symbol: string; name: string; sector: string }[] = [
  { symbol: 'SPY', name: 'S&P 500', sector: 'INDEX' },
  { symbol: 'QQQ', name: 'Nasdaq 100', sector: 'INDEX' },
  { symbol: 'IWM', name: 'Russell 2000', sector: 'INDEX' },
];

const CACHE_TTL_MS = 30 * 60 * 1000; // 30분
const FETCH_TIMEOUT_MS = 10_000;

// ── Cache ──

let _cachedSnapshot: USSectorSnapshot | null = null;
let _cacheTimestamp = 0;

// ── Yahoo Finance fetch ──

async function fetchQuoteChangePct(symbol: string): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=2d&interval=1d`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      chart?: {
        result?: Array<{
          indicators?: {
            quote?: Array<{ close?: (number | null)[] }>;
          };
          meta?: { regularMarketPrice?: number; previousClose?: number; chartPreviousClose?: number };
        }>;
      };
    };

    const result = data?.chart?.result?.[0];
    if (!result) return null;

    // 방법 1: meta에서 직접 가져오기
    const meta = result.meta;
    if (meta?.regularMarketPrice && meta?.chartPreviousClose && meta.chartPreviousClose > 0) {
      return ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100;
    }
    if (meta?.regularMarketPrice && meta?.previousClose && meta.previousClose > 0) {
      return ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100;
    }

    // 방법 2: OHLCV 데이터에서 계산
    const closes = result.indicators?.quote?.[0]?.close?.filter((c): c is number => c != null);
    if (closes && closes.length >= 2) {
      const prevClose = closes[closes.length - 2];
      const lastClose = closes[closes.length - 1];
      if (prevClose > 0) return ((lastClose - prevClose) / prevClose) * 100;
    }

    return null;
  } catch {
    return null;
  }
}

// ── Main API ──

export async function getUSSectorSignals(): Promise<USSectorSnapshot> {
  // 캐시 히트
  if (_cachedSnapshot && Date.now() - _cacheTimestamp < CACHE_TTL_MS) {
    return _cachedSnapshot;
  }

  const allEtfs = [...SECTOR_ETFS, ...INDEX_ETFS];

  // 병렬 수집 (Yahoo Finance 부하 분산: 5개씩 배치)
  const results: (number | null)[] = [];
  const BATCH_SIZE = 5;
  for (let i = 0; i < allEtfs.length; i += BATCH_SIZE) {
    const batch = allEtfs.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map((etf) => fetchQuoteChangePct(etf.symbol)));
    results.push(...batchResults);

    // 배치 간 짧은 딜레이 (rate limit 방지)
    if (i + BATCH_SIZE < allEtfs.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const sectors: SectorSignal[] = [];
  const indices: SectorSignal[] = [];

  for (let i = 0; i < allEtfs.length; i++) {
    const etf = allEtfs[i];
    const changePct = results[i] ?? 0;
    const signal: SectorSignal = {
      symbol: etf.symbol,
      name: etf.name,
      changePct: Math.round(changePct * 100) / 100,
      sector: etf.sector,
    };

    if (i < SECTOR_ETFS.length) {
      sectors.push(signal);
    } else {
      indices.push(signal);
    }
  }

  // Market breadth 계산
  const bullishCount = sectors.filter((s) => s.changePct > 0).length;
  const totalCount = sectors.length;
  const breadth = totalCount > 0 ? bullishCount / totalCount : 0.5;

  // 전반적 시장 트렌드 판단
  let marketTrend: USSectorSnapshot['marketTrend'];
  const spyChange = indices.find((i) => i.symbol === 'SPY')?.changePct ?? 0;
  if (breadth >= 0.8 && spyChange > 0.5) {
    marketTrend = 'STRONG_BULL';
  } else if (breadth >= 0.6) {
    marketTrend = 'BULL';
  } else if (breadth >= 0.4) {
    marketTrend = 'MIXED';
  } else if (breadth >= 0.2) {
    marketTrend = 'BEAR';
  } else {
    marketTrend = 'STRONG_BEAR';
  }

  const snapshot: USSectorSnapshot = {
    sectors,
    indices,
    breadth,
    bullishCount,
    totalCount,
    marketTrend,
    timestamp: new Date().toISOString(),
  };

  // 캐시 저장
  _cachedSnapshot = snapshot;
  _cacheTimestamp = Date.now();

  const sectorSummary = sectors.map((s) => `${s.symbol}:${s.changePct > 0 ? '+' : ''}${s.changePct}%`).join(', ');
  logger.info(
    `📊 US 섹터: ${sectorSummary} | breadth=${bullishCount}/${totalCount} → ${marketTrend}`,
    { component: 'US_SECTOR' },
  );

  return snapshot;
}

/** 섹터 스냅샷을 AI 프롬프트에 삽입할 텍스트로 변환 */
export function formatSectorSignalsForPrompt(snapshot: USSectorSnapshot): string {
  const indexLines = snapshot.indices
    .map((i) => `${i.name}(${i.symbol}): ${i.changePct > 0 ? '+' : ''}${i.changePct}%`)
    .join(' | ');

  const sectorLines = snapshot.sectors
    .sort((a, b) => b.changePct - a.changePct) // 상승률 높은 순
    .map((s) => `${s.name}(${s.symbol}): ${s.changePct > 0 ? '+' : ''}${s.changePct}%`)
    .join('\n');

  return [
    `【US 시장 섹터 분석】`,
    `지수: ${indexLines}`,
    `Market Breadth: ${snapshot.bullishCount}/${snapshot.totalCount} 섹터 상승 → ${snapshot.marketTrend}`,
    ``,
    `섹터별 등락률 (상승순):`,
    sectorLines,
  ].join('\n');
}

/** 약세 섹터 코드 리스트 반환 (changePct < -1%) */
export function getWeakSectors(snapshot: USSectorSnapshot): string[] {
  return snapshot.sectors.filter((s) => s.changePct < -1.0).map((s) => s.sector);
}

/** 강세 섹터 코드 리스트 반환 (changePct > 1%) */
export function getStrongSectors(snapshot: USSectorSnapshot): string[] {
  return snapshot.sectors.filter((s) => s.changePct > 1.0).map((s) => s.sector);
}

/** 캐시 초기화 (테스트용) */
export function clearUSSectorCache(): void {
  _cachedSnapshot = null;
  _cacheTimestamp = 0;
}
