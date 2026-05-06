/**
 * 유휴 현금 파킹 관리자 (비활성화됨)
 *
 * 파킹 ETF 매수/매도 수수료가 수익을 잠식하므로 BUY 기능 비활성화.
 * 기존에 파킹된 포지션은 즉시 청산(SELL)만 처리.
 *
 * DEFENSE 모드는 defense-park.ts가 담당하므로 이 모듈에서 제외
 */

import type { TradeDecision, TransactionChain } from '../../db/models.js';
import type { CurrentPrice } from '../../kis/market.js';
import type { StrategyMode } from '../../config/constants.js';
import { logger } from '../../utils/logger.js';

export const IDLE_PARK_STOCK_CODE = '360750'; // KODEX S&P500
export const IDLE_PARK_STOCK_NAME = 'KODEX S&P500';

// 총자산 대비 최소 현금 보유 비율 (Option A 핵심 파라미터)
// defense-park.ts도 이 값을 임포트하여 동일 기준 적용
export const CASH_RESERVE_RATIO = 0.25;

// 파킹 매수를 위한 최소 초과 현금 (너무 소액은 수수료만 냄)
const MIN_PARK_AMOUNT = 150_000;

export interface CashManagerParams {
  orderableCash: number;
  totalAssets: number;
  hasBuyCandidates: boolean;
  openChains: TransactionChain[];
  livePrices: Map<string, CurrentPrice>;
  mode: StrategyMode;
  blockNewBuys: boolean;
}

/**
 * 유휴 현금 파킹 결정 생성
 * 반환값: SELL(파킹 해제) 결정은 decisions 앞에, BUY(파킹) 결정은 뒤에 추가할 것
 */
export function manageCashParking(params: CashManagerParams): TradeDecision[] {
  const { orderableCash, totalAssets, hasBuyCandidates, openChains, livePrices, mode, blockNewBuys } = params;

  if (mode === 'DEFENSE') return []; // defense-park.ts가 처리

  const decisions: TradeDecision[] = [];
  const parkChain = openChains.find(c => c.stock_code === IDLE_PARK_STOCK_CODE);
  const parkQty = Number(parkChain?.total_quantity ?? 0);
  const parkPrice = livePrices.get(IDLE_PARK_STOCK_CODE);

  // 기존 파킹 포지션이 있으면 즉시 청산 (BUY 기능 비활성화로 잔여분 처리)
  if (parkQty > 0) {
    logger.info(
      `💰 파킹 잔여 포지션 청산: ${IDLE_PARK_STOCK_NAME} ${parkQty}주 → 현금 전환`,
      { component: 'CASH_MANAGER' },
    );
    decisions.push({
      action: 'SELL',
      stock_code: IDLE_PARK_STOCK_CODE,
      quantity: parkQty,
      price_type: 'MARKET',
      reasoning: `💰 파킹 ETF 비활성화 — 잔여 포지션 청산`,
      confidence: 0.99,
    });
  }

  // BUY 기능 비활성화: 수수료 잠식으로 수익 악화 확인됨
  return decisions;
}
