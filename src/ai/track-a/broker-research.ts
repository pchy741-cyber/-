// 증권사 리서치 — DART 전자공시 OpenAPI 기반 (무료, 공식 데이터)
import { safeQuery as query } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { getKSTNow } from '../../utils/time.js';

interface ResearchNote {
  id: number;
  url: string | null;
  title: string | null;
  content: string;
  memo: string | null;
  fetched_at: Date;
}

interface DartDisclosure {
  rcept_no: string;
  corp_name: string;
  report_nm: string;
  rcept_dt: string;
  corp_code: string;
}

const DART_API_KEY = process.env.DART_API_KEY ?? '';

// DART 전자공시 최근 공시 조회 (감시 종목별)
async function fetchDartDisclosures(
  corpCode: string,
  corpName: string,
): Promise<Array<{ title: string; url: string; summary: string }>> {
  if (!DART_API_KEY) return [];

  try {
    const url =
      `https://opendart.fss.or.kr/api/list.json` +
      `?crtfc_key=${DART_API_KEY}&corp_code=${corpCode}&bgn_de=${getPastDate(14)}&end_de=${getToday()}&page_count=5`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];

    const json = (await res.json()) as { status: string; list?: DartDisclosure[] };
    if (json.status !== '000' || !json.list?.length) return [];

    return json.list.map((d) => ({
      title: `[${corpName}] ${d.report_nm}`,
      url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${d.rcept_no}`,
      summary: `공시일: ${d.rcept_dt.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')} | ${d.report_nm}`,
    }));
  } catch {
    return [];
  }
}

// DART 종목 코드 조회 (주식코드 → corp_code 변환)
async function getDartCorpCode(stockCode: string): Promise<string | null> {
  if (!DART_API_KEY) return null;
  try {
    const url = `https://opendart.fss.or.kr/api/company.json?crtfc_key=${DART_API_KEY}&stock_code=${stockCode}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { status: string; corp_code?: string };
    return json.status === '000' ? (json.corp_code ?? null) : null;
  } catch {
    return null;
  }
}

function getToday(): string {
  return getKSTNow().toISOString().slice(0, 10).replace(/-/g, '');
}

function getPastDate(days: number): string {
  const d = getKSTNow();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function isAlreadyCrawled(url: string): Promise<boolean> {
  const result = await query<{ id: number }>(
    `SELECT id FROM broker_research_notes WHERE url = $1 AND fetched_at >= NOW() - INTERVAL '7 days' LIMIT 1`,
    [url],
  );
  return result.rows.length > 0;
}

// Track A 실행 전 자동 수집 — DART 공시를 감시 종목별로 조회 → DB 저장
export async function autoCrawlBrokerResearch(
  stocks: Array<{ stock_code: string; stock_name: string }>,
): Promise<number> {
  if (!DART_API_KEY) {
    logger.warn('DART_API_KEY 미설정 — 리서치 수집 스킵', { component: 'BROKER_RESEARCH' });
    return 0;
  }

  let saved = 0;

  for (const stock of stocks.slice(0, 10)) {
    try {
      const corpCode = await getDartCorpCode(stock.stock_code);
      if (!corpCode) continue;

      const disclosures = await fetchDartDisclosures(corpCode, stock.stock_name);

      for (const d of disclosures) {
        if (await isAlreadyCrawled(d.url)) continue;

        await query(
          `INSERT INTO broker_research_notes (url, title, content, memo)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [d.url, d.title, d.summary, `${stock.stock_name}(${stock.stock_code})`],
        );
        saved++;
      }
    } catch {
      /* 개별 종목 실패 스킵 */
    }
  }

  if (saved > 0) {
    logger.info(`DART 공시 자동 수집 완료: ${saved}건`, { component: 'BROKER_RESEARCH' });
  }
  return saved;
}

// Track A Gemini 주입용 — DB에서 최근 공시 텍스트 섹션 생성
export async function getBrokerResearchSection(maxAgeDays = 14): Promise<string | null> {
  try {
    const result = await query<ResearchNote>(
      `SELECT id, url, title, content, memo, fetched_at
       FROM broker_research_notes
       WHERE fetched_at >= NOW() - ($1 || ' days')::INTERVAL
       ORDER BY fetched_at DESC
       LIMIT 15`,
      [maxAgeDays],
    );

    if (!result.rows.length) return null;

    const parts = result.rows.map((r: ResearchNote) => {
      const header = r.title ?? r.url ?? '[공시]';
      const extra = r.memo ? ` (${r.memo})` : '';
      return `${header}${extra}\n${r.content.slice(0, 500)}`;
    });

    return `## DART 전자공시 (최근 실적·주요공시)\n${parts.join('\n\n---\n')}`;
  } catch (err) {
    logger.warn(`DART 공시 DB 조회 실패: ${err}`, { component: 'TRACK_A' });
    return null;
  }
}
