/**
 * 외부 무료 API 신호 집계
 * - CNN Fear & Greed Index (키 불필요)
 * - VIX (Yahoo Finance, 키 불필요)
 * - Finnhub 어닝 캘린더 + 뉴스 감성 (FINNHUB_API_KEY 환경변수)
 */

import { logger } from '../utils/logger.js';

export interface MarketSentiment {
  fearGreedScore: number;   // 0(극공포)~100(극탐욕)
  fearGreedLabel: string;   // 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed'
  vix: number;              // VIX 수치 (18 미만=안정, 25+ 위험, 35+ 공황)
  updatedAt: Date;
}

export interface EarningsEvent {
  code: string;
  date: string;       // YYYY-MM-DD
  epsEstimate: number | null;
  revenueEstimate: number | null;
  daysUntil: number;  // 음수=지남
}

export interface NewsSentiment {
  code: string;
  sentimentScore: number;   // -1(매우부정)~1(매우긍정)
  bullishPct: number;       // 0~100
  bearishPct: number;
  articleCount: number;
  updatedAt: Date;
}

// ── 캐시 (60분 유효) ──────────────────────────────────────────
let _fgCache: { data: MarketSentiment; fetchedAt: number } | null = null;
let _earningsCache: { data: EarningsEvent[]; fetchedAt: number } | null = null;
const _newsCache = new Map<string, { data: NewsSentiment; fetchedAt: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1시간

// ──────────────────────────────────────────────────────────────
// 1. CNN Fear & Greed Index
// ──────────────────────────────────────────────────────────────
export async function getFearGreedIndex(): Promise<MarketSentiment | null> {
  if (_fgCache && Date.now() - _fgCache.fetchedAt < CACHE_TTL) return _fgCache.data;

  try {
    const res = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as any;
    const score = Math.round(json?.fear_and_greed?.score ?? -1);
    const rating = (json?.fear_and_greed?.rating ?? '') as string;
    if (score < 0) throw new Error('score 파싱 실패');

    // VIX — Yahoo Finance
    let vix = 0;
    try {
      const vixRes = await fetch(
        'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d',
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) },
      );
      const vixJson = await vixRes.json() as any;
      vix = vixJson?.chart?.result?.[0]?.meta?.regularMarketPrice ?? 0;
    } catch { /* VIX 실패해도 F&G만 반환 */ }

    const label = rating.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || scorToLabel(score);
    const data: MarketSentiment = { fearGreedScore: score, fearGreedLabel: label, vix, updatedAt: new Date() };
    _fgCache = { data, fetchedAt: Date.now() };
    logger.info(`📊 Fear&Greed: ${score}(${label}) VIX: ${vix.toFixed(1)}`, { component: 'EXT_SIGNAL' });
    return data;
  } catch (err: any) {
    logger.warn(`Fear&Greed 조회 실패: ${err.message}`, { component: 'EXT_SIGNAL' });
    return _fgCache?.data ?? null;
  }
}

function scorToLabel(score: number): string {
  if (score <= 25) return 'Extreme Fear';
  if (score <= 44) return 'Fear';
  if (score <= 55) return 'Neutral';
  if (score <= 75) return 'Greed';
  return 'Extreme Greed';
}

// ──────────────────────────────────────────────────────────────
// 2. Finnhub — 어닝 캘린더 (미국 종목)
// ──────────────────────────────────────────────────────────────
export async function getUpcomingEarnings(codes: string[]): Promise<EarningsEvent[]> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return [];

  if (_earningsCache && Date.now() - _earningsCache.fetchedAt < CACHE_TTL) {
    return _earningsCache.data.filter(e => codes.includes(e.code));
  }

  try {
    const today = new Date();
    const from = today.toISOString().slice(0, 10);
    const to = new Date(today.getTime() + 30 * 86400000).toISOString().slice(0, 10);
    const res = await fetch(
      `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${key}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as any;
    const events: EarningsEvent[] = (json?.earningsCalendar ?? [])
      .filter((e: any) => codes.includes(e.symbol))
      .map((e: any) => {
        const daysUntil = Math.round((new Date(e.date).getTime() - Date.now()) / 86400000);
        return {
          code: e.symbol,
          date: e.date,
          epsEstimate: e.epsEstimate ?? null,
          revenueEstimate: e.revenueEstimate ?? null,
          daysUntil,
        };
      });
    _earningsCache = { data: events, fetchedAt: Date.now() };
    if (events.length > 0) {
      logger.info(`📅 어닝 캘린더: ${events.map(e => `${e.code}(D+${e.daysUntil})`).join(', ')}`, { component: 'EXT_SIGNAL' });
    }
    return events.filter(e => codes.includes(e.code));
  } catch (err: any) {
    logger.warn(`Finnhub 어닝 조회 실패: ${err.message}`, { component: 'EXT_SIGNAL' });
    return [];
  }
}

// ──────────────────────────────────────────────────────────────
// 3. Finnhub — 뉴스 감성분석 (미국 종목)
// ──────────────────────────────────────────────────────────────
export async function getNewsSentiment(code: string): Promise<NewsSentiment | null> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;

  const cached = _newsCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.data;

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/news-sentiment?symbol=${code}&token=${key}`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as any;
    const sent = json?.sentiment;
    if (!sent) return null;

    const data: NewsSentiment = {
      code,
      sentimentScore: sent.companyNewsScore ?? 0,
      bullishPct: Math.round((sent.bullishPercent ?? 0) * 100),
      bearishPct: Math.round((sent.bearishPercent ?? 0) * 100),
      articleCount: json?.buzz?.articlesInLastWeek ?? 0,
      updatedAt: new Date(),
    };
    _newsCache.set(code, { data, fetchedAt: Date.now() });
    return data;
  } catch (err: any) {
    logger.warn(`Finnhub 감성 조회 실패(${code}): ${err.message}`, { component: 'EXT_SIGNAL' });
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// 4. 종합 시장 신호 — 매매 판단 보조
// ──────────────────────────────────────────────────────────────
export function interpretMarketSentiment(s: MarketSentiment): {
  allowBuy: boolean;
  aggressive: boolean;  // 극공포 → 역매수 기회
  reason: string;
} {
  const { fearGreedScore: fg, vix } = s;
  // VIX 35+ = 공황 수준 → 매수 금지 (단, 극공포 역매수 제외)
  if (vix > 35 && fg > 25) {
    return { allowBuy: false, aggressive: false, reason: `VIX 공황(${vix.toFixed(0)}) + 탐욕(${fg}) → 매수 금지` };
  }
  // 극공포(≤20) = 역매수 최적 구간
  if (fg <= 20) {
    return { allowBuy: true, aggressive: true, reason: `극공포(${fg}) 역매수 구간 — 저점 가능성` };
  }
  // 극탐욕(≥80) = 과열, 신규 매수 자제
  if (fg >= 80) {
    return { allowBuy: false, aggressive: false, reason: `극탐욕(${fg}) 과열 — 신규 매수 자제` };
  }
  return { allowBuy: true, aggressive: false, reason: `F&G ${fg}(${s.fearGreedLabel}) VIX ${vix.toFixed(0)}` };
}

export function hasEarningsRisk(code: string, earnings: EarningsEvent[], daysWindow = 3): boolean {
  return earnings.some(e => e.code === code && e.daysUntil >= 0 && e.daysUntil <= daysWindow);
}
