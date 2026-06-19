/**
 * KOSPI 레짐 차단 당일 우회 — 인메모리 override, 당일만 유효
 * (settings.ts에서 추출 → ai→api 역방향 의존 제거)
 */

let _kospiOverrideExpiry = 0;

export function isKospiOverrideActive(): boolean {
  return Date.now() < _kospiOverrideExpiry;
}

export function setKospiOverrideExpiry(expiryMs: number): void {
  _kospiOverrideExpiry = expiryMs;
}
