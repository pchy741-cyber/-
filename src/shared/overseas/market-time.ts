/**
 * 시장 시간 계산 유틸리티 — scheduler/overseas/session.ts에서 추출
 * 순수 시간 계산 함수만 포함 (DB/상태 없음)
 */

// ── KST 오프셋 (UTC → KST 변환용, 밀리초) ──
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000; // +9 hours

// ── 미국 서머타임(DST) 자동 감지 ──
export function isUSDST(): boolean {
  const now = new Date();
  const month = now.getUTCMonth();
  const year = now.getUTCFullYear();

  if (month > 2 && month < 10) return true;
  if (month < 2 || month > 10) return false;

  const nthSunday = (m: number, n: number) => {
    const dow = new Date(Date.UTC(year, m, 1)).getUTCDay();
    return (dow === 0 ? 1 : 8 - dow) + (n - 1) * 7;
  };

  if (month === 2) {
    return now >= new Date(Date.UTC(year, 2, nthSunday(2, 2), 7));
  }
  return now < new Date(Date.UTC(year, 10, nthSunday(10, 1), 6));
}

// ── 현재 열려 있는 시장 판별 (KST 기준, DST 자동) ──
export function getOpenMarketRegions(): Set<string> {
  const now = new Date();
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const open = new Set<string>();

  const shift = isUSDST() ? 0 : 60;

  const usOpen = 22 * 60 + 30 + shift;
  const usClose = 5 * 60 + shift;
  if (mins >= usOpen || mins <= usClose) open.add('US');

  const preStart = 17 * 60 + shift;
  const postEnd = 9 * 60 + shift;
  if ((mins >= preStart && mins < usOpen) || (mins > usClose && mins <= postEnd)) open.add('US_EXTENDED');

  if (mins >= 9 * 60 && mins <= 15 * 60 + 30) open.add('KR');

  if ((mins >= 9 * 60 && mins <= 11 * 60 + 30) || (mins >= 12 * 60 + 30 && mins <= 15 * 60 + 30)) open.add('JP');

  if (mins >= 10 * 60 && mins <= 14 * 60 + 30) open.add('TW');

  return open;
}
