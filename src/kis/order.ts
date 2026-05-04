import { KIS_TR_ID, type OrderSide, OrderType } from '../config/constants.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { adjustToTickSize } from '../utils/money.js';
import { getHashkey } from './auth.js';
import { kisRequest } from './client.js';

// ── 주문 결과 ──
export interface OrderResult {
  success: boolean;
  orderNo: string; // KIS 주문번호
  message: string;
}

// ── 체결 내역 ──
export interface FillInfo {
  orderNo: string;
  stockCode: string;
  side: string;
  orderQty: number;
  filledQty: number;
  filledPrice: number;
  status: string; // 01=정상, 02=정정, 03=취소
}

/**
 * 매수/매도 주문 실행
 */
export async function placeOrder(params: {
  stockCode: string;
  side: OrderSide;
  quantity: number;
  price?: number;
  orderType?: OrderType;
}): Promise<OrderResult> {
  const { stockCode, side, quantity, price, orderType = OrderType.MARKET } = params;
  const trIds = config.isPaper ? KIS_TR_ID.PAPER : KIS_TR_ID.LIVE;
  const trId = side === 'BUY' ? trIds.BUY : trIds.SELL;

  const body: Record<string, string> = {
    CANO: config.kis.accountNo,
    ACNT_PRDT_CD: config.kis.accountProductCode,
    PDNO: stockCode,
    ORD_DVSN: orderType,
    ORD_QTY: String(quantity),
    // 지정가 주문 시 호가 단위 자동 맞춤 (KRX 규정)
    ORD_UNPR: orderType === OrderType.MARKET ? '0' : String(adjustToTickSize(price ?? 0)),
  };

  const hashkey = await getHashkey(body);

  logger.info(`주문 전송: ${side} ${stockCode} x${quantity} @${price ?? '시장가'}`, {
    component: 'KIS_ORDER',
  });

  // 주문은 rate limiter 큐 건너뜀 — 매도가 큐 뒤에서 40초 대기하는 현상 방지
  const res = await kisRequest({
    path: '/uapi/domestic-stock/v1/trading/order-cash',
    method: 'POST',
    trId,
    body,
    hashkey,
    skipRateLimiter: true,
  });

  const output = res.output as Record<string, string>;

  return {
    success: res.rtCd === '0',
    orderNo: output?.ODNO ?? '',
    message: res.msg1,
  };
}

/**
 * 체결 내역 조회 (주문 후 실제 체결 확인용 — Double Check)
 */
export async function getOrderFills(orderNo: string): Promise<FillInfo | null> {
  const trIds = config.isPaper ? KIS_TR_ID.PAPER : KIS_TR_ID.LIVE;
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');

  const res = await kisRequest({
    path: '/uapi/domestic-stock/v1/trading/inquire-daily-ccld',
    trId: trIds.ORDER_STATUS,
    params: {
      CANO: config.kis.accountNo,
      ACNT_PRDT_CD: config.kis.accountProductCode,
      INQR_STRT_DT: today,
      INQR_END_DT: today,
      SLL_BUY_DVSN_CD: '00', // 전체
      INQR_DVSN: '00',
      PDNO: '',
      CCLD_DVSN: '01', // 체결만
      ORD_GNO_BRNO: '',
      ODNO: orderNo,
      INQR_DVSN_3: '00',
      INQR_DVSN_1: '',
      CTX_AREA_FK100: '',
      CTX_AREA_NK100: '',
    },
  });

  const items = (res.output1 ?? []) as Record<string, string>[];
  const matched = items.find((item) => item.odno === orderNo);

  if (!matched) return null;

  return {
    orderNo: matched.odno,
    stockCode: matched.pdno,
    side: matched.sll_buy_dvsn_cd === '01' ? 'SELL' : 'BUY',
    orderQty: Number(matched.ord_qty),
    filledQty: Number(matched.tot_ccld_qty),
    filledPrice: Number(matched.avg_prvs),
    status: matched.ord_dvsn_cd,
  };
}

/**
 * 주문 취소
 */
export async function cancelOrder(params: {
  orderNo: string;
  stockCode: string;
  quantity: number;
}): Promise<OrderResult> {
  const trIds = config.isPaper ? KIS_TR_ID.PAPER : KIS_TR_ID.LIVE;

  const body = {
    CANO: config.kis.accountNo,
    ACNT_PRDT_CD: config.kis.accountProductCode,
    KRX_FWDG_ORD_ORGNO: '',
    ORGN_ODNO: params.orderNo,
    ORD_DVSN: '00',
    RVSE_CNCL_DVSN_CD: '02', // 02 = 취소
    ORD_QTY: String(params.quantity),
    ORD_UNPR: '0',
    QTY_ALL_ORD_YN: 'Y',
  };

  const hashkey = await getHashkey(body);

  const res = await kisRequest({
    path: '/uapi/domestic-stock/v1/trading/order-rvsecncl',
    method: 'POST',
    trId: trIds.BUY, // 취소도 동일 tr_id 사용
    body,
    hashkey,
  });

  return {
    success: res.rtCd === '0',
    orderNo: params.orderNo,
    message: res.msg1,
  };
}
