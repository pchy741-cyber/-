/**
 * Dashboard builder helper functions — extracted from builder.ts IIFEs
 */

export interface SuggestedAction {
  type: string;
  priority: 'high' | 'medium' | 'low';
  message: string;
  detail?: string;
  mode?: 'paper' | 'live';
}

export function buildSuggestedActions(
  overseasHoldings: any[],
  displayChains: any[],
  grandTotalValue: number,
  actualCash: number,
): SuggestedAction[] {
  const actions: SuggestedAction[] = [];

  for (const h of overseasHoldings) {
    if (h.last_price <= 0 || h.avg_price <= 0) continue;
    const curPnlPct = ((h.last_price - h.avg_price) / h.avg_price) * 100;

    if (h.next_partial_tp_pct != null) {
      const gap = h.next_partial_tp_pct - curPnlPct;
      if (gap > 0 && gap <= 3) {
        actions.push({
          type: 'partial_tp_near',
          priority: 'high',
          message: `${h.stock_code} 부분익절 ${h.partial_tp_stage + 1}단계 임박`,
          detail: `현재 +${curPnlPct.toFixed(1)}% → 목표 +${h.next_partial_tp_pct}% (${gap.toFixed(1)}% 남음)`,
        });
      }
    }

    if (h.trail_active) {
      actions.push({
        type: 'trail_active',
        priority: 'medium',
        message: `${h.stock_code} 트레일링 스톱 가동 중`,
        detail: `고점 대비 +${h.max_pnl_pct.toFixed(1)}% / 현재 +${curPnlPct.toFixed(1)}% / 스톱 ${h.trail_stop_pct.toFixed(1)}%`,
      });
    }
  }

  // KIS T+2 정산 타이밍 불일치 시 현금 > 총자산 발생 가능 — 실제 현금 포함한 유효 총액으로 비중 계산
  const effectiveTotal = Math.max(grandTotalValue, actualCash || 0);
  const cashRatio = effectiveTotal > 0 ? ((actualCash || 0) / effectiveTotal) * 100 : 0;
  if (cashRatio > 60 && grandTotalValue > 100000) {
    actions.push({
      type: 'high_cash',
      priority: 'low',
      message: `현금 비중 ${Math.round(cashRatio)}% — 자동매매가 기회 탐색 중`,
      detail: `유휴 자금 ₩${Math.round(actualCash || 0).toLocaleString()} 대기`,
    });
  }

  for (const ch of displayChains) {
    const pnlPct = ch.unrealizedPnlPct ?? 0;
    if (pnlPct < -10) {
      actions.push({
        type: 'deep_loss',
        priority: 'high',
        message: `${ch.stock_name || ch.stock_code} 손실 ${pnlPct.toFixed(1)}%`,
        detail: '자동 손절 조건 모니터링 중',
      });
    }
  }

  return actions.slice(0, 8);
}

export interface MonthlyGoalResult {
  targetPct: number;
  targetAmount: number;
  currentPnl: number;
  progressPct: number;
  remaining: number;
}

export function buildMonthlyGoal(
  grandTotalValue: number,
  totalPnl: number,
  overseasMarketValueKrw: number,
  overseasInvestedKrw: number,
): MonthlyGoalResult {
  const monthlyTargetPct = 50;
  const seedKr = grandTotalValue > 0 ? grandTotalValue : 0;
  const targetAmount = Math.round((seedKr * monthlyTargetPct) / 100);
  const overseasUnrealizedForGoal = Number.isNaN(overseasMarketValueKrw - overseasInvestedKrw)
    ? 0
    : overseasMarketValueKrw - overseasInvestedKrw;
  const currentPnl = Math.round(totalPnl + overseasUnrealizedForGoal);
  const progressPct = targetAmount > 0 ? Math.min(200, Math.round((currentPnl / targetAmount) * 100)) : 0;
  return {
    targetPct: monthlyTargetPct,
    targetAmount,
    currentPnl,
    progressPct,
    remaining: Math.max(0, targetAmount - currentPnl),
  };
}

export interface FxImpactResult {
  fxRate: number;
  exposureUsd: number;
  exposureKrw: number;
  impactPer10Won: number;
  overseasPnlUsd: number;
  overseasPnlKrw: number;
}

export function buildFxImpact(
  overseasTotalInvested: number,
  overseasMarketValueUsd: number,
  fxRate: number,
): FxImpactResult | null {
  if (overseasTotalInvested <= 0 || fxRate <= 0) return null;
  const impactPer10Won = Math.round(overseasMarketValueUsd * 10);
  const overseasPnlUsd = overseasMarketValueUsd - overseasTotalInvested;
  const overseasPnlKrw = Math.round(overseasPnlUsd * fxRate);
  return {
    fxRate,
    exposureUsd: Math.round(overseasMarketValueUsd * 100) / 100,
    exposureKrw: Math.round(overseasMarketValueUsd * fxRate),
    impactPer10Won,
    overseasPnlUsd: Math.round(overseasPnlUsd * 100) / 100,
    overseasPnlKrw,
  };
}
