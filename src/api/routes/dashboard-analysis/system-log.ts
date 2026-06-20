import { Hono } from 'hono';
import { getPool } from '../../../db/client.js';

export const systemLogRoutes = new Hono();

// ── 시스템 로그 ──
systemLogRoutes.get('/logs', async (c) => {
  const rawLimit = Number(c.req.query('limit') ?? 100);
  const limit = Math.min(Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 100), 500);
  const component = c.req.query('component');

  try {
    let sql = 'SELECT * FROM system_log';
    const params: any[] = [];

    if (component) {
      sql += ' WHERE component = $1';
      params.push(component);
    }

    sql += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const { rows } = await getPool().query(sql, params);
    return c.json(rows);
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── 최근 7일 전략 모드 전환 이력 ──
systemLogRoutes.get('/strategy/history', async (c) => {
  try {
    const { rows } = await getPool().query(
      `SELECT timestamp AS created_at, message
         FROM system_log
        WHERE component = 'REGIME'
          AND level = 'WARN'
          AND message LIKE '전략 자동 전환%'
          AND timestamp >= NOW() - INTERVAL '7 days'
        ORDER BY timestamp DESC
        LIMIT 20`,
    );
    const events = rows.map((r: any) => {
      const m = String(r.message).match(/전략 자동 전환: (\w+) → (\w+)/);
      return { ts: r.created_at, from: m?.[1] ?? '', to: m?.[2] ?? '', message: r.message };
    });
    return c.json(events);
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});
