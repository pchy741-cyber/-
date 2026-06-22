/**
 * Piotroski F-Score 모듈
 *
 * DART 재무데이터(당기/전기)로 9가지 재무건전성 신호를 계산하여
 * 가짜 돌파 차단 및 Track B 점수 조정에 활용.
 *
 * F1-F4: 수익성, F5-F7: 재무구조, F8-F9: 효율성
 */

import type { FinancialStatement } from './dart-research.js';

export interface PiotroskiFScoreResult {
  fScore: number;       // 0-9 합산 점수
  signals: boolean[];   // 9개 개별 신호 (F1~F9)
}

/**
 * Piotroski F-Score 계산 (순수 함수)
 * @param current 당기 재무제표
 * @param prior   전기 재무제표
 */
export function calcPiotroskiFScore(
  current: FinancialStatement,
  prior: FinancialStatement,
): PiotroskiFScoreResult {
  // 파생 지표 계산
  const curROA = current.totalAssets > 0 ? current.netIncome / current.totalAssets : 0;
  const priorROA = prior.totalAssets > 0 ? prior.netIncome / prior.totalAssets : 0;

  const curEquity = current.equity ?? (current.totalAssets - current.totalDebt);
  const priorEquity = prior.equity ?? (prior.totalAssets - prior.totalDebt);

  const curDebtRatio = curEquity > 0 ? current.totalDebt / curEquity : Infinity;
  const priorDebtRatio = priorEquity > 0 ? prior.totalDebt / priorEquity : Infinity;

  const curCurrentRatio =
    current.currentAssets != null && current.currentLiabilities != null && current.currentLiabilities > 0
      ? current.currentAssets / current.currentLiabilities
      : null;
  const priorCurrentRatio =
    prior.currentAssets != null && prior.currentLiabilities != null && prior.currentLiabilities > 0
      ? prior.currentAssets / prior.currentLiabilities
      : null;

  const curGrossMargin =
    current.grossProfit != null && current.revenue > 0
      ? current.grossProfit / current.revenue
      : null;
  const priorGrossMargin =
    prior.grossProfit != null && prior.revenue > 0
      ? prior.grossProfit / prior.revenue
      : null;

  const curAssetTurnover = current.totalAssets > 0 ? current.revenue / current.totalAssets : 0;
  const priorAssetTurnover = prior.totalAssets > 0 ? prior.revenue / prior.totalAssets : 0;

  // ── 9가지 F-Score 신호 ──

  // F1: 순이익 > 0 (수익성)
  const f1 = current.netIncome > 0;

  // F2: 영업CF > 0 (수익성) — CF 데이터 없으면 영업이익으로 대체
  const f2 = current.operatingCashFlow != null
    ? current.operatingCashFlow > 0
    : current.operatingIncome > 0;

  // F3: ROA 개선 (수익성)
  const f3 = curROA > priorROA;

  // F4: CF > 순이익 (수익의 질) — CF 데이터 없으면 영업이익 > 순이익으로 근사
  const f4 = current.operatingCashFlow != null
    ? current.operatingCashFlow > current.netIncome
    : current.operatingIncome > current.netIncome;

  // F5: 부채비율 감소 (재무구조)
  const f5 = curDebtRatio < priorDebtRatio;

  // F6: 유동비율 개선 (재무구조) — 데이터 없으면 false (보수적)
  const f6 = curCurrentRatio != null && priorCurrentRatio != null
    ? curCurrentRatio > priorCurrentRatio
    : false;

  // F7: 신주 미발행 (재무구조) — equity 증가가 순이익보다 크면 신주 발행 의심
  // 단순 근사: equity 변동 - netIncome > 0이면 외부 조달 → false
  const equityChange = curEquity - priorEquity;
  const f7 = equityChange <= current.netIncome;

  // F8: 매출총이익률 개선 (효율성) — 데이터 없으면 영업이익률로 대체
  const f8 = curGrossMargin != null && priorGrossMargin != null
    ? curGrossMargin > priorGrossMargin
    : current.operatingMargin > prior.operatingMargin;

  // F9: 자산회전율 개선 (효율성)
  const f9 = curAssetTurnover > priorAssetTurnover;

  const signals = [f1, f2, f3, f4, f5, f6, f7, f8, f9];
  const fScore = signals.filter(Boolean).length;

  return { fScore, signals };
}
