/**
 * DART 재무제표 조회 + Gemini AI 분석 (무료 AI Studio 활용)
 *
 * - DART Open API: 재무제표(fnlttSinglAcnt), 기업정보(company), 공시목록(list)
 * - Gemini AI Studio (무료): 재무 데이터 자연어 분석 → 투자 인사이트 생성
 * - 결과: Track A fundamental_score 강화 + 퀀트 리서치 봇 표시
 */

import { callVertexGemini } from '../utils/vertex-gemini.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { calcPiotroskiFScore } from './piotroski.js';
import { getPool } from '../db/client.js';

const COMP = 'DART_RESEARCH';
const DART_BASE = 'https://opendart.fss.or.kr/api';

// 24시간 인메모리 캐시 — Track A 반복 호출 + DART API rate limit 보호 (성능)
const _resultCache = new Map<string, { result: DartResearchResult; fetchedAt: number }>();
const RESULT_CACHE_TTL_MS = 24 * 60 * 60_000;
const RESULT_CACHE_MAX = 300; // v16.2: 메모리 누수 방지

// v16.2: 만료 엔트리 정리 (6시간마다)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _resultCache) {
    if (now - entry.fetchedAt >= RESULT_CACHE_TTL_MS) _resultCache.delete(key);
  }
  if (_resultCache.size > RESULT_CACHE_MAX) _resultCache.clear();
}, 6 * 60 * 60_000).unref();

// ── DB 캐시: 분기별 결과 영구 저장 (재시작/재배포 생존) ──

/** 현재 분기 계산 */
function getCurrentQuarter(): { year: string; quarter: string } {
  const now = new Date();
  const m = now.getMonth(); // 0-indexed
  // 가장 최근 공시된 분기 (공시 lag 감안)
  if (m < 5) return { year: String(now.getFullYear() - 1), quarter: 'annual' };
  if (m < 8) return { year: String(now.getFullYear()), quarter: 'q1' };
  if (m < 11) return { year: String(now.getFullYear()), quarter: 'h1' };
  return { year: String(now.getFullYear()), quarter: 'q3' };
}

/** DB 캐시에서 분기별 결과 조회 */
async function getDbCachedResult(stockCode: string, year: string, quarter: string): Promise<DartResearchResult | null> {
  try {
    const { rows } = await getPool().query(
      `SELECT result FROM dart_research_cache WHERE stock_code = $1 AND year = $2 AND quarter = $3`,
      [stockCode, year, quarter],
    );
    if (rows[0]?.result) {
      logger.debug(`DART DB캐시 히트: ${stockCode}/${year}/${quarter}`, { component: COMP });
      return rows[0].result as DartResearchResult;
    }
  } catch { /* DB 없으면 무시 (마이그레이션 전) */ }
  return null;
}

/** DB 캐시에 결과 UPSERT */
async function upsertDbCache(stockCode: string, year: string, quarter: string, result: DartResearchResult): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO dart_research_cache (stock_code, year, quarter, result, fundamental_score, piotroski_score)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (stock_code, year, quarter)
       DO UPDATE SET result = $4, fundamental_score = $5, piotroski_score = $6, analyzed_at = NOW()`,
      [stockCode, year, quarter, JSON.stringify(result), result.fundamentalScore ?? null, result.piotroskiScore ?? null],
    );
  } catch (e) {
    logger.debug(`DART DB캐시 저장 실패 (무시): ${e}`, { component: COMP });
  }
}

/**
 * 스마트 DART 분석 타겟 선택 — DB캐시 미스 종목만 필터
 * 동일 분기 이미 분석된 종목은 재분석 불필요
 */
export async function getSmartDartTargets(allCodes: string[], limit: number): Promise<string[]> {
  const { year, quarter } = getCurrentQuarter();
  try {
    const { rows } = await getPool().query(
      `SELECT stock_code FROM dart_research_cache WHERE year = $1 AND quarter = $2 AND stock_code = ANY($3)`,
      [year, quarter, allCodes],
    );
    const cached = new Set(rows.map((r: { stock_code: string }) => r.stock_code));
    return allCodes.filter((c) => !cached.has(c)).slice(0, limit);
  } catch {
    // DB 미사용 시 전체 반환 (기존 동작 호환)
    return allCodes.slice(0, limit);
  }
}

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
  // Piotroski F-Score 추가 필드 (DART API에서 파싱, 없으면 undefined)
  operatingCashFlow?: number;  // 영업활동현금흐름 (원) — CF
  currentAssets?: number;      // 유동자산 (원) — BS
  currentLiabilities?: number; // 유동부채 (원) — BS
  equity?: number;             // 자본총계 (원) — BS
  grossProfit?: number;        // 매출총이익 (원) — IS
  fetchedAt: string;
}

export interface DartResearchResult {
  stockCode: string;
  corpName: string;
  financial?: FinancialStatement;
  aiAnalysis?: string;         // Gemini 분석 텍스트
  fundamentalScore?: number;   // AI 판단 기본적 점수 (0~100)
  piotroskiScore?: number;     // Piotroski F-Score (0~9)
  keyRisks: string[];
  keyStrengths: string[];
  analyzedAt: string;
}

interface DartFinancialRow {
  sj_div: string;     // IS=손익, BS=재무상태, CF=현금흐름
  account_nm: string; // 계정명
  thstrm_amount: string; // 당기
  frmtrm_amount: string; // 전기
}

// ── Corp Code 동적 조회 (corpCode.xml ZIP 다운로드 → 전체 매핑) ──

const _corpCodeCache = new Map<string, string>(); // stockCode → corpCode
let _corpCodeLoaded = false;
let _corpCodeLoadingPromise: Promise<void> | null = null;

/** DART corpCode.xml ZIP 다운로드 → stockCode→corpCode 매핑 캐시 (24시간 유효) */
async function loadCorpCodeMap(apiKey: string): Promise<void> {
  if (_corpCodeLoaded && _corpCodeCache.size > 100) return;
  if (_corpCodeLoadingPromise) return _corpCodeLoadingPromise;

  _corpCodeLoadingPromise = (async () => {
    try {
      // 하드코딩 fallback (ZIP 다운로드 실패 시에도 주요 종목은 동작)
      const HARDCODED: Record<string, string> = {
        '005930': '00126380', '000660': '00164779', '373220': '01620944',
        '005380': '00164742', '009540': '00164785', '035420': '00401731',
        '035720': '00258801', '006400': '00126362', '051910': '00356361',
        '003670': '00140108', '012450': '00156360', '000270': '00164518',
        '207940': '00935937', '105560': '00164902', '055550': '00131781',
        '086790': '00148643', '316140': '00185610', '064350': '00112055',
        '034020': '00159591', '047810': '00131016',
      };
      for (const [sc, cc] of Object.entries(HARDCODED)) _corpCodeCache.set(sc, cc);

      const url = `${DART_BASE}/corpCode.xml?crtfc_key=${apiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        logger.warn(`DART corpCode.xml HTTP ${res.status}`, { component: COMP });
        _corpCodeLoaded = true;
        return;
      }

      const buffer = await res.arrayBuffer();
      // ZIP 내부의 CORPCODE.xml 파싱 (간이 ZIP 해제 — 단일 파일 ZIP)
      const bytes = new Uint8Array(buffer);
      const xmlStr = await extractXmlFromZip(bytes);
      if (!xmlStr) {
        logger.warn('DART corpCode.xml ZIP 해제 실패', { component: COMP });
        _corpCodeLoaded = true;
        return;
      }

      // XML 파싱: <list><corp_code>00126380</corp_code><stock_code>005930</stock_code>...</list>
      const corpCodeRegex = /<corp_code>(\d+)<\/corp_code>/g;
      const stockCodeRegex = /<stock_code>\s*(\d{6})\s*<\/stock_code>/g;
      const listRegex = /<list>([\s\S]*?)<\/list>/g;
      let match;
      let count = 0;
      while ((match = listRegex.exec(xmlStr)) !== null) {
        const block = match[1];
        const ccMatch = /<corp_code>(\d+)<\/corp_code>/.exec(block);
        const scMatch = /<stock_code>\s*(\d{6})\s*<\/stock_code>/.exec(block);
        if (ccMatch && scMatch) {
          _corpCodeCache.set(scMatch[1], ccMatch[1]);
          count++;
        }
      }
      _corpCodeLoaded = true;
      logger.info(`✅ DART corpCode 매핑 로드: ${count}개 종목 (캐시 총 ${_corpCodeCache.size}개)`, { component: COMP });
    } catch (err) {
      logger.warn(`DART corpCode 매핑 로드 실패: ${err}`, { component: COMP });
      _corpCodeLoaded = true; // 실패해도 재시도 방지 (하드코딩으로 fallback)
    } finally {
      _corpCodeLoadingPromise = null;
    }
  })();
  return _corpCodeLoadingPromise;
}

/** 단일 파일 ZIP에서 XML 텍스트 추출 (간이 구현 — deflate raw) */
async function extractXmlFromZip(zipBytes: Uint8Array): Promise<string | null> {
  try {
    // ZIP local file header: PK\x03\x04 (offset 0)
    if (zipBytes[0] !== 0x50 || zipBytes[1] !== 0x4B) return null;
    const compressionMethod = zipBytes[8] | (zipBytes[9] << 8);
    const compressedSize = zipBytes[18] | (zipBytes[19] << 8) | (zipBytes[20] << 16) | (zipBytes[21] << 24);
    const fileNameLen = zipBytes[26] | (zipBytes[27] << 8);
    const extraLen = zipBytes[28] | (zipBytes[29] << 8);
    const dataOffset = 30 + fileNameLen + extraLen;

    if (compressionMethod === 0) {
      // Stored (비압축)
      const decoder = new TextDecoder('utf-8');
      return decoder.decode(zipBytes.slice(dataOffset, dataOffset + compressedSize));
    } else if (compressionMethod === 8) {
      // Deflate
      const compressed = zipBytes.slice(dataOffset, dataOffset + compressedSize);
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(compressed);
      writer.close();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const totalLen = chunks.reduce((s, c) => s + c.length, 0);
      const result = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      return new TextDecoder('utf-8').decode(result);
    }
    return null;
  } catch (err) {
    logger.warn(`ZIP 해제 오류: ${err}`, { component: COMP });
    return null;
  }
}

async function getCorpCode(apiKey: string, stockCode: string): Promise<string | null> {
  await loadCorpCodeMap(apiKey);
  return _corpCodeCache.get(stockCode) ?? null;
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
    logger.info(`DART 재무제표 요청: ${stockCode}/${year}/${quarter} corp=${corpCode}`, { component: COMP });
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      logger.warn(`DART 재무제표 HTTP ${res.status}: ${stockCode}/${year}`, { component: COMP });
      return null;
    }

    const data = (await res.json()) as { status: string; list?: DartFinancialRow[] };
    if (data.status !== '000' || !data.list?.length) {
      logger.warn(`DART 재무제표 응답 status=${data.status} rows=${data.list?.length ?? 0}: ${stockCode}/${year}`, { component: COMP });
      return null;
    }

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
    const currentAssetsRow = find('BS', '유동자산');
    const currentLiabRow = find('BS', '유동부채');
    const equityRow = find('BS', '자본총계');

    // 손익계산서 추가 (IS)
    const grossProfitRow = find('IS', '매출총이익');

    // 현금흐름표 (CF)
    const cfRow = rows.find(
      (r) => r.sj_div === 'CF' && r.account_nm.includes('영업활동'),
    );

    const revenue = parseAmount(revRow?.thstrm_amount);
    const revenuePrev = parseAmount(revRow?.frmtrm_amount);
    const operatingIncome = parseAmount(opRow?.thstrm_amount);
    const operatingIncomePrev = parseAmount(opRow?.frmtrm_amount);
    const netIncome = parseAmount(netRow?.thstrm_amount);
    const totalAssets = parseAmount(assetRow?.thstrm_amount);
    const totalDebt = parseAmount(debtRow?.thstrm_amount);
    const equityVal = equityRow ? parseAmount(equityRow.thstrm_amount) : totalAssets - totalDebt;
    const debtRatio = equityVal > 0 ? Math.round((totalDebt / equityVal) * 100) : 0;

    // Piotroski 추가 필드 (있으면 파싱, 없으면 undefined)
    const operatingCashFlow = cfRow ? parseAmount(cfRow.thstrm_amount) : undefined;
    const currentAssets = currentAssetsRow ? parseAmount(currentAssetsRow.thstrm_amount) : undefined;
    const currentLiabilities = currentLiabRow ? parseAmount(currentLiabRow.thstrm_amount) : undefined;
    const grossProfit = grossProfitRow ? parseAmount(grossProfitRow.thstrm_amount) : undefined;

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
      operatingCashFlow,
      currentAssets,
      currentLiabilities,
      equity: equityVal,
      grossProfit,
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

  // 최대 2회 시도 (모델 truncation 대응)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await callVertexGemini(ANALYSIS_SYSTEM, userMsg, {
        label: `dart-research:${financial.stockCode}`,
        grounded: true, // GenAI App Builder 크레딧 소모 (Google Search Grounding)
        temperature: attempt === 0 ? 0.2 : 0.5,
        maxOutputTokens: 8192,
      });

      // 코드블록 마커 제거 후 JSON 추출
      const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn(`Gemini JSON 추출 실패 (${financial.stockCode}) attempt=${attempt}: ${text.slice(0, 300)}`, { component: COMP });
        if (attempt === 0) { await sleep(1000); continue; }
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        fundamentalScore?: number;
        summary?: string;
        strengths?: string[];
        risks?: string[];
      };

      logger.info(`Gemini 분석 완료 (${financial.stockCode}): score=${parsed.fundamentalScore}`, { component: COMP });

      return {
        score: Math.max(0, Math.min(100, Number(parsed.fundamentalScore ?? 50))),
        analysis: parsed.summary ?? '',
        strengths: parsed.strengths ?? [],
        risks: parsed.risks ?? [],
      };
    } catch (err) {
      logger.warn(`Gemini 분석 실패 (${financial.stockCode}) attempt=${attempt}: ${err}`, { component: COMP });
      if (attempt === 0) { await sleep(1000); continue; }
      return null;
    }
  }
  return null;
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
  const apiKey = process.env.DART_API_KEY?.replace(/^\uFEFF/, '').trim();
  // 연간보고서: 3월 공시 → 6월에도 전년도 데이터가 최신. 항상 전년도 기본값
  // 1분기(q1): 5월 공시, 반기(h1): 8월 공시, 3분기(q3): 11월 공시
  const now = new Date();
  const defaultYear = (() => {
    const q = options?.quarter ?? 'annual';
    const m = now.getMonth(); // 0-indexed
    if (q === 'annual') return now.getFullYear() - 1; // 연간보고서는 항상 전년도
    if (q === 'q1') return m < 5 ? now.getFullYear() - 1 : now.getFullYear(); // 5월 이후 당해
    if (q === 'h1') return m < 8 ? now.getFullYear() - 1 : now.getFullYear(); // 8월 이후 당해
    if (q === 'q3') return m < 11 ? now.getFullYear() - 1 : now.getFullYear(); // 11월 이후 당해
    return now.getFullYear() - 1;
  })();
  const year = options?.year ?? String(defaultYear);
  const quarter = options?.quarter ?? 'annual';
  const cacheKey = `${stockCode}-${year}-${quarter}`;

  // 1차: 인메모리 24시간 캐시 (재시작 사이 성능)
  const cached = _resultCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < RESULT_CACHE_TTL_MS) {
    logger.debug(`DART 메모리캐시 히트: ${cacheKey}`, { component: COMP });
    return cached.result;
  }

  // 2차: DB 분기 캐시 (재시작/재배포 생존 — 동일 분기 재분석 방지)
  const dbCached = await getDbCachedResult(stockCode, year, quarter);
  if (dbCached) {
    _resultCache.set(cacheKey, { result: dbCached, fetchedAt: Date.now() });
    return dbCached;
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

  // Piotroski F-Score: 전년도 재무제표 추가 조회 → 당기 vs 전기 비교
  if (financial) {
    try {
      const priorYear = String(Number(year) - 1);
      const priorCacheKey = `${stockCode}-${priorYear}-${quarter}`;
      const priorCached = _resultCache.get(priorCacheKey);
      let priorFinancial: FinancialStatement | null = null;

      if (priorCached && Date.now() - priorCached.fetchedAt < RESULT_CACHE_TTL_MS) {
        priorFinancial = priorCached.result.financial ?? null;
      } else {
        await sleep(300); // DART API rate limit
        priorFinancial = await fetchFinancialStatement(apiKey, corpCode, stockCode, base.corpName, priorYear, quarter);
      }

      if (priorFinancial) {
        const piotroski = calcPiotroskiFScore(financial, priorFinancial);
        base.piotroskiScore = piotroski.fScore;
        logger.info(
          `📊 Piotroski F-Score: ${stockCode} = ${piotroski.fScore}/9 (${piotroski.signals.map((s, i) => `F${i + 1}:${s ? '✓' : '✗'}`).join(' ')})`,
          { component: COMP },
        );
      }
    } catch (err) {
      logger.warn(`Piotroski 계산 실패 (${stockCode}): ${err}`, { component: COMP });
    }
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

  // DB 분기 캐시에 저장 (재시작 후에도 재분석 방지)
  if (base.financial) {
    await upsertDbCache(stockCode, year, quarter, base);
  }

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

/**
 * 캐시된 Piotroski F-Score 반환 (Track B pipeline용)
 * 캐시 미스 시 undefined (리서치 미실행 종목)
 */
export function getCachedPiotroskiScore(stockCode: string): number | undefined {
  for (const [key, entry] of _resultCache) {
    if (key.startsWith(`${stockCode}-`) && Date.now() - entry.fetchedAt < RESULT_CACHE_TTL_MS) {
      return entry.result.piotroskiScore;
    }
  }
  return undefined;
}

/**
 * 캐시된 Gemini fundamentalScore 반환 (Track B pipeline용)
 * 0~100 점수 → 매매 점수 보정에 사용
 * 캐시 미스 시 undefined (리서치 미실행 종목)
 */
export function getCachedFundamentalScore(stockCode: string): number | undefined {
  for (const [key, entry] of _resultCache) {
    if (key.startsWith(`${stockCode}-`) && Date.now() - entry.fetchedAt < RESULT_CACHE_TTL_MS) {
      return entry.result.fundamentalScore;
    }
  }
  return undefined;
}

/**
 * v16.2: 서버 시작 시 DB 분기캐시 → 인메모리 캐시 워밍
 * 배포/재시작 후에도 DART 결과가 즉시 사용 가능 (수동 클릭 불필요)
 */
export async function warmDartCacheFromDb(): Promise<number> {
  const { year, quarter } = getCurrentQuarter();
  try {
    const { rows } = await getPool().query(
      `SELECT stock_code, result FROM dart_research_cache WHERE year = $1 AND quarter = $2 AND result IS NOT NULL`,
      [year, quarter],
    );
    let loaded = 0;
    for (const row of rows) {
      try {
        const parsed = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
        if (!parsed || !parsed.stockCode) continue; // null/빈 결과 스킵
        const result = parsed as DartResearchResult;
        const cacheKey = `${row.stock_code}-${year}-${quarter}`;
        if (!_resultCache.has(cacheKey)) {
          _resultCache.set(cacheKey, { result, fetchedAt: Date.now() });
          loaded++;
        }
      } catch { continue; } // JSON 파싱 실패 → 스킵
    }
    if (loaded > 0) {
      logger.info(`📊 DART DB→메모리 캐시 워밍 완료: ${loaded}종목 (${year}/${quarter})`, { component: COMP });
    }
    return loaded;
  } catch (e) {
    logger.debug(`DART 캐시 워밍 실패 (무시): ${e}`, { component: COMP });
    return 0;
  }
}
