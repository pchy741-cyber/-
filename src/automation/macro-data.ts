/**
 * 거시경제 데이터 수집 — 시장 체제(regime) 감지용
 *
 * Data Sources:
 * - VKOSPI (변동성지수): Naver 증권 API
 * - USD/KRW 환율: Naver 환율 API
 * - 한국은행 기준금리: ECOS API (BOK_API_KEY 필요, 없으면 기본값)
 * - KOSPI 등락률: market-regime에서 이미 수집하는 데이터 활용
 *
 * 30분 캐시 적용. 모든 fetch 실패 시 sensible defaults 반환 (절대 crash 안 함).
 */

import { logger } from '../utils/logger.js';

// ── Interfaces ──

export interface MacroSnapshot {
  baseRate: number; // 한국은행 기준금리
  usdKrw: number; // 달러/원 환율
  vkospi: number; // 변동성 지수
  kospiChange: number; // KOSPI 등락률 (%)
  fearGreedIndex: number; // 0-100 (0=극단적 공포, 100=극단적 탐욕)
  regime: 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';
  timestamp: string;
}

// ── Constants ──

const CACHE_TTL_MS = 30 * 60 * 1000; // 30분
const FETCH_TIMEOUT_MS = 8_000;

const DEFAULTS = {
  baseRate: 3.0,
  usdKrw: 1_500,
  vkospi: 20,
  kospiChange: 0,
} as const;

// ── Cache ──

let cachedSnapshot: MacroSnapshot | null = null;
let cacheTimestamp = 0;

// fetchExchangeRate() 전용 캐시 — getCash() 등 핫패스에서 매 호출마다 Naver API 치는 것 방지
let cachedFxRate: number | null = null;
let cachedFxTimestamp = 0;
const FX_CACHE_TTL_MS = 5 * 60 * 1000; // 5분 (환율 변동 빠른 반영)

// ── Helper: safe fetch with timeout ──

async function safeFetch(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

// ── VKOSPI (변동성지수) ──

export async function fetchVKOSPI(): Promise<number> {
  try {
    const res = await safeFetch('https://m.stock.naver.com/api/index/VKOSPI/basic');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as Record<string, unknown>;
    const value = Number(
      (data as Record<string, Record<string, string>>)?.closePrice ??
        (data as Record<string, Record<string, string>>)?.now ??
        (data as Record<string, Record<string, string>>)?.currentValue,
    );

    if (!Number.isFinite(value) || value <= 0) {
      // Naver 응답 구조가 변경됐을 수 있음 — deep search
      const raw = JSON.stringify(data);
      const match = raw.match(
        /"(?:closePrice|now|risefall|compareToPreviousClosePrice|currentValue)"\s*:\s*"?([\d.]+)"?/,
      );
      if (match) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed) && parsed > 5 && parsed < 100) return parsed;
      }
      logger.warn('VKOSPI 파싱 실패, 기본값 사용', { component: 'MACRO' });
      return DEFAULTS.vkospi;
    }

    return value;
  } catch (error) {
    logger.warn(`VKOSPI 조회 실패: ${error}`, { component: 'MACRO' });
    return DEFAULTS.vkospi;
  }
}

// ── USD/KRW 환율 ──

export async function fetchExchangeRate(): Promise<number> {
  // 캐시 히트: 10분 이내 조회값 재사용 (getCash/updateTradeState 등 핫패스 보호)
  if (cachedFxRate !== null && Date.now() - cachedFxTimestamp < FX_CACHE_TTL_MS) {
    return cachedFxRate;
  }

  // 1차: open.er-api.com (무료, 안정적)
  try {
    const res = await safeFetch('https://open.er-api.com/v6/latest/USD');
    if (res.ok) {
      const data = (await res.json()) as { rates?: { KRW?: number } };
      const value = data?.rates?.KRW;
      if (value && Number.isFinite(value) && value > 800 && value < 2000) {
        cachedFxRate = Math.round(value * 100) / 100;
        cachedFxTimestamp = Date.now();
        return cachedFxRate;
      }
    }
  } catch {
    /* fallback to next source */
  }

  // 2차: Naver 증권 (기존 — 현재 404일 수 있음)
  try {
    const res = await safeFetch('https://m.stock.naver.com/api/exchange/FX_USDKRW/basic');
    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      const raw = JSON.stringify(data);
      const match = raw.match(/"(?:closePrice|now|currentValue)"\s*:\s*"?([\d,.]+)"?/);
      if (match) {
        const parsed = Number(match[1].replace(/,/g, ''));
        if (Number.isFinite(parsed) && parsed > 800 && parsed < 2000) {
          cachedFxRate = parsed;
          cachedFxTimestamp = Date.now();
          return cachedFxRate;
        }
      }
    }
  } catch {
    /* fallback */
  }

  logger.warn('USD/KRW 모든 소스 실패, 캐시/기본값 사용', { component: 'MACRO' });
  return cachedFxRate ?? DEFAULTS.usdKrw;
}

// ── 한국은행 기준금리 (ECOS API) ──

export async function fetchBaseRate(): Promise<number> {
  const apiKey = process.env.BOK_API_KEY;
  if (!apiKey) {
    logger.debug('BOK_API_KEY 미설정, 기준금리 기본값 사용', { component: 'MACRO' });
    return DEFAULTS.baseRate;
  }

  try {
    // 최근 1개 데이터 조회: 722Y001 / 0101000 (한국은행 기준금리)
    const url = `https://ecos.bok.or.kr/api/StatisticSearch/${apiKey}/json/kr/1/1/722Y001/M/202401/209912/0101000`;
    const res = await safeFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as Record<string, Record<string, Record<string, string>[]>>;
    const rows = data?.StatisticSearch?.row;
    if (rows && rows.length > 0) {
      const rate = Number(rows[rows.length - 1].DATA_VALUE);
      if (Number.isFinite(rate) && rate > 0 && rate < 20) return rate;
    }

    return DEFAULTS.baseRate;
  } catch (error) {
    logger.warn(`기준금리 조회 실패: ${error}`, { component: 'MACRO' });
    return DEFAULTS.baseRate;
  }
}

// ── KOSPI 등락률 (Naver API) ──

async function fetchKospiChange(): Promise<number> {
  try {
    const res = await safeFetch('https://m.stock.naver.com/api/index/KOSPI/basic');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as Record<string, unknown>;
    // compareToPreviousClosePrice / fluctuationsRatio 등 다양한 필드명 시도
    const raw = JSON.stringify(data);
    const match = raw.match(/"(?:fluctuationsRatio|compareToPreviousPrice\.rate|rateOfChange)"\s*:\s*"?([-\d.]+)"?/);
    if (match) {
      const pct = Number(match[1]);
      if (Number.isFinite(pct) && Math.abs(pct) < 30) return pct;
    }

    // 직접 계산 시도
    const closePrice = Number((data as Record<string, string>)?.closePrice ?? 0);
    const prevClose = Number((data as Record<string, string>)?.compareToPreviousClosePrice ?? 0);
    if (closePrice > 0 && prevClose !== 0) {
      return (prevClose / (closePrice - prevClose)) * 100;
    }

    return DEFAULTS.kospiChange;
  } catch (error) {
    logger.warn(`KOSPI 등락률 조회 실패: ${error}`, { component: 'MACRO' });
    return DEFAULTS.kospiChange;
  }
}

// ── Fear & Greed Index 계산 ──

export function calculateFearGreedIndex(vkospi: number, kospiChange: number): number {
  let score: number;

  if (vkospi > 35) {
    // 극단적 공포: 0-20
    score = Math.max(0, 20 - (vkospi - 35) * 2);
  } else if (vkospi > 25) {
    // 공포: 20-40
    score = 40 - ((vkospi - 25) / 10) * 20;
  } else if (vkospi >= 15) {
    // 중립: 40-60
    score = 60 - ((vkospi - 15) / 10) * 20;
  } else {
    // 탐욕: 60-100
    score = 60 + ((15 - vkospi) / 15) * 40;
  }

  // KOSPI 등락률 보정: 상승 시 +, 하락 시 -
  const kospiAdjustment = kospiChange * 5; // 1% 변동 = ±5 포인트
  score += kospiAdjustment;

  // 0-100 범위로 클램핑
  return Math.round(Math.max(0, Math.min(100, score)));
}

// ── MacroSnapshot 통합 수집 ──

export async function getMacroSnapshot(): Promise<MacroSnapshot> {
  // 캐시 확인
  if (cachedSnapshot && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedSnapshot;
  }

  // 병렬 수집
  const [vkospi, usdKrw, baseRate, kospiChange] = await Promise.all([
    fetchVKOSPI(),
    fetchExchangeRate(),
    fetchBaseRate(),
    fetchKospiChange(),
  ]);

  const fearGreedIndex = calculateFearGreedIndex(vkospi, kospiChange);

  // 체제(Regime) 판단
  let regime: MacroSnapshot['regime'];
  if (fearGreedIndex > 60) {
    regime = 'RISK_ON';
  } else if (fearGreedIndex >= 40) {
    regime = 'NEUTRAL';
  } else {
    regime = 'RISK_OFF';
  }

  const snapshot: MacroSnapshot = {
    baseRate,
    usdKrw,
    vkospi,
    kospiChange,
    fearGreedIndex,
    regime,
    timestamp: new Date().toISOString(),
  };

  // 캐시 저장
  cachedSnapshot = snapshot;
  cacheTimestamp = Date.now();

  logger.info(
    `매크로 스냅샷: VKOSPI=${vkospi.toFixed(1)} USD/KRW=${usdKrw.toFixed(0)} F&G=${fearGreedIndex} → ${regime}`,
    { component: 'MACRO' },
  );

  return snapshot;
}

// ── 매크로 기반 점수 보정 ──

export function getMacroScoreAdjustment(snapshot: MacroSnapshot): number {
  const { regime, fearGreedIndex } = snapshot;

  // 극단적 공포 → 역발상 매수 시그널 ("공포에 사라")
  if (fearGreedIndex < 20) {
    return +10;
  }

  switch (regime) {
    case 'RISK_ON':
      return +5; // 시장 우호적
    case 'NEUTRAL':
      return 0;
    case 'RISK_OFF':
      return -10; // 방어적
    default:
      return 0;
  }
}

// ── 캐시 초기화 (테스트용) ──

export function clearMacroCache(): void {
  cachedSnapshot = null;
  cacheTimestamp = 0;
  cachedFxRate = null;
  cachedFxTimestamp = 0;
}
