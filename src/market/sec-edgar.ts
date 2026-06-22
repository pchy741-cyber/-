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
    let sells30d = 0;
    let netBuyValueUsd = 0;
    let largestBuyUsd = 0;
    const recentBuyers = new Set<string>();

    // Form 4 filing 수집 (최대 100개 검사, 30일 내)
    const form4Filings: { accession: string; date: string }[] = [];
    const maxCheck = Math.min(100, recent.form.length);
    for (let i = 0; i < maxCheck; i++) {
      if (recent.form[i] !== '4') continue;
      const fDate = recent.filingDate?.[i];
      if (!fDate) continue;
      if (new Date(fDate).getTime() < cutoffMs) break;
      const acc = recent.accessionNumber?.[i];
      if (acc) form4Filings.push({ accession: acc, date: fDate });
    }

    // Form 4 XML 파싱 (최대 10건 — SEC rate limit 보호)
    const toParse = form4Filings.slice(0, 10);
    for (const f of toParse) {
      try {
        const parsed = await parseForm4Xml(cik, f.accession);
        if (!parsed) continue;
        for (const tx of parsed.transactions) {
          if (tx.code === 'P') {
            buys30d++;
            netBuyValueUsd += tx.valueUsd;
            if (tx.valueUsd > largestBuyUsd) largestBuyUsd = tx.valueUsd;
          } else if (tx.code === 'S') {
            sells30d++;
            netBuyValueUsd -= tx.valueUsd;
          }
          // A(grant), M(exercise), G(gift) 등은 무시
        }
        if (parsed.officerTitle) recentBuyers.add(parsed.officerTitle);
      } catch { /* 개별 filing 파싱 실패 → 스킵 */ }
      await new Promise((r) => setTimeout(r, 120)); // SEC rate limit
    }

    // 미파싱 filing은 활동 건수만 추가 (보수적)
    const unparsedCount = form4Filings.length - toParse.length;

    let scoreAdjustment = 0;
    let reason = '';
    const totalActivity = buys30d + sells30d + unparsedCount;

    if (buys30d >= 3 && netBuyValueUsd >= 1_000_000) {
      scoreAdjustment = 15;
      reason = `인사이더 대규모 매수 ${buys30d}건 ($${(netBuyValueUsd / 1e6).toFixed(1)}M, ${[...recentBuyers].join('/')})`;
    } else if (buys30d >= 3) {
      scoreAdjustment = 10;
      reason = `인사이더 매수 ${buys30d}건 ($${Math.round(netBuyValueUsd / 1000)}K)`;
    } else if (buys30d >= 1) {
      scoreAdjustment = 5;
      reason = `인사이더 매수 ${buys30d}건 ($${Math.round(netBuyValueUsd / 1000)}K)`;
    } else if (sells30d >= 3) {
      scoreAdjustment = -5;
      reason = `인사이더 매도 ${sells30d}건 (경고)`;
    } else if (totalActivity >= 1) {
      scoreAdjustment = 2;
      reason = `인사이더 활동 ${totalActivity}건 (매수${buys30d}/매도${sells30d})`;
    } else {
      reason = '인사이더 매매 없음';
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

// ── Form 4 XML 파서 ──

interface Form4Transaction {
  code: string; // P=purchase, S=sale, A=award, M=exercise, G=gift
  shares: number;
  pricePerShare: number;
  valueUsd: number;
}

interface Form4Parsed {
  officerTitle: string;
  transactions: Form4Transaction[];
}

function extractXmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
  return re.exec(xml)?.[1]?.trim() ?? '';
}

function extractAllBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
  return xml.match(re) ?? [];
}

async function parseForm4Xml(cik: string, accessionRaw: string): Promise<Form4Parsed | null> {
  // accession: "0001234567-24-001234" → "000123456724001234"
  const accNoDash = accessionRaw.replace(/-/g, '');
  const url = `${SEC_BASE}/Archives/edgar/data/${cik.replace(/^0+/, '')}/${accNoDash}/${accessionRaw}.txt`;
  const res = await fetch(url, {
    headers: { 'User-Agent': SEC_UA, Accept: 'text/xml' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const xml = await res.text();

  const officerTitle = extractXmlTag(xml, 'officerTitle');
  const txBlocks = extractAllBlocks(xml, 'nonDerivativeTransaction');
  const transactions: Form4Transaction[] = [];

  for (const block of txBlocks) {
    const code = extractXmlTag(block, 'transactionCode');
    if (!code) continue;
    const shares = Math.abs(Number(extractXmlTag(block, 'transactionShares') || extractXmlTag(block, 'value')) || 0);
    const price = Number(extractXmlTag(block, 'transactionPricePerShare') || extractXmlTag(block, 'value')) || 0;
    const valueUsd = shares * price;
    if (shares > 0) {
      transactions.push({ code, shares, pricePerShare: price, valueUsd });
    }
  }

  return { officerTitle, transactions };
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
