/**
 * DART 내부자 매수/매도 감지 — elestock.json API
 *
 * 임원/주요주주 매수 = 강한 매수 신호 (자기 돈 투입)
 * 복수 내부자 동시 매수(클러스터) = 더 강한 신호
 *
 * Score Adjustment:
 *   - 내부자 매수 클러스터 (2명+): +12
 *   - 단일 내부자 매수: +8
 *   - 내부자 매도: -10
 *   - 대량 매도 (복수): -15
 *   - 데이터 없음/에러: 0
 */

import { getCorpCode } from './dart-monitor.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { getKSTNow } from '../utils/time.js';

const COMPONENT = 'DART_INSIDER';

// ── 캐시 (4시간 TTL — 내부자 공시는 빈번하지 않음) ──

interface InsiderCacheEntry {
  buyCount: number;
  sellCount: number;
  fetchedAt: number;
}

const _insiderCache = new Map<string, InsiderCacheEntry>();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4시간
const CACHE_MAX_ENTRIES = 200;

// 만료 엔트리 자동 정리 (4시간 주기)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _insiderCache) {
    if (now - entry.fetchedAt >= CACHE_TTL_MS) _insiderCache.delete(key);
  }
  if (_insiderCache.size > CACHE_MAX_ENTRIES) _insiderCache.clear();
}, CACHE_TTL_MS).unref();

// ── DART elestock API 응답 타입 ──

interface ElestockResponse {
  status: string;
  message: string;
  list?: Array<{
    rcept_no: string;
    rcept_dt: string;       // 접수일자 YYYYMMDD
    corp_code: string;
    corp_name: string;
    repror: string;         // 보고자
    isu_exctv_rgist_at: string; // 발행회사 임원 등기여부
    isu_exctv_ofcps: string;    // 임원 직위
    isu_exctv_nm: string;       // 성명
    sp_stock_lmp_cnt: string;   // 특정증권등 소유주식수 변동
    sp_stock_lmp_irds_cnt: string; // 특정증권등 증감수 (양수=매수, 음수=매도)
    sp_stock_lmp_rate: string;  // 변동비율
  }>;
}

// ── 핵심 로직 ──

/**
 * 단일 종목의 내부자 거래 데이터를 DART에서 조회
 */
async function fetchInsiderData(stockCode: string): Promise<{ buyCount: number; sellCount: number }> {
  const corpCode = getCorpCode(stockCode);
  if (!corpCode) return { buyCount: 0, sellCount: 0 };

  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) return { buyCount: 0, sellCount: 0 };

  const url = `https://opendart.fss.or.kr/api/elestock.json?crtfc_key=${apiKey}&corp_code=${corpCode}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return { buyCount: 0, sellCount: 0 };

  const data = (await res.json()) as ElestockResponse;
  if (data.status !== '000' || !data.list || data.list.length === 0) {
    return { buyCount: 0, sellCount: 0 };
  }

  // 최근 30일 내 보고서만 필터
  const now = getKSTNow();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const cutoff = thirtyDaysAgo.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD

  let buyCount = 0;
  let sellCount = 0;

  for (const item of data.list) {
    if (item.rcept_dt < cutoff) continue;

    const changeCount = parseInt(item.sp_stock_lmp_irds_cnt?.replace(/,/g, '') || '0', 10);
    if (changeCount > 0) buyCount++;
    else if (changeCount < 0) sellCount++;
  }

  return { buyCount, sellCount };
}

/**
 * 감시 종목 일괄 내부자 데이터 갱신 (3개씩 배치 + 500ms 딜레이)
 */
export async function refreshInsiderData(stockCodes: string[]): Promise<void> {
  if (!process.env.DART_API_KEY) return;

  const codesToFetch = stockCodes.filter((code) => {
    const cached = _insiderCache.get(code);
    return !cached || Date.now() - cached.fetchedAt >= CACHE_TTL_MS;
  });

  if (codesToFetch.length === 0) return;

  const BATCH_SIZE = 3;
  for (let i = 0; i < codesToFetch.length; i += BATCH_SIZE) {
    const batch = codesToFetch.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (code) => {
        const result = await fetchInsiderData(code);
        _insiderCache.set(code, { ...result, fetchedAt: Date.now() });
        return { code, ...result };
      }),
    );

    // 로그: 내부자 매수/매도 감지
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const { code, buyCount, sellCount } = r.value;
        if (buyCount > 0) {
          logger.info(`📋 내부자 매수 감지: ${code} (${buyCount}건)`, { component: COMPONENT });
        }
        if (sellCount > 0) {
          logger.info(`📋 내부자 매도 감지: ${code} (${sellCount}건)`, { component: COMPONENT });
        }
      }
    }

    // 마지막 배치가 아니면 딜레이
    if (i + BATCH_SIZE < codesToFetch.length) {
      await sleep(500);
    }
  }
}

/**
 * Pipeline Score Adjustment 반환
 * Range: -15 ~ +12
 */
export function getInsiderScoreAdjustment(stockCode: string): number {
  try {
    const cached = _insiderCache.get(stockCode);
    if (!cached || Date.now() - cached.fetchedAt > CACHE_TTL_MS) return 0;

    const { buyCount, sellCount } = cached;

    // 매수 + 매도 동시 → 서로 상쇄, 매수 우세면 매수 신호
    if (buyCount >= 2 && sellCount === 0) return 12;   // 클러스터 매수
    if (buyCount >= 1 && sellCount === 0) return 8;    // 단일 매수
    if (sellCount >= 2 && buyCount === 0) return -15;  // 대량 매도
    if (sellCount >= 1 && buyCount === 0) return -10;  // 단일 매도

    // 혼합 신호 → 축소
    if (buyCount > sellCount) return 4;
    if (sellCount > buyCount) return -5;

    return 0;
  } catch (err) {
    logger.debug(`내부자 스코어 조회 실패 (${stockCode}): ${err}`, { component: COMPONENT });
    return 0;
  }
}
