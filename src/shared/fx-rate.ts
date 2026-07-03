/**
 * 환율 캐시 — api/routes/dashboard/helpers.ts에서 추출
 * API 라우트 외 레이어(risk, ai, automation)에서도 사용
 */
import { FALLBACK_FX_RATE } from '../config/constants.js';

let _fxCache = { rate: FALLBACK_FX_RATE, fetchedAt: 0 };

export async function getFxRate(): Promise<number> {
  const now = Date.now();
  if (now - _fxCache.fetchedAt < 60 * 60 * 1000) return _fxCache.rate;
  try {
    const resp = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(2000) });
    const data = (await resp.json()) as any;
    const krw = data?.rates?.KRW;
    if (krw && krw > 1000 && krw < 2000) {
      _fxCache = { rate: Math.round(krw), fetchedAt: now };
    }
  } catch {
    /* 폴백 유지 */
  }
  return _fxCache.rate;
}
