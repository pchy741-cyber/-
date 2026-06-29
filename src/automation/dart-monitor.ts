import { getActiveWatchlist } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { getKSTNow } from '../utils/time.js';

/**
 * DART 공시 모니터링 모듈
 *
 * DART Open API를 직접 호출하여 감시 종목의 최신 공시를 수집하고,
 * 중요도별 분류 및 점수 조정을 수행합니다.
 *
 * - HIGH: 실적, 대량보유, 합병, 분할, 증자, 자사주, 임원변동
 * - MEDIUM: 공급계약, 수주, 투자, 결산
 * - LOW: 기타
 */

// ── Types ──

export type DisclosurePolarity = 'VERY_POSITIVE' | 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'VERY_NEGATIVE';

export interface DartDisclosure {
  corp_name: string;
  report_nm: string;
  rcept_dt: string;
  rcept_no: string;
  flr_nm: string;
  importance: 'HIGH' | 'MEDIUM' | 'LOW';
  polarity: DisclosurePolarity;
}

interface DartApiResponse {
  status: string;
  message: string;
  page_no: number;
  page_count: number;
  total_count: number;
  total_page: number;
  list: Array<{
    corp_name: string;
    report_nm: string;
    rcept_dt: string;
    rcept_no: string;
    flr_nm: string;
    corp_code: string;
    stock_code: string;
  }>;
}

// ── Corp Code Mapping (종목코드 → DART 고유번호) ──

const STOCK_TO_CORP_CODE: Record<string, string> = {
  '005930': '00126380', // 삼성전자
  '000660': '00164779', // SK하이닉스
  '373220': '01620944', // LG에너지솔루션
  '005380': '00164742', // 현대자동차
  '009540': '00164785', // HD한국조선해양
  '035420': '00401731', // NAVER
  '035720': '00258801', // 카카오
  '006400': '00126362', // 삼성SDI
  '051910': '00356361', // LG화학
  '003670': '00140108', // 포스코퓨처엠
};

// ── 공시 캐시 (당일 유지) ──

let disclosureCache: Map<string, DartDisclosure[]> = new Map();
let lastCacheDate = '';

// ── Classification Keywords ──

const HIGH_KEYWORDS = [
  '실적',
  '대량보유',
  '합병',
  '분할',
  '유상증자',
  '무상증자',
  '자사주',
  '자기주식',
  '임원변동',
  '임원퇴임',
  '대표이사',
  '주요사항보고',
];

const MEDIUM_KEYWORDS = ['공급계약', '수주', '투자', '결산', '단일판매', '매출액', '타법인주식'];

// ── Polarity keywords for score adjustment (세분화) ──

const VERY_POSITIVE_KEYWORDS = [
  '자사주 취득 결정', '자기주식 취득 결정', '자사주 매입',
  '대규모 수주', '특별배당', '실적 호전', '실적 개선',
];
const POSITIVE_KEYWORDS = [
  '전환사채 상환', '신규 사업', '기술 이전', '기술 수출',
  '공급계약 체결', '무상증자', '자기주식 취득',
];
const NEGATIVE_KEYWORDS = [
  'CB 발행', 'BW 발행', '전환사채 발행', '신주인수권부사채',
  '대표이사 변경', '소송 제기', '실적 부진',
];
const VERY_NEGATIVE_KEYWORDS = [
  '유상증자 결정', '유상증자', '감사의견 거절', '감사의견 부적정',
  '상장폐지', '횡령', '배임', '실적 악화', '임원 퇴임', '대표이사 사임',
];

// ── Core Functions ──

/**
 * 공시 중요도 분류
 */
export function classifyDisclosure(reportName: string): 'HIGH' | 'MEDIUM' | 'LOW' {
  for (const keyword of HIGH_KEYWORDS) {
    if (reportName.includes(keyword)) return 'HIGH';
  }
  for (const keyword of MEDIUM_KEYWORDS) {
    if (reportName.includes(keyword)) return 'MEDIUM';
  }
  return 'LOW';
}

/**
 * 공시 방향성(polarity) 분류 — 호재/악재 세분화
 */
export function classifyPolarity(reportName: string): DisclosurePolarity {
  for (const kw of VERY_NEGATIVE_KEYWORDS) {
    if (reportName.includes(kw)) return 'VERY_NEGATIVE';
  }
  for (const kw of VERY_POSITIVE_KEYWORDS) {
    if (reportName.includes(kw)) return 'VERY_POSITIVE';
  }
  for (const kw of NEGATIVE_KEYWORDS) {
    if (reportName.includes(kw)) return 'NEGATIVE';
  }
  for (const kw of POSITIVE_KEYWORDS) {
    if (reportName.includes(kw)) return 'POSITIVE';
  }
  return 'NEUTRAL';
}

/**
 * YYYYMMDD 날짜 포맷 반환
 */
function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * DART API에서 특정 기업의 최근 공시 조회
 */
async function fetchCorpDisclosures(
  apiKey: string,
  corpCode: string,
  beginDate: string,
  endDate: string,
): Promise<DartDisclosure[]> {
  try {
    const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${apiKey}&bgn_de=${beginDate}&end_de=${endDate}&corp_code=${corpCode}&page_count=100`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'AIBot/0.2.0' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      logger.warn(`DART API 응답 오류: ${res.status}`, { component: 'DART' });
      return [];
    }

    const data = (await res.json()) as DartApiResponse;

    // status "000" = 정상, "013" = 조회된 데이터 없음
    if (data.status === '013' || !data.list) return [];
    if (data.status !== '000') {
      logger.warn(`DART API 상태: ${data.status} - ${data.message}`, { component: 'DART' });
      return [];
    }

    return data.list.map((item) => ({
      corp_name: item.corp_name,
      report_nm: item.report_nm,
      rcept_dt: item.rcept_dt,
      rcept_no: item.rcept_no,
      flr_nm: item.flr_nm,
      importance: classifyDisclosure(item.report_nm),
      polarity: classifyPolarity(item.report_nm),
    }));
  } catch (error) {
    logger.warn(`DART 공시 조회 실패 (${corpCode}): ${error}`, { component: 'DART' });
    return [];
  }
}

/**
 * 감시 종목의 최근 3일 공시 일괄 조회
 */
export async function fetchRecentDisclosures(stockCodes: string[]): Promise<DartDisclosure[]> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) {
    logger.warn('DART_API_KEY 미설정 → 공시 조회 비활성', { component: 'DART' });
    return [];
  }

  const now = getKSTNow();
  const threeDaysAgo = new Date(now);
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  const endDate = formatDate(now);
  const beginDate = formatDate(threeDaysAgo);

  const allDisclosures: DartDisclosure[] = [];

  // 배치 처리 (3개씩, rate limit 대응)
  const batchSize = 3;
  for (let i = 0; i < stockCodes.length; i += batchSize) {
    const batch = stockCodes.slice(i, i + batchSize);

    const results = await Promise.allSettled(
      batch.map((stockCode) => {
        const corpCode = STOCK_TO_CORP_CODE[stockCode];
        if (!corpCode) {
          logger.warn(`DART corp_code 매핑 없음: ${stockCode}`, { component: 'DART' });
          return Promise.resolve([] as DartDisclosure[]);
        }
        return fetchCorpDisclosures(apiKey, corpCode, beginDate, endDate);
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allDisclosures.push(...result.value);
      }
    }

    // rate limit (DART API: 분당 1000건이지만 안전하게)
    if (i + batchSize < stockCodes.length) {
      await sleep(500);
    }
  }

  return allDisclosures;
}

/**
 * 공시 기반 점수 조정값 반환 (polarity 기반 단일 매핑)
 *
 * - VERY_POSITIVE: +20, POSITIVE: +10
 * - VERY_NEGATIVE: -20, NEGATIVE: -10
 * - NEUTRAL: 0
 */
const POLARITY_SCORE: Record<DisclosurePolarity, number> = {
  VERY_POSITIVE: 20,
  POSITIVE: 10,
  NEUTRAL: 0,
  NEGATIVE: -10,
  VERY_NEGATIVE: -20,
};

export function getDisclosureScoreAdjustment(stockCode: string): number {
  const disclosures = disclosureCache.get(stockCode);
  if (!disclosures || disclosures.length === 0) return 0;

  let totalAdjustment = 0;
  for (const disc of disclosures) {
    totalAdjustment += POLARITY_SCORE[disc.polarity];
  }

  // 범위 제한: -20 ~ +20
  return Math.max(-20, Math.min(20, totalAdjustment));
}

/**
 * 메인 공시 모니터링 함수
 *
 * 1. 감시 종목 전체의 최근 공시 조회
 * 2. HIGH 중요도 공시 로깅
 * 3. HIGH 중요도 공시 Telegram 알림 전송
 */
export async function monitorDisclosures(): Promise<DartDisclosure[]> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) {
    logger.warn('DART_API_KEY 미설정 → 공시 모니터링 비활성', { component: 'DART' });
    return [];
  }

  // 날짜 변경 시 캐시 초기화
  const today = getKSTNow().toISOString().split('T')[0];
  if (lastCacheDate !== today) {
    disclosureCache = new Map();
    lastCacheDate = today;
  }

  const watchlist = await getActiveWatchlist();
  if (watchlist.length === 0) {
    logger.info('감시 종목 없음 → 공시 모니터링 스킵', { component: 'DART' });
    return [];
  }

  const stockCodes = watchlist.map((w) => w.stock_code);
  const disclosures = await fetchRecentDisclosures(stockCodes);

  // 종목별 캐시 업데이트
  for (const disc of disclosures) {
    const matchingStock = watchlist.find((w) => w.stock_name === disc.corp_name);
    if (matchingStock) {
      const existing = disclosureCache.get(matchingStock.stock_code) ?? [];
      const isDuplicate = existing.some((e) => e.rcept_no === disc.rcept_no);
      if (!isDuplicate) {
        disclosureCache.set(matchingStock.stock_code, [...existing, disc]);
      }
    }
  }

  // HIGH 중요도 공시 처리
  const highImportance = disclosures.filter((d) => d.importance === 'HIGH');

  if (highImportance.length > 0) {
    logger.info(`🚨 DART 주요 공시 ${highImportance.length}건 감지`, {
      component: 'DART',
      count: highImportance.length,
    });

    for (const disc of highImportance) {
      logger.info(`[${disc.corp_name}] ${disc.report_nm} (${disc.rcept_dt})`, { component: 'DART' });
    }

    // Telegram 알림 전송
    const alertLines = highImportance.map((d) => `- *${d.corp_name}*: ${d.report_nm} (${d.rcept_dt})`);
    const message = [
      `🚨 *DART 주요 공시 알림*`,
      ``,
      ...alertLines,
      ``,
      `총 ${highImportance.length}건의 주요 공시가 감지되었습니다.`,
    ].join('\n');

    await sendTelegramMessage(message).catch(() => {});

    // v16.2: 실적 공시 감지 → DART 리서치 자동 트리거 (재무 점수 즉시 갱신)
    const earningsKeywords = ['실적', '결산', '매출액', '영업이익', '분기보고서', '반기보고서', '사업보고서'];
    const earningsDisclosures = highImportance.filter((d) =>
      earningsKeywords.some((kw) => d.report_nm.includes(kw)),
    );
    if (earningsDisclosures.length > 0) {
      const earningsStockCodes = earningsDisclosures
        .map((d) => watchlist.find((w) => w.stock_name === d.corp_name)?.stock_code)
        .filter((c): c is string => !!c);
      const uniqueCodes = [...new Set(earningsStockCodes)];
      if (uniqueCodes.length > 0) {
        logger.info(`📊 실적 공시 감지 → DART 리서치 자동 트리거: ${uniqueCodes.join(',')}`, { component: 'DART' });
        import('./dart-research.js')
          .then((m) => m.runDartResearchBatch(uniqueCodes))
          .catch((e) => logger.warn(`실적 공시 DART 리서치 실패: ${e}`, { component: 'DART' }));
      }
    }
  } else {
    logger.info(`DART 공시 ${disclosures.length}건 수집 (주요 공시 없음)`, { component: 'DART' });
  }

  return disclosures;
}

/**
 * 캐시된 공시 데이터 반환 (외부 조회용)
 */
export function getCachedDisclosures(): Map<string, DartDisclosure[]> {
  return disclosureCache;
}

/**
 * 종목코드 → DART corp_code 매핑 조회
 */
export function getCorpCode(stockCode: string): string | undefined {
  return STOCK_TO_CORP_CODE[stockCode];
}
