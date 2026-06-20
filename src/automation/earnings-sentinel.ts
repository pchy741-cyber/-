/**
 * 실적발표 감시자 — 매수 전 실적발표 일정 사전 차단
 *
 * KR: NAVER Finance 일정 API (키 불필요)
 * US: Yahoo Finance calendarEvents (키 불필요)
 *
 * 7일 이내 실적발표 → 매수 차단 (공시 직후 변동성 회피)
 * 4시간 캐시 / 실패 시 안전 기본값 (통과) 반환
 */

import { REFRESH } from '../config/constants.js';
import { logger } from '../utils/logger.js';

export interface EarningsCheckResult {
  hasUpcomingEarnings: boolean;
  earningsDate: string | null;
  daysUntil: number | null;
}

const SAFE: EarningsCheckResult = { hasUpcomingEarnings: false, earningsDate: null, daysUntil: null };

const _cache = new Map<string, { result: EarningsCheckResult; expires: number }>();
const EARNINGS_CACHE_MAX_SIZE = 300; // 메모리 누수 방지

function evictExpiredCache(): void {
  if (_cache.size < EARNINGS_CACHE_MAX_SIZE) return;
  const now = Date.now();
  for (const [key, entry] of _cache) {
    if (now >= entry.expires) _cache.delete(key);
  }
  if (_cache.size >= EARNINGS_CACHE_MAX_SIZE) _cache.clear();
}

function toYYYYMMDD(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// ── 한국 실적발표 감시 (NAVER Finance 일정 API) ──
export async function checkKrEarnings(code: string): Promise<EarningsCheckResult> {
  const cacheKey = `kr_${code}`;
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() < hit.expires) return hit.result;

  try {
    const today = new Date();
    const future = new Date(today.getTime() + 30 * 86400000);
    const url = `https://m.stock.naver.com/api/stock/${code}/scheduleList?startDate=${toYYYYMMDD(today)}&endDate=${toYYYYMMDD(future)}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://m.stock.naver.com/' },
      signal: AbortSignal.timeout(REFRESH.EARNINGS_FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      evictExpiredCache();
      _cache.set(cacheKey, { result: SAFE, expires: Date.now() + 60_000 /* 1분 재시도 */ });
      return SAFE;
    }

    const data = (await res.json()) as unknown;
    const items: Array<Record<string, unknown>> = Array.isArray(data)
      ? (data as Array<Record<string, unknown>>)
      : (((data as Record<string, unknown>)?.list as Array<Record<string, unknown>>) ?? []);

    const EARNINGS_MARKERS = ['실적발표', '잠정실적', '분기실적', '영업실적'];
    for (const item of items) {
      const title = String(item.title ?? item.name ?? item.eventName ?? '');
      if (EARNINGS_MARKERS.some((m) => title.includes(m))) {
        const dateRaw = String(item.date ?? item.startDate ?? item.eventDate ?? '');
        const normalized = dateRaw.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
        const eventDate = normalized ? new Date(normalized) : null;
        if (eventDate && !Number.isNaN(eventDate.getTime())) {
          const daysUntil = Math.round((eventDate.getTime() - today.getTime()) / 86400000);
          if (daysUntil >= 0 && daysUntil <= REFRESH.EARNINGS_WINDOW_DAYS) {
            const result: EarningsCheckResult = {
              hasUpcomingEarnings: true,
              earningsDate: dateRaw,
              daysUntil,
            };
            evictExpiredCache();
            _cache.set(cacheKey, { result, expires: Date.now() + REFRESH.EARNINGS_CACHE_TTL_MS });
            logger.info(`📅 KR실적발표 [${code}] D+${daysUntil}일 (${dateRaw}) → 매수 차단`, {
              component: 'EARNINGS_SENTINEL',
            });
            return result;
          }
        }
      }
    }

    evictExpiredCache();
    _cache.set(cacheKey, { result: SAFE, expires: Date.now() + REFRESH.EARNINGS_CACHE_TTL_MS });
    return SAFE;
  } catch (err) {
    logger.debug(`KR실적조회실패(${code}): ${err}`, { component: 'EARNINGS_SENTINEL' });
    evictExpiredCache();
    _cache.set(cacheKey, { result: SAFE, expires: Date.now() + 60_000 /* 1분 재시도 */ });
    return SAFE;
  }
}

// ── 미국 실적발표 감시 (Yahoo Finance calendarEvents, 키 불필요) ──
export async function checkUsEarnings(symbol: string): Promise<EarningsCheckResult> {
  const cacheKey = `us_${symbol}`;
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() < hit.expires) return hit.result;

  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=calendarEvents`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(REFRESH.EARNINGS_FETCH_TIMEOUT_MS),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;

    const summary = json as { quoteSummary?: { result?: Array<{ calendarEvents?: { earnings?: { earningsDate?: number[] } } }> } };
    const earningsDates: number[] =
      summary?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate ?? [];

    const nowSec = Date.now() / 1000;
    for (const ts of earningsDates) {
      const daysUntil = Math.round((ts - nowSec) / 86400);
      if (daysUntil >= -1 && daysUntil <= REFRESH.EARNINGS_WINDOW_DAYS) {
        const dateStr = new Date(ts * 1000).toISOString().slice(0, 10);
        const result: EarningsCheckResult = {
          hasUpcomingEarnings: true,
          earningsDate: dateStr,
          daysUntil: Math.max(0, daysUntil),
        };
        evictExpiredCache();
        _cache.set(cacheKey, { result, expires: Date.now() + REFRESH.EARNINGS_CACHE_TTL_MS });
        logger.info(`📅 US실적발표 [${symbol}] D+${daysUntil}일 (${dateStr}) → 매수 차단`, {
          component: 'EARNINGS_SENTINEL',
        });
        return result;
      }
    }

    evictExpiredCache();
    _cache.set(cacheKey, { result: SAFE, expires: Date.now() + REFRESH.EARNINGS_CACHE_TTL_MS });
    return SAFE;
  } catch (err) {
    logger.debug(`US실적조회실패(${symbol}): ${err}`, { component: 'EARNINGS_SENTINEL' });
    evictExpiredCache();
    _cache.set(cacheKey, { result: SAFE, expires: Date.now() + 60_000 /* 1분 재시도 */ });
    return SAFE;
  }
}

export function clearEarningsCache(code?: string): void {
  if (code) {
    _cache.delete(`kr_${code}`);
    _cache.delete(`us_${code}`);
  } else {
    _cache.clear();
  }
}
