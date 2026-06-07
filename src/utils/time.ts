/** KST 현재 시간 (UTC+9 고정 — Intl/locale 의존 제거) */
export function getKSTNow(): Date {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
