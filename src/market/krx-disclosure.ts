/**
 * KRX KIND 공시 크롤러
 * https://kind.krx.co.kr — 당일 공시 HTML 파싱
 * 인증 키 불필요, 30분 인메모리 캐시
 */

import { logger } from '../utils/logger.js';

export type DisclosureSentiment = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface KrxDisclosure {
  time: string;
  companyName: string;
  title: string;
  sentiment: DisclosureSentiment;
  urgency: 'HIGH' | 'LOW';
}

export interface StockDisclosureResult {
  stockCode: string;
  companyName: string;
  disclosures: KrxDisclosure[];
  hasBullish: boolean;
  hasBearish: boolean;
  /** Gemini 컨텍스트 주입용 텍스트 */
  summary: string;
}

// ── 30분 캐시 ───────────────────────────────────────────────────
const CACHE_TTL_MS = 30 * 60 * 1000;
let _cache: { items: Array<{ companyName: string; title: string; time: string }>; fetchedAt: number } | null = null;

// ── 악재 패턴 ────────────────────────────────────────────────────
const BEARISH_RE = [
  /유상증자/,
  /전환사채.*발행/,
  /신주인수권부사채/,
  /불성실공시/,
  /파산|회생절차|워크아웃/,
  /상장폐지/,
  /감사의견.*거절|의견거절/,
  /최대주주.*변경/,
  /대표이사.*해임/,
];

// ── 호재 패턴 ────────────────────────────────────────────────────
const BULLISH_RE = [
  /단일판매.*공급계약체결/,
  /자기주식.*취득결정/,
  /무상증자/,
  /배당.*결정/,
  /특허.*등록/,
  /수주.*결정|납품계약/,
];

function classify(title: string): { sentiment: DisclosureSentiment; urgency: 'HIGH' | 'LOW' } {
  for (const re of BEARISH_RE) if (re.test(title)) return { sentiment: 'BEARISH', urgency: 'HIGH' };
  for (const re of BULLISH_RE) if (re.test(title)) return { sentiment: 'BULLISH', urgency: 'HIGH' };
  return { sentiment: 'NEUTRAL', urgency: 'LOW' };
}

function parseKindHtml(html: string): Array<{ companyName: string; title: string; time: string }> {
  const results: Array<{ companyName: string; title: string; time: string }> = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const row = m[1];
    const timeM = row.match(/<td[^>]*class="[^"]*txc[^"]*"[^>]*>\s*(\d{2}:\d{2})\s*<\/td>/);
    const compM = row.match(/companysummary_open\('\d+'\)[^>]*title='([^']+)'/);
    const titleM = row.match(/openDisclsViewer\('[^']+','[^']*'\)[^>]*title='([^']+)'/);
    if (timeM && compM && titleM) {
      results.push({ time: timeM[1], companyName: compM[1].trim(), title: titleM[1].trim() });
    }
  }
  return results;
}

async function fetchAllDisclosures(): Promise<Array<{ companyName: string; title: string; time: string }>> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) return _cache.items;

  const res = await fetch('https://kind.krx.co.kr/disclosure/todaydisclosure.do', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Referer: 'https://kind.krx.co.kr/',
    },
    body: new URLSearchParams({
      method: 'searchTodayDisclosureSub',
      currentPage: '1',
      maxResults: '200',
      orderMode: '0',
      orderStat: 'D',
      forward: 'todaydisclosure_sub',
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`KIND HTTP ${res.status}`);
  const html = await res.text();
  const items = parseKindHtml(html);
  _cache = { items, fetchedAt: Date.now() };
  logger.info(`KIND 공시 ${items.length}건 로드 완료`, { component: 'KRX_DISCLOSURE' });
  return items;
}

/**
 * 감시목록 종목들의 당일 KIND 공시 조회 및 감성 분류
 * @param stocks { stockCode, companyName }[] — 종목코드 + 한국어 회사명
 */
export async function fetchStockDisclosures(
  stocks: Array<{ stockCode: string; companyName: string }>,
): Promise<StockDisclosureResult[]> {
  try {
    const all = await fetchAllDisclosures();
    const results: StockDisclosureResult[] = [];

    for (const { stockCode, companyName } of stocks) {
      const key = companyName.slice(0, 4); // 4자 부분 매칭
      const matched = all.filter(
        (d) => d.companyName.includes(key) || key.includes(d.companyName.slice(0, 4)),
      );
      if (matched.length === 0) continue;

      const disclosures: KrxDisclosure[] = matched.map((d) => ({ ...d, ...classify(d.title) }));
      const hasBullish = disclosures.some((d) => d.sentiment === 'BULLISH');
      const hasBearish = disclosures.some((d) => d.sentiment === 'BEARISH');
      const summary = disclosures
        .map(
          (d) =>
            `${d.time} [${d.sentiment === 'BULLISH' ? '호재' : d.sentiment === 'BEARISH' ? '악재' : '중립'}] ${d.title}`,
        )
        .join('\n');

      results.push({ stockCode, companyName, disclosures, hasBullish, hasBearish, summary });
    }

    return results;
  } catch (err) {
    logger.warn(`KIND 공시 크롤링 실패 (스킵): ${err}`, { component: 'KRX_DISCLOSURE' });
    return [];
  }
}
