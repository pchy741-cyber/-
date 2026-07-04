/**
 * 배당 세후 실수령 계산기
 * - 한국 종합소득세 누진 구간
 * - 금융소득 2천만원 초과 종합과세
 * - 배당세액공제
 * - 건강보험료 추가분
 */

const TAX_BRACKETS = [
  { limit: 14_000_000, rate: 0.06, deduction: 0 },
  { limit: 50_000_000, rate: 0.15, deduction: 1_260_000 },
  { limit: 88_000_000, rate: 0.24, deduction: 5_760_000 },
  { limit: 150_000_000, rate: 0.35, deduction: 15_440_000 },
  { limit: 300_000_000, rate: 0.38, deduction: 19_940_000 },
  { limit: 500_000_000, rate: 0.40, deduction: 25_940_000 },
  { limit: 1_000_000_000, rate: 0.42, deduction: 35_940_000 },
  { limit: Infinity, rate: 0.45, deduction: 65_940_000 },
];

const WITHHOLDING_RATE = 0.154; // 원천징수 15.4%
const FINANCIAL_THRESHOLD = 20_000_000; // 종합과세 기준선
const HEALTH_RATE = 0.08135; // 건보료율

export interface TaxSimInput {
  investmentKrw: number;
  weightedYieldPct: number;
  earnedIncomeKrw: number;
  otherFinancialKrw: number;
  insuranceType: 'local' | 'employee';
}

export interface TaxSimResult {
  grossAnnualDiv: number;
  withholdingTax: number;
  comprehensiveTax: number;
  healthInsuranceDelta: number;
  netAnnualDiv: number;
  netMonthlyDiv: number;
  effectiveTaxRate: number;
  threshold20M: {
    currentFinancialIncome: number;
    isOver: boolean;
    headroom: number;
    maxSafeInvestment: number;
  };
  breakdown: Array<{
    investmentKrw: number;
    grossDiv: number;
    netDiv: number;
    effectiveRate: number;
  }>;
}

/** 누진세 산출세액 계산 */
function calcProgressiveTax(taxableIncome: number): number {
  if (taxableIncome <= 0) return 0;
  for (const bracket of TAX_BRACKETS) {
    if (taxableIncome <= bracket.limit) {
      return taxableIncome * bracket.rate - bracket.deduction;
    }
  }
  const last = TAX_BRACKETS[TAX_BRACKETS.length - 1];
  return taxableIncome * last.rate - last.deduction;
}

/** 배당세액공제율 결정 */
function getDividendCreditRate(totalIncome: number): number {
  if (totalIncome <= 46_000_000) return 1.0;    // 100%
  if (totalIncome <= 100_000_000) return 0.30;   // 30%
  return 0.25;                                    // 25%
}

/** 단일 투자금 기준 세후 계산 */
function calcNetForInvestment(
  investmentKrw: number,
  yieldPct: number,
  earnedIncomeKrw: number,
  otherFinancialKrw: number,
  insuranceType: 'local' | 'employee',
): { grossDiv: number; withholding: number; compTax: number; healthDelta: number; netDiv: number } {
  const grossDiv = investmentKrw * (yieldPct / 100);
  const withholding = grossDiv * WITHHOLDING_RATE;
  const totalFinancial = grossDiv + otherFinancialKrw;

  let compTax = 0;
  if (totalFinancial > FINANCIAL_THRESHOLD) {
    // 종합과세: 전체 소득에 누진세 적용
    const totalIncome = earnedIncomeKrw + totalFinancial;
    const progressiveTax = calcProgressiveTax(totalIncome);

    // 배당세액공제
    const creditRate = getDividendCreditRate(totalIncome);
    const dividendCredit = Math.min(grossDiv * 0.14 * creditRate, progressiveTax);

    // 종합과세 추가분 = 산출세액 - 배당세액공제 - 원천징수 기납부
    // (근로소득 원천징수는 별도이므로, 배당 관련 추가분만 계산)
    const taxOnFinancialOnly = calcProgressiveTax(totalIncome) - calcProgressiveTax(earnedIncomeKrw);
    compTax = Math.max(0, taxOnFinancialOnly - dividendCredit - withholding);
  }

  // 건강보험료 추가분
  let healthDelta = 0;
  if (insuranceType === 'local' && totalFinancial > 10_000_000) {
    healthDelta = (totalFinancial - 10_000_000) * HEALTH_RATE;
  } else if (insuranceType === 'employee' && totalFinancial > 20_000_000) {
    healthDelta = (totalFinancial - 20_000_000) * HEALTH_RATE;
  }

  const netDiv = grossDiv - withholding - compTax - healthDelta;
  return { grossDiv, withholding, compTax, healthDelta, netDiv };
}

export function simulateDividendTax(input: TaxSimInput): TaxSimResult {
  const { investmentKrw, weightedYieldPct, earnedIncomeKrw, otherFinancialKrw, insuranceType } = input;

  const main = calcNetForInvestment(investmentKrw, weightedYieldPct, earnedIncomeKrw, otherFinancialKrw, insuranceType);

  const totalFinancial = main.grossDiv + otherFinancialKrw;
  const totalTax = main.withholding + main.compTax + main.healthDelta;
  const effectiveTaxRate = main.grossDiv > 0 ? (totalTax / main.grossDiv) * 100 : 0;

  // 2천만원 임계점 분석
  const headroom = Math.max(0, FINANCIAL_THRESHOLD - totalFinancial);
  const maxSafeFinancial = FINANCIAL_THRESHOLD - otherFinancialKrw;
  const maxSafeInvestment = weightedYieldPct > 0
    ? Math.max(0, Math.floor(maxSafeFinancial / (weightedYieldPct / 100)))
    : 0;

  // 투자금 단계별 비교
  const breakdownLevels = [100_000_000, 200_000_000, 300_000_000, 500_000_000, 700_000_000, 1_000_000_000];
  const breakdown = breakdownLevels.map(inv => {
    const r = calcNetForInvestment(inv, weightedYieldPct, earnedIncomeKrw, otherFinancialKrw, insuranceType);
    const tax = r.withholding + r.compTax + r.healthDelta;
    return {
      investmentKrw: inv,
      grossDiv: Math.round(r.grossDiv),
      netDiv: Math.round(r.netDiv),
      effectiveRate: r.grossDiv > 0 ? +((tax / r.grossDiv) * 100).toFixed(1) : 0,
    };
  });

  return {
    grossAnnualDiv: Math.round(main.grossDiv),
    withholdingTax: Math.round(main.withholding),
    comprehensiveTax: Math.round(main.compTax),
    healthInsuranceDelta: Math.round(main.healthDelta),
    netAnnualDiv: Math.round(main.netDiv),
    netMonthlyDiv: Math.round(main.netDiv / 12),
    effectiveTaxRate: +effectiveTaxRate.toFixed(1),
    threshold20M: {
      currentFinancialIncome: Math.round(totalFinancial),
      isOver: totalFinancial > FINANCIAL_THRESHOLD,
      headroom: Math.round(headroom),
      maxSafeInvestment: Math.round(maxSafeInvestment),
    },
    breakdown,
  };
}
