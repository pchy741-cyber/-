/**
 * 뉴스 감시자 — NAVER Finance 뉴스 기반 악재/공시 실시간 감지
 *
 * - 보유 종목 악재 키워드 → Track B FORCE_CLOSE 트리거
 * - 매수 후보 실적발표 키워드 → trade-gate 진입 차단
 *
 * 5분 캐시(per code) / 실패 시 안전 기본값 반환 (거래 중단 없음)
 */

import { logger } from '../utils/logger.js';

// ── 악재 키워드: 보유 종목에서 감지 시 즉시 청산 ──
const BAD_KEYWORDS = [
  '상장폐지', '감리', '분식회계', '횡령', '배임', '검찰수사', '검찰',
  '회계감리', '감사의견 거절', '감사거절', '자본잠식', '파산신청', '부도',
  '워크아웃', '법정관리', '주가조작', '불성실공시', '거래정지', '매매정지',
  '과징금', '영업정지', '기소', '압수수색', '구속영장',
];

// ── 실적 발표 키워드: 매수 후보에서 감지 시 공시 직후 변동성 회피 ──
const EARNINGS_KEYWORDS = [
  '잠정실적', '실적발표', '실적 발표', '분기실적', '어닝쇼크', '어닝 쇼크',
  '어닝서프라이즈', '영업이익 감소', '영업이익 하락', '순손실 전환', '적자전환',
  '이익 급감', '실적 쇼크',
];

export interface NewsSentinelResult {
  hasBadNews: boolean;
  isEarningsRisk: boolean;
  headline: string;
}

const SAFE: NewsSentinelResult = { hasBadNews: false, isEarningsRisk: false, headline: '' };

const _cache = new Map<string, { result: NewsSentinelResult; expires: number }>();
const CACHE_TTL = 5 * 60_000;
const FETCH_TIMEOUT = 4_000;

export async function checkNewsForStock(code: string): Promise<NewsSentinelResult> {
  const hit = _cache.get(code);
  if (hit && Date.now() < hit.expires) return hit.result;

  try {
    const url = `https://m.stock.naver.com/api/news/list?code=${code}&pageSize=10&page=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as Record<string, unknown>;

    // NAVER 뉴스 API — 다양한 응답 구조 대응
    let titles: string[] = [];
    const listField = data.newsList ?? data.list ?? data.items;
    if (Array.isArray(listField)) {
      titles = (listField as Array<Record<string, unknown>>)
        .map(n => String(n.title ?? n.headline ?? n.subject ?? ''))
        .filter(t => t.length > 0);
    }
    if (titles.length === 0) {
      // fallback: JSON raw 파싱
      const raw = JSON.stringify(data);
      const matches = raw.match(/"title":"([^"]{4,80})"/g) ?? [];
      titles = matches.map(m => m.slice(9, -1));
    }

    if (titles.length === 0) {
      _cache.set(code, { result: SAFE, expires: Date.now() + CACHE_TTL });
      return SAFE;
    }

    const allText = titles.join(' ');
    const badKw = BAD_KEYWORDS.find(kw => allText.includes(kw));
    const earningsKw = EARNINGS_KEYWORDS.find(kw => allText.includes(kw));

    const result: NewsSentinelResult = {
      hasBadNews: !!badKw,
      isEarningsRisk: !!earningsKw && !badKw,
      headline: badKw
        ? (titles.find(t => t.includes(badKw)) ?? '')
        : earningsKw
        ? (titles.find(t => t.includes(earningsKw)) ?? '')
        : '',
    };

    if (result.hasBadNews || result.isEarningsRisk) {
      logger.info(
        `📰 뉴스감지 [${code}] ${result.hasBadNews ? `악재:"${badKw}"` : `실적:"${earningsKw}"`} ← "${result.headline.slice(0, 70)}"`,
        { component: 'NEWS_SENTINEL' },
      );
    }

    _cache.set(code, { result, expires: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    logger.debug(`뉴스조회실패(${code}): ${err}`, { component: 'NEWS_SENTINEL' });
    _cache.set(code, { result: SAFE, expires: Date.now() + 60_000 });
    return SAFE;
  }
}

export function clearNewsCache(code?: string): void {
  if (code) _cache.delete(code);
  else _cache.clear();
}
