import { getPool, logSystem } from '../db/client.js';
import { logger } from '../utils/logger.js';

/**
 * 3개월 데이터 자동 아카이빙
 *
 * 매주 일요일 02:00 KST 실행
 * - system_log: 90일 초과 → 삭제
 * - ai_scores: 90일 초과 → 삭제
 * - portfolio_snapshots: 90일 초과 → 삭제
 * - orders/transaction_chains: 유지 (매매 기록은 영구 보관)
 */
export async function archiveOldData(): Promise<void> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 90);
  const cutoff = cutoffDate.toISOString();

  logger.info(`🗄️ 데이터 아카이빙 시작 (기준: ${cutoff.split('T')[0]} 이전)`, { component: 'ARCHIVE' });

  let totalDeleted = 0;

  // system_log 정리
  try {
    const { rowCount } = await getPool().query('DELETE FROM system_log WHERE timestamp < $1', [cutoff]);
    totalDeleted += rowCount ?? 0;
    logger.info(`  system_log: ${rowCount ?? 0}건 삭제`, { component: 'ARCHIVE' });
  } catch (e) {
    logger.warn(`  system_log 정리 실패: ${e}`, { component: 'ARCHIVE' });
  }

  // ai_scores 정리
  try {
    const { rowCount } = await getPool().query('DELETE FROM ai_scores WHERE created_at < $1', [cutoff]);
    totalDeleted += rowCount ?? 0;
    logger.info(`  ai_scores: ${rowCount ?? 0}건 삭제`, { component: 'ARCHIVE' });
  } catch (e) {
    logger.warn(`  ai_scores 정리 실패: ${e}`, { component: 'ARCHIVE' });
  }

  // portfolio_snapshots 정리
  try {
    const { rowCount } = await getPool().query('DELETE FROM portfolio_snapshots WHERE snapshot_at < $1', [cutoff]);
    totalDeleted += rowCount ?? 0;
    logger.info(`  portfolio_snapshots: ${rowCount ?? 0}건 삭제`, { component: 'ARCHIVE' });
  } catch (e) {
    logger.warn(`  portfolio_snapshots 정리 실패: ${e}`, { component: 'ARCHIVE' });
  }

  // risk_events 정리
  try {
    const { rowCount } = await getPool().query('DELETE FROM risk_events WHERE created_at < $1', [cutoff]);
    totalDeleted += rowCount ?? 0;
    logger.info(`  risk_events: ${rowCount ?? 0}건 삭제`, { component: 'ARCHIVE' });
  } catch (e) {
    logger.warn(`  risk_events 정리 실패: ${e}`, { component: 'ARCHIVE' });
  }

  await logSystem('INFO', 'ARCHIVE', `데이터 아카이빙 완료: ${totalDeleted}건 삭제`);
  logger.info(`🗄️ 아카이빙 완료: 총 ${totalDeleted}건 삭제`, { component: 'ARCHIVE' });
}
