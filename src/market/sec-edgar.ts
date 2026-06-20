/**
 * 📜 SEC EDGAR Form 4 — 미국 인사이더 매수 감지
 *
 * 무료, 인증 불필요. User-Agent 헤더만 필수.
 *
 * Form 4 = 임원/이사/10%+ 주주의 자사주 거래 의무 공시 (2영업일 내)
 * 인사이더 매수 = 가장 신뢰할 수 있는 매수 신호 (워런 버핏도 추적)
 *
 * Track A/Gemini 미관여 — 독립 신호로 decision-flow에 가산점 제공
 *
 * 활용:
 * - 보유 종목 또는 후보 종목의 7일 내 Form 4 매수 → 가산점
 * - 대규모 매수 ($1M+) → 더 큰 가산점
 */

import { logger } from '../utils/logger.js';

const COMP = 'SEC_EDGAR';
const SEC_BASE = 'https://data.sec.gov';
// SEC 요구사항: Company Name + Email (Contact Info)
const SEC_UA = process.env.SEC_USER_AGENT ?? 'QuantOps quantops-trading@proscom-hr.com';

export interface InsiderSignal {
  ticker: string;
  cik?: string;
  buys30d: number; // 최근 30일 매수 건수
  sells30d: number;
  netBuyValueUsd: number; // 순매수 금액 (USD)
  largestBuyUsd: number; // 최대 단일 매수
  recentBuyers: string[]; // 최근 매수자 직책 (CEO, CFO 등)
  /** decision-flow 가산점 (-5 ~ +15) */
  scoreAdjustment: number;
  reason: string;
}

interface _CikMap {
  [ticker: string]: string;
}

let _cikCache: _CikMap | null = null;
let _cikFetchedAt = 0;
const CIK_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일

async function fetchCikMap(): Promise<_CikMap> {
  if (_cikCache && Date.now() - _cikFetchedAt < CIK_CACHE_TTL_MS) return _cikCache;
  try {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': SEC_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, { ticker: string; cik_str: number }>;
    const map: _CikMap = {};
    for (const v of Object.values(data)) {
      map[v.ticker] = String(v.cik_str).padStart(10, '0');
    }
    _cikCache = map;
    _cikFetchedAt = Date.now();
    logger.info(`SEC CIK 맵 로드: ${Object.keys(map).length}개 종목`, { component: COMP });
    return map;
  } catch (e) {
    logger.warn(`SEC CIK 맵 로드 실패: ${(e as Error).message}`, { component: COMP });
    return _cikCache ?? {};
  }
}

/** ticker → 최근 인사이더 매매 분석 */
export async function getInsiderSignal(ticker: string): Promise<InsiderSignal | null> {
  const cikMap = await fetchCikMap();
  const cik = cikMap[ticker.toUpperCase()];
  if (!cik) return null;

  try {
    // 1. 회사 submissions 조회 → Form 4 필터
    const subUrl = `${SEC_BASE}/submissions/CIK${cik}.json`;
    const subRes = await fetch(subUrl, {
      headers: { 'User-Agent': SEC_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!subRes.ok) return null;
    const subData = (await subRes.json()) as {
      filings?: { recent?: { form?: string[]; filingDate?: string[]; accessionNumber?: string[] } };
    };

    const recent = subData.filings?.recent;
    if (!recent?.form || !recent.filingDate) return null;

    const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let buys30d = 0;
    const sells30d = 0;
    const netBuyValueUsd = 0;
    const largestBuyUsd = 0;
    const recentBuyers = new Set<string>();

    // Form 4 만 추출 (최대 100개 검사 — 큰 회사도 30일 내에 100개 넘기 어려움)
    // NOTE: Form 4 includes BOTH buys and sells (+ option exercises, gifts, etc.).
    // Without parsing the XML content of each filing, we cannot distinguish buy vs sell.
    // We count all Form 4 filings as "insider activity" (not "buys") and use a conservative
    // score adjustment. The buys30d field is a misnomer — it tracks total Form 4 filings.
    // TODO: Parse individual Form 4 XML to extract transactionCode:
    //   'P' = open-market purchase, 'S' = open-market sale, 'A' = grant/award, etc.
    const maxCheck = Math.min(100, recent.form.length);
    for (let i = 0; i < maxCheck; i++) {
      if (recent.form[i] !== '4') continue;
      const fDate = recent.filingDate?.[i];
      if (!fDate) continue;
      const fMs = new Date(fDate).getTime();
      if (fMs < cutoffMs) break; // 정렬되어 있어서 break OK
      // Count as generic insider activity (Form 4 includes both buys AND sells)
      buys30d++;
    }

    // Score adjustment is conservative since we cannot distinguish buys from sells
    // without parsing filing XML. High activity is still a useful signal (insiders are active).
    let scoreAdjustment = 0;
    let reason = '';

    if (buys30d >= 5) {
      scoreAdjustment = 10; // Reduced from 15 — may include sells
      reason = `인사이더 활동 활발 (Form 4 ${buys30d}건/30일, 매수+매도 혼합)`;
    } else if (buys30d >= 3) {
      scoreAdjustment = 5; // Reduced from 10 — may include sells
      reason = `인사이더 매매 ${buys30d}건/30일 (매수+매도 미분류)`;
    } else if (buys30d >= 1) {
      scoreAdjustment = 3; // Reduced from 5 — may include sells
      reason = `인사이더 매매 ${buys30d}건/30일 (매수+매도 미분류)`;
    } else {
      scoreAdjustment = 0;
      reason = `인사이더 매매 없음`;
    }

    return {
      ticker: ticker.toUpperCase(),
      cik,
      buys30d,
      sells30d,
      netBuyValueUsd,
      largestBuyUsd,
      recentBuyers: [...recentBuyers],
      scoreAdjustment,
      reason,
    };
  } catch (e) {
    logger.debug(`SEC ${ticker} 조회 실패: ${(e as Error).message}`, { component: COMP });
    return null;
  }
}

/** 배치 조회 — 여러 ticker 인사이더 신호 동시 수집 */
export async function getBatchInsiderSignals(tickers: string[]): Promise<Map<string, InsiderSignal>> {
  const result = new Map<string, InsiderSignal>();
  // SEC rate limit: 10 req/sec 권장. 5개씩 직렬 처리
  const chunkSize = 5;
  for (let i = 0; i < tickers.length; i += chunkSize) {
    const chunk = tickers.slice(i, i + chunkSize);
    const signals = await Promise.all(chunk.map((t) => getInsiderSignal(t).catch(() => null)));
    for (let j = 0; j < chunk.length; j++) {
      const sig = signals[j];
      if (sig) result.set(chunk[j].toUpperCase(), sig);
    }
    // chunk 사이 200ms 쿨다운 (rate limit 안전 마진)
    if (i + chunkSize < tickers.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return result;
}
