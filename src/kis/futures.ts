/**
 * KIS 해외선물 API 클라이언트
 * - 마이크로 선물 (MES, MNQ) 극소액 트레이딩용
 * - 완전 격리: 별도 예산, 명시적 승인 필요
 */
import { config } from '../config/index.js';
import { kisRequest, overseasRateLimiter } from './client.js';
import { logger } from '../utils/logger.js';

const COMP = 'FUTURES';

async function futuresKisRequest<T = unknown>(opts: Parameters<typeof kisRequest<T>>[0]): ReturnType<typeof kisRequest<T>> {
  await overseasRateLimiter.acquire();
  return kisRequest<T>({ ...opts, skipRateLimiter: true });
}

// 선물 월코드: F=1월, G=2, H=3, J=4, K=5, M=6, N=7, Q=8, U=9, V=10, X=11, Z=12
const MONTH_CODES = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];

/** 현재 활성 계약 심볼 생성 (예: MESU25) */
export function getActiveSymbol(product: string): string {
  const now = new Date();
  let m = now.getUTCMonth();
  let y = now.getUTCFullYear() % 100;
  // CME 분기 만기: 3,6,9,12 (H,M,U,Z)
  const quarterMonths = [2, 5, 8, 11]; // 0-indexed
  // 다음 분기월 찾기
  let nextQ = quarterMonths.find(q => q >= m);
  if (nextQ === undefined) { nextQ = 2; y += 1; } // 다음해 3월
  // 만기일 전 2주면 다음 분기로 롤
  if (nextQ === m && now.getUTCDate() > 14) {
    const idx = quarterMonths.indexOf(nextQ);
    if (idx < 3) { nextQ = quarterMonths[idx + 1]; }
    else { nextQ = 2; y += 1; }
  }
  return `${product}${MONTH_CODES[nextQ]}${y}`;
}

// ── 대표 마이크로 선물 상품 ──
export const MICRO_FUTURES = [
  { product: 'MES', name: 'Micro E-mini S&P 500', exchange: 'CME', tickSize: 0.25, tickValue: 1.25, marginApprox: 1500 },
  { product: 'MNQ', name: 'Micro E-mini Nasdaq 100', exchange: 'CME', tickSize: 0.25, tickValue: 0.50, marginApprox: 2000 },
  { product: 'M2K', name: 'Micro E-mini Russell 2000', exchange: 'CME', tickSize: 0.10, tickValue: 0.50, marginApprox: 800 },
  { product: 'MGC', name: 'E-Micro Gold', exchange: 'CME', tickSize: 0.10, tickValue: 1.00, marginApprox: 1000 },
  { product: 'MCL', name: 'Micro WTI Crude Oil', exchange: 'CME', tickSize: 0.01, tickValue: 1.00, marginApprox: 700 },
];

export interface FuturesPrice {
  symbol: string;
  price: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  volume: number;
  openInterest: number;
}

/** 해외선물 현재가 조회 */
export async function getFuturesPrice(symbol: string): Promise<FuturesPrice | null> {
  try {
    const data = await futuresKisRequest<any>({
      path: '/uapi/overseas-futureoption/v1/quotations/inquire-price',
      trId: 'HHDFC55010000',
      useRealUrl: true,
      params: {
        OVRS_FUTR_FX_PDNO: symbol,
        OVRS_FUTR_FX_MKET_CD: '00',
      },
    });
    const o = data.output;
    if (!o) return null;
    return {
      symbol,
      price: parseFloat(o.ovrs_futr_oprc || o.last || '0'),
      change: parseFloat(o.ovrs_futr_prdy_vrss || '0'),
      changePct: parseFloat(o.ovrs_futr_prdy_ctrt || '0'),
      high: parseFloat(o.ovrs_futr_hgpr || '0'),
      low: parseFloat(o.ovrs_futr_lwpr || '0'),
      volume: parseInt(o.acml_vol || '0', 10),
      openInterest: parseInt(o.opnint_qty || '0', 10),
    };
  } catch (e: any) {
    logger.warn(`선물 시세 조회 실패: ${symbol} — ${e.message}`, { component: COMP });
    return null;
  }
}

export interface FuturesPosition {
  symbol: string;
  product: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  marginUsed: number;
}

/** 해외선물 미결제 포지션 조회 */
export async function getFuturesPositions(): Promise<FuturesPosition[]> {
  try {
    const data = await futuresKisRequest<any>({
      path: '/uapi/overseas-futureoption/v1/trading/inquire-unpd',
      trId: 'OTFM1412R',
      params: {
        CANO: config.kis.accountNo,
        ACNT_PRDT_CD: '08',
        FUOP_DVSN: '01', // 선물만
        CTX_AREA_FK100: '',
        CTX_AREA_NK100: '',
      },
    });
    const items = data.output1 || data.output || [];
    if (!Array.isArray(items)) return [];
    return items.filter((r: any) => parseInt(r.cblc_qty || '0', 10) > 0).map((r: any) => ({
      symbol: r.pdno || r.ovrs_futr_fx_pdno || '',
      product: (r.pdno || '').replace(/[A-Z]\d{2}$/, ''),
      side: (r.sll_buy_dvsn_cd === '02' ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
      quantity: parseInt(r.cblc_qty || '0', 10),
      avgPrice: parseFloat(r.pchs_avg_pric || '0'),
      currentPrice: parseFloat(r.now_pric || '0'),
      pnl: parseFloat(r.frcr_evlu_pfls_amt || '0'),
      marginUsed: parseFloat(r.use_mgn_amt || '0'),
    }));
  } catch (e: any) {
    logger.warn(`선물 포지션 조회 실패: ${e.message}`, { component: COMP });
    return [];
  }
}

/** 해외선물 예수금 조회 */
export async function getFuturesDeposit(): Promise<{ totalDeposit: number; availableMargin: number; usedMargin: number }> {
  try {
    const data = await futuresKisRequest<any>({
      path: '/uapi/overseas-futureoption/v1/trading/inquire-deposit',
      trId: 'OTFM1411R',
      params: {
        CANO: config.kis.accountNo,
        ACNT_PRDT_CD: '08',
        CRCY_CD: 'USD',
        INQR_DT: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      },
    });
    const o = data.output || {};
    return {
      totalDeposit: parseFloat(o.dps_amt || '0'),
      availableMargin: parseFloat(o.ord_psbl_amt || '0'),
      usedMargin: parseFloat(o.use_mgn_amt || '0'),
    };
  } catch (e: any) {
    logger.warn(`선물 예수금 조회 실패: ${e.message}`, { component: COMP });
    return { totalDeposit: 0, availableMargin: 0, usedMargin: 0 };
  }
}

/** 해외선물 주문 */
export async function placeFuturesOrder(params: {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price?: number;
  orderType?: 'LIMIT' | 'MARKET';
}): Promise<{ success: boolean; orderNo?: string; message?: string }> {
  try {
    const data = await futuresKisRequest<any>({
      path: '/uapi/overseas-futureoption/v1/trading/order',
      method: 'POST',
      trId: 'OTFM3001U',
      body: {
        CANO: config.kis.accountNo,
        ACNT_PRDT_CD: '08',
        OVRS_FUTR_FX_PDNO: params.symbol,
        SLL_BUY_DVSN_CD: params.side === 'BUY' ? '02' : '01',
        FM_ORD_QTY: String(params.quantity),
        PRIC_DVSN_CD: params.orderType === 'MARKET' ? '2' : '1',
        FM_LIMIT_ORD_PRIC: params.price ? String(params.price) : '0',
        FM_STOP_ORD_PRIC: '0',
        FM_LQD_USTL_CCLD_DT: '',
        FM_LQD_USTL_CCNO: '',
        FM_LQD_LMT_ORD_PRIC: '0',
        FM_LQD_STOP_ORD_PRIC: '0',
        CCLD_CNDT_CD: '6',
        CPLX_ORD_DVSN_CD: '',
        ECIS_RSVN_ORD_YN: 'N',
        FM_HDGE_ORD_SCRN_YN: 'N',
      },
    });
    if (data.rtCd === '0') {
      const orderNo = (data.output as any)?.odno || '';
      logger.info(`선물 주문 성공: ${params.symbol} ${params.side} ${params.quantity}계약 (${orderNo})`, { component: COMP });
      return { success: true, orderNo };
    }
    return { success: false, message: data.msg1 || '주문 실패' };
  } catch (e: any) {
    logger.error(`선물 주문 실패: ${e.message}`, { component: COMP });
    return { success: false, message: e.message };
  }
}

/** 해외선물 주문 취소 */
export async function cancelFuturesOrder(orderNo: string, orderDate: string): Promise<{ success: boolean; message?: string }> {
  try {
    const data = await futuresKisRequest<any>({
      path: '/uapi/overseas-futureoption/v1/trading/order-rvsecncl',
      method: 'POST',
      trId: 'OTFM3003U',
      body: {
        CANO: config.kis.accountNo,
        ACNT_PRDT_CD: '08',
        ORGN_ORD_DT: orderDate,
        ORGN_ODNO: orderNo.padStart(8, '0'),
        FM_MKPR_CVSN_YN: 'N',
      },
    });
    return data.rtCd === '0'
      ? { success: true }
      : { success: false, message: data.msg1 };
  } catch (e: any) {
    return { success: false, message: e.message };
  }
}

/** 선물 일봉 차트 데이터 */
export async function getFuturesDailyChart(symbol: string, days = 30): Promise<Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>> {
  try {
    const data = await futuresKisRequest<any>({
      path: '/uapi/overseas-futureoption/v1/quotations/daily-ccnl',
      trId: 'HHDFC55020100',
      useRealUrl: true,
      params: {
        OVRS_FUTR_FX_PDNO: symbol,
        OVRS_FUTR_FX_MKET_CD: '00',
        INQR_STRT_DT: '',
        INQR_END_DT: '',
        OVRS_FUTR_FX_DMRS_DVSN_CD: '1',
        CTX_AREA_FK100: '',
        CTX_AREA_NK100: '',
      },
    });
    const items = data.output2 || data.output || [];
    if (!Array.isArray(items)) return [];
    return items.slice(0, days).map((r: any) => ({
      date: r.stck_bsop_date || r.trd_dd || '',
      open: parseFloat(r.ovrs_futr_oprc || '0'),
      high: parseFloat(r.ovrs_futr_hgpr || '0'),
      low: parseFloat(r.ovrs_futr_lwpr || '0'),
      close: parseFloat(r.ovrs_futr_prpr || r.last || '0'),
      volume: parseInt(r.acml_vol || '0', 10),
    }));
  } catch {
    return [];
  }
}
