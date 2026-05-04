/**
 * 한국 주식시장 공휴일 (KRX)
 * - 하드코딩 fallback: 근로자의날·대체공휴일 포함 (2026–2028)
 * - API 캐시: 부팅 시 KIS API로 자동 갱신 → setApiHolidayCache() 호출
 */

// ── 하드코딩 fallback (KIS API 실패 시 사용) ──────────────────────────────
const HOLIDAYS_FALLBACK: Record<number, Set<string>> = {
  2026: new Set([
    '2026-01-01', // 신정 (목)
    '2026-02-16', '2026-02-17', '2026-02-18', // 설 연휴 (월~수)
    '2026-03-01', // 삼일절 (일)
    '2026-03-02', // 삼일절 대체공휴일 (월)
    '2026-05-01', // 근로자의날 (금) ← 버그 원인 항목
    '2026-05-05', // 어린이날 (화)
    '2026-05-24', // 부처님오신날 (일)
    '2026-05-25', // 부처님오신날 대체공휴일 (월)
    '2026-06-06', // 현충일 (토)
    '2026-06-08', // 현충일 대체공휴일 (월)
    '2026-08-15', // 광복절 (토)
    '2026-08-17', // 광복절 대체공휴일 (월)
    '2026-09-24', '2026-09-25', '2026-09-26', // 추석 연휴 (목~토)
    '2026-09-28', // 추석 대체공휴일 (월)
    '2026-10-03', // 개천절 (토)
    '2026-10-05', // 개천절 대체공휴일 (월)
    '2026-10-09', // 한글날 (금)
    '2026-12-25', // 크리스마스 (금)
    '2026-12-31', // 연말 KRX 휴장 (목)
  ]),
  2027: new Set([
    '2027-01-01', // 신정 (금)
    '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', // 설 연휴+대체 (금~월)
    '2027-03-01', // 삼일절 (월)
    '2027-05-01', // 근로자의날 (토)
    '2027-05-03', // 근로자의날 대체공휴일 (월)
    '2027-05-05', // 어린이날 (수)
    '2027-05-13', // 부처님오신날 (목)
    '2027-06-06', // 현충일 (일)
    '2027-06-07', // 현충일 대체공휴일 (월)
    '2027-08-15', // 광복절 (일)
    '2027-08-16', // 광복절 대체공휴일 (월)
    '2027-10-03', // 개천절 (일)
    '2027-10-04', // 개천절 대체공휴일 (월)
    '2027-10-09', // 한글날 (토)
    '2027-10-11', '2027-10-12', '2027-10-13', // 추석 연휴 (월~수)
    '2027-12-25', // 크리스마스 (토)
    '2027-12-27', // 크리스마스 대체공휴일 (월)
    '2027-12-31', // 연말 KRX 휴장 (금)
  ]),
  2028: new Set([
    '2028-01-01', // 신정 (토)
    '2028-01-03', // 신정 대체공휴일 (월)
    '2028-01-25', '2028-01-26', '2028-01-27', // 설 연휴 (화~목)
    '2028-03-01', // 삼일절 (수)
    '2028-05-01', // 근로자의날 (월)
    '2028-05-02', // 부처님오신날 (화)
    '2028-05-05', // 어린이날 (금)
    '2028-06-06', // 현충일 (수)
    '2028-08-15', // 광복절 (화)
    '2028-09-29', '2028-09-30', '2028-10-01', // 추석 연휴 (금~일)
    '2028-10-02', // 추석 대체공휴일 (월)
    '2028-10-03', // 개천절 (화)
    '2028-10-09', // 한글날 (월)
    '2028-12-25', // 크리스마스 (월)
    '2028-12-29', // 연말 KRX 휴장 (금)
  ]),
};

// ── KIS API 캐시 (부팅 시 refreshMarketHolidayCache가 채움) ─────────────
let _apiCache: { year: number; dates: Set<string> } | null = null;

/** KIS API 응답 기반 휴장일 캐시 주입 (market.ts에서 호출) */
export function setApiHolidayCache(year: number, dates: Set<string>): void {
  _apiCache = { year, dates };
}

function getKSTDateStr(date: Date): string {
  // en-CA = YYYY-MM-DD 형식 보장
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(date);
}

export function isKoreanHoliday(date: Date = new Date()): boolean {
  const dateStr = getKSTDateStr(date);
  const year = Number(dateStr.split('-')[0]);

  // API 캐시 우선 (KIS 공식 데이터)
  if (_apiCache?.year === year) {
    return _apiCache.dates.has(dateStr);
  }

  // fallback: 하드코딩 목록
  return HOLIDAYS_FALLBACK[year]?.has(dateStr) ?? false;
}

export function isTradingDay(date: Date = new Date()): boolean {
  const dayStr = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(date);
  if (dayStr === 'Sat' || dayStr === 'Sun') return false;
  if (isKoreanHoliday(date)) return false;
  return true;
}
