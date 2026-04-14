import { Hono } from 'hono';
import { getActiveStrategy, getPool, isMemoryMode } from '../../db/client.js';
import { memSetActiveStrategy } from '../../db/memory-store.js';
import { activateKillSwitch, deactivateKillSwitch, getKillSwitchStatus } from '../../risk/kill-switch.js';
import { runTrackAJob } from '../../scheduler/track-a-job.js';
import { logger } from '../../utils/logger.js';

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
    buy_threshold: body.buy_threshold ?? 70,
    stop_loss_pct: body.stop_loss_pct ?? -5.0,
    take_profit_pct: body.take_profit_pct ?? 8.0,
    strategy_document: body.strategy_document ?? '',
    risk_prompt: body.risk_prompt ?? '',
  };

  // 인메모리 모드: DB 없이도 전략 변경 가능
  if (isMemoryMode()) {
    const updated = memSetActiveStrategy(strategyData);
    return c.json(updated);
  }

  try {
    await getPool().query('UPDATE strategy_config SET is_active = false WHERE is_active = true');
    // 컬럼이 없을 경우 자동 추가
    await getPool().query(`ALTER TABLE strategy_config ADD COLUMN IF NOT EXISTS notebooklm_prompt TEXT DEFAULT ''`).catch(() => {});
    await getPool().query(`ALTER TABLE strategy_config ADD COLUMN IF NOT EXISTS strategy_document TEXT DEFAULT ''`).catch(() => {});
    await getPool().query(`ALTER TABLE strategy_config ADD COLUMN IF NOT EXISTS risk_prompt TEXT DEFAULT ''`).catch(() => {});

    const { rows } = await getPool().query(
      `INSERT INTO strategy_config (mode, is_active, notebooklm_prompt, gemini_prompt, gpt_prompt, claude_prompt, buy_threshold, stop_loss_pct, take_profit_pct, strategy_document, risk_prompt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [strategyData.mode, true, strategyData.notebooklm_prompt, strategyData.gemini_prompt, strategyData.gpt_prompt, strategyData.claude_prompt, strategyData.buy_threshold, strategyData.stop_loss_pct, strategyData.take_profit_pct, strategyData.strategy_document, strategyData.risk_prompt],
    );

    return c.json(rows[0]);
  } catch (err: any) {
    // DB 실패 시 인메모리 폴백
    const updated = memSetActiveStrategy(strategyData);
    return c.json(updated);
  }
});

// ── 푸시 알림 ──
settingsRoutes.get('/push/vapid-key', async (c) => {
  const { getVapidPublicKey } = await import('../../notifications/web-push.js');
  return c.json({ publicKey: getVapidPublicKey() });
});

settingsRoutes.post('/push/subscribe', async (c) => {
  const subscription = await c.req.json();
  const { saveSubscription } = await import('../../notifications/web-push.js');
  await saveSubscription(subscription);
  return c.json({ ok: true });
});

settingsRoutes.post('/push/test', async (c) => {
  const { sendPushNotification } = await import('../../notifications/web-push.js');
  await sendPushNotification({ title: 'QUANTOPS 테스트', body: '알림이 정상 작동합니다!' });
  return c.json({ ok: true });
});

// ── 수동 실행 API ──
settingsRoutes.post('/run-track-a', async (c) => {
  const body = await c.req.json();
  runTrackAJob(body.sources).catch((e) => logger.error(`Track A 수동 실행 실패: ${e}`, { component: 'SETTINGS' }));
  return c.json({ ok: true, message: 'Track A 수동 실행 시작' });
});

settingsRoutes.post('/run-track-b', async (c) => {
  const { runTrackBJob } = await import('../../scheduler/track-b-job.js');
  runTrackBJob().catch((e) => logger.error(`Track B 수동 실행 실패: ${e}`, { component: 'SETTINGS' }));
  return c.json({ ok: true, message: 'Track B 수동 실행 시작' });
});

settingsRoutes.post('/run-overseas', async (c) => {
  const { runOverseasJob } = await import('../../scheduler/overseas-job.js');
  runOverseasJob().catch((e) => logger.error(`해외주식 수동 실행 실패: ${e}`, { component: 'SETTINGS' }));
  return c.json({ ok: true, message: '해외주식 수동 실행 시작' });
});

// ── 인사이트 관리 ──
// GET: 전체 인사이트 조회
settingsRoutes.get('/insights', async (c) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, category, insight, confidence, sample_count, last_updated, is_manual,
              recommendation, param_change, is_applied, applied_at
       FROM learned_insights ORDER BY is_manual DESC, confidence DESC LIMIT 50`
    );
    return c.json(rows);
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// POST: CEO 수동 인사이트 추가
settingsRoutes.post('/insights', async (c) => {
  const body = await c.req.json();
  const category = String(body.category ?? 'MANUAL').trim();
  const insight = String(body.insight ?? '').trim();
  if (!insight) return c.json({ error: '내용 필요' }, 400);

  try {
    const { rows } = await getPool().query(
      `INSERT INTO learned_insights (category, insight, confidence, sample_count, last_updated, is_manual)
       VALUES ($1, $2, $3, 1, NOW(), TRUE) RETURNING *`,
      [category, insight, body.confidence ?? 0.8]
    );
    return c.json(rows[0]);
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// POST: 인사이트 파라미터 전략 적용
settingsRoutes.post('/insights/:id/apply', async (c) => {
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ error: 'id 필요' }, 400);
  try {
    const { applyInsightById } = await import('../../automation/self-learning.js');
    const result = await applyInsightById(String(id));
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// DELETE: 인사이트 삭제 (수동/자동 모두 삭제 가능)
settingsRoutes.delete('/insights/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ error: 'id 필요' }, 400);
  try {
    await getPool().query('DELETE FROM learned_insights WHERE id = $1', [id]);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// 종목명 즉시 보정 (코드로만 저장된 종목 → KRX API로 이름 조회)
settingsRoutes.post('/fix-names', async (c) => {
  const { fixWatchlistNames } = await import('../../kis/interest-group.js');
  fixWatchlistNames()
    .then((r) => logger.info(`종목명 보정 완료: ${r.fixed}/${r.total}건`, { component: 'SETTINGS' }))
    .catch((e) => logger.error(`종목명 보정 실패: ${e}`, { component: 'SETTINGS' }));
  return c.json({ ok: true, message: '종목명 보정 시작 (KRX API 조회 중...)' });
});
