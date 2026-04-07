/**
 * 한국 주식시장 공휴일 (KRX)
 * 매년 초에 한국거래소 공시 확인 후 업데이트 필요
 */

const HOLIDAYS: Record<number, Set<string>> = {
  2026: new Set([
    '2026-01-01', // 신정
    '2026-02-16', '2026-02-17', '2026-02-18', // 설 연휴
    '2026-03-01', // 삼일절
    '2026-05-05', // 어린이날
    '2026-05-24', // 부처님오신날
    '2026-06-06', // 현충일
    '2026-08-15', // 광복절
    '2026-09-24', '2026-09-25', '2026-09-26', // 추석 연휴
    '2026-10-03', // 개천절
    '2026-10-09', // 한글날
    '2026-12-25', // 크리스마스
  ]),
  2027: new Set([
    '2027-01-01', // 신정
    '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', // 설 연휴 (대체)
    '2027-03-01', // 삼일절
    '2027-05-05', // 어린이날
    '2027-05-13', // 부처님오신날
    '2027-06-06', // 현충일
    '2027-06-07', // 대체공휴일
    '2027-08-15', // 광복절
    '2027-08-16', // 대체공휴일
    '2027-10-03', // 개천절
    '2027-10-04', // 대체공휴일
    '2027-10-09', // 한글날
    '2027-10-11', '2027-10-12', '2027-10-13', // 추석 연휴
    '2027-12-25', // 크리스마스
  ]),
  2028: new Set([
    '2028-01-01', // 신정
    '2028-01-25', '2028-01-26', '2028-01-27', // 설 연휴
    '2028-03-01', // 삼일절
    '2028-05-02', // 부처님오신날
    '2028-05-05', // 어린이날
    '2028-06-06', // 현충일
    '2028-08-15', // 광복절
    '2028-09-29', '2028-09-30', '2028-10-01', // 추석 연휴
    '2028-10-02', // 대체공휴일
    '2028-10-03', // 개천절
    '2028-10-09', // 한글날
    '2028-12-25', // 크리스마스
  ]),
};

function getKSTDateStr(date: Date): string {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD format
  return formatter.format(date);
}

export function isKoreanHoliday(date: Date = new Date()): boolean {
  const dateStr = getKSTDateStr(date);
  const year = Number(dateStr.split('-')[0]);
  return HOLIDAYS[year]?.has(dateStr) ?? false;
}

export function isTradingDay(date: Date = new Date()): boolean {
  // KST 요일 정확 추출
  const dayStr = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(date);
  if (dayStr === 'Sat' || dayStr === 'Sun') return false;
  if (isKoreanHoliday(date)) return false;
  return true;
}
