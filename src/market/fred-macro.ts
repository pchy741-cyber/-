/**
 * 🏦 FRED API — Federal Reserve Economic Data 통합
 *
 * 무료 키: https://fredaccount.stlouisfed.org/apikey (이메일만 필요)
 * 사용량: 무제한 (rate limit 없음, 합리적 사용)
 *
 * 수집 데이터:
 * - FEDFUNDS: 연방기금 금리 (월별)
 * - CPIAUCSL: CPI 소비자물가지수 (월별)
 * - UNRATE: 실업률 (월별)
 * - DGS10: 10년물 국채 수익률 (일별)
 * - T10Y2Y: 10-2년 수익률 스프레드 (장단기 역전 = 침체 시그널)
 * - VIXCLS: VIX 종가 (일별)
 *
 * 활용:
 * - market-regime.ts에 점수 가산 (금리 인상/CPI 급등 = 부정)
 * - 매크로 충격 즉시 디펜시브 전환
 * - 캐시 24h (월별 데이터는 자주 안 바뀜)
 */

import { logger } from '../utils/logger.js';

const COMP = 'FRED';
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

export interface FredMacroSnapshot {
  fedFundsRate: number; // 연방기금 금리 %
  fedFundsChange1m: number; // 1개월 변화 (인상/인하)
  cpiYoY: number; // CPI 연간 변화율 %
  unemploymentRate: number; // 실업률 %
  treasuryYield10Y: number; // 10년물 %
  yieldCurveSpread: number; // 10y-2y 스프레드 (음수 = 역전 = 침체 시그널)
  vixPrev: number; // VIX 전일 종가
  /** 매크로 위험 점수 (-10 = 극위험, +5 = 안정) */
  macroRiskScore: number;
  /** 위험 사유 */
  reasons: string[];
  fetchedAt: string;
}

let _cache: { data: FredMacroSnapshot; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24시간

async function fetchFredSeries(seriesId: string, limit = 2): Promise<number[]> {
  const apiKey = process.env.FRED_API_KEY ?? '';
  if (!apiKey) return [];
  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${limit}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      logger.warn(`FRED ${seriesId} HTTP ${res.status}`, { component: COMP });
      return [];
    }
    const data = (await res.json()) as { observations?: Array<{ value: string }> };
    const obs = data.observations ?? [];
    return obs.map((o) => Number(o.value)).filter((v) => !isNaN(v));
  } catch (e) {
    logger.warn(`FRED ${seriesId} 실패: ${(e as Error).message}`, { component: COMP });
    return [];
  }
}

export async function getFredMacro(): Promise<FredMacroSnapshot | null> {
  // 메모리 캐시 우선
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.data;
  }
  // 장기 보완 #5: DB 캐시 폴백 (서버 재시작 견딤)
  try {
    const { getPool } = await import('../db/client.js');
    const { rows } = await getPool().query(
      `SELECT value FROM system_state WHERE key = 'fred_macro_snapshot' AND updated_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
    );
    if (rows[0]?.value) {
      const data = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
      _cache = { data, fetchedAt: new Date(data.fetchedAt).getTime() };
      logger.info(`FRED DB 캐시 복원 (24h 이내)`, { component: COMP });
      return data;
    }
  } catch {
    /* DB 캐시 실패 시 신규 fetch */
  }
  if (!process.env.FRED_API_KEY) {
    logger.debug('FRED_API_KEY 미설정 — FRED 매크로 스킵', { component: COMP });
    return null;
  }

  try {
    // 병렬 조회
    const [fedFunds, cpi, unemploy, t10, t10y2y, vix] = await Promise.all([
      fetchFredSeries('FEDFUNDS', 2), // 최근 2개월
      fetchFredSeries('CPIAUCSL', 13), // 최근 13개월 (YoY 계산용)
      fetchFredSeries('UNRATE', 1),
      fetchFredSeries('DGS10', 1),
      fetchFredSeries('T10Y2Y', 1),
      fetchFredSeries('VIXCLS', 1),
    ]);

    const fedFundsRate = fedFunds[0] ?? 0;
    const fedFundsPrev = fedFunds[1] ?? fedFundsRate;
    const fedFundsChange1m = fedFundsRate - fedFundsPrev;

    const cpiNow = cpi[0] ?? 0;
    const cpi12m = cpi[12] ?? cpiNow;
    const cpiYoY = cpi12m > 0 ? ((cpiNow - cpi12m) / cpi12m) * 100 : 0;

    const unemploymentRate = unemploy[0] ?? 0;
    const treasuryYield10Y = t10[0] ?? 0;
    const yieldCurveSpread = t10y2y[0] ?? 0;
    const vixPrev = vix[0] ?? 0;

    // 매크로 위험 점수 계산
    let macroRiskScore = 0;
    const reasons: string[] = [];

    // 금리 급변
    if (fedFundsChange1m >= 0.5) {
      macroRiskScore -= 3;
      reasons.push(`Fed 금리 +${fedFundsChange1m.toFixed(2)}% (급등)`);
    } else if (fedFundsChange1m >= 0.25) {
      macroRiskScore -= 1;
      reasons.push(`Fed 금리 +${fedFundsChange1m.toFixed(2)}%`);
    } else if (fedFundsChange1m <= -0.25) {
      macroRiskScore += 2;
      reasons.push(`Fed 금리 인하 ${fedFundsChange1m.toFixed(2)}% (완화)`);
    }

    // CPI 인플레
    if (cpiYoY >= 5.0) {
      macroRiskScore -= 2;
      reasons.push(`CPI YoY ${cpiYoY.toFixed(1)}% (고인플레)`);
    } else if (cpiYoY <= 2.0 && cpiYoY > 0) {
      macroRiskScore += 1;
      reasons.push(`CPI YoY ${cpiYoY.toFixed(1)}% (안정)`);
    }

    // 실업률 급등
    if (unemploymentRate >= 6.0) {
      macroRiskScore -= 2;
      reasons.push(`실업률 ${unemploymentRate.toFixed(1)}% (경기침체 신호)`);
    } else if (unemploymentRate <= 4.0) {
      macroRiskScore += 1;
      reasons.push(`실업률 ${unemploymentRate.toFixed(1)}% (완전고용)`);
    }

    // 수익률 곡선 역전
    if (yieldCurveSpread < -0.5) {
      macroRiskScore -= 3;
      reasons.push(`수익률곡선 역전 ${yieldCurveSpread.toFixed(2)}%p (강한 침체 신호)`);
    } else if (yieldCurveSpread < 0) {
      macroRiskScore -= 1;
      reasons.push(`수익률곡선 역전 ${yieldCurveSpread.toFixed(2)}%p`);
    }

    // VIX
    if (vixPrev >= 30) {
      macroRiskScore -= 2;
      reasons.push(`VIX ${vixPrev.toFixed(0)} (공포)`);
    } else if (vixPrev <= 15) {
      macroRiskScore += 1;
      reasons.push(`VIX ${vixPrev.toFixed(0)} (안정)`);
    }

    const snapshot: FredMacroSnapshot = {
      fedFundsRate,
      fedFundsChange1m,
      cpiYoY,
      unemploymentRate,
      treasuryYield10Y,
      yieldCurveSpread,
      vixPrev,
      macroRiskScore,
      reasons,
      fetchedAt: new Date().toISOString(),
    };

    _cache = { data: snapshot, fetchedAt: Date.now() };
    // 장기 보완 #5: DB 영속화 (재시작 견딤)
    try {
      const { getPool } = await import('../db/client.js');
      await getPool().query(
        `INSERT INTO system_state (key, value, updated_at) VALUES ('fred_macro_snapshot', $1::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
        [JSON.stringify(snapshot)],
      );
    } catch (e) {
      logger.debug(`FRED DB 캐시 저장 실패: ${(e as Error).message}`, { component: COMP });
    }
    logger.info(
      `📊 FRED 매크로: Fed ${fedFundsRate.toFixed(2)}% (Δ${fedFundsChange1m >= 0 ? '+' : ''}${fedFundsChange1m.toFixed(2)}) | CPI ${cpiYoY.toFixed(1)}% | 실업 ${unemploymentRate.toFixed(1)}% | 10Y ${treasuryYield10Y.toFixed(2)}% | 곡선 ${yieldCurveSpread.toFixed(2)} → risk ${macroRiskScore >= 0 ? '+' : ''}${macroRiskScore}`,
      { component: COMP },
    );
    return snapshot;
  } catch (e) {
    logger.warn(`FRED 매크로 조회 실패: ${(e as Error).message}`, { component: COMP });
    return null;
  }
}

/** market-regime에서 호출용 — 점수 가산만 */
export async function getFredMacroAdjustment(): Promise<{ score: number; reasons: string[] }> {
  const macro = await getFredMacro();
  if (!macro) return { score: 0, reasons: [] };
  return { score: macro.macroRiskScore, reasons: macro.reasons };
}
