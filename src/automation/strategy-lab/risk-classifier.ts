/**
 * 졸업 리스크 분류 — LOW/MEDIUM/HIGH 자동 판정
 *
 * LOW:    자동적용 (알림 없음)  — 기준 대비 여유 큼
 * MEDIUM: 자동적용 + CEO 알림  — 기준 충족, 적정 여유
 * HIGH:   CEO 승인 필수        — 여유 부족 or 고위험 전략
 */

import type { GraduationCriteria, GraduationResult } from '../strategy-graduation.js';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RiskClassification {
  level: RiskLevel;
  reasons: string[];
  autoApply: boolean;
}

const HIGH_RISK_STRATEGIES = new Set(['BREAKOUT']);

// ── 리스크 분류 기준 상수 ──
const NARROW_WIN_RATE_MARGIN = 0.03; // 승률 여유 부족 기준 (3%p)
const NARROW_PF_MARGIN = 0.2; // PF 여유 부족 기준
const NARROW_MDD_MARGIN = 3; // MDD 여유 부족 기준 (%p)
const LOW_WIN_RATE_MARGIN = 0.1; // LOW 리스크 승률 기준 (10%p 이상)
const LOW_PF_MARGIN = 0.5; // LOW 리스크 PF 기준
const LOW_MDD_MARGIN = 5; // LOW 리스크 MDD 기준 (%p)
const LOW_TRADE_RATIO = 1.5; // LOW 리스크 거래수 비율

export function classifyGraduationRisk(result: GraduationResult, criteria: GraduationCriteria): RiskClassification {
  if (!result.eligible) {
    return { level: 'HIGH', reasons: ['기준 미충족'], autoApply: false };
  }

  const { actual } = result;
  const reasons: string[] = [];

  const wrMargin = actual.winRate - criteria.minWinRate;
  const pfMargin = actual.profitFactor - criteria.minProfitFactor;
  // mdd: 둘 다 음수, actual이 0에 가까울수록 좋음
  const mddMargin = actual.mdd - criteria.maxMDD;
  const tradeRatio = actual.trades / criteria.minTrades;

  // HIGH: 여유 부족 or 고위험 전략
  const isHighRisk = HIGH_RISK_STRATEGIES.has(result.mode);
  const narrowWR = wrMargin < NARROW_WIN_RATE_MARGIN;
  const narrowPF = pfMargin < NARROW_PF_MARGIN;
  const narrowMDD = mddMargin < NARROW_MDD_MARGIN;

  if (isHighRisk) reasons.push(`고위험 전략 (${result.mode})`);
  if (narrowWR) reasons.push(`승률 여유 ${(wrMargin * 100).toFixed(1)}%p`);
  if (narrowPF) reasons.push(`PF 여유 ${pfMargin.toFixed(2)}`);
  if (narrowMDD) reasons.push(`MDD 한도 근접 ${mddMargin.toFixed(1)}%p`);

  if (isHighRisk || narrowWR || narrowPF || narrowMDD) {
    return { level: 'HIGH', reasons, autoApply: false };
  }

  // LOW: 모든 기준 충분한 여유
  if (wrMargin >= LOW_WIN_RATE_MARGIN && pfMargin >= LOW_PF_MARGIN && mddMargin >= LOW_MDD_MARGIN && tradeRatio >= LOW_TRADE_RATIO) {
    reasons.push('모든 기준 충분한 여유');
    return { level: 'LOW', reasons, autoApply: true };
  }

  // MEDIUM: 기준 충족, 적정 여유
  reasons.push('기준 충족, 적정 여유');
  return { level: 'MEDIUM', reasons, autoApply: true };
}
