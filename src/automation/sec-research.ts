/**
 * SEC EDGAR 재무제표 (10-K/10-Q) + Gemini AI 분석
 *
 * - SEC XBRL API: 무료, 인증 불필요 (User-Agent만 필수)
 * - 데이터: Revenue, Operating Income, Net Income, Total Assets, Debt 등
 * - Gemini: GCP Vertex AI 크레딧으로 분석 → fundamentalScore (0-100)
 * - 24시간 캐시 (재무제표는 매일 변하지 않음)
 * - 실전/연습 공통 데이터
 */

import { callVertexGemini } from '../utils/vertex-gemini.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

const COMP = 'SEC_RESEARCH';
const SEC_BASE = 'https://data.sec.gov';
const SEC_UA = process.env.SEC_USER_AGENT ?? 'QuantOps quantops-trading@proscom-hr.com';

// 24시간 결과 캐시
const _resultCache = new Map<string, { result: SecResearchResult; fetchedAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60_000;

// ── Types ──

export interface USFinancialStatement {
  ticker: string;
  companyName: string;
  year: number;
  quarter: 'annual' | 'Q1' | 'Q2' | 'Q3' | 'Q4';
  revenue: number;
  revenueYoy: number;
  operatingIncome: number;
  operatingIncomeYoy: number;
  operatingMargin: number;
  netIncome: number;
  totalAssets: number;
  totalLiabilities: number;
  debtRatio: number;
  eps: number;
  fetchedAt: string;
}

export interface SecResearchResult {
  ticker: string;
  companyName: string;
  financial?: USFinancialStatement;
  aiAnalysis?: string;
  fundamentalScore?: number;
  keyRisks: string[];
  keyStrengths: string[];
  analyzedAt: string;
}

// ── CIK 캐시 (sec-edgar.ts와 공유 패턴) ──

interface CikMap { [ticker: string]: string }
let _cikCache: CikMap | null = null;
let _cikFetchedAt = 0;

async function getCik(ticker: string): Promise<string | null> {
  if (!_cikCache || Date.now() - _cikFetchedAt > 7 * 24 * 60 * 60_000) {
    try {
      const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
        headers: { 'User-Agent': SEC_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, { ticker: string; cik_str: number; title: string }>;
      const map: CikMap = {};
      for (const v of Object.values(data)) {
        map[v.ticker] = String(v.cik_str).padStart(10, '0');
      }
      _cikCache = map;
      _cikFetchedAt = Date.now();
    } catch (e) {
      logger.warn(`SEC CIK 맵 실패: ${(e as Error).message}`, { component: COMP });
      if (!_cikCache) return null;
    }
  }
  return _cikCache?.[ticker.toUpperCase()] ?? null;
}

// ── SEC XBRL API에서 재무제표 추출 ──

interface XbrlFact {
  val: number;
  end: string;     // "2024-12-31"
  fy: number;      // fiscal year
  fp: string;      // "FY", "Q1", "Q2", "Q3", "Q4"
  form: string;    // "10-K", "10-Q"
}

async function fetchCompanyFacts(cik: string): Promise<Record<string, XbrlFact[]> | null> {
  try {
    const url = `${SEC_BASE}/api/xbrl/companyfacts/CIK${cik}.json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': SEC_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      entityName?: string;
      facts?: { 'us-gaap'?: Record<string, { units?: Record<string, XbrlFact[]> }> };
    };
    const gaap = data.facts?.['us-gaap'];
    if (!gaap) return null;

    // 모든 us-gaap concept → USD 단위만 추출
    const result: Record<string, XbrlFact[]> & { _entityName?: string } = {};
    (result as any)._entityName = data.entityName ?? '';
    for (const [concept, info] of Object.entries(gaap)) {
      const usd = info.units?.['USD'];
      if (usd && usd.length > 0) {
        result[concept] = usd;
      }
      // EPS는 USD/shares 단위
      const perShare = info.units?.['USD/shares'];
      if (perShare && perShare.length > 0) {
        result[concept] = perShare;
      }
    }
    return result;
  } catch (e) {
    logger.warn(`SEC XBRL 조회 실패 (CIK${cik}): ${(e as Error).message}`, { component: COMP });
    return null;
  }
}

// XBRL concept에서 특정 연도 값 추출 (10-K 우선)
function extractValue(
  facts: Record<string, XbrlFact[]>,
  concepts: string[],
  targetFy: number,
  targetFp = 'FY',
): number | null {
  for (const concept of concepts) {
    const entries = facts[concept];
    if (!entries) continue;
    // 10-K(FY) 또는 10-Q 에서 해당 fiscal year 매칭
    const match = entries
      .filter((e) => e.fy === targetFy && e.fp === targetFp && (targetFp === 'FY' ? e.form === '10-K' : e.form === '10-Q'))
      .sort((a, b) => new Date(b.end).getTime() - new Date(a.end).getTime());
    if (match.length > 0) return match[0].val;
    // form 조건 없이 재시도
    const matchLoose = entries
      .filter((e) => e.fy === targetFy && e.fp === targetFp)
      .sort((a, b) => new Date(b.end).getTime() - new Date(a.end).getTime());
    if (matchLoose.length > 0) return matchLoose[0].val;
  }
  return null;
}

function buildFinancial(
  ticker: string,
  companyName: string,
  facts: Record<string, XbrlFact[]>,
  targetFy: number,
): USFinancialStatement | null {
  const rev = extractValue(facts, [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
  ], targetFy);
  const opInc = extractValue(facts, ['OperatingIncomeLoss'], targetFy);
  const netInc = extractValue(facts, ['NetIncomeLoss', 'ProfitLoss'], targetFy);
  const totalAssets = extractValue(facts, ['Assets'], targetFy);
  const totalLiab = extractValue(facts, ['Liabilities', 'LiabilitiesAndStockholdersEquity'], targetFy);
  const eps = extractValue(facts, ['EarningsPerShareBasic', 'EarningsPerShareDiluted'], targetFy);

  // 최소 매출 + 총자산 필요
  if (rev == null && totalAssets == null) return null;

  // YoY 계산 (전년도)
  const prevRev = extractValue(facts, [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
  ], targetFy - 1);
  const prevOpInc = extractValue(facts, ['OperatingIncomeLoss'], targetFy - 1);

  const revenueYoy = rev && prevRev && prevRev !== 0 ? Math.round(((rev - prevRev) / Math.abs(prevRev)) * 1000) / 10 : 0;
  const opIncYoy = opInc != null && prevOpInc != null && prevOpInc !== 0
    ? Math.round(((opInc - prevOpInc) / Math.abs(prevOpInc)) * 1000) / 10 : 0;

  // Liabilities 조정 — LiabilitiesAndStockholdersEquity가 아닌 실제 Liabilities 추출
  let actualLiab = totalLiab ?? 0;
  if (totalLiab != null && totalAssets != null && totalLiab > totalAssets) {
    // LiabilitiesAndStockholdersEquity → 실제 Liabilities = totalAssets - equity
    const equity = extractValue(facts, ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'], targetFy);
    if (equity != null) actualLiab = (totalAssets ?? 0) - equity;
  }

  return {
    ticker,
    companyName,
    year: targetFy,
    quarter: 'annual',
    revenue: rev ?? 0,
    revenueYoy,
    operatingIncome: opInc ?? 0,
    operatingIncomeYoy: opIncYoy,
    operatingMargin: rev && rev > 0 && opInc != null ? Math.round((opInc / rev) * 1000) / 10 : 0,
    netIncome: netInc ?? 0,
    totalAssets: totalAssets ?? 0,
    totalLiabilities: actualLiab,
    debtRatio: totalAssets && totalAssets > 0 ? Math.round((actualLiab / totalAssets) * 1000) / 10 : 0,
    eps: eps ?? 0,
    fetchedAt: new Date().toISOString(),
  };
}

// ── Gemini AI 분석 ──

const ANALYSIS_SYSTEM = `You are a US stock market quant analyst.
Analyze the financial data and respond in Korean with JSON only (no code blocks):
{
  "fundamentalScore": 0~100,
  "summary": "3줄 이내 핵심 요약 (한국어)",
  "strengths": ["강점1", "강점2"],
  "risks": ["리스크1", "리스크2"],
  "verdict": "BUY|HOLD|SELL"
}

Scoring:
- Operating Income YoY +20%+ → +20 points
- Operating Margin 15%+ → +10 points
- Debt Ratio ≤50% → +10 points
- Operating Income YoY negative → -20 points
- Operating Loss → -40 points
Base 50 points, adjust from there.`;

async function analyzeWithGemini(
  financial: USFinancialStatement,
): Promise<{ score: number; analysis: string; strengths: string[]; risks: string[] } | null> {
  const fmtB = (n: number) => {
    const b = n / 1e9;
    if (Math.abs(b) >= 1) return `$${b.toFixed(1)}B`;
    return `$${(n / 1e6).toFixed(0)}M`;
  };

  const userMsg = `## ${financial.companyName} (${financial.ticker}) — FY${financial.year} Annual Financials

- Revenue: ${fmtB(financial.revenue)} (YoY ${financial.revenueYoy > 0 ? '+' : ''}${financial.revenueYoy}%)
- Operating Income: ${fmtB(financial.operatingIncome)} (YoY ${financial.operatingIncomeYoy > 0 ? '+' : ''}${financial.operatingIncomeYoy}%, margin ${financial.operatingMargin}%)
- Net Income: ${fmtB(financial.netIncome)}
- Total Assets: ${fmtB(financial.totalAssets)}
- Debt Ratio: ${financial.debtRatio}%
- EPS: $${financial.eps.toFixed(2)}

위 재무 데이터를 분석하여 JSON으로 응답하세요.`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await callVertexGemini(ANALYSIS_SYSTEM, userMsg, {
        label: `sec-research:${financial.ticker}`,
        grounded: true,
        temperature: attempt === 0 ? 0.2 : 0.5,
        maxOutputTokens: 4096,
      });

      const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        if (attempt === 0) { await sleep(1000); continue; }
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        fundamentalScore?: number;
        summary?: string;
        strengths?: string[];
        risks?: string[];
      };

      logger.info(`SEC Gemini 분석 완료 (${financial.ticker}): score=${parsed.fundamentalScore}`, { component: COMP });

      return {
        score: Math.max(0, Math.min(100, Number(parsed.fundamentalScore ?? 50))),
        analysis: parsed.summary ?? '',
        strengths: parsed.strengths ?? [],
        risks: parsed.risks ?? [],
      };
    } catch (err) {
      logger.warn(`SEC Gemini 실패 (${financial.ticker}) attempt=${attempt}: ${err}`, { component: COMP });
      if (attempt === 0) { await sleep(1000); continue; }
      return null;
    }
  }
  return null;
}

// ── 메인: 종목 리서치 실행 ──

export async function runSecResearch(ticker: string): Promise<SecResearchResult> {
  const now = new Date();
  // 10-K는 보통 2~3월 제출 → 6월 이전이면 2년 전, 이후면 전년도
  const targetFy = now.getMonth() < 5 ? now.getFullYear() - 2 : now.getFullYear() - 1;
  const cacheKey = `${ticker.toUpperCase()}-${targetFy}`;

  const cached = _resultCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    logger.debug(`SEC 캐시 히트: ${cacheKey}`, { component: COMP });
    return cached.result;
  }

  const base: SecResearchResult = {
    ticker: ticker.toUpperCase(),
    companyName: ticker.toUpperCase(),
    keyRisks: [],
    keyStrengths: [],
    analyzedAt: new Date().toISOString(),
  };

  const cik = await getCik(ticker);
  if (!cik) {
    logger.warn(`SEC CIK 없음: ${ticker}`, { component: COMP });
    return base;
  }

  const facts = await fetchCompanyFacts(cik);
  if (!facts) {
    logger.warn(`SEC XBRL 데이터 없음: ${ticker} (CIK${cik})`, { component: COMP });
    return base;
  }

  const entityName = (facts as any)._entityName ?? ticker.toUpperCase();
  base.companyName = entityName;

  const financial = buildFinancial(ticker.toUpperCase(), entityName, facts, targetFy);
  if (financial) {
    base.financial = financial;
    logger.info(
      `SEC 재무 조회 완료: ${entityName} FY${targetFy} 매출 ${financial.revenueYoy > 0 ? '+' : ''}${financial.revenueYoy}% 영업이익률 ${financial.operatingMargin}%`,
      { component: COMP },
    );

    const geminiResult = await analyzeWithGemini(financial);
    if (geminiResult) {
      base.aiAnalysis = geminiResult.analysis;
      base.fundamentalScore = geminiResult.score;
      base.keyStrengths = geminiResult.strengths;
      base.keyRisks = geminiResult.risks;
    }
  } else {
    logger.warn(`SEC 재무 데이터 파싱 불가: ${ticker} FY${targetFy}`, { component: COMP });
  }

  _resultCache.set(cacheKey, { result: base, fetchedAt: Date.now() });
  return base;
}

// ── 배치: 다수 종목 순차 분석 ──

/**
 * 캐시된 SEC fundamentalScore 반환 (해외 매매 파이프라인용)
 * 0~100 점수 → 매수 정렬 및 필터에 사용
 * 캐시 미스 시 undefined (리서치 미실행 종목)
 */
export function getCachedSecFundamentalScore(ticker: string): number | undefined {
  const upperTicker = ticker.toUpperCase();
  for (const [key, entry] of _resultCache) {
    if (key.startsWith(`${upperTicker}-`) && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
      return entry.result.fundamentalScore;
    }
  }
  return undefined;
}

export async function runSecResearchBatch(tickers: string[]): Promise<SecResearchResult[]> {
  const results: SecResearchResult[] = [];
  for (const ticker of tickers) {
    const result = await runSecResearch(ticker);
    results.push(result);
    await sleep(300); // SEC rate limit (10 req/sec)
  }
  return results;
}
