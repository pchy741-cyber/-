import { getPool, logSystem } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

/**
 * 워치리스트 자동 순환 (Weekly)
 *
 * - 지난 14일간 AI 스코어 평균이 40점 미만인 종목 → 비활성화
 * - 지난 7일간 AI 스코어 평균이 65점 이상 + 워치리스트 미등록 종목 → 자동 추가
 * - 단, 현재 보유 중인 종목은 절대 제거하지 않음
 * - 주 1회 (일요일 19:00) 실행
 */
const MIN_SCORE_THRESHOLD = 40;
const AUTO_ADD_THRESHOLD = 65; // 자동 추가 기준 점수
const EVAL_DAYS = 14;
const ADD_EVAL_DAYS = 7; // 자동 추가는 최근 7일 기준
const MIN_SCORE_RECORDS = 3;
const MIN_ADD_RECORDS = 3; // 자동 추가 최소 평가 건수
const MAX_AUTO_ADD = 5; // 주당 최대 자동 추가 종목 수

export async function runWatchlistRotation(): Promise<void> {
  logger.info('🔄 워치리스트 자동 순환 시작', { component: 'WATCHLIST_ROTATION' });

  try {
    const pool = getPool();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - EVAL_DAYS);

    const addCutoff = new Date();
    addCutoff.setDate(addCutoff.getDate() - ADD_EVAL_DAYS);

    // 현재 보유 중인 종목 코드 목록 (절대 제거 금지)
    const { rows: holdingRows } = await pool.query(
      `SELECT DISTINCT stock_code FROM transaction_chains WHERE status = 'OPEN' AND total_quantity > 0`,
    );
    const holdingCodes = new Set(holdingRows.map((r: any) => String(r.stock_code)));

    // 현재 워치리스트 전체 (활성/비활성 모두)
    const { rows: watchlistRows } = await pool.query(`SELECT stock_code FROM watchlist`);
    const existingCodes = new Set(watchlistRows.map((r: any) => String(r.stock_code)));

    // ── 1. 저성과 종목 제거 ──────────────────────────────────────────────
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

      if (!existingCodes.has(code)) continue; // 워치리스트에 없으면 스킵
      if (recordCount < MIN_SCORE_RECORDS) continue;
      if (avgScore >= MIN_SCORE_THRESHOLD) continue;

      if (holdingCodes.has(code)) {
        skipped.push(`${code}(보유중, ${avgScore.toFixed(0)}점)`);
        continue;
      }

      await pool.query(`UPDATE watchlist SET is_active = false WHERE stock_code = $1`, [code]);
      logger.info(
        `🗑️ 워치리스트 제거: ${code} — 14일 평균 ${avgScore.toFixed(1)}점 (기준 ${MIN_SCORE_THRESHOLD}점 미달)`,
        { component: 'WATCHLIST_ROTATION' },
      );
      removed.push(`${code}(${avgScore.toFixed(0)}점)`);
    }

    // ── 2. 고점수 신규 종목 자동 추가 ────────────────────────────────────
    const { rows: addCandidates } = await pool.query(
      `SELECT stock_code,
              COUNT(*) AS record_count,
              AVG(composite_score) AS avg_score,
              MAX(stock_name) AS stock_name
         FROM ai_scores
        WHERE score_date >= $1
          AND composite_score IS NOT NULL
        GROUP BY stock_code
        HAVING COUNT(*) >= $2 AND AVG(composite_score) >= $3
        ORDER BY AVG(composite_score) DESC
        LIMIT 20`,
      [addCutoff.toISOString().split('T')[0], MIN_ADD_RECORDS, AUTO_ADD_THRESHOLD],
    );

    const added: string[] = [];

    for (const row of addCandidates) {
      if (added.length >= MAX_AUTO_ADD) break;

      const code = String(row.stock_code);
      const avgScore = Number(row.avg_score ?? 0);
      const stockName = String(row.stock_name ?? code);

      if (existingCodes.has(code)) {
        // 이미 있으면 비활성화됐을 수 있으니 재활성화
        const { rowCount } = await pool.query(
          `UPDATE watchlist SET is_active = true WHERE stock_code = $1 AND is_active = false`,
          [code],
        );
        if (rowCount && rowCount > 0) {
          logger.info(`♻️ 워치리스트 재활성화: ${code}(${stockName}) — 7일 평균 ${avgScore.toFixed(1)}점`, { component: 'WATCHLIST_ROTATION' });
          added.push(`${code}(${avgScore.toFixed(0)}점, 재활성화)`);
        }
        continue;
      }

      // 신규 추가 (source 컬럼은 없을 수 있으므로 기본 컬럼만 사용)
      await pool.query(
        `INSERT INTO watchlist (stock_code, stock_name, is_active)
         VALUES ($1, $2, true)
         ON CONFLICT (stock_code) DO UPDATE SET is_active = true, stock_name = EXCLUDED.stock_name`,
        [code, stockName],
      );
      existingCodes.add(code); // 중복 추가 방지
      logger.info(
        `✨ 워치리스트 자동 추가: ${code}(${stockName}) — 7일 평균 ${avgScore.toFixed(1)}점`,
        { component: 'WATCHLIST_ROTATION' },
      );
      added.push(`${code}(${avgScore.toFixed(0)}점)`);
    }

    // ── 3. 결과 리포트 ───────────────────────────────────────────────────
    await logSystem('INFO', 'WATCHLIST_ROTATION', '워치리스트 순환 완료', {
      removed: removed.length,
      added: added.length,
      skipped: skipped.length,
      removedCodes: removed,
      addedCodes: added,
      skippedCodes: skipped,
    });

    const hasChanges = removed.length > 0 || added.length > 0 || skipped.length > 0;
    if (hasChanges) {
      const msg = [
        `🔄 워치리스트 자동 순환 완료`,
        removed.length > 0 ? `제거(${removed.length}): ${removed.join(', ')}` : '',
        added.length > 0 ? `✨ 신규 추가(${added.length}): ${added.join(', ')}` : '',
        skipped.length > 0 ? `보유중 유지(${skipped.length}): ${skipped.join(', ')}` : '',
      ].filter(Boolean).join('\n');
      await sendTelegramMessage(msg);
    } else {
      logger.info('워치리스트 순환: 변경 없음', { component: 'WATCHLIST_ROTATION' });
    }
  } catch (error) {
    logger.error(`워치리스트 순환 실패: ${error}`, { component: 'WATCHLIST_ROTATION' });
  }
}
