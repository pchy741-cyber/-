/**
 * 외부 무료 API 신호 집계
 * - CNN Fear & Greed Index (키 불필요)
 * - VIX (Yahoo Finance, 키 불필요)
 * - Finnhub 어닝 캘린더 + 뉴스 감성 (FINNHUB_API_KEY 환경변수)
 */

import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';

export interface MarketSentiment {
  fearGreedScore: number; // 0(극공포)~100(극탐욕)
  fearGreedLabel: string; // 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed'
  vix: number; // VIX 수치 (18 미만=안정, 25+ 위험, 35+ 공황)
  greedyStreak: number; // FGI≥80 연속 거래일 수 (5일+ → 익절 고려 신호)
  updatedAt: Date;
}

export interface EarningsEvent {
  code: string;
  date: string; // YYYY-MM-DD
  epsEstimate: number | null;
  revenueEstimate: number | null;
  daysUntil: number; // 음수=지남
}

export interface NewsSentiment {
  code: string;
  sentimentScore: number; // -1(매우부정)~1(매우긍정)
  bullishPct: number; // 0~100
  bearishPct: number;
  articleCount: number;
  updatedAt: Date;
}

// ── 캐시 (60분 유효) ──────────────────────────────────────────
let _fgCache: { data: MarketSentiment; fetchedAt: number } | null = null;
// v11.0: FGI≥80 연속 거래일 추적 (날짜별 1회만 증가, 1일 하락 허용)
let _greedyStreak = 0;
let _greedyStreakLastDate = '';
let _greedyMissedDays = 0; // 80 미만 연속일 (1일까지 유예)
let _earningsCache: { data: EarningsEvent[]; fetchedAt: number } | null = null;
const _newsCache = new Map<string, { data: NewsSentiment; fetchedAt: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1시간

// 만료 엔트리 자동 정리 (30분 주기)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _newsCache) {
    if (now - entry.fetchedAt >= CACHE_TTL) _newsCache.delete(key);
  }
}, 30 * 60 * 1000).unref();

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
    const json = (await res.json()) as any;
    const score = Math.round(json?.fear_and_greed?.score ?? -1);
    const rating = (json?.fear_and_greed?.rating ?? '') as string;
    if (score < 0) throw new Error('score 파싱 실패');

    // VIX — Yahoo Finance
    let vix = 0;
    try {
      const vixRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(6000),
      });
      const vixJson = (await vixRes.json()) as any;
      vix = vixJson?.chart?.result?.[0]?.meta?.regularMarketPrice ?? 0;
    } catch {
      /* VIX 실패해도 F&G만 반환 */
    }

    const label = rating.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || scorToLabel(score);

    // FGI≥80 연속일 카운터 (날짜 바뀔 때마다 1회 증가, 1일 하락 허용)
    const todayStr = getKSTNow().toISOString().slice(0, 10);
    if (score >= 80) {
      if (_greedyStreakLastDate !== todayStr) {
        _greedyStreak++;
        _greedyStreakLastDate = todayStr;
        _greedyMissedDays = 0; // 탐욕 복귀 → 유예 리셋
      }
    } else if (_greedyStreakLastDate !== todayStr && _greedyStreak > 0) {
      _greedyMissedDays++;
      _greedyStreakLastDate = todayStr;
      if (_greedyMissedDays > 1) {
        // 2일 연속 80 미만 → 스트릭 리셋
        _greedyStreak = 0;
        _greedyMissedDays = 0;
        _greedyStreakLastDate = '';
      }
    }

    const data: MarketSentiment = { fearGreedScore: score, fearGreedLabel: label, vix, greedyStreak: _greedyStreak, updatedAt: new Date() };
    _fgCache = { data, fetchedAt: Date.now() };
    logger.info(`📊 Fear&Greed: ${score}(${label}) VIX: ${vix.toFixed(1)}`, { component: 'EXT_SIGNAL' });
    return data;
  } catch (err: any) {
    logger.warn(`Fear&Greed 조회 실패: ${err.message}`, { component: 'EXT_SIGNAL' });
    const cached = _fgCache?.data;
    if (cached && !('greedyStreak' in cached)) (cached as any).greedyStreak = _greedyStreak;
    return cached ?? null;
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
    return _earningsCache.data.filter((e) => codes.includes(e.code));
  }

  try {
    const today = getKSTNow();
    const from = today.toISOString().slice(0, 10);
    const to = new Date(today.getTime() + 30 * 86400000).toISOString().slice(0, 10);
    const res = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${key}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as any;
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
      logger.info(`📅 어닝 캘린더: ${events.map((e) => `${e.code}(D+${e.daysUntil})`).join(', ')}`, {
        component: 'EXT_SIGNAL',
      });
    }
    return events.filter((e) => codes.includes(e.code));
  } catch (err: any) {
    logger.warn(`Finnhub 어닝 조회 실패: ${err.message}`, { component: 'EXT_SIGNAL' });
    return [];
  }
}

// ──────────────────────────────────────────────────────────────
// 3. Finnhub — 뉴스 감성분석 (미국 종목)
// ──────────────────────────────────────────────────────────────
async function getNewsSentiment(code: string): Promise<NewsSentiment | null> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;

  const cached = _newsCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.data;

  try {
    const res = await fetch(`https://finnhub.io/api/v1/news-sentiment?symbol=${code}&token=${key}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as any;
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

// marketQuality 4단계:
//   GREAT    VIX<18 + F&G 40~65 → 최고 진입 환경, 모멘텀 허용
//   OK       VIX<22 + F&G 25~75 → 일반 진입, 기준 그대로
//   CAUTIOUS VIX 22~30 OR F&G<30/70~79 → 선택적 진입, 고확신만
//   DANGER   VIX>30 OR F&G≥80/≤20+VIX>25 → 방어 섹터 or 정지
export type MarketQuality = 'GREAT' | 'OK' | 'CAUTIOUS' | 'DANGER';

export function interpretMarketSentiment(s: MarketSentiment): {
  allowBuy: boolean;
  aggressive: boolean; // 극공포 → 역매수 기회
  marketQuality: MarketQuality;
  reason: string;
} {
  const { fearGreedScore: fg, vix } = s;

  // VIX 30+ = 공황 수준 → 방어 섹터만 허용
  if (vix > 30 && fg > 25) {
    return {
      allowBuy: true,
      aggressive: false,
      marketQuality: 'DANGER',
      reason: `VIX 위험(${vix.toFixed(0)}) → 방어 섹터만`,
    };
  }
  // VIX 35+ + 탐욕 = 완전 정지
  if (vix > 35 && fg > 40) {
    return {
      allowBuy: false,
      aggressive: false,
      marketQuality: 'DANGER',
      reason: `VIX 공황(${vix.toFixed(0)}) + 탐욕(${fg}) → 매수 금지`,
    };
  }
  // 극공포(≤20) = 역매수 최적 구간
  if (fg <= 20) {
    return {
      allowBuy: true,
      aggressive: true,
      marketQuality: 'CAUTIOUS',
      reason: `극공포(${fg}) 역매수 구간 — 방어+저점 종목만`,
    };
  }
  // 극탐욕(≥80) = 과열, 신규 매수 자제
  if (fg >= 80) {
    const streakWarn = s.greedyStreak >= 5 ? ` ⚠️ ${s.greedyStreak}일 연속 — 익절 고려` : '';
    return {
      allowBuy: false,
      aggressive: false,
      marketQuality: 'DANGER',
      reason: `극탐욕(${fg}) 과열 — 신규 매수 자제${streakWarn}`,
    };
  }
  // 최고 진입 환경 (F&G 중립 + VIX 안정)
  if (fg >= 40 && fg <= 65 && vix < 18) {
    return {
      allowBuy: true,
      aggressive: false,
      marketQuality: 'GREAT',
      reason: `최적 진입 환경 F&G ${fg} VIX ${vix.toFixed(0)}`,
    };
  }
  // 주의 구간 (F&G 쏠림 or VIX 상승)
  if (fg < 30 || fg >= 70 || vix >= 22) {
    return {
      allowBuy: true,
      aggressive: false,
      marketQuality: 'CAUTIOUS',
      reason: `주의 구간 F&G ${fg} VIX ${vix.toFixed(0)} — 고확신만`,
    };
  }
  return {
    allowBuy: true,
    aggressive: false,
    marketQuality: 'OK',
    reason: `F&G ${fg}(${s.fearGreedLabel}) VIX ${vix.toFixed(0)}`,
  };
}

export function hasEarningsRisk(code: string, earnings: EarningsEvent[], daysWindow = 3): boolean {
  return earnings.some((e) => e.code === code && e.daysUntil >= 0 && e.daysUntil <= daysWindow);
}
