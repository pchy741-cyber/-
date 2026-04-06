import { KIS_TR_ID } from '../config/constants.js';
import { config } from '../config/index.js';
import { kisRequest } from './client.js';

// ── 보유 종목 ──
export interface Position {
  stockCode: string;
  stockName: string;
  quantity: number;
  avgBuyPrice: number;
  currentPrice: number;
  evalAmount: number;
  profitLoss: number;
  profitLossPct: number;
}

// ── 계좌 잔고 ──
export interface AccountBalance {
  totalDeposit: number; // 예수금 총액
  orderableCash: number; // 주문가능 현금
  totalEvalAmount: number; // 총 평가금액
  totalProfitLoss: number; // 총 손익
  totalProfitLossPct: number;
  positions: Position[];
}

/**
 * 계좌 잔고 + 보유 종목 조회
 */
export async function getAccountBalance(): Promise<AccountBalance> {
  const trIds = config.isPaper ? KIS_TR_ID.PAPER : KIS_TR_ID.LIVE;

  const res = await kisRequest({
    path: '/uapi/domestic-stock/v1/trading/inquire-balance',
    trId: trIds.BALANCE,
    params: {
      CANO: config.kis.accountNo,
      ACNT_PRDT_CD: config.kis.accountProductCode,
      AFHR_FLPR_YN: 'N',
      OFL_YN: '',
      INQR_DVSN: '02',
      UNPR_DVSN: '01',
      FUND_STTL_ICLD_YN: 'N',
      FNCG_AMT_AUTO_RDPT_YN: 'N',
      PRCS_DVSN: '00',
      CTX_AREA_FK100: '',
      CTX_AREA_NK100: '',
    },
  });

  // 보유 종목 파싱 (output1)
  const positionItems = (res.output1 ?? []) as Record<string, string>[];
  const positions: Position[] = positionItems
    .filter((item) => Number(item.hldg_qty) > 0)
    .map((item) => ({
      stockCode: item.pdno,
      stockName: item.prdt_name,
      quantity: Number(item.hldg_qty),
      avgBuyPrice: Number(item.pchs_avg_pric),
      currentPrice: Number(item.prpr),
      evalAmount: Number(item.evlu_amt),
      profitLoss: Number(item.evlu_pfls_amt),
      profitLossPct: Number(item.evlu_pfls_rt),
    }));

  // 계좌 요약 파싱 (output2)
  const summary = (Array.isArray(res.output2) ? res.output2[0] : res.output2) as Record<string, string>;

  const orderableCash = Number(summary?.ord_psbl_cash ?? 0);
  const totalDeposit = Number(summary?.dnca_tot_amt ?? 0);

  // 모의투자 계좌 예수금이 0원이면 가상 자금 1,000만원 부여
  const PAPER_DEFAULT_CASH = 10_000_000;
  const effectiveCash = config.isPaper && orderableCash === 0 ? PAPER_DEFAULT_CASH : orderableCash;
  const effectiveDeposit = config.isPaper && totalDeposit === 0 ? PAPER_DEFAULT_CASH : totalDeposit;

  return {
    totalDeposit: effectiveDeposit,
    orderableCash: effectiveCash,
    totalEvalAmount: Number(summary?.scts_evlu_amt ?? 0),
    totalProfitLoss: Number(summary?.evlu_pfls_smtl_amt ?? 0),
    totalProfitLossPct: Number(summary?.evlu_pfls_rt ?? 0),
    positions,
  };
}

/**
 * 주문 가능 금액 조회
 */
export async function getOrderableCash(): Promise<number> {
  const balance = await getAccountBalance();
  return balance.orderableCash;
}

/**
 * 특정 종목 보유 여부 및 수량 확인
 */
export async function getPositionForStock(stockCode: string): Promise<Position | null> {
  const balance = await getAccountBalance();
  return balance.positions.find((p) => p.stockCode === stockCode) ?? null;
}
