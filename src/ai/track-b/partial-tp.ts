/**
 * 국내주식 분할 수익실현 (Partial Take-Profit)
 *
 * 해외 시스템(risk-intelligence.ts)의 getPartialTpStages를 국내 포팅
 * 수익 종목에서 단계별로 일부 매도 → 수익 확정 + 나머지는 트레일링으로 더 달림
 *
 * 왕복 수수료: 0.21% (매수 0.015% + 매도 0.015% + 거래세 0.18%)
 */

import { SECTOR_MAP_KR } from '../../config/constants.js';
import { safeQuery } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

const KR_ROUND_TRIP_FEE = 0.21; // %

export interface PartialTpStage {
  stage: number;
  triggerPct: number; // 수익률 임계값 (수수료 미포함)
  sellRatio: number;  // 매도 비율 (0~1)
}

/**
 * 국내 섹터별 분할 수익실현 단계
 * - 대형주: 보수적 (1.5%부터)
 * - 중소형/테마: 공격적 (2%부터, 더 넓은 간격)
 * - 방어주: 빠른 확정 (1%부터)
 */
export function getKrPartialTpStages(stockCode: string): PartialTpStage[] {
  const sector = SECTOR_MAP_KR[stockCode] ?? '';

  // 반도체/IT — 변동성 높은 대형주
  if (['반도체', 'IT', '전기전자'].includes(sector)) {
    return [
      { stage: 1, triggerPct: 2.0, sellRatio: 0.25 },  // +2% → 25% 확정
      { stage: 2, triggerPct: 4.0, sellRatio: 0.20 },  // +4% → 20%
      { stage: 3, triggerPct: 7.0, sellRatio: 0.20 },  // +7% → 20%
      { stage: 4, triggerPct: 11.0, sellRatio: 0.20 }, // +11% → 20%
      { stage: 5, triggerPct: 16.0, sellRatio: 0.15 }, // +16% → 15% (나머지 트레일링)
    ];
  }

  // 방산/조선/에너지 — 중간 변동성
  if (['방산', '조선', '에너지', '화학', '철강'].includes(sector)) {
    return [
      { stage: 1, triggerPct: 2.5, sellRatio: 0.25 },
      { stage: 2, triggerPct: 5.0, sellRatio: 0.25 },
      { stage: 3, triggerPct: 8.0, sellRatio: 0.25 },
      { stage: 4, triggerPct: 12.0, sellRatio: 0.25 },
    ];
  }

  // 바이오 — 고변동성
  if (['바이오', '제약'].includes(sector)) {
    return [
      { stage: 1, triggerPct: 3.0, sellRatio: 0.20 },
      { stage: 2, triggerPct: 6.0, sellRatio: 0.20 },
      { stage: 3, triggerPct: 10.0, sellRatio: 0.20 },
      { stage: 4, triggerPct: 15.0, sellRatio: 0.20 },
      { stage: 5, triggerPct: 22.0, sellRatio: 0.20 },
    ];
  }

  // 금융/유틸리티 — 저변동성, 빠른 확정
  if (['금융', '은행', '보험', '유틸리티', '통신'].includes(sector)) {
    return [
      { stage: 1, triggerPct: 1.5, sellRatio: 0.30 },
      { stage: 2, triggerPct: 3.0, sellRatio: 0.30 },
      { stage: 3, triggerPct: 5.0, sellRatio: 0.25 },
      { stage: 4, triggerPct: 8.0, sellRatio: 0.15 },
    ];
  }

  // 기본 (자동차, 건설 등)
  return [
    { stage: 1, triggerPct: 2.0, sellRatio: 0.25 },
    { stage: 2, triggerPct: 4.0, sellRatio: 0.20 },
    { stage: 3, triggerPct: 7.0, sellRatio: 0.20 },
    { stage: 4, triggerPct: 10.0, sellRatio: 0.20 },
    { stage: 5, triggerPct: 14.0, sellRatio: 0.15 },
  ];
}

// ── DB 기반 스테이지 추적 (transaction_chains.metadata JSON) ──

export async function getKrPartialTpStageNum(chainId: string): Promise<number> {
  try {
    const { rows } = await safeQuery<{ partial_tp_stage: number }>(
      `SELECT (metadata->>'partial_tp_stage')::int AS partial_tp_stage FROM transaction_chains WHERE id = $1`,
      [chainId],
    );
    return rows[0]?.partial_tp_stage ?? 0;
  } catch {
    return 0;
  }
}

export async function setKrPartialTpStageNum(chainId: string, stage: number): Promise<void> {
  try {
    await safeQuery(
      `UPDATE transaction_chains SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('partial_tp_stage', $2) WHERE id = $1`,
      [chainId, stage],
    );
  } catch (e) {
    logger.warn(`분할 TP 스테이지 저장 실패: ${e}`, { component: 'PARTIAL_TP' });
  }
}

/**
 * 분할 수익실현 결정 생성
 * @returns PARTIAL_SELL 결정 배열 (빈 배열 = 해당 없음)
 */
export async function evaluateKrPartialTp(params: {
  chainId: string;
  stockCode: string;
  pnlPct: number;
  totalQty: number;
  adx?: number; // ADX ≥35 추세 강하면 분할TP 지연
}): Promise<Array<{ action: 'PARTIAL_SELL'; quantity: number; stage: number; triggerPct: number }>> {
  const { chainId, stockCode, pnlPct, totalQty, adx } = params;

  // 최소 2주 이상 보유해야 분할 의미 있음
  if (totalQty < 2) return [];

  // 강한 추세(ADX ≥ 35)에서는 분할TP 임계값 +1.5% 상향 (추세 더 태우기)
  const trendBonus = (adx ?? 0) >= 35 ? 1.5 : 0;

  const stages = getKrPartialTpStages(stockCode);
  const currentStage = await getKrPartialTpStageNum(chainId);

  const nextStage = stages.find(
    (st) => st.stage > currentStage && pnlPct >= st.triggerPct + KR_ROUND_TRIP_FEE + trendBonus,
  );

  if (!nextStage) return [];

  const sellQty = Math.max(1, Math.floor(totalQty * nextStage.sellRatio));
  await setKrPartialTpStageNum(chainId, nextStage.stage);

  logger.info(
    `💰 분할TP ${nextStage.stage}단계: ${stockCode} +${pnlPct.toFixed(1)}% → ${sellQty}주 매도 (${(nextStage.sellRatio * 100).toFixed(0)}%)${trendBonus > 0 ? ' [추세보너스+1.5%]' : ''}`,
    { component: 'PARTIAL_TP' },
  );

  return [{ action: 'PARTIAL_SELL', quantity: sellQty, stage: nextStage.stage, triggerPct: nextStage.triggerPct }];
}
