// 증권사 리서치 자동 크롤러 — 네이버 금융 리서치 무료 리포트 자동 수집 → Track A Gemini 주입
import { query } from '../../db/client.js';
import { logger } from '../../utils/logger.js';

interface ResearchNote {
  id: number;
  url: string | null;
  title: string | null;
  content: string;
  memo: string | null;
  fetched_at: Date;
}

const NAVER_RESEARCH_URL = 'https://finance.naver.com/research/stock_list.naver';
const CRAWL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  Referer: 'https://finance.naver.com',
  Accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
};

// 네이버 금융 리서치 목록 파싱 → 리포트 URL + 제목 + 종목코드 추출
async function fetchNaverResearchList(stocks: Array<{ stock_code: string; stock_name: string }>): Promise<
  Array<{ url: string; title: string; stockCode: string; stockName: string }>
> {
  const results: Array<{ url: string; title: string; stockCode: string; stockName: string }> = [];

  try {
    const res = await fetch(`${NAVER_RESEARCH_URL}?page=1`, {
      headers: CRAWL_HEADERS,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return results;

    const html = await res.text();

    // 리포트 행 파싱: <td class="file">...<a href="...">제목</a> + <td class="num">종목코드</td>
    // 네이버 금융 리서치 테이블 구조 파싱
    const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    const rows = html.match(rowRegex) ?? [];

    for (const row of rows) {
      // 리포트 URL
      const urlMatch = row.match(/href="(\/research\/stock_read\.naver\?[^"]+)"/);
      if (!urlMatch) continue;

      // 제목
      const titleMatch = row.match(/<a[^>]+href="[^"]*stock_read[^"]*"[^>]*>([^<]+)<\/a>/);
      const title = titleMatch ? titleMatch[1].trim() : '';

      // 종목명으로 감시 종목 매칭
      const stockMatch = stocks.find((s) =>
        row.includes(s.stock_name) || row.includes(s.stock_code),
      );
      if (!stockMatch) continue;

      const fullUrl = `https://finance.naver.com${urlMatch[1]}`;
      results.push({
        url: fullUrl,
        title,
        stockCode: stockMatch.stock_code,
        stockName: stockMatch.stock_name,
      });

      if (results.length >= 10) break;
    }
  } catch (err) {
    logger.warn(`네이버 리서치 목록 수집 실패: ${err}`, { component: 'BROKER_RESEARCH' });
  }

  return results;
}

// 리포트 페이지에서 본문 텍스트 추출
async function crawlReportPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: CRAWL_HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const html = await res.text();
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 3000);

    return text.length > 100 ? text : null;
  } catch {
    return null;
  }
}

// 이미 수집된 URL인지 확인 (중복 방지)
async function isAlreadyCrawled(url: string): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `SELECT id FROM broker_research_notes WHERE url = $1 AND fetched_at >= NOW() - INTERVAL '7 days' LIMIT 1`,
    [url],
  );
  return rows.length > 0;
}

// Track A 실행 전 자동 크롤링 — 감시 종목 리포트 자동 수집
export async function autoCrawlBrokerResearch(
  stocks: Array<{ stock_code: string; stock_name: string }>,
): Promise<number> {
  let saved = 0;
  try {
    const reports = await fetchNaverResearchList(stocks);
    if (reports.length === 0) return 0;

    for (const report of reports) {
      try {
        if (await isAlreadyCrawled(report.url)) continue;

        const content = await crawlReportPage(report.url);
        if (!content) continue;

        await query(
          `INSERT INTO broker_research_notes (url, title, content, memo)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [report.url, report.title, content, `${report.stockName}(${report.stockCode})`],
        );
        saved++;
      } catch {
        /* 개별 실패는 스킵 */
      }
    }

    if (saved > 0) {
      logger.info(`증권사 리서치 자동 수집 완료: ${saved}건`, { component: 'BROKER_RESEARCH' });
    }
  } catch (err) {
    logger.warn(`증권사 리서치 자동 수집 실패: ${err}`, { component: 'BROKER_RESEARCH' });
  }
  return saved;
}

// Track A Gemini 주입용 — DB에서 최근 리포트 텍스트 섹션 생성
export async function getBrokerResearchSection(maxAgeDays = 14): Promise<string | null> {
  try {
    const rows = await query<ResearchNote>(
      `SELECT id, url, title, content, memo, fetched_at
       FROM broker_research_notes
       WHERE fetched_at >= NOW() - ($1 || ' days')::INTERVAL
       ORDER BY fetched_at DESC
       LIMIT 10`,
      [maxAgeDays],
    );

    if (!rows.length) return null;

    const parts = rows.map((r) => {
      const header = r.title ? `[${r.title}]` : r.url ? `[${r.url}]` : '[리포트]';
      const extra = r.memo ? ` (${r.memo})` : '';
      const body = r.content.slice(0, 800);
      return `${header}${extra}\n${body}`;
    });

    return `## 증권사 리서치 리포트 (목표가·투자의견)\n${parts.join('\n\n---\n')}`;
  } catch (err) {
    logger.warn(`브로커 리서치 DB 조회 실패: ${err}`, { component: 'TRACK_A' });
    return null;
  }
}
