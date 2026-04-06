import { Hono } from 'hono';
import { getActiveStrategy, getPool } from '../../db/client.js';
import { activateKillSwitch, deactivateKillSwitch, getKillSwitchStatus } from '../../risk/kill-switch.js';
import { runTrackAJob } from '../../scheduler/track-a-job.js';

export const settingsRoutes = new Hono();

// ── Kill Switch 제어 ──
settingsRoutes.get('/kill-switch', (c) => {
  return c.json(getKillSwitchStatus());
});

settingsRoutes.post('/kill-switch/activate', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const reason = String(body.reason ?? '').trim() || 'CEO 수동 발동 (대시보드)';

  try {
    await activateKillSwitch(reason);
    return c.json({ ok: true, status: getKillSwitchStatus() });
  } catch (err: any) {
    return c.json({ ok: false, error: err?.message ?? 'kill switch activate failed' }, 500);
  }
});

settingsRoutes.post('/kill-switch/deactivate', async (c) => {
  try {
    await deactivateKillSwitch();
    return c.json({ ok: true, status: getKillSwitchStatus() });
  } catch (err: any) {
    return c.json({ ok: false, error: err?.message ?? 'kill switch deactivate failed' }, 500);
  }
});

// ── 전략 설정 (CEO 프롬프트 관리) ──
settingsRoutes.get('/strategy', async (c) => {
  const strategy = await getActiveStrategy();
  return c.json(strategy ?? { mode: 'SWING', message: '설정 없음' });
});

settingsRoutes.put('/strategy', async (c) => {
  const body = await c.req.json();

  try {
    await getPool().query('UPDATE strategy_config SET is_active = false WHERE is_active = true');

    const { rows } = await getPool().query(
      `INSERT INTO strategy_config (mode, is_active, gemini_prompt, gpt_prompt, claude_prompt, buy_threshold, stop_loss_pct, take_profit_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        body.mode ?? 'SWING',
        true,
        body.gemini_prompt ?? '',
        body.gpt_prompt ?? '',
        body.claude_prompt ?? '',
        body.buy_threshold ?? 75,
        body.stop_loss_pct ?? -5.0,
        body.take_profit_pct ?? 8.0,
      ],
    );

    return c.json(rows[0]);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// ── 수동 Track A 실행 ──
settingsRoutes.post('/run-track-a', async (c) => {
  const body = await c.req.json();
  // 비동기 실행 (응답은 먼저 반환)
  runTrackAJob(body.sources).catch(() => {});
  return c.json({ ok: true, message: 'Track A 수동 실행 시작' });
});
