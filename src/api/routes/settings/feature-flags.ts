import { Hono } from 'hono';
import { getPool } from '../../../db/client.js';
import { logger } from '../../../utils/logger.js';

export const featureFlagsRoutes = new Hono();

// ── 기능 플래그 목록 조회 ──
featureFlagsRoutes.get('/feature-flags', async (c) => {
  try {
    const { rows } = await getPool().query(
      'SELECT key, enabled, config, updated_at FROM feature_flags ORDER BY key',
    );
    return c.json(rows);
  } catch (e: any) {
    logger.error(`Feature flags 조회 실패: ${e.message}`, { component: 'SETTINGS' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── 기능 플래그 토글 ──
featureFlagsRoutes.post('/feature-flags/:key/toggle', async (c) => {
  const key = c.req.param('key');
  try {
    const { rows } = await getPool().query(
      'UPDATE feature_flags SET enabled = NOT enabled, updated_at = NOW() WHERE key = $1 RETURNING key, enabled',
      [key],
    );
    if (rows.length === 0) {
      return c.json({ error: `플래그 '${key}'를 찾을 수 없습니다` }, 404);
    }
    logger.info(`Feature flag '${key}' → ${rows[0].enabled ? 'ON' : 'OFF'}`, { component: 'SETTINGS' });
    return c.json(rows[0]);
  } catch (e: any) {
    logger.error(`Feature flag 토글 실패: ${e.message}`, { component: 'SETTINGS' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});
