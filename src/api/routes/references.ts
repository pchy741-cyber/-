/**
 * Trading References API — 커뮤니티/인플루언서 인사이트 → 단기 매매 반영
 */
import { Hono } from 'hono';
import { getPool } from '../../db/client.js';
import { getCtxIsPaper } from '../../config/context.js';
import { setOverride, removeOverride } from '../../ai/ai-overrides.js';
import { analyzeTextReference, analyzeImageReference } from '../../ai/reference-analyzer.js';
import { logger } from '../../utils/logger.js';

export const referenceRoutes = new Hono();

// ── GET /api/references — 활성 레퍼런스 목록 ─────────────────────────
referenceRoutes.get('/references', async (c) => {
  const isPaper = getCtxIsPaper();
  try {
    const { rows } = await getPool().query(
      `SELECT id, content, analysis, stock_codes, sentiment, confidence,
              overrides_applied, ttl_hours, expires_at, created_at,
              CASE WHEN image_base64 IS NOT NULL THEN true ELSE false END AS has_image
       FROM trading_references
       WHERE is_active = true AND is_paper = $1 AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [isPaper],
    );
    return c.json({ count: rows.length, references: rows });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── POST /api/references — 레퍼런스 등록 + AI 분석 + 오버라이드 생성 ──
referenceRoutes.post('/references', async (c) => {
  const isPaper = getCtxIsPaper();
  let body: { content: string; imageBase64?: string; mimeType?: string; ttlHours?: number };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.content && !body.imageBase64) {
    return c.json({ error: '텍스트 또는 이미지가 필요합니다' }, 400);
  }

  const content = body.content ?? '';
  const ttlHours = Math.max(1, Math.min(72, body.ttlHours ?? 24));
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();

  try {
    // 1. AI 분석
    const analysis = body.imageBase64
      ? await analyzeImageReference(content, body.imageBase64, body.mimeType ?? 'image/png')
      : await analyzeTextReference(content);

    logger.info(
      `[Reference] 분석 완료: ${analysis.sentiment} conf=${analysis.confidence} codes=${analysis.stockCodes.join(',')} actions=${analysis.actions.length}`,
      { component: 'REFERENCE' },
    );

    // 2. 오버라이드 생성 (confidence 60+ 만)
    const overridesApplied: string[] = [];
    const ttlMinutes = ttlHours * 60;

    if (analysis.confidence >= 60) {
      for (const action of analysis.actions) {
        let key: string;
        let value: unknown;

        if (action.action === 'scoreAdj') {
          key = `${action.code}_scoreAdj`;
          value = action.value;
        } else if (action.action === 'forceHold') {
          key = `${action.code}_forceHold`;
          value = true;
        } else if (action.action === 'blacklist') {
          key = `${action.code}_blacklist`;
          value = true;
        } else {
          continue;
        }

        const res = await setOverride('stock', key, value, `[Ref] ${action.reason}`, ttlMinutes, isPaper);
        if (res.ok) {
          overridesApplied.push(key);
          logger.info(`[Reference] Override 설정: ${key}=${JSON.stringify(value)} (${ttlHours}h)`, { component: 'REFERENCE' });
        }
      }
    }

    // 3. DB 저장
    const { rows } = await getPool().query(
      `INSERT INTO trading_references
       (content, image_base64, mime_type, analysis, stock_codes, sentiment, confidence, overrides_applied, is_paper, ttl_hours, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        content,
        body.imageBase64 || null,
        body.mimeType || null,
        JSON.stringify(analysis),
        analysis.stockCodes,
        analysis.sentiment,
        analysis.confidence,
        overridesApplied,
        isPaper,
        ttlHours,
        expiresAt,
      ],
    );

    return c.json({
      ok: true,
      id: rows[0].id,
      analysis,
      overridesApplied,
      expiresAt,
    });
  } catch (err) {
    logger.error(`[Reference] 등록 실패: ${err}`, { component: 'REFERENCE' });
    return c.json({ error: String(err) }, 500);
  }
});

// ── DELETE /api/references/:id — 삭제 + 연관 오버라이드 제거 ────────
referenceRoutes.delete('/references/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const isPaper = getCtxIsPaper();

  try {
    // 오버라이드 키 조회
    const { rows } = await getPool().query(
      'SELECT overrides_applied FROM trading_references WHERE id = $1 AND is_paper = $2',
      [id, isPaper],
    );

    if (rows.length === 0) return c.json({ error: 'Not found' }, 404);

    // 연관 오버라이드 제거
    const keys = (rows[0].overrides_applied ?? []) as string[];
    for (const key of keys) {
      await removeOverride(key, isPaper);
    }

    // DB 삭제
    await getPool().query('DELETE FROM trading_references WHERE id = $1', [id]);

    logger.info(`[Reference] #${id} 삭제, ${keys.length}건 오버라이드 해제`, { component: 'REFERENCE' });
    return c.json({ ok: true, overridesRemoved: keys.length });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});
