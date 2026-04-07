import { config } from '../config/index.js';
import { kisRequest, overseasRateLimiter } from './client.js';

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

// ── KIS 해외주식 tr_id ──
const OVERSEAS_TR_ID = {
  PRICE: 'HHDFS00000300', // 해외주식 현재가
  DAILY_CHART: 'HHDFS76240000', // 해외주식 일봉
  BUY: config.isPaper ? 'VTTT1002U' : 'JTTT1002U', // 매수
  SELL: config.isPaper ? 'VTTT1001U' : 'JTTT1006U', // 매도
  BALANCE: config.isPaper ? 'VTTS3012R' : 'TTTS3012R', // 잔고
} as const;

// 거래소 코드
const EXCHANGE_MAP: Record<string, string> = {
  NYSE: 'NYS',
  NASDAQ: 'NAS',
  AMEX: 'AMS',
};

export interface OverseasPrice {
  stockCode: string;
  stockName: string;
  currentPrice: number; // USD
  changePrice: number;
  changePct: number;
  volume: number;
  exchange: string;
}

/**
 * 미국 주식 현재가 조회
 */
export async function getOverseasPrice(stockCode: string, exchange: string = 'NASDAQ'): Promise<OverseasPrice> {
  const excd = EXCHANGE_MAP[exchange] ?? 'NAS';

  const res = await overseasKisRequest({
    path: '/uapi/overseas-price/v1/quotations/price',
    trId: OVERSEAS_TR_ID.PRICE,
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
  };
}

/**
 * 미국 주식 일봉 차트
 */
export async function getOverseasDailyChart(stockCode: string, exchange: string = 'NASDAQ', days: number = 60) {
  const excd = EXCHANGE_MAP[exchange] ?? 'NAS';
  const endDate = new Date().toISOString().split('T')[0].replace(/-/g, '');

  const res = await overseasKisRequest({
    path: '/uapi/overseas-price/v1/quotations/dailyprice',
    trId: OVERSEAS_TR_ID.DAILY_CHART,
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
  const excd = EXCHANGE_MAP[exchange] ?? 'NAS';
  const trId = side === 'BUY' ? OVERSEAS_TR_ID.BUY : OVERSEAS_TR_ID.SELL;

  const body: Record<string, string> = {
    CANO: config.kis.accountNo,
    ACNT_PRDT_CD: config.kis.accountProductCode,
    OVRS_EXCG_CD: excd,
    PDNO: stockCode,
    ORD_QTY: String(quantity),
    OVRS_ORD_UNPR: price ? String(price) : '0',
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
 * 해외 주식 잔고 조회
 */
export async function getOverseasBalance() {
  const res = await overseasKisRequest({
    path: '/uapi/overseas-stock/v1/trading/inquire-balance',
    trId: OVERSEAS_TR_ID.BALANCE,
    params: {
      CANO: config.kis.accountNo,
      ACNT_PRDT_CD: config.kis.accountProductCode,
      OVRS_EXCG_CD: 'NASD',
      TR_CRCY_CD: 'USD',
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
    currency: 'USD',
  }));
}
