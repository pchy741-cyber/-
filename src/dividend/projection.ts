/**
 * 배당 장기 프로젝션
 * 순수 수학 계산 (DB 불필요), 연 단위 복리
 */

export interface ProjectionInput {
  initialKrw: number;
  monthlyContribution: number;
  years: number;
  dividendYieldPct: number;
  priceGrowthPct: number;
  reinvestDividends: boolean;
  inflationPct: number;
  taxRate: number; // 실효세율 (%)
}

export interface ProjectionYearData {
  year: number;
  portfolioValue: number;
  realValue: number;
  annualDividend: number;
  annualDividendAfterTax: number;
  cumulativeContributions: number;
  cumulativeDividends: number;
  totalReturn: number;
}

export interface ProjectionResult {
  years: ProjectionYearData[];
  summary: {
    finalValue: number;
    finalRealValue: number;
    totalContributions: number;
    totalDividends: number;
    totalReturn: number;
    monthlyIncomeAtEnd: number;
    cagr: number;
  };
}

export function projectDividendGrowth(input: ProjectionInput): ProjectionResult {
  const {
    initialKrw, monthlyContribution, years: numYears,
    dividendYieldPct, priceGrowthPct, reinvestDividends,
    inflationPct, taxRate,
  } = input;

  const divYield = dividendYieldPct / 100;
  const priceGrowth = priceGrowthPct / 100;
  const inflation = inflationPct / 100;
  const taxMult = 1 - taxRate / 100;

  let portfolioValue = initialKrw;
  let cumulativeContributions = initialKrw;
  let cumulativeDividends = 0;
  const yearData: ProjectionYearData[] = [];

  for (let y = 1; y <= numYears; y++) {
    // 연간 적립금 (12개월)
    const annualContribution = monthlyContribution * 12;
    // 적립금은 연중 균등 투입 → 평균적으로 반년치 수익 적용
    const midYearContribution = annualContribution / 2;

    // 배당금 계산 (기초 + 적립금 반년 기준)
    const divBase = portfolioValue + midYearContribution;
    const annualDividend = divBase * divYield;
    const annualDividendAfterTax = annualDividend * taxMult;

    // 시세 상승 적용
    const priceAppreciation = divBase * priceGrowth;

    // 포트폴리오 = 기초 + 적립 + 시세상승 + (재투자 시 세후배당)
    portfolioValue = portfolioValue + annualContribution + priceAppreciation;
    if (reinvestDividends) {
      portfolioValue += annualDividendAfterTax;
    }

    cumulativeContributions += annualContribution;
    cumulativeDividends += annualDividendAfterTax;

    // 실질 가치 (인플레이션 차감)
    const realValue = portfolioValue / Math.pow(1 + inflation, y);
    const totalReturn = portfolioValue + (reinvestDividends ? 0 : cumulativeDividends) - cumulativeContributions;

    yearData.push({
      year: y,
      portfolioValue: Math.round(portfolioValue),
      realValue: Math.round(realValue),
      annualDividend: Math.round(annualDividend),
      annualDividendAfterTax: Math.round(annualDividendAfterTax),
      cumulativeContributions: Math.round(cumulativeContributions),
      cumulativeDividends: Math.round(cumulativeDividends),
      totalReturn: Math.round(totalReturn),
    });
  }

  const lastYear = yearData[yearData.length - 1];
  const finalValue = lastYear?.portfolioValue ?? initialKrw;
  const finalRealValue = lastYear?.realValue ?? initialKrw;
  const totalContributions = lastYear?.cumulativeContributions ?? initialKrw;
  const totalDividends = lastYear?.cumulativeDividends ?? 0;

  // CAGR 계산
  const totalEndValue = finalValue + (reinvestDividends ? 0 : totalDividends);
  const cagr = totalContributions > 0 && numYears > 0
    ? (Math.pow(totalEndValue / initialKrw, 1 / numYears) - 1) * 100
    : 0;

  // 마지막 해 기준 월 배당
  const monthlyIncomeAtEnd = lastYear
    ? Math.round(lastYear.annualDividendAfterTax / 12)
    : 0;

  return {
    years: yearData,
    summary: {
      finalValue: Math.round(finalValue),
      finalRealValue: Math.round(finalRealValue),
      totalContributions: Math.round(totalContributions),
      totalDividends: Math.round(totalDividends),
      totalReturn: Math.round(totalEndValue - totalContributions),
      monthlyIncomeAtEnd,
      cagr: +cagr.toFixed(1),
    },
  };
}
