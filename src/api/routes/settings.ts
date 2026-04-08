import { Hono } from 'hono';
import { getActiveStrategy, getPool, isMemoryMode } from '../../db/client.js';
import { memSetActiveStrategy } from '../../db/memory-store.js';
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

  const strategyData = {
    mode: body.mode ?? 'SWING',
    notebooklm_prompt: body.notebooklm_prompt ?? '',
    gemini_prompt: body.gemini_prompt ?? '',
    gpt_prompt: body.gpt_prompt ?? '',
    claude_prompt: body.claude_prompt ?? '',
    buy_threshold: body.buy_threshold ?? 75,
    stop_loss_pct: body.stop_loss_pct ?? -5.0,
    take_profit_pct: body.take_profit_pct ?? 8.0,
  };

  // 인메모리 모드: DB 없이도 전략 변경 가능
  if (isMemoryMode()) {
    const updated = memSetActiveStrategy(strategyData);
    return c.json(updated);
  }

  try {
    await getPool().query('UPDATE strategy_config SET is_active = false WHERE is_active = true');
    await getPool().query(`ALTER TABLE strategy_config ADD COLUMN IF NOT EXISTS notebooklm_prompt TEXT DEFAULT ''`).catch(() => {});

    const { rows } = await getPool().query(
      `INSERT INTO strategy_config (mode, is_active, notebooklm_prompt, gemini_prompt, gpt_prompt, claude_prompt, buy_threshold, stop_loss_pct, take_profit_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [strategyData.mode, true, strategyData.notebooklm_prompt, strategyData.gemini_prompt, strategyData.gpt_prompt, strategyData.claude_prompt, strategyData.buy_threshold, strategyData.stop_loss_pct, strategyData.take_profit_pct],
    );

    return c.json(rows[0]);
  } catch (err: any) {
    // DB 실패 시 인메모리 폴백
    const updated = memSetActiveStrategy(strategyData);
    return c.json(updated);
  }
});

// ── 수동 Track A 실행 ──
settingsRoutes.post('/run-track-a', async (c) => {
  const body = await c.req.json();
  // 비동기 실행 (응답은 먼저 반환)
  runTrackAJob(body.sources).catch(() => {});
  return c.json({ ok: true, message: 'Track A 수동 실행 시작' });
});
