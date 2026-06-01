/**
 * 유휴 현금 파킹 관리자
 *
 * 전략:
 *   - 현금 비중 60%+ + 매수 후보 없음 → KOSPI 시총 대형주 중 당일 상승 종목에 파킹
 *   - 파킹 종목이 이미 OPEN 상태면 유지 (재매수 없음)
 *   - 파킹 포지션 청산 조건: 좋은 매수 후보 등장 OR 현금 필요 OR SL/TP 백엔드 처리
 *
 * DEFENSE 모드는 defense-park.ts가 담당
 */

import type { TradeDecision, TransactionChain } from '../../db/models.js';
import type { CurrentPrice } from '../../kis/market.js';
import type { StrategyMode } from '../../config/constants.js';
import { logger } from '../../utils/logger.js';

// 총자산 대비 최소 현금 보유 비율 (defense-park.ts도 임포트)
export const CASH_RESERVE_RATIO = 0.25;

// 파킹 시작 기준 — 현금 이 비율 초과 시 파킹 검토 (파워풀: 45%)
const PARK_TRIGGER_RATIO = 0.45;

// 파킹 매수 최소 금액
const MIN_PARK_AMOUNT = 200_000;

// 파킹 매수 최대 비중 (총자산 대비) — 파워풀: 35%까지 파킹
const MAX_PARK_RATIO = 0.35;

// KOSPI 시총 상위 대형주 파킹 후보 (순위 순)
// 당일 상승 중인 종목 우선 선택
export const MEGA_CAP_PARK_CANDIDATES: Array<{ code: string; name: string }> = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '005380', name: '현대차' },
  { code: '000270', name: '기아' },
  { code: '012450', name: '한화에어로스페이스' },
  { code: '105560', name: 'KB금융' },
  { code: '055550', name: '신한지주' },
  { code: '064350', name: '현대로템' },
];

// 레거시 호환 (pipeline.ts에서 참조)
export const IDLE_PARK_STOCK_CODE = MEGA_CAP_PARK_CANDIDATES[0].code;

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
  if (blockNewBuys) return [];

  const decisions: TradeDecision[] = [];

  // 현재 파킹 중인 대형주 체인 확인
  const parkingCodes = new Set(MEGA_CAP_PARK_CANDIDATES.map(c => c.code));
  const parkChains = openChains.filter(c => parkingCodes.has(c.stock_code));

  // ── 파킹 자동 해제: 좋은 매수 신호 등장 시 파킹 청산 → 더 큰 수익 기회에 재투자 ──
  if (hasBuyCandidates && parkChains.length > 0) {
    for (const parkChain of parkChains) {
      const qty = Number(parkChain.total_quantity ?? 0);
      if (qty <= 0) continue;
      const name = MEGA_CAP_PARK_CANDIDATES.find(c => c.code === parkChain.stock_code)?.name ?? parkChain.stock_code;
      logger.info(
        `🔄 파킹 해제: ${name}(${parkChain.stock_code}) ${qty}주 → 더 큰 수익 기회로 현금 재배치`,
        { component: 'CASH_MANAGER' },
      );
      decisions.push({
        action: 'SELL',
        stock_code: parkChain.stock_code,
        quantity: qty,
        price_type: 'MARKET',
        reasoning: `🔄 파킹 해제 — 고확신 매수 신호 등장, 현금 재투입`,
        confidence: 0.90,
      });
    }
    return decisions; // 해제 결정만 반환, 신규 파킹 매수 없음
  }

  // ── 파킹 매수 조건 ──
  const cashRatio = totalAssets > 0 ? orderableCash / totalAssets : 0;
  if (cashRatio < PARK_TRIGGER_RATIO) return decisions; // 현금 45% 미만 → 파킹 불필요
  // 현금 75%+ 초과: 기술 조건 실패로 실제 매수 안 될 때도 파킹 강행
  // (hasBuyCandidates=true여도 technical 조건 실패 시 현금이 종일 방치되는 문제 방지)
  if (hasBuyCandidates && cashRatio < 0.75) return decisions;
  if (orderableCash < MIN_PARK_AMOUNT) return decisions;

  // 이미 파킹 중인 종목 제외
  const alreadyParked = new Set(openChains.map(c => c.stock_code));

  // 대형주 선택: 급등(+5%↑) 추격은 방지, 급락(-3%↓)은 제외. 소폭 하락은 허용(단기 파킹)
  const candidates = MEGA_CAP_PARK_CANDIDATES
    .filter(c => !alreadyParked.has(c.code))
    .map(c => ({ ...c, price: livePrices.get(c.code) }))
    .filter(c => c.price && c.price.changePct >= -3.0 && c.price.changePct <= 5.0) // -3~+5% 범위 허용
    .sort((a, b) => (b.price?.changePct ?? 0) - (a.price?.changePct ?? 0));

  if (candidates.length === 0) {
    logger.info(`💤 유휴현금 파킹 후보 없음 (현금 ${(cashRatio * 100).toFixed(0)}%, 당일 상승 대형주 없음)`, { component: 'CASH_MANAGER' });
    return decisions;
  }

  const target = candidates[0];
  const targetPrice = target.price!.currentPrice;
  const parkAmount = Math.min(orderableCash * 0.7, totalAssets * MAX_PARK_RATIO);
  const quantity = Math.floor(parkAmount / targetPrice);

  if (quantity < 1) return decisions;

  logger.info(
    `💰 유휴현금 파킹 매수: ${target.name}(${target.code}) ${quantity}주 @${targetPrice.toLocaleString()}원 (현금비중 ${(cashRatio * 100).toFixed(0)}%, 당일 +${target.price!.changePct.toFixed(2)}%)`,
    { component: 'CASH_MANAGER' },
  );

  decisions.push({
    action: 'BUY',
    stock_code: target.code,
    quantity,
    price_type: 'MARKET',
    reasoning: `💰 유휴현금 대형주 파킹: ${target.name} 당일 +${target.price!.changePct.toFixed(2)}% 상승 — 현금 ${(cashRatio * 100).toFixed(0)}% 유휴`,
    confidence: 0.70,
    ai_score: 75,
  });

  return decisions;
}
