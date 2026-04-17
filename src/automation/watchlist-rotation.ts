import { getPool, logSystem } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

/**
 * 워치리스트 자동 순환 (Weekly)
 *
 * - 지난 14일간 AI 스코어 평균이 40점 미만인 종목 → 비활성화
 * - 단, 현재 보유 중인 종목은 절대 제거하지 않음
 * - 주 1회 (일요일 19:00) 실행
 */
const MIN_SCORE_THRESHOLD = 40;
const EVAL_DAYS = 14;
const MIN_SCORE_RECORDS = 3; // 최소 3회 이상 평가된 종목만 판단

export async function runWatchlistRotation(): Promise<void> {
  logger.info('🔄 워치리스트 자동 순환 시작', { component: 'WATCHLIST_ROTATION' });

  try {
    const pool = getPool();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - EVAL_DAYS);

    // 현재 보유 중인 종목 코드 목록 (절대 제거 금지)
    const { rows: holdingRows } = await pool.query(
      `SELECT DISTINCT stock_code FROM transaction_chains WHERE status = 'OPEN' AND total_quantity > 0`,
    );
    const holdingCodes = new Set(holdingRows.map((r: any) => String(r.stock_code)));

    // 최근 14일간 평균 스코어 계산
    const { rows: scoreRows } = await pool.query(
      `SELECT stock_code,
              COUNT(*) AS record_count,
              AVG(composite_score) AS avg_score
         FROM ai_scores
        WHERE score_date >= $1
          AND composite_score IS NOT NULL
        GROUP BY stock_code`,
      [cutoff.toISOString().split('T')[0]],
    );

    const removed: string[] = [];
    const skipped: string[] = [];

    for (const row of scoreRows) {
      const code = String(row.stock_code);
      const avgScore = Number(row.avg_score ?? 0);
      const recordCount = Number(row.record_count ?? 0);

      if (recordCount < MIN_SCORE_RECORDS) continue; // 데이터 부족 → 유지
      if (avgScore >= MIN_SCORE_THRESHOLD) continue; // 점수 충분 → 유지

      if (holdingCodes.has(code)) {
        skipped.push(`${code}(보유중, ${avgScore.toFixed(0)}점)`);
        continue;
      }

      // 비활성화 (is_active = false)
      await pool.query(
        `UPDATE watchlist SET is_active = false WHERE stock_code = $1`,
        [code],
      );
      logger.info(
        `🗑️ 워치리스트 제거: ${code} — 14일 평균 ${avgScore.toFixed(1)}점 (기준 ${MIN_SCORE_THRESHOLD}점 미달)`,
        { component: 'WATCHLIST_ROTATION' },
      );
      removed.push(`${code}(${avgScore.toFixed(0)}점)`);
    }

    await logSystem('INFO', 'WATCHLIST_ROTATION', '워치리스트 순환 완료', {
      removed: removed.length,
      skipped: skipped.length,
      removedCodes: removed,
      skippedCodes: skipped,
    });

    if (removed.length > 0 || skipped.length > 0) {
      const msg = [
        `🔄 워치리스트 자동 순환 완료`,
        removed.length > 0 ? `제거(${removed.length}): ${removed.join(', ')}` : '',
        skipped.length > 0 ? `보유중 유지(${skipped.length}): ${skipped.join(', ')}` : '',
      ].filter(Boolean).join('\n');
      await sendTelegramMessage(msg);
    } else {
      logger.info('워치리스트 순환: 제거 대상 없음', { component: 'WATCHLIST_ROTATION' });
    }
  } catch (error) {
    logger.error(`워치리스트 순환 실패: ${error}`, { component: 'WATCHLIST_ROTATION' });
  }
}
