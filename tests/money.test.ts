import { describe, it, expect } from 'vitest';
import {
  roundKrw, calcAvgPrice, calcPnlPct, calcRealizedPnl,
  calcSplitQuantity, adjustToTickSize, validateOrderValue,
  calcAverageDownTrigger, calcTakeProfitTrigger,
} from '../src/utils/money.js';

describe('금액 계산 정밀도', () => {
  it('원 단위 반올림', () => {
    expect(roundKrw(123456.4)).toBe(123456);
    expect(roundKrw(123456.5)).toBe(123457);
    expect(roundKrw(0.1 + 0.2)).toBe(0); // float 오류 방지
  });

  it('평균단가 계산', () => {
    // 100주 @10000 + 50주 @9000 = 150주 @9667
    expect(calcAvgPrice(100, 10000, 50, 9000)).toBe(9667);
    // 0주 + 10주 @50000 = 50000
    expect(calcAvgPrice(0, 0, 10, 50000)).toBe(50000);
  });

  it('수익률 계산', () => {
    expect(calcPnlPct(10000, 10800)).toBe(8.0);   // +8%
    expect(calcPnlPct(10000, 9500)).toBe(-5.0);    // -5%
    expect(calcPnlPct(10000, 10000)).toBe(0);       // 0%
    expect(calcPnlPct(0, 10000)).toBe(0);            // 0원 기준 → 0
  });

  it('실현 손익 계산', () => {
    expect(calcRealizedPnl(11000, 10000, 10)).toBe(10000);  // +1만원
    expect(calcRealizedPnl(9500, 10000, 20)).toBe(-10000);  // -1만원
  });

  it('분할 매수 수량', () => {
    // 30만원 3분할, 주당 10000원
    expect(calcSplitQuantity(300000, 10000, 3, 0)).toBe(10); // 1차: 10만원 → 10주
    expect(calcSplitQuantity(300000, 10000, 3, 1)).toBe(10); // 2차: 10만원 → 10주
    expect(calcSplitQuantity(300000, 10000, 3, 2)).toBe(10); // 3차: 나머지
    // 예산 0 또는 가격 0
    expect(calcSplitQuantity(0, 10000, 3, 0)).toBe(0);
    expect(calcSplitQuantity(300000, 0, 3, 0)).toBe(0);
  });

  it('호가 단위 맞춤 (KRX)', () => {
    expect(adjustToTickSize(1500)).toBe(1500);     // ~2000: 1원 단위
    expect(adjustToTickSize(3333)).toBe(3330);     // 2000~5000: 5원 단위
    expect(adjustToTickSize(15678)).toBe(15670);   // 5000~20000: 10원 단위
    expect(adjustToTickSize(35123)).toBe(35100);   // 20000~50000: 50원 단위
    expect(adjustToTickSize(123456)).toBe(123400); // 50000~200000: 100원 단위
    expect(adjustToTickSize(350789)).toBe(350500); // 200000~500000: 500원 단위
    expect(adjustToTickSize(750000)).toBe(750000); // 500000+: 1000원 단위
  });

  it('주문 금액 검증', () => {
    const ok = validateOrderValue(10, 10000, 300000);
    expect(ok.valid).toBe(true);
    expect(ok.orderValue).toBe(100000);

    const over = validateOrderValue(50, 10000, 300000);
    expect(over.valid).toBe(false); // 50만원 > 30만원 한도

    const zero = validateOrderValue(0, 10000, 300000);
    expect(zero.valid).toBe(false);
  });

  it('물타기/익절/손절 트리거 가격', () => {
    // 10000원 기준 -3% 물타기
    expect(calcAverageDownTrigger(10000, -3)).toBe(9700);
    // 10000원 기준 +8% 익절
    expect(calcTakeProfitTrigger(10000, 8)).toBe(10800);
  });
});
