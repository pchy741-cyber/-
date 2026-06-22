import { Hono } from 'hono';
import { getPool } from '../../../db/client.js';
import type { KillSwitchScope } from '../../../risk/kill-switch.js';
import {
  activateKillSwitch,
  activateKillSwitchAll,
  deactivateKillSwitchForMode,
  getKillSwitchStatus,
  getKillSwitchStatusAll,
} from '../../../risk/kill-switch.js';
import { logger } from '../../../utils/logger.js';
import { getKSTNow } from '../../../utils/time.js';

export const killSwitchRoutes = new Hono();

// ── Kill Switch 제어 (KR/OVERSEAS 분리) ──
killSwitchRoutes.get('/kill-switch', (c) => {
  const scope = c.req.query('scope') as KillSwitchScope | undefined;
  if (scope === 'KR' || scope === 'OVERSEAS') {
    return c.json(getKillSwitchStatus(scope));
  }
  // scope 미지정 → 양쪽 모두 반환
  return c.json(getKillSwitchStatusAll());
});

killSwitchRoutes.post('/kill-switch/activate', async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const reason = String(body.reason ?? '').trim() || 'CEO 수동 발동 (대시보드)';
  const scope = body.scope as KillSwitchScope | undefined;

  try {
    if (scope === 'KR' || scope === 'OVERSEAS') {
      await activateKillSwitch(reason, true, scope);
    } else {
      // scope 미지정 → 양쪽 동시 차단 (CEO 긴급정지)
      await activateKillSwitchAll(reason, true);
    }
    return c.json({ ok: true, status: getKillSwitchStatusAll() });
  } catch (err: any) {
    logger.error(`Kill switch activate 실패: ${err?.message}`, { component: 'SETTINGS' });
    return c.json({ ok: false, error: 'Internal server error' }, 500);
  }
});

killSwitchRoutes.post('/kill-switch/deactivate', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const force = body.force === true;
    const scope = body.scope as KillSwitchScope | undefined;

    // paper + live 양쪽 모두 해제 — ALS 컨텍스트 의존 제거
    const scopes: KillSwitchScope[] = scope === 'KR' || scope === 'OVERSEAS' ? [scope] : ['KR', 'OVERSEAS'];
    await Promise.all(
      [true, false].flatMap((isPaper) => scopes.map((sc) => deactivateKillSwitchForMode(force, isPaper, sc))),
    );

    // Kill Switch 강제 해제 시 이번달 스냅샷 전체 삭제 후 현재값 재설정 → MDD 재트리거 방지
    // 단순 insertSnapshot으로는 이번달 고점이 DB에 남아 Track B가 3분 후 재발동하는 루프 발생
    if (force) {
      try {
        const { getAccountBalance } = await import('../../../kis/account.js');
        const { getPaperBalance } = await import('../../../risk/paper-balance.js');
        const { insertSnapshot } = await import('../../../db/client.js');
        const pool = getPool();
        // KST 월 시작일 계산
        const kstMonth = getKSTNow();
        kstMonth.setUTCDate(1);
        kstMonth.setUTCHours(0, 0, 0, 0);
        for (const isPaper of [true, false]) {
          // 이번달 스냅샷 전부 삭제 → MDD 고점 리셋
          await pool.query(
            `DELETE FROM portfolio_snapshots WHERE snapshot_at >= $1 AND is_paper = $2`,
            [kstMonth.toISOString(), isPaper],
          );
          const balance = isPaper ? await getPaperBalance() : await getAccountBalance(true);
          const totalValue = balance.totalDeposit + balance.totalEvalAmount;
          await insertSnapshot({
            total_value: totalValue,
            cash_balance: balance.orderableCash,
            invested_value: balance.totalEvalAmount,
            unrealized_pnl: balance.totalProfitLoss,
            daily_pnl: 0,
            daily_pnl_pct: 0,
            positions: balance.positions,
            is_paper: isPaper,
          });
        }
        logger.info(`✅ Kill Switch 강제 해제 + 이달 MDD 기준점 리셋 (paper + live 양쪽)`, { component: 'SETTINGS' });
      } catch (snapErr) {
        logger.warn(`⚠️ Kill Switch 해제 성공, MDD 리셋 실패: ${snapErr}`, { component: 'SETTINGS' });
      }
    }

    return c.json({ ok: true, status: getKillSwitchStatusAll() });
  } catch (err: any) {
    logger.error(`Kill switch deactivate 실패: ${err?.message}`, { component: 'SETTINGS' });
    return c.json({ ok: false, error: 'Internal server error' }, 500);
  }
});
