import { getPool, logSystem } from '../db/client.js';
import { logger } from '../utils/logger.js';

/**
 * 데이터 자동 아카이빙
 *
 * 매주 일요일 02:00 KST 실행
 * - system_log: 90일 초과 → 삭제 (순수 로그)
 * - ai_scores: 365일 보존 → 패턴 학습·Memory Agent 참조
 * - portfolio_snapshots: 365일 보존 → 포트폴리오 추이 분석
 * - risk_events: 365일 보존 → 리스크 패턴 학습
 * - orders/transaction_chains: 영구 보관 (매매 기록)
 */
export async function archiveOldData(): Promise<void> {
  const logCutoff = new Date();
  logCutoff.setDate(logCutoff.getDate() - 90);

  const dataCutoff = new Date();
  dataCutoff.setDate(dataCutoff.getDate() - 365);

  logger.info(
    `🗄️ 데이터 아카이빙 시작 (로그: ${logCutoff.toISOString().split('T')[0]} 이전, 데이터: ${dataCutoff.toISOString().split('T')[0]} 이전)`,
    { component: 'ARCHIVE' },
  );

  let totalDeleted = 0;

  // system_log 정리 (90일 — 순수 로그)
  try {
    const { rowCount } = await getPool().query('DELETE FROM system_log WHERE timestamp < $1', [
      logCutoff.toISOString(),
    ]);
    totalDeleted += rowCount ?? 0;
    logger.info(`  system_log: ${rowCount ?? 0}건 삭제`, { component: 'ARCHIVE' });
  } catch (e) {
    logger.warn(`  system_log 정리 실패: ${e}`, { component: 'ARCHIVE' });
  }

  // ai_scores 정리 (365일 — 패턴 학습에 활용)
  try {
    const { rowCount } = await getPool().query('DELETE FROM ai_scores WHERE created_at < $1', [
      dataCutoff.toISOString(),
    ]);
    totalDeleted += rowCount ?? 0;
    logger.info(`  ai_scores: ${rowCount ?? 0}건 삭제`, { component: 'ARCHIVE' });
  } catch (e) {
    logger.warn(`  ai_scores 정리 실패: ${e}`, { component: 'ARCHIVE' });
  }

  // portfolio_snapshots 정리 (365일 — 포트폴리오 추이 분석)
  try {
    // 양쪽 모드(paper + live) 모두 정리 — config.isPaper 한쪽만 정리 시 반대 모드 데이터 방치
    let snapDeleted = 0;
    for (const isPaperMode of [true, false]) {
      const { rowCount: rc } = await getPool().query(
        'DELETE FROM portfolio_snapshots WHERE snapshot_at < $1 AND is_paper = $2',
        [dataCutoff.toISOString(), isPaperMode],
      );
      snapDeleted += rc ?? 0;
    }
    totalDeleted += snapDeleted;
    logger.info(`  portfolio_snapshots: ${snapDeleted}건 삭제 (paper+live)`, { component: 'ARCHIVE' });
  } catch (e) {
    logger.warn(`  portfolio_snapshots 정리 실패: ${e}`, { component: 'ARCHIVE' });
  }

  // risk_events 정리 (365일 — 리스크 패턴 학습)
  try {
    const { rowCount } = await getPool().query('DELETE FROM risk_events WHERE created_at < $1', [
      dataCutoff.toISOString(),
    ]);
    totalDeleted += rowCount ?? 0;
    logger.info(`  risk_events: ${rowCount ?? 0}건 삭제`, { component: 'ARCHIVE' });
  } catch (e) {
    logger.warn(`  risk_events 정리 실패: ${e}`, { component: 'ARCHIVE' });
  }

  await logSystem('INFO', 'ARCHIVE', `데이터 아카이빙 완료: ${totalDeleted}건 삭제`);
  logger.info(`🗄️ 아카이빙 완료: 총 ${totalDeleted}건 삭제`, { component: 'ARCHIVE' });
}
