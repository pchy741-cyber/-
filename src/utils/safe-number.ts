/**
 * 안전한 숫자 변환 — Number(val ?? 0) 패턴을 대체
 */
export function safeNum(val: unknown, fallback = 0): number {
  if (val == null) return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}
