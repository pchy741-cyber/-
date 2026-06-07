import { KIS_TR_ID } from '../config/constants.js';
import { config } from '../config/index.js';
import { kisRequest } from './client.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';

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

// ── 계좌 잔고 메모리 캐시 (KIS API 호출 최소화) ──
const _balanceCache = new Map<string, { data: AccountBalance; ts: number }>();
const BALANCE_CACHE_TTL = 120_000; // 2분 — KIS API 호출 최소화 (PWA 접속 시 토큰 재발급 알림 폭탄 방지)
const BALANCE_CACHE_TTL_MORNING = 30_000; // 30초 — 장 개시 09:00~09:30 KST (정산 반영 지연 대응)

/** 현재 KST 기준 캐시 TTL 반환 — 아침에는 짧게 */
function getBalanceCacheTTL(): number {
  const kst = getKSTNow();
  const h = kst.getUTCHours(), m = kst.getUTCMinutes();
  // 09:00~09:30 장 개시 + 15:15~15:30 종가베팅 타이밍 → 캐시 단축
  if ((h === 9 && m < 30) || (h === 15 && m >= 15 && m <= 30)) return BALANCE_CACHE_TTL_MORNING;
  return BALANCE_CACHE_TTL;
}

/** 캐시를 무효화 (매수/매도 후 호출) */
export function invalidateBalanceCache(): void { _balanceCache.clear(); }

/**
 * 계좌 잔고 + 보유 종목 조회 (30초 메모리 캐시)
 * forceLive=true: 서버가 paper 모드여도 live KIS 서버에 live credential로 조회
 */
export async function getAccountBalance(forceLive = false): Promise<AccountBalance> {
  // context-aware 캐시 키 — paper/live 절대 충돌 방지
  const isPaper = !forceLive && config.isPaper;
  const cacheKey = forceLive ? 'live' : (isPaper ? 'paper' : 'live');
  const cached = _balanceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < getBalanceCacheTTL()) return cached.data;
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

  const scts_evlu = Number(summary?.scts_evlu_amt ?? 0);
  const nass = Number(summary?.nass_amt ?? 0);
  const pchs = Number(summary?.pchs_amt_smtl_amt ?? 0);

  // KIS 잔고 필드 파싱
  const ordPsblCash = Number(summary?.ord_psbl_cash ?? 0);       // CMA 주문가능현금
  const totalDeposit = Number(summary?.dnca_tot_amt ?? 0);        // 예수금 총액 (KIS 앱 "예수금"과 일치)
  const d2Deposit = Number(summary?.prvs_rcdl_excc_amt ?? 0);     // D+2 예수금
  const computedCash = nass > 0 && scts_evlu >= 0 ? Math.max(0, nass - scts_evlu) : 0; // 순자산 - 증권

  // 주문가능 현금: ord_psbl_cash(CMA) → D+2 예수금(실제 주문가능) → 예수금 → nass-evlu → 0
  const orderableCash = ordPsblCash > 0
    ? ordPsblCash
    : (d2Deposit > 0 ? d2Deposit : (totalDeposit > 0 ? totalDeposit : (computedCash > 0 ? computedCash : 0)));

  // 항상 로그 (산출 경로 디버그)
  const source = ordPsblCash > 0 ? 'ord_psbl_cash' : (d2Deposit > 0 ? 'd2_deposit' : (totalDeposit > 0 ? 'dnca_tot_amt' : (computedCash > 0 ? 'nass-evlu' : 'zero')));
  logger.info(
    `💰 잔고조회 [${forceLive ? 'forceLive' : (isPaper ? 'paper' : 'live')}]: ` +
    `ord_psbl=${ordPsblCash.toLocaleString()} deposit=${totalDeposit.toLocaleString()} d2=${d2Deposit.toLocaleString()} ` +
    `nass=${nass.toLocaleString()} evlu=${scts_evlu.toLocaleString()} computed=${computedCash.toLocaleString()} → ${source}=${orderableCash.toLocaleString()}`,
    { component: 'BALANCE' },
  );

  // 모의투자 계좌 예수금이 0원이면 가상 자금 1,000만원 부여
  const PAPER_DEFAULT_CASH = 10_000_000;
  const effectiveCash = isPaper && orderableCash === 0 ? PAPER_DEFAULT_CASH : orderableCash;
  const effectiveDeposit = isPaper && totalDeposit === 0 ? PAPER_DEFAULT_CASH : totalDeposit;

  const result: AccountBalance = {
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
  _balanceCache.set(cacheKey, { data: result, ts: Date.now() });
  return result;
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
