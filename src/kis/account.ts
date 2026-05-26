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
  totalEvalAmount: number; // 유가증권 평가금액 (scts_evlu_amt)
  totalProfitLoss: number; // 총 손익
  totalProfitLossPct: number;
  netAsset: number; // 순자산금액 (nass_amt) — T+2 미수 차감 완료, 가장 신뢰할 수 있는 총자산
  purchaseCost: number; // 매입금액 합계 (pchs_amt_smtl_amt) — 실제 투자 원가
  positions: Position[];
}

/**
 * 계좌 잔고 + 보유 종목 조회
 * forceLive=true: 서버가 paper 모드여도 live KIS 서버에 live credential로 조회
 */
export async function getAccountBalance(forceLive = false): Promise<AccountBalance> {
  const isPaper = !forceLive && config.isPaper;
  const trIds = isPaper ? KIS_TR_ID.PAPER : KIS_TR_ID.LIVE;

  // forceLive=true && 서버가 paper → live credential/URL 강제 사용
  const needForceMode = forceLive && config.isPaper;
  const forceMode = needForceMode ? 'live' as const : undefined;

  // 계좌번호: forceMode 시 live 전용 계좌 사용
  const acctRaw = needForceMode
    ? (process.env.KIS_ACCOUNT_NO_LIVE || process.env.KIS_ACCOUNT_NO || config.kis.accountNo)
    : undefined;
  const acctNo = needForceMode && acctRaw?.includes('-')
    ? acctRaw.split('-')[0]
    : (needForceMode ? acctRaw : config.kis.accountNo);
  const acctProd = needForceMode && acctRaw?.includes('-')
    ? (acctRaw.split('-')[1] || '01')
    : (needForceMode ? '01' : config.kis.accountProductCode);

  const res = await kisRequest({
    path: '/uapi/domestic-stock/v1/trading/inquire-balance',
    trId: trIds.BALANCE,
    forceMode,
    params: {
      CANO: acctNo ?? config.kis.accountNo,
      ACNT_PRDT_CD: acctProd ?? config.kis.accountProductCode,
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

  // ord_psbl_cash = CMA 전용 필드; 일반 위탁계좌는 absent → dnca_tot_amt로 폴백
  const orderableCash = Number(summary?.ord_psbl_cash || summary?.dnca_tot_amt || 0);
  const totalDeposit = Number(summary?.dnca_tot_amt ?? 0);

  // 모의투자 계좌 예수금이 0원이면 가상 자금 1,000만원 부여
  const PAPER_DEFAULT_CASH = 10_000_000;
  const effectiveCash = isPaper && orderableCash === 0 ? PAPER_DEFAULT_CASH : orderableCash;
  const effectiveDeposit = isPaper && totalDeposit === 0 ? PAPER_DEFAULT_CASH : totalDeposit;

  const scts_evlu = Number(summary?.scts_evlu_amt ?? 0);
  const nass = Number(summary?.nass_amt ?? 0);
  const pchs = Number(summary?.pchs_amt_smtl_amt ?? 0);

  return {
    totalDeposit: effectiveDeposit,
    orderableCash: effectiveCash,
    totalEvalAmount: scts_evlu,
    totalProfitLoss: Number(summary?.evlu_pfls_smtl_amt ?? 0),
    totalProfitLossPct: Number(summary?.evlu_pfls_rt ?? 0),
    // 순자산: KIS nass_amt (T+2 미수 차감 완료) — paper는 예수금+증권평가로 계산
    netAsset: isPaper ? (effectiveCash + scts_evlu) : (nass > 0 ? nass : (effectiveCash + scts_evlu)),
    purchaseCost: pchs,
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
