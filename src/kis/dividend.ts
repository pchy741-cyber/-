/**
 * KIS 해외주식 배당/권리 조회 API
 * - 배당 일정 조회 (CTRGT011R)
 * - 배당 수령 내역은 거래내역(CTOS4001R)에서 추출
 */
import { config } from '../config/index.js';
import { kisRequest, overseasRateLimiter } from './client.js';
import { logger } from '../utils/logger.js';

const COMP = 'DIVIDEND';

async function divKisRequest<T = unknown>(opts: Parameters<typeof kisRequest<T>>[0]): ReturnType<typeof kisRequest<T>> {
  await overseasRateLimiter.acquire();
  return kisRequest<T>({ ...opts, skipRateLimiter: true });
}

export interface DividendEvent {
  stockCode: string;
  exDate: string;
  payDate: string;
  dividendPerShare: number;
  currency: string;
  eventType: string; // 배당, 유상증자, 무상증자 등
}

/** 해외주식 기간별 배당/권리 조회 */
export async function getDividendSchedule(params?: {
  stockCode?: string;
  startDate?: string;
  endDate?: string;
}): Promise<DividendEvent[]> {
  try {
    const now = new Date();
    const start = params?.startDate || new Date(now.getTime() - 90 * 24 * 60 * 60_000).toISOString().slice(0, 10).replace(/-/g, '');
    const end = params?.endDate || new Date(now.getTime() + 90 * 24 * 60 * 60_000).toISOString().slice(0, 10).replace(/-/g, '');

    const queryParams: Record<string, string> = {
      CANO: config.kis.accountNo,
      ACNT_PRDT_CD: config.kis.accountProductCode,
      RGHT_TYPE_CD: '03', // 배당만
      INQR_DVSN_CD: '02', // 현지 기준일
      INQR_STRT_DT: start,
      INQR_END_DT: end,
      PDNO: params?.stockCode || '',
      PRDT_TYPE_CD: '',
      CTX_AREA_FK200: '',
      CTX_AREA_NK200: '',
    };

    const data = await divKisRequest<any>({
      path: '/uapi/overseas-price/v1/quotations/period-rights',
      trId: 'CTRGT011R',
      useRealUrl: true,
      params: queryParams,
    });

    const items = data.output1 || data.output || [];
    if (!Array.isArray(items)) return [];
    return items.map((r: any) => ({
      stockCode: r.pdno || r.stck_shrn_iscd || '',
      exDate: r.ex_date || r.rcrd_dt || '',
      payDate: r.pay_dt || '',
      dividendPerShare: parseFloat(r.divi_amt || r.rght_amt || '0'),
      currency: r.crcy_cd || 'USD',
      eventType: r.rght_type_nm || '배당',
    })).filter(d => d.stockCode && d.dividendPerShare > 0);
  } catch (e: any) {
    logger.warn(`배당 일정 조회 실패: ${e.message}`, { component: COMP });
    return [];
  }
}

/** 해외주식 거래내역에서 배당금 수령 추출 (Live 전용 — Paper 모드는 KIS TR 미지원) */
export async function getDividendReceipts(params?: {
  startDate?: string;
  endDate?: string;
}): Promise<Array<{ stockCode: string; amount: number; tax: number; netAmount: number; date: string; currency: string }>> {
  // CTOS4001R은 실전전용 TR — Paper 모드에서 호출 시 "모의투자 TR 이 아닙니다" 에러
  if (config.isPaper) {
    return [];
  }
  try {
    const now = new Date();
    const start = params?.startDate || new Date(now.getTime() - 365 * 24 * 60 * 60_000).toISOString().slice(0, 10).replace(/-/g, '');
    const end = params?.endDate || now.toISOString().slice(0, 10).replace(/-/g, '');

    const data = await divKisRequest<any>({
      path: '/uapi/overseas-stock/v1/trading/inquire-period-trans',
      trId: 'CTOS4001R',
      params: {
        CANO: config.kis.accountNo,
        ACNT_PRDT_CD: config.kis.accountProductCode,
        OVRS_EXCG_CD: '',
        NATN_CD: '',
        CRCY_CD: '',
        PDNO: '',
        INQR_STRT_DT: start,
        INQR_END_DT: end,
        CTX_AREA_FK200: '',
        CTX_AREA_NK200: '',
      },
    });

    const items = data.output1 || data.output || [];
    if (!Array.isArray(items)) return [];

    // 배당 관련 거래만 필터
    return items
      .filter((r: any) => {
        const type = (r.tr_type_nm || r.tr_dvsn_nm || '').toLowerCase();
        return type.includes('배당') || type.includes('dividend') || type.includes('div');
      })
      .map((r: any) => ({
        stockCode: r.pdno || r.stck_shrn_iscd || '',
        amount: Math.abs(parseFloat(r.tr_amt || r.ccld_amt || '0')),
        tax: Math.abs(parseFloat(r.tax_amt || '0')),
        netAmount: Math.abs(parseFloat(r.sttl_amt || r.tr_amt || '0')),
        date: r.trd_dt || r.tr_dt || '',
        currency: r.crcy_cd || 'USD',
      }));
  } catch (e: any) {
    logger.warn(`배당금 수령내역 조회 실패: ${e.message}`, { component: COMP });
    return [];
  }
}
