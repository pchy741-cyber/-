import { Hono } from 'hono';
import { getPool, logSystem } from '../../../db/client.js';
import { logger } from '../../../utils/logger.js';
import { resolveRequestMode } from '../../guards/live-pin.js';

export const insightsRoutes = new Hono();

// ── 인사이트 관리 ──
// GET: 전체 인사이트 조회
insightsRoutes.get('/insights', async (c) => {
  try {
    const isPaper = resolveRequestMode(c);
    const { rows } = await getPool().query(
      `SELECT *
       FROM learned_insights
       WHERE COALESCE(is_dismissed, false) IS NOT TRUE
         AND is_paper = $1
       ORDER BY is_manual DESC, confidence DESC LIMIT 30`,
      [isPaper],
    );
    return c.json(rows);
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// POST: CEO 수동 인사이트 추가
insightsRoutes.post('/insights', async (c) => {
  const body = await c.req.json();
  const category = String(body.category ?? 'MANUAL').trim();
  const insight = String(body.insight ?? '').trim();
  if (!insight) return c.json({ error: '내용 필요' }, 400);

  try {
    const { rows } = await getPool().query(
      `INSERT INTO learned_insights (category, insight, confidence, sample_count, last_updated, is_manual, is_paper)
       VALUES ($1, $2, $3, 1, NOW(), TRUE, $4) RETURNING *`,
      [category, insight, body.confidence ?? 0.8, resolveRequestMode(c)],
    );
    return c.json(rows[0]);
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// POST: 인사이트 파라미터 전략 적용
insightsRoutes.post('/insights/:id/apply', async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id 필요' }, 400);
  try {
    const { applyInsightById } = await import('../../../automation/self-learning.js');
    const result = await applyInsightById(id);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// DELETE: 인사이트 삭제 → v10: soft-delete (is_dismissed) — 재생성 방지
insightsRoutes.delete('/insights/:id', async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id 필요' }, 400);
  try {
    // v10: hard delete 대신 soft delete — saveInsights가 dismissed 키를 재생성하지 않음
    await getPool().query(
      `UPDATE learned_insights SET is_dismissed = true, dismissed_at = NOW() WHERE id = $1`,
      [id],
    ).catch(() =>
      // fallback: is_dismissed 컬럼 없으면 기존 hard delete
      getPool().query('DELETE FROM learned_insights WHERE id = $1', [id]),
    );
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// ── 연습→실전 인사이트 프로모션 ──

// GET: 프로모션 가능한 paper 인사이트 후보 목록
insightsRoutes.get('/insights/promotable', async (c) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, category, insight, confidence, sample_count, last_updated, recommendation, param_change
       FROM learned_insights
       WHERE is_paper = true
         AND category IN ('WIN_PATTERN', 'TIMING', 'SIZING')
         AND confidence >= 0.6
         AND sample_count >= 3
         AND COALESCE(is_promoted, false) IS NOT TRUE
       ORDER BY confidence DESC, sample_count DESC
       LIMIT 10`,
    );
    return c.json(rows);
  } catch (_err: any) {
    // 마이그레이션 전 — 프로모션 컬럼 없으면 빈 배열
    return c.json([]);
  }
});

// POST: paper 인사이트를 live로 프로모션 (CEO 수동 승인만)
insightsRoutes.post('/insights/:id/promote', async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id 필요' }, 400);

  try {
    // 1. 원본 확인 (반드시 paper 인사이트)
    const { rows: sourceRows } = await getPool().query(
      `SELECT * FROM learned_insights WHERE id = $1 AND is_paper = true`,
      [id],
    );
    const source = sourceRows[0];
    if (!source) return c.json({ error: '연습모드 인사이트를 찾을 수 없습니다' }, 404);

    // 2. LOSS_PATTERN은 프로모션 불가 (경고용이지 실전 적용 대상 아님)
    if (source.category === 'LOSS_PATTERN') {
      return c.json({ error: 'LOSS_PATTERN은 프로모션할 수 없습니다 (경고 전용)' }, 400);
    }

    // 3. 이미 프로모션 됐는지 확인
    const { rows: existing } = await getPool().query(`SELECT id FROM learned_insights WHERE promoted_from_id = $1`, [
      id,
    ]);
    if (existing.length > 0) return c.json({ error: '이미 프로모션된 인사이트입니다' }, 409);

    // 4. live로 복사 (confidence 0.7배, is_manual=true로 자기학습 삭제 방지)
    const reducedConfidence = Math.round(Number(source.confidence) * 0.7 * 100) / 100;
    const promotedInsight = `[연습검증] ${source.insight}`;

    const { rows: promoted } = await getPool().query(
      `INSERT INTO learned_insights
        (category, insight, confidence, sample_count, last_updated, details,
         recommendation, param_change, is_paper, is_manual,
         promoted_from_id, source_mode, promoted_at, live_validation_status)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, false, true,
               $8, 'promoted_from_paper', NOW(), 'pending')
       RETURNING *`,
      [
        source.category,
        promotedInsight,
        reducedConfidence,
        source.sample_count,
        source.details ? JSON.stringify(source.details) : null,
        source.recommendation,
        source.param_change ? JSON.stringify(source.param_change) : null,
        id,
      ],
    );

    // 5. 원본에 promoted 마킹 (자기학습 재생성 시 삭제 방지)
    await getPool().query(`UPDATE learned_insights SET is_promoted = true WHERE id = $1`, [id]);

    // 6. 텔레그램 알림
    const { sendTelegramMessage } = await import('../../../notifications/telegram.js');
    await sendTelegramMessage(
      `🔄 *연습→실전 인사이트 프로모션*\n` +
        `카테고리: ${source.category}\n` +
        `내용: ${String(source.insight).slice(0, 80)}...\n` +
        `신뢰도: ${source.confidence} → ${reducedConfidence} (0.7x 적용)\n` +
        `실전 검증 대기 중`,
    ).catch(() => {});

    await logSystem(
      'INFO',
      'PROMOTE',
      `연습→실전 프로모션: [${source.category}] ${String(source.insight).slice(0, 60)}`,
    ).catch(() => {});

    return c.json({ ok: true, promoted: promoted[0] });
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// POST: 프로모션 취소 (live에서 제거 + 원본 is_promoted 복원)
insightsRoutes.post('/insights/:id/revoke', async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id 필요' }, 400);

  try {
    const { rows } = await getPool().query(
      `SELECT * FROM learned_insights WHERE id = $1 AND source_mode = 'promoted_from_paper'`,
      [id],
    );
    if (!rows[0]) return c.json({ error: '프로모션된 인사이트가 아닙니다' }, 404);

    const originalId = rows[0].promoted_from_id;

    // live에서 프로모션 인사이트 삭제
    await getPool().query('DELETE FROM learned_insights WHERE id = $1', [id]);

    // 원본 paper 인사이트 is_promoted 복원
    if (originalId) {
      await getPool().query('UPDATE learned_insights SET is_promoted = false WHERE id = $1', [originalId]);
    }

    await logSystem('INFO', 'PROMOTE', `프로모션 취소: ${String(rows[0].insight).slice(0, 60)}`).catch(() => {});

    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});
