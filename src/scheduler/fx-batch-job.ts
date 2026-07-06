/**
 * v28 P3: 환전 배치 스켈레톤 — 수요일 환전
 * fx_ledger 테이블에 기록, 실제 환전은 TODO
 */
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';

export async function runFxBatchJob(): Promise<void> {
  const now = getKSTNow();
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 3=Wed

  // 수요일만 실행
  if (dayOfWeek !== 3) {
    logger.debug('환전 배치 — 수요일 아님, 스킵', { component: 'FX_BATCH' });
    return;
  }

  logger.info('💱 환전 배치 점검 시작 (수요일)', { component: 'FX_BATCH' });

  try {
    // TODO: 해외 잔고 확인 → 환전 필요 금액 계산
    // TODO: 환율 조회 (기준환율 vs 실제 적용환율)
    // TODO: spread_pct 계산
    // TODO: fx_ledger INSERT
    // TODO: 실제 환전 API 호출

    logger.info('💱 환전 배치 완료 (스켈레톤 — 실행 로직 미구현)', { component: 'FX_BATCH' });
  } catch (err) {
    logger.error(`환전 배치 실패: ${err}`, { component: 'FX_BATCH' });
  }
}
