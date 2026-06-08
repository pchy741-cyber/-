import { config } from '../config/index.js';
import { getCtxIsPaper } from '../config/context.js';
import { kisRequest, overseasRateLimiter } from './client.js';
import { logger } from '../utils/logger.js';

/** 해외 전용 KIS API 호출 — 국내와 별도 rate limiter 사용 */
async function overseasKisRequest<T = unknown>(opts: Parameters<typeof kisRequest<T>>[0]): ReturnType<typeof kisRequest<T>> {
  await overseasRateLimiter.acquire();
  return kisRequest<T>({ ...opts, skipRateLimiter: true });
}

/**
 * 🇺🇸 미국 주식 매매 모듈 (KIS 해외주식 API)
 *
 * KIS OpenAPI는 미국 주식도 지원:
 * - NYSE, NASDAQ 현재가 조회
 * - 미국 주식 매수/매도 주문
 * - 해외 주식 잔고 조회
 *
 * CEO 의견: "국내주식보다 달러강세인데 미국주식도"
 * → 같은 AI 파이프라인으로 미국 ETF/주식도 자동매매 가능
 */

// ── KIS 해외주식 tr_id (모드 전환 시 항상 최신값 반영되도록 getter 사용) ──
function getOverseasTrId() {
  const p = getCtxIsPaper();
  return {
    PRICE: 'HHDFS00000300',
    DAILY_CHART: 'HHDFS76240000',
    BUY: p ? 'VTTT1002U' : 'TTTT1002U',
    SELL: p ? 'VTTT1001U' : 'TTTT1006U',
    BALANCE: p ? 'VTTS3012R' : 'TTTS3012R',
    BUYABLE: p ? 'VTTS3007R' : 'TTTS3007R',
  };
}

// KIS API 거래소 코드 (OVRS_EXCG_CD / EXCD)
const EXCHANGE_MAP: Record<string, string> = {
  // 미국
  NYSE: 'NYS',
  NASDAQ: 'NAS',
  AMEX: 'AMS',
  // 아시아
  TSE: 'TSE',     // 일본 (도쿄증권거래소) — KIS코드: TKSE
  TKSE: 'TSE',    // 일본 alias
  TPE: 'TPE',     // 대만 (타이베이증권거래소)
  TWSE: 'TPE',    // 대만 alias (Taiwan Stock Exchange)
  SEHK: 'HKS',    // 홍콩 (홍콩증권거래소) — KIS코드: SEHK
  HKS: 'HKS',     // 홍콩 alias
  SSE: 'SHA',     // 중국 상해 — KIS코드: SHAA
  SHAA: 'SHA',    // 상해 alias
  SZSE: 'SZA',    // 중국 심천 — KIS코드: SZAA
  SZAA: 'SZA',    // 심천 alias
  HASE: 'HNX',    // 베트남 하노이
  VNSE: 'HSX',    // 베트남 호치민
};

// 시세 조회용 거래소 코드 (EXCD 파라미터 — 주문용과 다를 수 있음)
const QUOTE_EXCD_MAP: Record<string, string> = {
  NYSE: 'NYS', NASDAQ: 'NAS', AMEX: 'AMS',
  TSE: 'TSE', TKSE: 'TSE', TPE: 'TPE', TWSE: 'TPE',
  SEHK: 'HKS', HKS: 'HKS',
  SSE: 'SHS', SHAA: 'SHS', SZSE: 'SZS', SZAA: 'SZS',
  HASE: 'HNX', VNSE: 'HSX',
};

// 주문용 거래소 코드 (OVRS_EXCG_CD)
const ORDER_EXCD_MAP: Record<string, string> = {
  NYSE: 'NYSE', NASDAQ: 'NASD', AMEX: 'AMEX',
  TSE: 'TKSE', TKSE: 'TKSE', TPE: 'TPEX', TWSE: 'TPEX',
  SEHK: 'SEHK', HKS: 'SEHK',
  SSE: 'SHAA', SHAA: 'SHAA', SZSE: 'SZAA', SZAA: 'SZAA',
  HASE: 'HASE', VNSE: 'VNSE',
};

const BALANCE_CURRENCY_MAP: Record<string, string> = {
  NYSE: 'USD',
  NASDAQ: 'USD',
  AMEX: 'USD',
  TSE: 'JPY',
  TKSE: 'JPY',
  TPE: 'TWD',
  TWSE: 'TWD',
  SEHK: 'HKD',
  HKS: 'HKD',
  SSE: 'CNY',
  SHAA: 'CNY',
  SZSE: 'CNY',
  SZAA: 'CNY',
  HASE: 'VND',
  VNSE: 'VND',
};

export interface OverseasPrice {
  stockCode: string;
  stockName: string;
  currentPrice: number; // USD
  changePrice: number;
  changePct: number;
  volume: number;
  exchange: string;
  dayHigh: number;   // 당일 고가
  dayLow: number;    // 당일 저가
  dayOpen: number;   // 당일 시가
}

/**
 * 미국 주식 현재가 조회
 */
export async function getOverseasPrice(stockCode: string, exchange: string = 'NASDAQ'): Promise<OverseasPrice> {
  const excd = QUOTE_EXCD_MAP[exchange] ?? EXCHANGE_MAP[exchange] ?? 'NAS';

  const res = await overseasKisRequest({
    path: '/uapi/overseas-price/v1/quotations/price',
    trId: getOverseasTrId().PRICE,
    useRealUrl: true,
    params: {
      AUTH: '',
      EXCD: excd,
      SYMB: stockCode,
    },
  });

  const o = res.output as Record<string, string>;

  return {
    stockCode,
    stockName: o.rsym ?? stockCode,
    currentPrice: Number(o.last ?? 0),
    changePrice: Number(o.diff ?? 0),
    changePct: Number(o.rate ?? 0),
    volume: Number(o.tvol ?? 0),
    exchange,
    dayHigh: Number(o.high ?? o.last ?? 0),
    dayLow: Number(o.low ?? o.last ?? 0),
    dayOpen: Number(o.open ?? o.last ?? 0),
  };
}

/**
 * 미국 주식 일봉 차트
 */
export async function getOverseasDailyChart(stockCode: string, exchange: string = 'NASDAQ', days: number = 60) {
  const excd = QUOTE_EXCD_MAP[exchange] ?? EXCHANGE_MAP[exchange] ?? 'NAS';
  const endDate = new Date().toISOString().split('T')[0].replace(/-/g, '');

  const res = await overseasKisRequest({
    path: '/uapi/overseas-price/v1/quotations/dailyprice',
    trId: getOverseasTrId().DAILY_CHART,
    useRealUrl: true,
    params: {
      AUTH: '',
      EXCD: excd,
      SYMB: stockCode,
      GUBN: '0', // 일
      BYMD: endDate,
      MODP: '0',
    },
  });

  const raw = (res.output2 ?? res.output ?? []) as unknown;
  const items = Array.isArray(raw) ? (raw as Record<string, string>[]) : [];

  return items.slice(0, days).map((c) => ({
    date: c.xymd ?? '',
    open: Number(c.open ?? 0),
    high: Number(c.high ?? 0),
    low: Number(c.low ?? 0),
    close: Number(c.clos ?? 0),
    volume: Number(c.tvol ?? 0),
  }));
}

/**
 * 미국 주식 매수/매도 주문
 */
export async function placeOverseasOrder(params: {
  stockCode: string;
  exchange?: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price?: number; // 지정가 (없으면 시장가)
}) {
  const { stockCode, exchange = 'NASDAQ', side, quantity, price } = params;
  const excd = ORDER_EXCD_MAP[exchange] ?? EXCHANGE_MAP[exchange] ?? 'NAS';
  const trId = side === 'BUY' ? getOverseasTrId().BUY : getOverseasTrId().SELL;

  const body: Record<string, string> = {
    CANO: config.kis.accountNo,
    ACNT_PRDT_CD: config.kis.accountProductCode,
    OVRS_EXCG_CD: excd,
    PDNO: stockCode,
    ORD_QTY: String(quantity),
    OVRS_ORD_UNPR: price ? price.toFixed(2) : '0',
    SLL_TYPE: side === 'SELL' ? '00' : '',
    ORD_SVR_DVSN_CD: '0',
    ORD_DVSN: price ? '00' : '01', // 지정가 / 시장가
  };

  const res = await overseasKisRequest({
    path: '/uapi/overseas-stock/v1/trading/order',
    method: 'POST',
    trId,
    body,
  });

  const output = res.output as Record<string, string>;

  return {
    success: res.rtCd === '0',
    orderNo: output?.ODNO ?? '',
    message: res.msg1,
  };
}

/**
 * 해외주식 소수점 매수 (금액 기준 — KIS TTTT3016U)
 * 정수 주문 최소단위보다 작은 금액도 매수 가능
 */
export async function placeFractionalOverseasBuy(params: {
  stockCode: string;
  exchange?: string;
  amountUsd: number; // 달러 금액 기준
}): Promise<{ success: boolean; orderNo: string; message: string }> {
  const { stockCode, exchange = 'NASDAQ', amountUsd } = params;
  const excd = ORDER_EXCD_MAP[exchange] ?? EXCHANGE_MAP[exchange] ?? 'NAS';
  const trId = getCtxIsPaper() ? 'VTTT3016U' : 'TTTT3016U';

  const body: Record<string, string> = {
    CANO: config.kis.accountNo,
    ACNT_PRDT_CD: config.kis.accountProductCode,
    OVRS_EXCG_CD: excd,
    PDNO: stockCode,
    ORD_QTY: '0',                          // 소수점 매수: 수량 0 = 금액 기준
    OVRS_ORD_UNPR: '0',                    // 시장가
    ORD_SVR_DVSN_CD: '0',
    ORD_DVSN: '01',                        // 시장가
    OVRS_STCK_AMT: String(Math.floor(amountUsd)), // 주문 금액 (달러)
  };

  const res = await overseasKisRequest({
    path: '/uapi/overseas-stock/v1/trading/order',
    method: 'POST',
    trId,
    body,
  });

  const output = res.output as Record<string, string>;
  return {
    success: res.rtCd === '0',
    orderNo: output?.ODNO ?? '',
    message: res.msg1,
  };
}

/**
 * 해외 주식 주문 취소
 */
export async function cancelOverseasOrder(params: {
  stockCode: string;
  exchange?: string;
  orderNo: string;
  quantity: number;
}): Promise<{ success: boolean; message: string }> {
  const { stockCode, exchange = 'NASDAQ', orderNo, quantity } = params;
  const excd = ORDER_EXCD_MAP[exchange] ?? 'NASD';
  const trId = getCtxIsPaper() ? 'VTTT1004U' : 'TTTT1004U';

  const body: Record<string, string> = {
    CANO: config.kis.accountNo,
    ACNT_PRDT_CD: config.kis.accountProductCode,
    OVRS_EXCG_CD: excd,
    PDNO: stockCode,
    ORGN_ODNO: orderNo,
    ORD_SVR_DVSN_CD: '0',
    RVSE_CNCL_DVSN_CD: '02', // 02 = 취소
    ORD_QTY: String(quantity),
    OVRS_ORD_UNPR: '0',
    ORD_DVSN: '00',
  };

  const res = await overseasKisRequest({ path: '/uapi/overseas-stock/v1/trading/order-rvsecncl', method: 'POST', trId, body });
  return { success: res.rtCd === '0', message: res.msg1 };
}

/**
 * 해외 주식 잔고 조회
 */
export async function getOverseasBalance(exchange: string = 'NASDAQ') {
  const excd = ORDER_EXCD_MAP[exchange] ?? EXCHANGE_MAP[exchange] ?? 'NASD';
  const currency = BALANCE_CURRENCY_MAP[exchange] ?? 'USD';

  const res = await overseasKisRequest({
    path: '/uapi/overseas-stock/v1/trading/inquire-balance',
    trId: getOverseasTrId().BALANCE,
    params: {
      CANO: config.kis.accountNo,
      ACNT_PRDT_CD: config.kis.accountProductCode,
      OVRS_EXCG_CD: excd,
      TR_CRCY_CD: currency,
      CTX_AREA_FK200: '',
      CTX_AREA_NK200: '',
    },
  });

  const items = (res.output1 ?? []) as Record<string, string>[];

  return items.map((item) => ({
    stockCode: item.ovrs_pdno ?? '',
    stockName: item.ovrs_item_name ?? '',
    quantity: Number(item.ovrs_cblc_qty ?? 0),
    avgBuyPrice: Number(item.pchs_avg_pric ?? 0),
    currentPrice: Number(item.now_pric2 ?? 0),
    evalAmount: Number(item.ovrs_stck_evlu_amt ?? 0),
    profitLoss: Number(item.frcr_evlu_pfls_amt ?? 0),
    profitLossPct: Number(item.evlu_pfls_rt ?? 0),
    currency,
  }));
}

/**
 * 해외주문가능금액 조회 (KIS API) — 통합증거금 기준
 * USD + KRW(원화) 모두 반환. 통합증거금 계좌는 원화 필드가 정확.
 */
export interface OverseasBuyableResult {
  usd: number;        // ord_psbl_frcr_amt: 실제 주문가능 외화(USD)
  maxUsd: number;     // frcr_ord_psbl_amt1: 원화 포함 통합증거금 환산 최대 USD
  krw: number | null; // 주문가능원화 (통합증거금 기준 KRW)
  exrt: number;       // KIS 적용 환율
}

export async function getOverseasBuyableAmount(exchange: string = 'NASDAQ'): Promise<OverseasBuyableResult | null> {
  try {
    const excd = ORDER_EXCD_MAP[exchange] ?? EXCHANGE_MAP[exchange] ?? 'NASD';
    // ITEM_CD 필수 — 임의 종목(AAPL)으로 총 주문가능금액 조회 (종목 무관, 계좌 전체 가용액 반환)
    const res = await overseasKisRequest({
      path: '/uapi/overseas-stock/v1/trading/inquire-psamount',
      trId: getOverseasTrId().BUYABLE,
      params: {
        CANO: config.kis.accountNo,
        ACNT_PRDT_CD: config.kis.accountProductCode,
        OVRS_EXCG_CD: excd,
        OVRS_ORD_UNPR: '0',
        ITEM_CD: 'AAPL',
      },
    });

    const output = res.output as Record<string, string>;

    // 디버그: 전체 응답 필드 로깅 (KRW 필드 식별용)
    if (output) {
      const fields = Object.entries(output)
        .filter(([, v]) => v !== '' && v !== '0' && v !== '0.00')
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      logger.info(`💱 psamount 응답: ${fields}`, { component: 'OVERSEAS' });
    }

    const exrt = Number(output?.exrt ?? 0);

    // 통합증거금 psamount 필드 매핑 (tr_crcy_cd=USD 기준):
    // ord_psbl_frcr_amt: 실제 주문가능 외화금액 (KIS 앱 "달러화" 표시값) ← 외화 풀만
    // frcr_ord_psbl_amt1: 원화 포함 이론적 최대 외화주문가능금액 (KRW→USD 환산 포함) ← 통합증거금 전체
    // ovrs_ord_psbl_amt: 해외주문가능금액 (USD, ord_psbl_frcr_amt과 유사)
    const usd = Number(output?.ord_psbl_frcr_amt ?? output?.ovrs_ord_psbl_amt ?? 0);
    const maxUsd = Number(output?.frcr_ord_psbl_amt1 ?? 0);

    // KRW: 통합증거금 기준 주문가능원화 = maxUsd × 환율
    // maxUsd는 원화 풀까지 포함한 최대 주문가능액 (KIS 앱 "주문가능원화" / 환율)
    const krw = exrt > 0 ? Math.round(maxUsd * exrt) : null;

    return { usd, maxUsd, krw, exrt };
  } catch {
    return null;
  }
}
