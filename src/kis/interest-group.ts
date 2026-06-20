import { getCtxIsPaper } from '../config/context.js';
import { config } from '../config/index.js';
import { getActiveWatchlist, getPool, upsertWatchlistItem } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { kisRequest } from './client.js';
import { getCurrentPrice } from './market.js';

/**
 * KIS 관심종목 동기화
 *
 * 한국투자증권 앱에서 설정한 관심종목을 자동으로 봇 감시목록에 반영.
 * KIS OpenAPI 관심종목 조회: /uapi/domestic-stock/v1/quotations/search-stock-info
 *
 * 그룹 1~10번까지 조회 → DB watchlist에 없는 종목은 자동 추가
 */

/** 관심종목 조회 간 대기 시간 (rate limit 준수) */
const INTEREST_GROUP_DELAY_MS = 200;
/** 보유종목 시세 조회 간 대기 시간 */
const HOLDINGS_SYNC_DELAY_MS = 300;
/** KRX 전종목 조회 타임아웃 */
const KRX_REQUEST_TIMEOUT_MS = 10_000;

// KIS 관심종목 TR_ID
const INTEREST_TR_ID = {
  GROUP_LIST: 'HHKST02300100', // 관심종목 그룹목록 조회
  STOCK_LIST: 'HHKST02300200', // 관심종목 종목리스트 조회
} as const;

interface InterestStock {
  stockCode: string;
  stockName: string;
  market: 'KOSPI' | 'KOSDAQ';
}

/**
 * KIS 관심종목 그룹에서 종목 리스트 조회 (그룹 번호 1~10)
 */
async function fetchInterestGroup(groupNo: number): Promise<InterestStock[]> {
  try {
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/chk-interest-item',
      trId: INTEREST_TR_ID.STOCK_LIST,
      useRealUrl: true, // 관심종목은 실서버만 지원
      params: {
        CANO: config.kis.accountNo,
        ACNT_PRDT_CD: config.kis.accountProductCode,
        INTR_GRP_NO: String(groupNo).padStart(2, '0'),
        CTX_AREA_FK100: '',
        CTX_AREA_NK100: '',
      },
    });

    const items = (res.output ?? []) as Record<string, string>[];
    return items
      .filter((item) => item.pdno && item.pdno.length === 6)
      .map((item) => ({
        stockCode: item.pdno,
        stockName: item.prdt_name ?? item.pdno,
        market: item.mrkt_div_cls_code === '2' ? ('KOSDAQ' as const) : ('KOSPI' as const),
      }));
  } catch (e) {
    // 그룹이 비었거나 API 미지원 시 빈 배열
    logger.debug(`관심종목 그룹 ${groupNo} 조회 실패: ${(e as Error).message}`, { component: 'KIS_INTEREST' });
    return [];
  }
}

/**
 * KIS 앱 관심종목 전체 동기화
 *
 * 1. 그룹 1~5 조회 (대부분 유저는 1~3그룹 사용)
 * 2. DB watchlist에 없으면 자동 추가
 * 3. 추가된 종목 수 반환
 */
export async function syncInterestGroups(): Promise<{ added: string[]; total: number }> {
  // 관심종목 API는 실서버 live 계정만 지원 — paper 모드에서 호출 시 HTTP404 스팸 방지
  // getCtxIsPaper(): AsyncLocalStorage 컨텍스트 기반 (스케줄러 runWithMode 호환)
  const { getCtxIsPaper } = await import('../config/context.js');
  if (getCtxIsPaper()) return { added: [], total: 0 };
  logger.info('🔄 KIS 관심종목 동기화 시작', { component: 'KIS_INTEREST' });

  const allStocks = new Map<string, InterestStock>();

  // 그룹 1~10 조회 (빠른 실패 — 첫 2개 실패하면 API 미지원으로 판단 후 중단)
  let consecutiveFails = 0;
  for (let g = 1; g <= 10; g++) {
    const stocks = await fetchInterestGroup(g);
    if (stocks.length === 0) {
      consecutiveFails++;
      if (consecutiveFails >= 2 && allStocks.size === 0) {
        logger.info('관심종목 API 미지원 (모의투자) → 조기 종료', { component: 'KIS_INTEREST' });
        break;
      }
    } else {
      consecutiveFails = 0;
      for (const s of stocks) allStocks.set(s.stockCode, s);
      logger.info(`  그룹 ${g}: ${stocks.length}종목 (${stocks.map((s) => s.stockName).join(', ')})`, {
        component: 'KIS_INTEREST',
      });
    }
    await new Promise((r) => setTimeout(r, INTEREST_GROUP_DELAY_MS));
  }

  if (allStocks.size === 0) {
    logger.info('KIS 관심종목 없음 (또는 API 미지원)', { component: 'KIS_INTEREST' });
    return { added: [], total: 0 };
  }

  // 현재 DB watchlist와 비교
  const existing = await getActiveWatchlist();
  const existingCodes = new Set(existing.map((w) => w.stock_code));

  const added: string[] = [];

  for (const [code, stock] of allStocks) {
    if (existingCodes.has(code)) continue;

    // 종목명이 없으면 시세 API에서 보완
    let name = stock.stockName;
    if (!name || name === code) {
      try {
        const quote = await getCurrentPrice(code);
        name = quote.stockName || code;
      } catch {
        /* use code as fallback */
      }
    }

    await upsertWatchlistItem(
      {
        stock_code: code,
        stock_name: name,
        market: stock.market,
      },
      'KIS_SYNC',
    );

    added.push(`${name}(${code})`);
    logger.info(`  ✅ 추가: ${name} (${code}) [${stock.market}]`, { component: 'KIS_INTEREST' });
    await new Promise((r) => setTimeout(r, INTEREST_GROUP_DELAY_MS));
  }

  const result = { added, total: allStocks.size };
  logger.info(`🔄 KIS 관심종목 동기화 완료: 총 ${allStocks.size}종목, 신규 ${added.length}종목 추가`, {
    component: 'KIS_INTEREST',
  });

  return result;
}

/**
 * KIS 실계좌 보유종목을 watchlist에 자동 반영
 * (관심종목 API가 안 되더라도 실제 보유 종목은 무조건 감시)
 */
export async function syncHoldingsToWatchlist(): Promise<{ added: string[] }> {
  try {
    const { getAccountBalance } = await import('./account.js');
    const balance = await getAccountBalance();

    const existing = await getActiveWatchlist();
    const existingCodes = new Set(existing.map((w) => w.stock_code));

    const added: string[] = [];

    for (const pos of balance.positions) {
      if (existingCodes.has(pos.stockCode)) continue;

      // 시장 판별: KIS 시세 API에서 시장구분 조회
      let market: 'KOSPI' | 'KOSDAQ' = 'KOSPI';
      try {
        const res = await kisRequest({
          path: '/uapi/domestic-stock/v1/quotations/inquire-price',
          trId: 'FHKST01010100',
          params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: pos.stockCode },
        });
        const o = res.output as Record<string, string>;
        if (o?.rprs_mrkt_kor_name?.includes('코스닥') || o?.bstp_kor_isnm?.includes('코스닥')) {
          market = 'KOSDAQ';
        }
        if (o?.hts_kor_isnm) pos.stockName = o.hts_kor_isnm;
      } catch {
        /* fallback to KOSPI */
      }
      await new Promise((r) => setTimeout(r, HOLDINGS_SYNC_DELAY_MS));

      await upsertWatchlistItem(
        {
          stock_code: pos.stockCode,
          stock_name: pos.stockName,
          market,
        },
        'KIS_SYNC',
      );

      added.push(`${pos.stockName}(${pos.stockCode})`);
      logger.info(`  ✅ 보유종목 추가: ${pos.stockName} (${pos.stockCode})`, { component: 'KIS_INTEREST' });
    }

    if (added.length > 0) {
      logger.info(`📦 보유종목 → watchlist 동기화: ${added.length}종목 추가`, { component: 'KIS_INTEREST' });
    }

    return { added };
  } catch (e) {
    logger.warn(`보유종목 동기화 실패: ${(e as Error).message}`, { component: 'KIS_INTEREST' });
    return { added: [] };
  }
}

/**
 * watchlist 종목명 자동 보정
 * - 이름이 깨지거나 코드로만 저장된 종목을 KIS 시세 API로 정상 이름으로 업데이트
 * - transaction_chains / orders에 있지만 watchlist에 없는 종목도 먼저 추가
 */
const GARBLED_REGEX = /[^\w\s\uAC00-\uD7A3\u3131-\u318E\u1100-\u11FF().,\u00B7\-+%$]/;

export async function fixWatchlistNames(): Promise<{ fixed: number; total: number }> {
  logger.info('🔧 종목명 자동 보정 시작', { component: 'KIS_INTEREST' });
  try {
    // 1. transaction_chains에 있지만 watchlist에 없는 종목 추가
    const { rows: chainRows } = await getPool().query(
      `SELECT DISTINCT tc.stock_code FROM transaction_chains tc
       WHERE tc.stock_code NOT IN (SELECT stock_code FROM watchlist)
         AND tc.is_paper = $1`,
      [getCtxIsPaper()],
    );
    // 2. orders에 있지만 watchlist에 없는 종목 추가
    const { rows: orderRows } = await getPool().query(
      `SELECT DISTINCT o.stock_code FROM orders o
       WHERE o.stock_code NOT IN (SELECT stock_code FROM watchlist)
         AND o.is_paper = $1
         AND o.stock_code ~ '^[0-9]{6}$'`,
      [getCtxIsPaper()],
    );

    const missingCodes = [...new Set([...chainRows, ...orderRows].map((r) => r.stock_code))];
    for (const code of missingCodes) {
      await getPool().query(
        `INSERT INTO watchlist (stock_code, stock_name, market) VALUES ($1, $1, 'KOSPI') ON CONFLICT DO NOTHING`,
        [code],
      );
    }

    // 3. 전체 watchlist에서 이름 보정 필요 항목 처리 (6자리 한국 종목코드만)
    const { rows } = await getPool().query(
      `SELECT stock_code, stock_name FROM watchlist WHERE stock_code ~ '^[0-9]{6}$'`,
    );
    let fixed = 0;

    const needsFix = rows.filter(
      (row) =>
        !row.stock_name ||
        row.stock_name === row.stock_code ||
        /^\d{6}$/.test(row.stock_name) ||
        GARBLED_REGEX.test(row.stock_name),
    );

    if (needsFix.length === 0) {
      logger.info('🔧 종목명 보정 불필요 (모두 정상)', { component: 'KIS_INTEREST' });
      return { fixed: 0, total: rows.length };
    }

    logger.info(`🔧 KRX API로 ${needsFix.length}종목 병렬 보정 중...`, { component: 'KIS_INTEREST' });

    // KRX 전종목 리스트를 한 번만 조회 (rate limit 없음)
    const krxMap = new Map<string, string>();
    try {
      const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
      const resp = await fetch('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: 'https://data.krx.co.kr/',
          'User-Agent': 'Mozilla/5.0',
        },
        body: new URLSearchParams({
          bld: 'dbms/MDC/STAT/standard/MDCSTAT01901',
          mktId: 'ALL',
          trdDd: today,
          lang: 'ko',
          pageNo: '1',
          rowSize: '5000',
        }).toString(),
        signal: AbortSignal.timeout(KRX_REQUEST_TIMEOUT_MS),
      });
      const data = (await resp.json()) as { output?: Array<{ ISU_SRT_CD?: string; ISU_ABBRV?: string }> };
      if (Array.isArray(data.output)) {
        for (const item of data.output) {
          const code = String(item.ISU_SRT_CD ?? '').trim();
          const name = String(item.ISU_ABBRV ?? '').trim();
          if (code && name && !GARBLED_REGEX.test(name)) krxMap.set(code, name);
        }
        logger.info(`  KRX 전종목 ${krxMap.size}건 로드`, { component: 'KIS_INTEREST' });
      }
    } catch (e) {
      logger.warn(`  KRX 전종목 조회 실패: ${(e as Error).message}`, { component: 'KIS_INTEREST' });
    }

    for (const row of needsFix) {
      const resolved = krxMap.get(row.stock_code) ?? '';
      if (resolved) {
        await getPool().query('UPDATE watchlist SET stock_name = $1 WHERE stock_code = $2', [resolved, row.stock_code]);
        fixed++;
        logger.info(`  ✅ 보정: ${row.stock_code} → ${resolved}`, { component: 'KIS_INTEREST' });
      }
    }

    logger.info(`🔧 종목명 보정 완료: ${fixed}/${rows.length}건`, { component: 'KIS_INTEREST' });
    return { fixed, total: rows.length };
  } catch (e) {
    logger.warn(`종목명 보정 실패: ${(e as Error).message}`, { component: 'KIS_INTEREST' });
    return { fixed: 0, total: 0 };
  }
}
