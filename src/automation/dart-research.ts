/**
 * DART 재무제표 조회 + Gemini AI 분석 (GCP Vertex AI 크레딧 활용)
 *
 * - DART Open API: 재무제표(fnlttSinglAcnt), 기업정보(company), 공시목록(list)
 * - Vertex AI Gemini: 재무 데이터 자연어 분석 → 투자 인사이트 생성
 * - 결과: Track A fundamental_score 강화 + 퀀트 리서치 봇 표시
 */

import { callVertexGemini } from '../utils/vertex-gemini.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

const COMP = 'DART_RESEARCH';
const DART_BASE = 'https://opendart.fss.or.kr/api';

// 24시간 결과 캐시 — Track A 반복 호출 + DART API rate limit 보호
const _resultCache = new Map<string, { result: DartResearchResult; fetchedAt: number }>();
const RESULT_CACHE_TTL_MS = 24 * 60 * 60_000;

// ── Types ──

export interface FinancialStatement {
  stockCode: string;
  corpName: string;
  year: string;
  quarter: 'annual' | 'h1' | 'q1' | 'q3';
  revenue: number;             // 매출액 (원)
  revenueYoy: number;          // 매출 YoY 증감률 (%)
  operatingIncome: number;     // 영업이익 (원)
  operatingIncomeYoy: number;  // 영업이익 YoY 증감률 (%)
  operatingMargin: number;     // 영업이익률 (%)
  netIncome: number;           // 당기순이익 (원)
  totalAssets: number;         // 자산총계 (원)
  totalDebt: number;           // 부채총계 (원)
  debtRatio: number;           // 부채비율 (%)
  fetchedAt: string;
}

export interface DartResearchResult {
  stockCode: string;
  corpName: string;
  financial?: FinancialStatement;
  aiAnalysis?: string;         // Gemini 분석 텍스트
  fundamentalScore?: number;   // AI 판단 기본적 점수 (0~100)
  keyRisks: string[];
  keyStrengths: string[];
  analyzedAt: string;
}

interface DartCompanyInfo {
  status: string;
  corp_code: string;
  corp_name: string;
  stock_code: string;
}

interface DartFinancialRow {
  sj_div: string;     // IS=손익, BS=재무상태
  account_nm: string; // 계정명
  thstrm_amount: string; // 당기
  frmtrm_amount: string; // 전기
}

// ── Corp Code 동적 조회 (캐시) ──

const _corpCodeCache = new Map<string, string>(); // stockCode → corpCode

async function getCorpCode(apiKey: string, stockCode: string): Promise<string | null> {
  if (_corpCodeCache.has(stockCode)) return _corpCodeCache.get(stockCode)!;

  // 하드코딩 fallback (주요 종목 — dart-monitor.ts와 동기화)
  const HARDCODED: Record<string, string> = {
    '005930': '00126380', '000660': '00164779', '373220': '01620944',
    '005380': '00164742', '009540': '00164785', '035420': '00401731',
    '035720': '00258801', '006400': '00126362', '051910': '00356361',
    '003670': '00140108', '012450': '00156360', '000270': '00164518',
    '207940': '00935937', '105560': '00164902', '055550': '00131781',
    '086790': '00148643', '316140': '00185610', '064350': '00112055',
    '034020': '00159591', '047810': '00131016',
  };
  if (HARDCODED[stockCode]) {
    _corpCodeCache.set(stockCode, HARDCODED[stockCode]);
    return HARDCODED[stockCode];
  }

  try {
    const url = `${DART_BASE}/company.json?crtfc_key=${apiKey}&stock_code=${stockCode}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = (await res.json()) as DartCompanyInfo;
    if (data.status === '000' && data.corp_code) {
      _corpCodeCache.set(stockCode, data.corp_code);
      return data.corp_code;
    }
    return null;
  } catch {
    return null;
  }
}

// ── 재무제표 파싱 유틸 ──

function parseAmount(raw: string | undefined): number {
  if (!raw) return 0;
  return Number(raw.replace(/,/g, '').trim()) || 0;
}

function calcYoy(current: number, prev: number): number {
  if (prev === 0) return 0;
  return Math.round(((current - prev) / Math.abs(prev)) * 1000) / 10; // 소수점 1자리
}

// reprt_code: 11011=사업보고서(연간), 11012=반기, 11013=1분기, 11014=3분기
const REPRT_CODE: Record<string, string> = {
  annual: '11011', h1: '11012', q1: '11013', q3: '11014',
};

// ── 재무제표 조회 ──

async function fetchFinancialStatement(
  apiKey: string,
  corpCode: string,
  stockCode: string,
  corpName: string,
  year: string,
  quarter: 'annual' | 'h1' | 'q1' | 'q3' = 'annual',
): Promise<FinancialStatement | null> {
  try {
    const url = `${DART_BASE}/fnlttSinglAcnt.json?crtfc_key=${apiKey}&corp_code=${corpCode}&bsns_year=${year}&reprt_code=${REPRT_CODE[quarter]}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;

    const data = (await res.json()) as { status: string; list?: DartFinancialRow[] };
    if (data.status !== '000' || !data.list?.length) return null;

    const rows = data.list;

    // 손익계산서 (IS)
    const find = (sj: string, name: string) =>
      rows.find((r) => r.sj_div === sj && r.account_nm.includes(name));

    const revRow = find('IS', '매출액') ?? find('IS', '수익(매출액)');
    const opRow = find('IS', '영업이익');
    const netRow = find('IS', '당기순이익') ?? find('IS', '분기순이익');

    // 재무상태표 (BS)
    const assetRow = find('BS', '자산총계');
    const debtRow = find('BS', '부채총계');

    const revenue = parseAmount(revRow?.thstrm_amount);
    const revenuePrev = parseAmount(revRow?.frmtrm_amount);
    const operatingIncome = parseAmount(opRow?.thstrm_amount);
    const operatingIncomePrev = parseAmount(opRow?.frmtrm_amount);
    const netIncome = parseAmount(netRow?.thstrm_amount);
    const totalAssets = parseAmount(assetRow?.thstrm_amount);
    const totalDebt = parseAmount(debtRow?.thstrm_amount);
    const equity = totalAssets - totalDebt;
    const debtRatio = equity > 0 ? Math.round((totalDebt / equity) * 100) : 0;

    return {
      stockCode,
      corpName,
      year,
      quarter,
      revenue,
      revenueYoy: calcYoy(revenue, revenuePrev),
      operatingIncome,
      operatingIncomeYoy: calcYoy(operatingIncome, operatingIncomePrev),
      operatingMargin: revenue > 0 ? Math.round((operatingIncome / revenue) * 1000) / 10 : 0,
      netIncome,
      totalAssets,
      totalDebt,
      debtRatio,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn(`DART 재무제표 조회 실패 (${stockCode}/${year}): ${err}`, { component: COMP });
    return null;
  }
}

// ── Gemini AI 분석 ──

const ANALYSIS_SYSTEM = `당신은 한국 주식시장 전문 퀀트 애널리스트입니다.
제공된 재무 데이터를 바탕으로 투자 판단에 필요한 핵심 분석을 제공하세요.

출력 형식 (JSON만, 코드블록 없이):
{
  "fundamentalScore": 0~100,
  "summary": "3줄 이내 핵심 요약",
  "strengths": ["강점1", "강점2"],
  "risks": ["리스크1", "리스크2"],
  "verdict": "BUY|HOLD|SELL",
  "targetMultiple": 예상 PER배수 (숫자)
}

기준:
- 영업이익 YoY +20%+ → fundamentalScore +20
- 영업이익률 15%+ → fundamentalScore +10
- 부채비율 100% 이하 → fundamentalScore +10
- 영업이익 YoY 마이너스 → fundamentalScore -20
- 영업손실 → fundamentalScore -40
기본 50점에서 가감`;

async function analyzeWithGemini(
  financial: FinancialStatement,
  additionalContext?: string,
): Promise<{ score: number; analysis: string; strengths: string[]; risks: string[] } | null> {
  const amtFmt = (n: number) =>
    n >= 1e12 ? `${(n / 1e12).toFixed(1)}조` : n >= 1e8 ? `${(n / 1e8).toFixed(0)}억` : `${Math.round(n / 1e6)}백만`;

  const userMsg = `## ${financial.corpName} (${financial.stockCode}) — ${financial.year}년 ${financial.quarter === 'annual' ? '연간' : financial.quarter === 'h1' ? '상반기' : financial.quarter === 'q1' ? '1분기' : '3분기'} 재무제표

- 매출액: ${amtFmt(financial.revenue)} (YoY ${financial.revenueYoy > 0 ? '+' : ''}${financial.revenueYoy}%)
- 영업이익: ${amtFmt(financial.operatingIncome)} (YoY ${financial.operatingIncomeYoy > 0 ? '+' : ''}${financial.operatingIncomeYoy}%, 마진 ${financial.operatingMargin}%)
- 당기순이익: ${amtFmt(financial.netIncome)}
- 자산총계: ${amtFmt(financial.totalAssets)}
- 부채비율: ${financial.debtRatio}%
${additionalContext ? `\n## 추가 컨텍스트\n${additionalContext.slice(0, 1500)}` : ''}

위 재무 데이터를 분석하여 JSON으로 응답하세요.`;

  try {
    const text = await callVertexGemini(ANALYSIS_SYSTEM, userMsg, {
      label: `dart-research:${financial.stockCode}`,
      useVertex: true, // GCP 크레딧 직접 사용
      temperature: 0.2,
      maxOutputTokens: 1024,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as {
      fundamentalScore?: number;
      summary?: string;
      strengths?: string[];
      risks?: string[];
    };

    return {
      score: Math.max(0, Math.min(100, Number(parsed.fundamentalScore ?? 50))),
      analysis: parsed.summary ?? '',
      strengths: parsed.strengths ?? [],
      risks: parsed.risks ?? [],
    };
  } catch (err) {
    logger.warn(`Gemini 분석 실패 (${financial.stockCode}): ${err}`, { component: COMP });
    return null;
  }
}

// ── 메인: 종목 리서치 실행 ──

export async function runDartResearch(
  stockCode: string,
  options?: {
    year?: string;
    quarter?: 'annual' | 'h1' | 'q1' | 'q3';
    additionalContext?: string;
  },
): Promise<DartResearchResult> {
  const apiKey = process.env.DART_API_KEY;
  const year = options?.year ?? String(new Date().getFullYear() - (new Date().getMonth() < 3 ? 1 : 0));
  const quarter = options?.quarter ?? 'annual';
  const cacheKey = `${stockCode}-${year}-${quarter}`;

  // 24시간 캐시 — 재무제표는 매일 변하지 않음
  const cached = _resultCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < RESULT_CACHE_TTL_MS) {
    logger.debug(`DART 캐시 히트: ${cacheKey}`, { component: COMP });
    return cached.result;
  }

  const base: DartResearchResult = {
    stockCode,
    corpName: stockCode,
    keyRisks: [],
    keyStrengths: [],
    analyzedAt: new Date().toISOString(),
  };

  if (!apiKey) {
    logger.warn('DART_API_KEY 미설정', { component: COMP });
    return base;
  }

  const corpCode = await getCorpCode(apiKey, stockCode);
  if (!corpCode) {
    logger.warn(`corp_code 조회 실패: ${stockCode}`, { component: COMP });
    return base;
  }

  // 재무제표 조회
  const financial = await fetchFinancialStatement(apiKey, corpCode, stockCode, base.corpName, year, quarter);
  if (financial) {
    base.corpName = financial.corpName;
    base.financial = financial;
    logger.info(`DART 재무 조회 완료: ${financial.corpName} ${year}년 영업이익 ${financial.operatingIncomeYoy > 0 ? '+' : ''}${financial.operatingIncomeYoy}%`, { component: COMP });
  }

  // Gemini 분석 (재무 데이터 있을 때만)
  if (financial) {
    const geminiResult = await analyzeWithGemini(financial, options?.additionalContext);
    if (geminiResult) {
      base.aiAnalysis = geminiResult.analysis;
      base.fundamentalScore = geminiResult.score;
      base.keyStrengths = geminiResult.strengths;
      base.keyRisks = geminiResult.risks;
    }
  }

  _resultCache.set(cacheKey, { result: base, fetchedAt: Date.now() });
  return base;
}

// ── 배치: 다수 종목 순차 분석 ──

export async function runDartResearchBatch(
  stockCodes: string[],
  options?: { year?: string; quarter?: 'annual' | 'h1' | 'q1' | 'q3' },
): Promise<DartResearchResult[]> {
  const results: DartResearchResult[] = [];
  for (const code of stockCodes) {
    const result = await runDartResearch(code, options);
    results.push(result);
    await sleep(800); // DART API rate limit 대응
  }
  return results;
}
