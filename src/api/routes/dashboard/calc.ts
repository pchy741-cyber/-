/**
 * 대시보드 총자산 계산 — 순수 함수 (DB/API 호출 없음, 테스트 가능)
 *
 * 통합증거금 규칙:
 *   Live: 국내 현금 = 해외 현금 (동일 풀) → overseas cash 별도 합산 금지
 *   Paper: 국내 현금 / 해외 현금 완전 분리 → 각각 합산
 */

import { FALLBACK_FX_RATE } from '../../../config/constants.js';
import { logger } from '../../../utils/logger.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface TotalAssetInputs {
  viewIsPaper: boolean;

  // KIS 잔고 (또는 Paper balance)
  rawCash: number;                  // balance.orderableCash
  netAsset: number;                 // balance.netAsset (KIS nass_amt)
  kisDomEval: number;               // balance.totalEvalAmount (국내 증권 시가평가)
  kisPurchaseCost: number;          // balance.purchaseCost (국내 매입원가)
  kisTotalProfitLoss: number;       // balance.totalProfitLoss (미실현손익)
  kisTotalProfitLossPct: number;    // balance.totalProfitLossPct
  cashSource: string;               // balance.cashSource

  // 체인 집계 (builder에서 사전 계산)
  totalChainInvested: number;
  totalChainPnl: number;

  // 해외 보유 집계
  overseasTotalInvestedUsd: number;
  overseasMarketValueUsd: number;
  overseasCashRaw: number;          // Paper=USD, Live=KRW
  overseasMaxUsd: number;           // KIS cash_max_usd (통합증거금 전체 USD)

  // 외부
  fxRate: number;

  // 모드별 파라미터
  paperInitialCapital: number;      // Paper 시드 (KRW)
  liveRealizedPnl: number;         // Live DB 실현손익 합계

  // 수익률 계산 (전일 대비)
  prevDayTotalValue: number;        // 전일 총자산 스냅샷 (portfolio_snapshots)
}

export interface TotalAssetOutputs {
  // 핵심 총자산
  grandTotalValue: number;
  calcMethod: 'rawCash+eval' | 'rawCash_fallback' | 'paper_cash';

  // 현금
  freeDomesticCash: number;         // 국내 가용 현금 (KRW)
  totalCash: number;                // 총현금 (Paper: 국내+해외, Live: 국내만)
  unifiedCash: number;              // 국내 주문가능 (KR 매수 한도)
  actualCashSource: string;

  // 국내
  domesticInvested: number;         // 국내 투자원가
  domesticMarketValue: number;      // 국내 증권 시가

  // 해외 (KRW 변환)
  fxRate: number;
  overseasInvestedKrw: number;
  overseasMarketValueKrw: number;
  overseasCashKrw: number;          // 해외 현금 (KRW)
  overseasCashForDisplay: number;   // 해외 현금 표시용 (KRW, rounded)
  overseasCashUsdDisplay: number;   // 해외 현금 USD 표시

  // 손익
  totalInvested: number;            // 국내 + 해외 투자원가
  totalPnl: number;                 // 국내 + 해외 미실현 총손익
  totalPnlPct: number;
  overseasUnrealizedPnlKrw: number; // 해외 미실현 손익 (KRW)

  // 전일 대비 수익률
  prevDayTotalValue: number;
  dailyChangePct: number;
}

// ────────────────────────────────────────────────────────────
// Helper
// ────────────────────────────────────────────────────────────

/** NaN/undefined/null → 0 (모든 입력값을 한 곳에서 정화) */
function safe(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ────────────────────────────────────────────────────────────
// 순수 계산 함수
// ────────────────────────────────────────────────────────────

export function calcTotalAssets(i: TotalAssetInputs): TotalAssetOutputs {
  const fxRate = i.fxRate > 0 ? i.fxRate : FALLBACK_FX_RATE;

  // ─── 1. 해외 → KRW 변환 ───
  const overseasInvestedKrw = safe(i.overseasTotalInvestedUsd) * fxRate;
  const overseasMarketValueKrw = safe(i.overseasMarketValueUsd) * fxRate;
  const overseasUnrealizedPnlKrw = overseasMarketValueKrw - overseasInvestedKrw;

  // 해외 현금: Paper=USD로 저장 → KRW 변환, Live=KRW 그대로
  const rawOverseasCash = safe(i.overseasCashRaw);
  const overseasCashKrw = i.viewIsPaper ? rawOverseasCash * fxRate : rawOverseasCash;
  const safeOverseasCashKrw = Math.max(0, overseasCashKrw);

  // 해외 현금 표시
  const overseasCashForDisplay = Math.round(safeOverseasCashKrw);
  const overseasCashUsdDisplay = i.overseasMaxUsd > 0
    ? Math.round(i.overseasMaxUsd * 100) / 100
    : fxRate > 0 ? Math.round((overseasCashForDisplay / fxRate) * 100) / 100 : 0;

  // ─── 2. 국내 투자/시가 ───
  const domesticInvested = !i.viewIsPaper && i.kisPurchaseCost > 0
    ? i.kisPurchaseCost
    : (i.totalChainInvested > 0 ? i.totalChainInvested : safe(i.kisDomEval));

  const domesticMarketValue = i.kisDomEval > 0
    ? i.kisDomEval
    : i.viewIsPaper
      ? safe(i.kisDomEval)
      : i.totalChainInvested + i.totalChainPnl;

  // ─── 3. 총자산 ───
  const rawCashSafe = safe(i.rawCash);
  const safeDomestic = safe(domesticMarketValue);
  const safeOverseasMV = safe(overseasMarketValueKrw);

  let grandTotalValue: number;
  let freeDomesticCash: number;
  let calcMethod: TotalAssetOutputs['calcMethod'];

  if (!i.viewIsPaper && rawCashSafe > 0) {
    // Live: 총자산 = 주문가능(rawCash/maxBuyAmt) + 국내증권시가(kisDomEval) + 해외시가(overseasMV)
    // nass_amt(순자산) 사용 금지 — KIS 앱 표시와 불일치 (사용자: "82가 주문가능하고 매매중이 15만원이니 97만원이 총자산이어야지")
    freeDomesticCash = rawCashSafe;
    grandTotalValue = rawCashSafe + safeDomestic + safeOverseasMV;
    calcMethod = 'rawCash+eval';
  } else if (!i.viewIsPaper) {
    // Live: KIS API 실패 (rawCash=0) — 증권시가만으로 추정
    freeDomesticCash = 0;
    grandTotalValue = safeDomestic + safeOverseasMV;
    calcMethod = 'rawCash_fallback';
    if (grandTotalValue === 0) {
      logger.warn('⚠️ Live 총자산 0원 — KIS API 실패 또는 미연결', { component: 'CALC' });
    }
  } else {
    // Paper: 국내현금 + 국내증권 + 해외현금 + 해외증권
    freeDomesticCash = rawCashSafe;
    grandTotalValue = freeDomesticCash + safeDomestic + safeOverseasMV + safeOverseasCashKrw;
    calcMethod = 'paper_cash';
  }

  // ─── 4. 주문가능 = 총자산 - 매매중금액 (역산) ───
  const totalInvestedMV = safeDomestic + safeOverseasMV; // 국내+해외 증권 시가
  let actualCash: number;
  let actualCashSource: string;

  if (i.viewIsPaper) {
    // Paper: 국내 주문가능 = 국내 현금 그대로 (해외 현금은 별도 표시)
    actualCash = freeDomesticCash;
    actualCashSource = 'paper_domestic';
  } else {
    // Live: rawCash(주문가능) 기준 — KIS 앱과 동일
    actualCash = freeDomesticCash;
    actualCashSource = i.cashSource ?? 'buyable_api';
  }

  // ─── 5. 현금 표시용 ───
  const unifiedCash = Math.round(actualCash);
  const totalCash = Math.round(
    i.viewIsPaper ? freeDomesticCash + safeOverseasCashKrw : freeDomesticCash,
  );

  // ─── 6. 투자금 / 손익 ───
  const totalInvested = domesticInvested + overseasInvestedKrw;

  let totalPnl: number;
  if (i.viewIsPaper) {
    // Paper: 현재 보유 중인 포지션의 미실현 손익만 (누적 실현PnL은 realizedPnl 필드에 별도 표시)
    totalPnl = i.totalChainPnl;
  } else {
    // Live: KIS 미실현 손익 (실현PnL은 realizedPnl 필드에 별도 표시)
    totalPnl = safe(i.kisTotalProfitLoss);
  }

  const totalPnlPct = i.viewIsPaper
    ? i.paperInitialCapital > 0 ? (totalPnl / i.paperInitialCapital) * 100 : 0
    : safe(i.kisTotalProfitLossPct);

  // ─── 7. 전일 대비 수익률 ───
  const prevDay = safe(i.prevDayTotalValue);
  const rawDailyChangePct = prevDay > 0 && grandTotalValue > 0
    ? Math.round(((grandTotalValue - prevDay) / prevDay) * 10000) / 100
    : 0;
  // 마이그레이션(해외자산 신규 편입 등)으로 전일 스냅샷이 현재와 큰 차이를 보이면 0 처리
  const dailyChangePct = Math.abs(rawDailyChangePct) > 100 ? 0 : rawDailyChangePct;

  logger.info(`📊 calcTotalAssets [${i.viewIsPaper ? 'PAPER' : 'LIVE'}] method=${calcMethod} | netAsset=${safe(i.netAsset)} rawCash=${safe(i.rawCash)} kisDomEval=${safe(i.kisDomEval)} kisPurchaseCost=${safe(i.kisPurchaseCost)} | overseasMV_usd=${safe(i.overseasMarketValueUsd)} overseasCash=${rawOverseasCash} | grandTotal=${Math.round(grandTotalValue)} freeCash=${Math.round(freeDomesticCash)} domMV=${Math.round(domesticMarketValue)} overseasMV_krw=${Math.round(overseasMarketValueKrw)}`, { component: 'CALC' });

  return {
    grandTotalValue: Math.round(grandTotalValue),
    calcMethod,
    freeDomesticCash: Math.round(freeDomesticCash),
    totalCash,
    unifiedCash,
    actualCashSource,
    domesticInvested: Math.round(domesticInvested),
    domesticMarketValue: Math.round(domesticMarketValue),
    fxRate,
    overseasInvestedKrw: Math.round(overseasInvestedKrw),
    overseasMarketValueKrw: Math.round(overseasMarketValueKrw),
    overseasCashKrw: Math.round(safeOverseasCashKrw),
    overseasCashForDisplay,
    overseasCashUsdDisplay,
    overseasUnrealizedPnlKrw: Math.round(overseasUnrealizedPnlKrw),
    totalInvested: Math.round(totalInvested),
    totalPnl: Math.round(totalPnl),
    totalPnlPct: Math.round(totalPnlPct * 100) / 100,
    prevDayTotalValue: Math.round(prevDay),
    dailyChangePct,
  };
}
