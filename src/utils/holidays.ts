/**
 * 한국 주식시장 공휴일 (KRX)
 * 매년 초에 한국거래소 공시 확인 후 업데이트 필요
 */

// 2026년 한국 공휴일 (주말 제외, 대체공휴일 포함)
const HOLIDAYS_2026 = new Set([
  '2026-01-01', // 신정
  '2026-02-16', // 설 연휴
  '2026-02-17', // 설날
  '2026-02-18', // 설 연휴
  '2026-03-01', // 삼일절
  '2026-05-05', // 어린이날
  '2026-05-24', // 부처님오신날
  '2026-06-06', // 현충일
  '2026-08-15', // 광복절
  '2026-09-24', // 추석 연휴
  '2026-09-25', // 추석
  '2026-09-26', // 추석 연휴
  '2026-10-03', // 개천절
  '2026-10-09', // 한글날
  '2026-12-25', // 크리스마스
]);

export function isKoreanHoliday(date: Date = new Date()): boolean {
  const kst = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const dateStr = kst.toISOString().split('T')[0];
  return HOLIDAYS_2026.has(dateStr);
}

export function isTradingDay(date: Date = new Date()): boolean {
  const kst = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = kst.getDay();

  // 주말 체크
  if (day === 0 || day === 6) return false;

  // 공휴일 체크
  if (isKoreanHoliday(date)) return false;

  return true;
}
