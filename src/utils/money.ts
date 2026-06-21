/**
 * 금액 계산 유틸리티
 *
 * JavaScript float의 부동소수점 오류 방지
 * (0.1 + 0.2 = 0.30000000000000004 같은 문제)
 *
 * 주식 매매에서 1원 단위가 중요하므로 정수 연산 기반
 */

/** 원 단위 반올림 (주식은 원 단위가 최소) */
export function roundKrw(value: number): number {
  return Math.round(value);
}

/** 평균 단가 계산 (기존 보유 + 신규 매수) */
export function calcAvgPrice(existingQty: number, existingAvgPrice: number, newQty: number, newPrice: number): number {
  const totalQty = existingQty + newQty;
  if (totalQty <= 0) return 0; // 음수/0 수량 방어 (DB 부정합 시 극단 avgPrice 방지)
  const totalCost = existingQty * existingAvgPrice + newQty * newPrice;
  return roundKrw(totalCost / totalQty);
}

/** 수익률 계산 (%) — 소수 둘째자리 */
export function calcPnlPct(avgBuyPrice: number, currentPrice: number): number {
  if (avgBuyPrice === 0) return 0;
  return Math.round(((currentPrice - avgBuyPrice) / avgBuyPrice) * 10000) / 100;
}

/** 실현 손익 계산 (원) */
export function calcRealizedPnl(sellPrice: number, avgBuyPrice: number, quantity: number): number {
  return roundKrw((sellPrice - avgBuyPrice) * quantity);
}

/** 분할 매수 수량 계산 — 예산을 n등분하여 주식 수량으로 변환 */
export function calcSplitQuantity(
  budget: number,
  currentPrice: number,
  splitCount: number,
  splitIndex: number, // 0-based (0=1차, 1=2차, 2=3차)
): number {
  if (budget <= 0 || currentPrice <= 0 || splitCount <= 0) return 0;
  const perSplit = Math.floor(budget / splitCount);
  const amount = splitIndex === splitCount - 1 ? budget - perSplit * (splitCount - 1) : perSplit;
  if (amount <= 0) return 0;
  return Math.max(1, Math.floor(amount / currentPrice));
}

/** 호가 단위 맞춤 (KRX 호가 단위표) */
export function adjustToTickSize(price: number): number {
  const p = roundKrw(price);
  if (p < 2000) return Math.floor(p / 1) * 1;
  if (p < 5000) return Math.floor(p / 5) * 5;
  if (p < 20000) return Math.floor(p / 10) * 10;
  if (p < 50000) return Math.floor(p / 50) * 50;
  if (p < 200000) return Math.floor(p / 100) * 100;
  if (p < 500000) return Math.floor(p / 500) * 500;
  return Math.floor(p / 1000) * 1000;
}

/**
 * 목표 가격 계산 (호가 단위 적용)
 * @param basePrice 기준 가격 (e.g. 평단가)
 * @param changePct 변경 비율 (e.g. -10%는 -10, +15%는 15)
 */
function calcTriggerPrice(basePrice: number, changePct: number): number {
  return adjustToTickSize(basePrice * (1 + changePct / 100));
}

/** 물타기 트리거 가격 계산 (e.g. -10% 하락 시) */
export function calcAverageDownTrigger(avgBuyPrice: number, dropPct: number): number {
  return calcTriggerPrice(avgBuyPrice, dropPct);
}

/** 익절 트리거 가격 계산 (e.g. +15% 상승 시) */
export function calcTakeProfitTrigger(avgBuyPrice: number, profitPct: number): number {
  return calcTriggerPrice(avgBuyPrice, profitPct);
}

/** 손절 트리거 가격 계산 (e.g. -5% 하락 시) */
export function calcStopLossTrigger(avgBuyPrice: number, lossPct: number): number {
  return calcTriggerPrice(avgBuyPrice, lossPct);
}

/** 총 투자금액 안전 검증 */
export function validateOrderValue(
  quantity: number,
  price: number,
  maxPositionKrw: number,
): { valid: boolean; orderValue: number; message: string } {
  const orderValue = roundKrw(quantity * price);

  if (quantity <= 0) {
    return { valid: false, orderValue: 0, message: '수량이 0 이하' };
  }
  if (price <= 0) {
    return { valid: false, orderValue: 0, message: '가격이 0 이하' };
  }
  if (orderValue > maxPositionKrw) {
    return {
      valid: false,
      orderValue,
      message: `주문금액 ${orderValue.toLocaleString()}원 > 한도 ${maxPositionKrw.toLocaleString()}원`,
    };
  }

  return { valid: true, orderValue, message: 'OK' };
}
