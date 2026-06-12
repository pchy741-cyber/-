import { getPool, logSystem } from '../db/client.js';
import { logger } from '../utils/logger.js';

/**
 * 데이터 자동 아카이빙 — 백테스팅/장기 학습 데이터 영구 보존
 *
 * 매주 일요일 02:00 KST 실행
 *
 * 🛡️ 영구 보관 (절대 삭제 안 함):
 *   - orders, transaction_chains: 매매 기록 (백테스팅 핵심)
 *   - ai_scores: 패턴 학습 데이터
 *   - portfolio_snapshots: 포트폴리오 추이
 *   - risk_events: 리스크 이벤트 이력
 *
 * 🗑️ 단기 보관 (운영 데이터, 영향 미미):
 *   - system_log: 180일 (로그)
 *   - loop_ticks: 7일 (틱 수준 로그)
 *   - loop_sessions: 30일 (종결만)
 *   - capture_snapshots: 30일 (캡쳐 진단 — 최근 보존이면 충분)
 *
 * CEO 지시 (2026-06-12): "백테스팅 때문에 유지비 들면서 데이터 쌓게 하는데
 * 날라가는 게 말이 되나" → 모든 학습 데이터 영구 보존
 */
export async function archiveOldData(): Promise<void> {
  // 로그성 데이터만 cutoff 적용 (학습 데이터는 영구)
  const logCutoff = new Date();
  logCutoff.setDate(logCutoff.getDate() - 180); // 90일 → 180일 확장

  logger.info(`🗄️ 데이터 아카이빙 시작 (로그만: ${logCutoff.toISOString().split('T')[0]} 이전, 학습 데이터 영구 보존)`, {
    component: 'ARCHIVE',
  });

  let totalDeleted = 0;

  // system_log 정리 (180일 — 순수 로그, 진단 데이터 보존 늘림)
  try {
    const { rowCount } = await getPool().query('DELETE FROM system_log WHERE timestamp < $1', [
      logCutoff.toISOString(),
    ]);
    totalDeleted += rowCount ?? 0;
    logger.info(`  system_log: ${rowCount ?? 0}건 삭제 (180일+)`, { component: 'ARCHIVE' });
  } catch (e) {
    logger.warn(`  system_log 정리 실패: ${e}`, { component: 'ARCHIVE' });
  }

  // 🛡️ ai_scores / portfolio_snapshots / risk_events:
  //   영구 보존 — 백테스팅·장기 학습 데이터로 절대 삭제 안 함.
  //   이전 365일 cutoff 삭제 → DB 크기 우려 시 BigQuery로 오프로드
  logger.info(
    `  [BACKTEST] ai_scores/portfolio_snapshots/risk_events 영구 보존 (BigQuery 백업으로 오프로드 가능)`,
    { component: 'ARCHIVE' },
  );

  // ── 장기 운영 보완 (2026-06-12): 빠르게 누적되는 운영 데이터 단기 보존 ──

  // loop_ticks (7일+) — 매 5분 1 row * 24h * 7일 = 2016/주 → 빠르게 큰
  const tickCutoff = new Date();
  tickCutoff.setDate(tickCutoff.getDate() - 7);
  try {
    const { rowCount } = await getPool().query('DELETE FROM loop_ticks WHERE executed_at < $1', [
      tickCutoff.toISOString(),
    ]);
    totalDeleted += rowCount ?? 0;
    logger.info(`  loop_ticks: ${rowCount ?? 0}건 삭제 (7일+)`, { component: 'ARCHIVE' });
  } catch (e) {
    logger.warn(`  loop_ticks 정리 실패: ${e}`, { component: 'ARCHIVE' });
  }

  // loop_sessions (30일+) — 일 1세션 정도
  const sessionCutoff = new Date();
  sessionCutoff.setDate(sessionCutoff.getDate() - 30);
  try {
    const { rowCount } = await getPool().query(
      'DELETE FROM loop_sessions WHERE ended_at IS NOT NULL AND started_at < $1',
      [sessionCutoff.toISOString()],
    );
    totalDeleted += rowCount ?? 0;
    logger.info(`  loop_sessions: ${rowCount ?? 0}건 삭제 (30일+ 종결)`, { component: 'ARCHIVE' });
  } catch (e) {
    logger.warn(`  loop_sessions 정리 실패: ${e}`, { component: 'ARCHIVE' });
  }

  // capture_snapshots (30일+) — 시간별 2건 * 24h * 30일 = 1440/월
  try {
    const { rowCount } = await getPool().query('DELETE FROM capture_snapshots WHERE captured_at < $1', [
      sessionCutoff.toISOString(),
    ]);
    totalDeleted += rowCount ?? 0;
    logger.info(`  capture_snapshots: ${rowCount ?? 0}건 삭제 (30일+)`, { component: 'ARCHIVE' });
  } catch (e) {
    logger.warn(`  capture_snapshots 정리 실패: ${e}`, { component: 'ARCHIVE' });
  }

  await logSystem('INFO', 'ARCHIVE', `데이터 아카이빙 완료: ${totalDeleted}건 삭제`);
  logger.info(`🗄️ 아카이빙 완료: 총 ${totalDeleted}건 삭제`, { component: 'ARCHIVE' });
}
