/**
 * 국내주식 분할 수익실현 (Partial Take-Profit)
 *
 * 해외 시스템(risk-intelligence.ts)의 getPartialTpStages를 국내 포팅
 * 수익 종목에서 단계별로 일부 매도 → 수익 확정 + 나머지는 트레일링으로 더 달림
 *
 * 왕복 수수료: 0.21% (매수 0.015% + 매도 0.015% + 거래세 0.18%)
 */

import { BEAR_ADAPTIVE, SECTOR_MAP_KR } from '../../config/constants.js';
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
 * v15 Ultra Quick Win: Stage 1을 대폭 낮춰서 빠른 수익 확정 → 승률↑
 * 모멘텀(ADX≥28) 감지 시 기존 트리거 유지 → 위너 라이딩
 */
export function getKrPartialTpStages(stockCode: string, adx?: number, bearMode?: boolean): PartialTpStage[] {
  // 하락장 모드: 부분익절 비활성화 → TP 도달 시 전량 청산 (수수료 절감)
  if (bearMode) {
    return [];
  }

  const sector = SECTOR_MAP_KR[stockCode] ?? '';
  // v15: ADX≥28이면 모멘텀 → 기존 높은 트리거로 위너 라이딩
  const accel = (adx ?? 0) >= 28;

  // v11: 최소 트리거 1.0% 강제 (수수료 0.21% + 슬리피지 0.05% = 0.26% → 순익 0.74% 보장)
  // 기존 0.6~0.7% 트리거는 수수료 감안 시 순익 0.39~0.49% → 슬리피지 포함 시 사실상 손실
  const MIN_TRIGGER = 1.0;

  let stages: PartialTpStage[];

  // v19: Stage 1 트리거 상향 + sellRatio 축소 (40→25%) — 소액 익절 과다 → 손익비 개선
  // 핵심: 수수료 0.21% 감안 시 +1.0% 익절 = 순익 0.79% → 3회 손절 1회(SL -3%)이면 적자
  // 반도체/IT — 변동성 높은 대형주
  if (['반도체', 'IT', '전기전자'].includes(sector)) {
    stages = [
      { stage: 1, triggerPct: accel ? 3.0 : 2.0, sellRatio: 0.25 },
      { stage: 2, triggerPct: 4.5, sellRatio: 0.25 },
      { stage: 3, triggerPct: 7.0, sellRatio: 0.25 },
      { stage: 4, triggerPct: 11.0, sellRatio: 0.25 },
    ];
  } else if (['방산', '조선', '에너지', '화학', '철강'].includes(sector)) {
    // 방산/조선/에너지 — 중간 변동성
    stages = [
      { stage: 1, triggerPct: accel ? 3.5 : 2.0, sellRatio: 0.25 },
      { stage: 2, triggerPct: 5.0, sellRatio: 0.25 },
      { stage: 3, triggerPct: 8.0, sellRatio: 0.25 },
      { stage: 4, triggerPct: 12.0, sellRatio: 0.25 },
    ];
  } else if (['바이오', '제약'].includes(sector)) {
    // 바이오 — 고변동성
    stages = [
      { stage: 1, triggerPct: accel ? 4.0 : 2.5, sellRatio: 0.20 },
      { stage: 2, triggerPct: 6.0, sellRatio: 0.25 },
      { stage: 3, triggerPct: 10.0, sellRatio: 0.25 },
      { stage: 4, triggerPct: 15.0, sellRatio: 0.20 },
      { stage: 5, triggerPct: 22.0, sellRatio: 0.10 },
    ];
  } else if (['금융', '은행', '보험', '유틸리티', '통신'].includes(sector)) {
    // 금융/유틸리티 — 저변동성
    stages = [
      { stage: 1, triggerPct: accel ? 2.0 : 1.5, sellRatio: 0.25 },
      { stage: 2, triggerPct: 3.0, sellRatio: 0.25 },
      { stage: 3, triggerPct: 5.0, sellRatio: 0.25 },
      { stage: 4, triggerPct: 8.0, sellRatio: 0.25 },
    ];
  } else {
    // 기본 (자동차, 건설 등)
    stages = [
      { stage: 1, triggerPct: accel ? 3.0 : 2.0, sellRatio: 0.25 },
      { stage: 2, triggerPct: 4.5, sellRatio: 0.25 },
      { stage: 3, triggerPct: 7.0, sellRatio: 0.25 },
      { stage: 4, triggerPct: 10.0, sellRatio: 0.15 },
      { stage: 5, triggerPct: 14.0, sellRatio: 0.10 },
    ];
  }

  // 최소 트리거 강제 클램핑 (수수료+슬리피지 보장)
  return stages.map((s) => ({
    ...s,
    triggerPct: Math.max(s.triggerPct, MIN_TRIGGER),
  }));
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
  bearMode?: boolean; // 하락장 적응형 모드
}): Promise<Array<{ action: 'PARTIAL_SELL'; quantity: number; stage: number; triggerPct: number }>> {
  const { chainId, stockCode, pnlPct, totalQty, adx, bearMode } = params;

  // 최소 2주 이상 보유해야 분할 의미 있음
  if (totalQty < 2) return [];

  // 강한 추세(ADX ≥ 35)에서는 분할TP 임계값 +1.5% 상향 (추세 더 태우기)
  const trendBonus = (adx ?? 0) >= 35 ? 1.5 : 0;

  const stages = getKrPartialTpStages(stockCode, adx, bearMode);
  const currentStage = await getKrPartialTpStageNum(chainId);

  const nextStage = stages.find(
    (st) => st.stage > currentStage && pnlPct >= st.triggerPct + KR_ROUND_TRIP_FEE + trendBonus,
  );

  if (!nextStage) return [];

  const sellQty = Math.max(1, Math.floor(totalQty * nextStage.sellRatio));
  // v10.11: 스테이지 카운터는 매도 확인 후 호출측에서 증가 (기존: 여기서 미리 증가 → 매도 실패시 영구 스킵)
  // setKrPartialTpStageNum은 executor의 매도 체결 콜백에서 호출해야 함

  logger.info(
    `💰 분할TP ${nextStage.stage}단계: ${stockCode} +${pnlPct.toFixed(1)}% → ${sellQty}주 매도 (${(nextStage.sellRatio * 100).toFixed(0)}%)${trendBonus > 0 ? ' [추세보너스+1.5%]' : ''}`,
    { component: 'PARTIAL_TP' },
  );

  return [{ action: 'PARTIAL_SELL', quantity: sellQty, stage: nextStage.stage, triggerPct: nextStage.triggerPct }];
}
