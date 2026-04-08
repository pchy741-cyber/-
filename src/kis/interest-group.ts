import { config } from '../config/index.js';
import { getActiveWatchlist, upsertWatchlistItem } from '../db/client.js';
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
        market: item.mrkt_div_cls_code === '2' ? 'KOSDAQ' as const : 'KOSPI' as const,
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
      logger.info(`  그룹 ${g}: ${stocks.length}종목 (${stocks.map((s) => s.stockName).join(', ')})`, { component: 'KIS_INTEREST' });
    }
    await new Promise((r) => setTimeout(r, 200));
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
      } catch { /* use code as fallback */ }
    }

    await upsertWatchlistItem({
      stock_code: code,
      stock_name: name,
      market: stock.market,
    });

    added.push(`${name}(${code})`);
    logger.info(`  ✅ 추가: ${name} (${code}) [${stock.market}]`, { component: 'KIS_INTEREST' });
    await new Promise((r) => setTimeout(r, 200));
  }

  const result = { added, total: allStocks.size };
  logger.info(`🔄 KIS 관심종목 동기화 완료: 총 ${allStocks.size}종목, 신규 ${added.length}종목 추가`, { component: 'KIS_INTEREST' });

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
      } catch { /* fallback to KOSPI */ }
      await new Promise((r) => setTimeout(r, 300));

      await upsertWatchlistItem({
        stock_code: pos.stockCode,
        stock_name: pos.stockName,
        market,
      });

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
