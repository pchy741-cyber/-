/**
 * v28 P3: 세금수확 스켈레톤 — 12월 전용 (12/1~12/20만 활성)
 * 실현손익 합산 → 텔레그램 승인 대기 → TODO: 실행
 */
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';

export async function runTaxHarvestCheck(): Promise<void> {
  const now = getKSTNow();
  const month = now.getUTCMonth() + 1; // KST month
  const day = now.getUTCDate();

  // 12월 1~20일만 활성
  if (month !== 12 || day > 20) {
    logger.debug('세금수확 비활성 기간 — 스킵', { component: 'TAX_HARVEST' });
    return;
  }

  logger.info('📊 세금수확 점검 시작 (12월 활성기간)', { component: 'TAX_HARVEST' });

  try {
    // TODO: 실현손익 합산 (ai_scores + transaction_chains 기반)
    // TODO: 손실 종목 식별 → 세금 상쇄 가능 금액 계산
    // TODO: 텔레그램 승인 대기 메커니즘
    // TODO: 승인 후 자동 매도 실행

    logger.info('📊 세금수확 점검 완료 (스켈레톤 — 실행 로직 미구현)', { component: 'TAX_HARVEST' });
  } catch (err) {
    logger.error(`세금수확 실패: ${err}`, { component: 'TAX_HARVEST' });
  }
}
