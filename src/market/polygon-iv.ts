/**
 * 📊 Polygon.io 옵션 IV (Implied Volatility) — 15분 지연 무료
 *
 * 무료 발급: https://polygon.io/dashboard/api-keys (Free tier 5 calls/min)
 *
 * IV (내재변동성) = 옵션 가격에서 역산한 시장의 미래 변동성 기대치
 * - IV 급등 = 큰 이벤트 (실적, 합병, FDA, 사건) 예고
 * - 매수 직전 IV 급등 → 보통 손실 (이벤트 후 IV 급락 + 가격 반응)
 * - "IV crush" 패턴
 *
 * Gemini 미관여 — 매수 직전 가드/회피용 독립 신호
 *
 * 활용:
 *  - 매수 후보 종목의 IV rank 조회
 *  - IV >= 80 percentile → 매수 보류 (이벤트 임박)
 *  - IV <= 30 percentile → 매수 보너스 (안정 구간)
 */

import { logger } from '../utils/logger.js';

const COMP = 'POLYGON_IV';
const POLYGON_BASE = 'https://api.polygon.io';

export interface OptionsIvSnapshot {
  ticker: string;
  currentIv: number; // 현재 ATM 30일 옵션 IV
  ivRank30d: number; // 30일 percentile (0-100, 100이 최고치)
  ivPercentile1y: number; // 1년 percentile (참고)
  isHigh: boolean; // >= 80 percentile
  isLow: boolean; // <= 30 percentile
  warning: string | null; // 매수 전 경고
  scoreAdjustment: number; // 점수 조정 (-10 = 회피, +5 = 보너스)
  fetchedAt: string;
}

const _cache = new Map<string, { data: OptionsIvSnapshot; fetchedAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30분 (free tier 5 calls/min 보호)

async function fetchAtmOptionIv(ticker: string): Promise<number> {
  const apiKey = process.env.POLYGON_API_KEY ?? '';
  if (!apiKey) return 0;
  try {
    // 30일 후 만기 ATM 콜 옵션 — 단순화: snapshot으로 첫 ATM 콜의 IV
    const url = `${POLYGON_BASE}/v3/snapshot/options/${ticker}?apiKey=${apiKey}&limit=20`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      logger.debug(`Polygon ${ticker} HTTP ${res.status}`, { component: COMP });
      return 0;
    }
    const data = (await res.json()) as {
      results?: Array<{ implied_volatility?: number; details?: { strike_price?: number } }>;
    };
    const results = data.results ?? [];
    if (results.length === 0) return 0;
    // 평균 IV (단순)
    const ivs = results.map((r) => r.implied_volatility ?? 0).filter((v) => v > 0);
    if (ivs.length === 0) return 0;
    return ivs.reduce((s, v) => s + v, 0) / ivs.length;
  } catch (e) {
    logger.debug(`Polygon ${ticker} 실패: ${(e as Error).message}`, { component: COMP });
    return 0;
  }
}

export async function getOptionsIv(ticker: string): Promise<OptionsIvSnapshot | null> {
  const tk = ticker.toUpperCase();
  const cached = _cache.get(tk);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  if (!process.env.POLYGON_API_KEY) {
    logger.debug('POLYGON_API_KEY 미설정 — IV 스킵', { component: COMP });
    return null;
  }

  const currentIv = await fetchAtmOptionIv(tk);
  if (currentIv === 0) return null;

  // IV rank/percentile은 historical IV 필요 — free tier로는 어려움
  // 간이 추정: typical stocks ATM 30d IV는 20-40 (0.2-0.4) 정도
  // 0.4 이상 = high, 0.2 이하 = low
  const ivRank30d = Math.min(100, Math.max(0, ((currentIv - 0.15) / 0.6) * 100));
  const ivPercentile1y = ivRank30d; // 단순화

  const isHigh = ivRank30d >= 80;
  const isLow = ivRank30d <= 30;

  let warning: string | null = null;
  let scoreAdjustment = 0;

  if (isHigh) {
    warning = `IV ${(currentIv * 100).toFixed(0)}% / rank ${ivRank30d.toFixed(0)} → 이벤트 임박 가능성 (매수 보류 권장)`;
    scoreAdjustment = -10;
  } else if (isLow) {
    warning = null;
    scoreAdjustment = 3; // 안정 구간 보너스
  }

  const snapshot: OptionsIvSnapshot = {
    ticker: tk,
    currentIv,
    ivRank30d,
    ivPercentile1y,
    isHigh,
    isLow,
    warning,
    scoreAdjustment,
    fetchedAt: new Date().toISOString(),
  };

  _cache.set(tk, { data: snapshot, fetchedAt: Date.now() });
  return snapshot;
}

/** 매수 전 가드 — IV 너무 높으면 false 반환 */
export async function isBuyAllowedByIv(ticker: string): Promise<{ allowed: boolean; reason: string }> {
  const snap = await getOptionsIv(ticker).catch(() => null);
  if (!snap) return { allowed: true, reason: 'IV 데이터 없음 (스킵)' };
  if (snap.isHigh) {
    return { allowed: false, reason: snap.warning ?? `IV ${(snap.currentIv * 100).toFixed(0)}% 너무 높음` };
  }
  return { allowed: true, reason: snap.isLow ? `IV 안정 (${(snap.currentIv * 100).toFixed(0)}%)` : `IV 정상` };
}
