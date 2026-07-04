import { isMemoryMode, queryWithRetry } from '../pool.js';
import { memGetLatestScores, memUpsertAIScore } from '../memory-store.js';
import type { AIScore } from '../models.js';
import { getKSTNow } from '../../utils/time.js';

/** KST 기준 YYYY-MM-DD 문자열 (UTC 사용 시 새벽 시간대 날짜 불일치 방지) */
function kstDateStr(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export async function upsertAIScore(score: Omit<AIScore, 'id' | 'created_at'>) {
  // 점수 범위 검증: 음수 또는 100 초과 → 클램핑 (AI 모델 오출력 방어)
  if (score.composite_score != null) {
    score = { ...score, composite_score: Math.max(0, Math.min(100, score.composite_score)) };
  }
  if (score.fundamental_score != null) {
    score = { ...score, fundamental_score: Math.max(0, Math.min(100, score.fundamental_score)) };
  }
  if (score.technical_score != null) {
    score = { ...score, technical_score: Math.max(0, Math.min(100, score.technical_score)) };
  }
  if (score.sentiment_score != null) {
    score = { ...score, sentiment_score: Math.max(0, Math.min(100, score.sentiment_score)) };
  }
  if (isMemoryMode()) {
    memUpsertAIScore(score);
    return;
  }
  await queryWithRetry(
    `INSERT INTO ai_scores (stock_code, score_date, gemini_summary, composite_score,
       fundamental_score, technical_score, sentiment_score, confidence, reasoning,
       signal, target_price, stop_loss_price)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (stock_code, score_date) DO UPDATE SET
       gemini_summary=$3, composite_score=$4, fundamental_score=$5,
       technical_score=$6, sentiment_score=$7, confidence=$8, reasoning=$9,
       signal=$10, target_price=$11, stop_loss_price=$12`,
    [
      score.stock_code,
      score.score_date,
      JSON.stringify(score.gemini_summary),
      score.composite_score,
      score.fundamental_score,
      score.technical_score,
      score.sentiment_score,
      score.confidence,
      score.reasoning,
      score.signal,
      score.target_price,
      score.stop_loss_price,
    ],
  );
}

export async function getLatestScores(stockCodes: string[]): Promise<AIScore[]> {
  if (!stockCodes || stockCodes.length === 0) return [];
  const validCodes = stockCodes.filter((c) => c != null && c.length > 0);
  if (validCodes.length === 0) return [];
  if (isMemoryMode()) return memGetLatestScores(validCodes);

  const today = kstDateStr(getKSTNow());
  const placeholders = validCodes.map((_, i) => `$${i + 1}`).join(',');

  // 오늘 스코어 먼저 조회
  // v26: SELECT * → 필요 컬럼만 (네트워크 바이트 ~20% 절감)
  const SCORE_COLS = 'stock_code, score_date, composite_score, fundamental_score, technical_score, sentiment_score, confidence, signal, reasoning, target_price, stop_loss_price, gemini_summary, created_at';
  const { rows } = await queryWithRetry(
    `SELECT ${SCORE_COLS} FROM ai_scores WHERE stock_code IN (${placeholders}) AND score_date = $${validCodes.length + 1}
     AND composite_score > 0
     ORDER BY composite_score DESC`,
    [...validCodes, today],
  );

  if (rows.length > 0) return rows;

  // 오늘 없으면 최근 7일 이내 스코어 fallback (설날/추석 등 장기 연휴 5일+ 대비)
  const threeDaysAgo = kstDateStr(new Date(getKSTNow().getTime() - 7 * 24 * 60 * 60 * 1000));
  const { rows: fallbackRows } = await queryWithRetry(
    `SELECT DISTINCT ON (stock_code) ${SCORE_COLS} FROM ai_scores
     WHERE stock_code IN (${placeholders}) AND score_date >= $${validCodes.length + 1}
     AND composite_score > 0
     ORDER BY stock_code, score_date DESC, composite_score DESC`,
    [...validCodes, threeDaysAgo],
  );

  return fallbackRows;
}

/** 오늘(또는 최근 7일) 채점된 전체 종목 점수 조회 — 워치리스트 범위 불일치 해결 */
export async function getAllRecentScores(): Promise<AIScore[]> {
  if (isMemoryMode()) return [];
  const today = kstDateStr(getKSTNow());
  const ALL_SCORE_COLS = 'stock_code, score_date, composite_score, fundamental_score, technical_score, sentiment_score, confidence, signal, reasoning, target_price, stop_loss_price, gemini_summary, created_at';
  const { rows } = await queryWithRetry(
    `SELECT ${ALL_SCORE_COLS} FROM ai_scores WHERE score_date = $1 AND composite_score > 0 ORDER BY composite_score DESC`,
    [today],
  );
  if (rows.length > 0) return rows;
  // 오늘 없으면 최근 2일 fallback
  const twoDaysAgo = kstDateStr(new Date(getKSTNow().getTime() - 2 * 24 * 60 * 60 * 1000));
  const { rows: fallback } = await queryWithRetry(
    `SELECT DISTINCT ON (stock_code) ${ALL_SCORE_COLS} FROM ai_scores WHERE score_date >= $1 AND composite_score > 0 ORDER BY stock_code, score_date DESC`,
    [twoDaysAgo],
  );
  return fallback;
}
