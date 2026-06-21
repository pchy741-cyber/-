import { Hono } from 'hono';
import { getSeedCapitalStatus, setSeedCapital } from '../../../risk/seed-capital.js';
import { getCooldownStatus, resetCooldown } from '../../../risk/trade-gate.js';
import { logger } from '../../../utils/logger.js';

export const riskControlsRoutes = new Hono();

// ── 기준자본 (Seed Capital) 조회/설정 ──
riskControlsRoutes.get('/seed-capital', (c) => {
  return c.json(getSeedCapitalStatus());
});

riskControlsRoutes.put('/seed-capital', async (c) => {
  const body = await c.req.json();
  const market = body.market === 'OVERSEAS' ? 'OVERSEAS' : 'KR';
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: '금액은 유한한 양수여야 합니다' }, 400);

  await setSeedCapital(market, amount);
  return c.json({ ok: true, status: getSeedCapitalStatus() });
});

// ── 연속손실 쿨다운 제어 ──
riskControlsRoutes.get('/cooldown', async (c) => {
  return c.json(await getCooldownStatus());
});

riskControlsRoutes.post('/cooldown/reset', async (c) => {
  resetCooldown();
  logger.info('🔓 쿨다운 수동 초기화 (대시보드)', { component: 'TRADE_GATE' });
  return c.json({ ok: true, status: await getCooldownStatus() });
});
