/**
 * 시장 시그널 API — 체결강도, 공매도, 프로그램매매, 수급 등
 * KIS OpenAPI 추가 데이터로 매매 정확도 향상
 */
import { KIS_TR_ID } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { kisRequest, marketDataRateLimiter } from './client.js';

/** NaN 방지: API 응답 필드가 undefined/비정상이면 fallback 반환 */
const safeNum = (v: string | undefined | null, fallback = 0): number => {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** 공매도 조회 시 조회 기간 (영업일 기준) */
const SHORT_SELLING_LOOKBACK_DAYS = 5;
/** 대차거래 조회 시 조회 기간 (영업일 기준) */
const STOCK_LENDING_LOOKBACK_DAYS = 5;
/** 배치 시그널 수집 시 동시 종목 수 (종목당 6개 API x 3종목 = 18 동시 호출 → rate limit 이내) */
const SIGNAL_BATCH_CONCURRENCY = 3;

// ── 체결강도 (매수/매도 체결 비율) ──
export interface TradingIntensity {
  stockCode: string;
  /** 체결강도 (>100 = 매수 우위, <100 = 매도 우위) */
  intensity: number;
  /** 전일 체결강도 */
  prevIntensity: number;
  /** 순매수 체결량 */
  netBuyVolume: number;
}

export async function getTradingIntensity(stockCode: string): Promise<TradingIntensity | null> {
  try {
    await marketDataRateLimiter.acquire();
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/inquire-ccnl-trend',
      trId: KIS_TR_ID.SIGNAL.TRADING_INTENSITY,
      useRealUrl: true,
      skipRateLimiter: true,
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: stockCode,
      },
    });
    const o = res.output as Record<string, string>;
    if (!o) return null;
    return {
      stockCode,
      intensity: safeNum(o.tday_rltv), // 당일 체결강도
      prevIntensity: safeNum(o.d1_rltv), // 전일 체결강도
      netBuyVolume: safeNum(o.shnu_cnqn_smtn) - safeNum(o.seln_cnqn_smtn), // 매수총량 - 매도총량
    };
  } catch {
    return null;
  }
}

// ── 공매도 일별 추이 ──
export interface ShortSellingInfo {
  stockCode: string;
  /** 공매도 거래량 */
  shortVolume: number;
  /** 공매도 비율 (%) */
  shortRatio: number;
  /** 공매도 잔고 */
  shortBalance: number;
}

export async function getShortSelling(stockCode: string): Promise<ShortSellingInfo | null> {
  try {
    await marketDataRateLimiter.acquire();
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/inquire-daily-shortselling',
      trId: KIS_TR_ID.SIGNAL.SHORT_SELLING,
      useRealUrl: true,
      skipRateLimiter: true,
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: stockCode,
        FID_INPUT_DATE_1: formatKstDate(-SHORT_SELLING_LOOKBACK_DAYS),
        FID_INPUT_DATE_2: formatKstDate(0),
      },
    });
    const items = (res.output1 ?? res.output ?? []) as Record<string, string>[];
    if (!Array.isArray(items) || items.length === 0) return null;
    const latest = items[0]; // 최근 일자
    return {
      stockCode,
      shortVolume: safeNum(latest.shrt_trde_vol || latest.total_shrt_vol),
      shortRatio: safeNum(latest.shrt_trde_prc_rt || latest.total_shrt_rt),
      shortBalance: safeNum(latest.shrt_bal_qty),
    };
  } catch {
    return null;
  }
}

// ── 프로그램매매 종합 ──
export interface ProgramTrading {
  /** 프로그램 순매수 금액 (백만원) */
  netBuyAmountMil: number;
  /** 차익 순매수 금액 */
  arbitrageNetMil: number;
  /** 비차익 순매수 금액 */
  nonArbitrageNetMil: number;
}

export async function getProgramTrading(): Promise<ProgramTrading | null> {
  try {
    await marketDataRateLimiter.acquire();
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/program-trade-by-stock',
      trId: KIS_TR_ID.SIGNAL.PROGRAM_TRADING,
      useRealUrl: true,
      skipRateLimiter: true,
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: '0001', // KOSPI 전체
      },
    });
    const o = res.output as Record<string, string>;
    if (!o) return null;
    return {
      netBuyAmountMil: Math.round(safeNum(o.tot_ntby_qty) / 1_000_000),
      arbitrageNetMil: Math.round(safeNum(o.arbt_ntby_qty) / 1_000_000),
      nonArbitrageNetMil: Math.round(safeNum(o.narbt_ntby_qty) / 1_000_000),
    };
  } catch {
    return null;
  }
}

// ── 호가잔량 분석 (개별 종목) ──
export interface OrderbookDepth {
  stockCode: string;
  /** 총 매수 잔량 */
  totalBidVolume: number;
  /** 총 매도 잔량 */
  totalAskVolume: number;
  /** 매수/매도 비율 (>1 = 매수벽, <1 = 매도벽) */
  bidAskRatio: number;
}

export async function getOrderbookDepth(stockCode: string): Promise<OrderbookDepth | null> {
  try {
    await marketDataRateLimiter.acquire();
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn',
      trId: 'FHKST01010200', // 호가 조회 (기존)
      useRealUrl: true,
      skipRateLimiter: true,
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: stockCode,
      },
    });
    const o = res.output as Record<string, string>;
    if (!o) return null;
    const totalBid = safeNum(o.total_bidp_rsqn);
    const totalAsk = safeNum(o.total_askp_rsqn);
    return {
      stockCode,
      totalBidVolume: totalBid,
      totalAskVolume: totalAsk,
      bidAskRatio: totalAsk > 0 ? totalBid / totalAsk : 1,
    };
  } catch {
    return null;
  }
}

// ── 업종별 지수 ──
export interface SectorIndex {
  sectorCode: string;
  sectorName: string;
  currentIndex: number;
  changePct: number;
  volume: number;
}

export async function getSectorIndices(): Promise<SectorIndex[]> {
  try {
    await marketDataRateLimiter.acquire();
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/inquire-daily-indexchart',
      trId: KIS_TR_ID.SIGNAL.SECTOR_INDEX,
      useRealUrl: true,
      skipRateLimiter: true,
      params: {
        FID_COND_MRKT_DIV_CODE: 'U', // 업종
        FID_INPUT_ISCD: '0001', // KOSPI 전체 업종
        FID_INPUT_DATE_1: formatKstDate(0),
        FID_INPUT_DATE_2: formatKstDate(0),
        FID_PERIOD_DIV_CODE: 'D',
      },
    });
    const items = (res.output2 ?? res.output ?? []) as Record<string, string>[];
    if (!Array.isArray(items)) return [];
    return items.slice(0, 20).map((o) => ({
      sectorCode: o.idx_cd || o.bstp_cls_code || '',
      sectorName: o.idx_nm || o.bstp_nmix_prpr || '',
      currentIndex: safeNum(o.bstp_nmix_prpr || o.idx_prpr),
      changePct: safeNum(o.bstp_nmix_prdy_ctrt || o.idx_prdy_ctrt),
      volume: safeNum(o.acml_vol),
    }));
  } catch {
    return [];
  }
}

// ── 투자자별 추정가집계 (장중 실시간) ──
export interface IntradayInvestorEstimate {
  stockCode: string;
  /** 외국인 추정 순매수 금액 (백만원) */
  foreignNetEstMil: number;
  /** 기관 추정 순매수 금액 (백만원) */
  institutionNetEstMil: number;
}

export async function getIntradayInvestorEstimate(stockCode: string): Promise<IntradayInvestorEstimate | null> {
  try {
    await marketDataRateLimiter.acquire();
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/inquire-investor-estimate',
      trId: KIS_TR_ID.SIGNAL.INTRADAY_INVESTOR,
      useRealUrl: true,
      skipRateLimiter: true,
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: stockCode,
      },
    });
    const items = (res.output ?? []) as Record<string, string>[];
    if (!Array.isArray(items) || items.length === 0) return null;
    const latest = items[0];
    return {
      stockCode,
      foreignNetEstMil: Math.round(safeNum(latest.frgn_ntby_tr_pbmn) / 1_000_000),
      institutionNetEstMil: Math.round(safeNum(latest.orgn_ntby_tr_pbmn) / 1_000_000),
    };
  } catch {
    return null;
  }
}

// ── 거래원(회원사) 정보 ──
export interface BrokerInfo {
  stockCode: string;
  /** 매수 상위 5 증권사 */
  topBuyers: Array<{ name: string; volume: number }>;
  /** 매도 상위 5 증권사 */
  topSellers: Array<{ name: string; volume: number }>;
  /** 외국계 순매수 여부 */
  foreignBrokerNetBuy: boolean;
}

export async function getBrokerInfo(stockCode: string): Promise<BrokerInfo | null> {
  try {
    await marketDataRateLimiter.acquire();
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/inquire-member',
      trId: KIS_TR_ID.QUOTE.BROKER_INFO,
      useRealUrl: true,
      skipRateLimiter: true,
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: stockCode,
      },
    });
    const items = (res.output ?? []) as Record<string, string>[];
    if (!Array.isArray(items)) return null;

    const topBuyers: Array<{ name: string; volume: number }> = [];
    const topSellers: Array<{ name: string; volume: number }> = [];
    let foreignBrokerNetBuy = false;

    for (const row of items.slice(0, 5)) {
      const buyName = row.shnu_mbcr_nm || '';   // 매수 회원사 (shnu=매수)
      const sellName = row.seln_mbcr_nm || ''; // 매도 회원사 (seln=매도)
      const buyVol = safeNum(row.shnu_vol);
      const sellVol = safeNum(row.seln_vol);
      if (buyName) topBuyers.push({ name: buyName, volume: buyVol });
      if (sellName) topSellers.push({ name: sellName, volume: sellVol });
      // 외국계 증권사 패턴 (모건스탠리, CS, 골드만, UBS, 메릴린치 등)
      const foreignPatterns = ['모건', 'CS', '골드만', 'UBS', '메릴', 'JP모건', 'CLSA', '씨티', 'BNP'];
      if (foreignPatterns.some((p) => buyName.includes(p))) foreignBrokerNetBuy = true;
    }

    return { stockCode, topBuyers, topSellers, foreignBrokerNetBuy };
  } catch {
    return null;
  }
}

// ── 예상체결 순위 (프리마켓 갭 예측) ──
export interface ExpectedFillRanking {
  stockCode: string;
  stockName: string;
  expectedPrice: number;
  expectedChangePct: number;
  expectedVolume: number;
}

export async function getExpectedFillRanking(
  direction: 'up' | 'down' = 'up',
  limit = 20,
): Promise<ExpectedFillRanking[]> {
  try {
    await marketDataRateLimiter.acquire();
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/ranking/expected-execution-fluctuation',
      trId: KIS_TR_ID.SIGNAL.EXPECTED_FILL,
      useRealUrl: true,
      skipRateLimiter: true,
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_COND_SCR_DIV_CODE: '20182',
        FID_INPUT_ISCD: '0001',
        FID_RANK_SORT_CLS_CODE: direction === 'up' ? '0' : '1',
        FID_DIV_CLS_CODE: '0',
        FID_TRGT_CLS_CODE: '111111111',
        FID_TRGT_EXLS_CLS_CODE: '000000',
        FID_INPUT_PRICE_1: '',
        FID_INPUT_PRICE_2: '',
        FID_VOL_CNT: '',
        FID_INPUT_DATE_1: '',
      },
    });
    const items = (res.output as Record<string, string>[]) ?? [];
    return items.slice(0, limit).map((o) => ({
      stockCode: o.stck_shrn_iscd || '',
      stockName: o.hts_kor_isnm || '',
      expectedPrice: safeNum(o.antc_cnpr),
      expectedChangePct: safeNum(o.antc_cntg_prdy_ctrt || o.prdy_ctrt),
      expectedVolume: safeNum(o.antc_vol),
    }));
  } catch {
    return [];
  }
}

// ── 신용잔고 순위 ──
export interface CreditBalance {
  stockCode: string;
  stockName: string;
  /** 신용잔고율 (%) */
  creditBalanceRatio: number;
  /** 신용잔고 */
  creditBalance: number;
}

export async function getCreditBalanceRanking(limit = 30): Promise<CreditBalance[]> {
  try {
    await marketDataRateLimiter.acquire();
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/ranking/credit-balance',
      trId: KIS_TR_ID.SIGNAL.CREDIT_BALANCE,
      useRealUrl: true,
      skipRateLimiter: true,
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_COND_SCR_DIV_CODE: '20170',
        FID_INPUT_ISCD: '0001',
        FID_RANK_SORT_CLS_CODE: '0',
        FID_DIV_CLS_CODE: '0',
        FID_TRGT_CLS_CODE: '111111111',
        FID_TRGT_EXLS_CLS_CODE: '000000',
        FID_INPUT_PRICE_1: '',
        FID_INPUT_PRICE_2: '',
        FID_VOL_CNT: '',
        FID_INPUT_DATE_1: '',
      },
    });
    const items = (res.output as Record<string, string>[]) ?? [];
    return items.slice(0, limit).map((o) => ({
      stockCode: o.stck_shrn_iscd || '',
      stockName: o.hts_kor_isnm || '',
      creditBalanceRatio: safeNum(o.crdt_rate),
      creditBalance: safeNum(o.crdt_bal),
    }));
  } catch {
    return [];
  }
}

// ── 대차거래 추이 ──
export interface StockLending {
  stockCode: string;
  /** 대차잔고 */
  lendingBalance: number;
  /** 대차잔고 증감 */
  lendingChange: number;
  /** 대차잔고율 (%) */
  lendingRatio: number;
}

export async function getStockLending(stockCode: string): Promise<StockLending | null> {
  try {
    await marketDataRateLimiter.acquire();
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/inquire-daily-stock-lending',
      trId: KIS_TR_ID.SIGNAL.STOCK_LENDING,
      useRealUrl: true,
      skipRateLimiter: true,
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: stockCode,
        FID_INPUT_DATE_1: formatKstDate(-STOCK_LENDING_LOOKBACK_DAYS),
        FID_INPUT_DATE_2: formatKstDate(0),
      },
    });
    const items = (res.output1 ?? res.output ?? []) as Record<string, string>[];
    if (!Array.isArray(items) || items.length === 0) return null;
    const latest = items[0];
    return {
      stockCode,
      lendingBalance: safeNum(latest.sll_bal_qty || latest.lend_bal),
      lendingChange: safeNum(latest.sll_bal_incr || latest.lend_chg),
      lendingRatio: safeNum(latest.sll_bal_rt || latest.lend_rt),
    };
  } catch {
    return null;
  }
}

// ── 신고가/신저가 근접 종목 ──
export interface Near52WeekHighLow {
  stockCode: string;
  stockName: string;
  currentPrice: number;
  /** 52주 고가 대비 (%) — 음수면 고점 아래 */
  pctFromHigh: number;
  /** 52주 저가 대비 (%) — 양수면 저점 위 */
  pctFromLow: number;
}

export async function getNear52WeekHighLow(type: 'high' | 'low' = 'high', limit = 20): Promise<Near52WeekHighLow[]> {
  try {
    await marketDataRateLimiter.acquire();
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/ranking/near-52w-high-low',
      trId: KIS_TR_ID.SIGNAL.NEAR_52W_HIGH_LOW,
      useRealUrl: true,
      skipRateLimiter: true,
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_COND_SCR_DIV_CODE: '20187',
        FID_INPUT_ISCD: '0001',
        FID_RANK_SORT_CLS_CODE: type === 'high' ? '0' : '1',
        FID_DIV_CLS_CODE: '0',
        FID_TRGT_CLS_CODE: '111111111',
        FID_TRGT_EXLS_CLS_CODE: '000000',
        FID_INPUT_PRICE_1: '',
        FID_INPUT_PRICE_2: '',
        FID_VOL_CNT: '',
        FID_INPUT_DATE_1: '',
      },
    });
    const items = (res.output as Record<string, string>[]) ?? [];
    return items.slice(0, limit).map((o) => ({
      stockCode: o.stck_shrn_iscd || '',
      stockName: o.hts_kor_isnm || '',
      currentPrice: safeNum(o.stck_prpr),
      pctFromHigh: safeNum(o.d250_hgpr_vrss_prpr_rate),
      pctFromLow: safeNum(o.d250_lwpr_vrss_prpr_rate),
    }));
  } catch {
    return [];
  }
}

// ── 배치 시그널 수집 (종목별) ──
export interface StockSignals {
  tradingIntensity: TradingIntensity | null;
  shortSelling: ShortSellingInfo | null;
  orderbookDepth: OrderbookDepth | null;
  intradayInvestor: IntradayInvestorEstimate | null;
  brokerInfo: BrokerInfo | null;
  stockLending: StockLending | null;
}

/**
 * 개별 종목의 모든 시그널을 병렬 수집
 * 실패한 항목은 null — 파이프라인 진행에 영향 없음
 */
export async function getStockSignals(stockCode: string): Promise<StockSignals> {
  const [tradingIntensity, shortSelling, orderbookDepth, intradayInvestor, brokerInfo, stockLending] =
    await Promise.allSettled([
      getTradingIntensity(stockCode),
      getShortSelling(stockCode),
      getOrderbookDepth(stockCode),
      getIntradayInvestorEstimate(stockCode),
      getBrokerInfo(stockCode),
      getStockLending(stockCode),
    ]);

  return {
    tradingIntensity: tradingIntensity.status === 'fulfilled' ? tradingIntensity.value : null,
    shortSelling: shortSelling.status === 'fulfilled' ? shortSelling.value : null,
    orderbookDepth: orderbookDepth.status === 'fulfilled' ? orderbookDepth.value : null,
    intradayInvestor: intradayInvestor.status === 'fulfilled' ? intradayInvestor.value : null,
    brokerInfo: brokerInfo.status === 'fulfilled' ? brokerInfo.value : null,
    stockLending: stockLending.status === 'fulfilled' ? stockLending.value : null,
  };
}

/**
 * 복수 종목 시그널 일괄 수집 (배치 5개씩, rate limit 준수)
 */
export async function getBatchStockSignals(stockCodes: string[]): Promise<Map<string, StockSignals>> {
  const result = new Map<string, StockSignals>();
  const BATCH = SIGNAL_BATCH_CONCURRENCY;
  for (let i = 0; i < stockCodes.length; i += BATCH) {
    const slice = stockCodes.slice(i, i + BATCH);
    const settled = await Promise.allSettled(slice.map((c) => getStockSignals(c)));
    for (let j = 0; j < slice.length; j++) {
      const r = settled[j];
      if (r.status === 'fulfilled') result.set(slice[j], r.value);
    }
  }

  logger.info(`시그널 수집 완료: ${result.size}/${stockCodes.length}개 종목`, { component: 'SIGNALS' });
  return result;
}

// ── 유틸 ──
function formatKstDate(daysOffset: number): string {
  const d = new Date(Date.now() + 9 * 60 * 60_000 + daysOffset * 24 * 60 * 60_000);
  return d.toISOString().split('T')[0].replace(/-/g, '');
}
