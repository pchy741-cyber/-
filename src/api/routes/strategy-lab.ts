import { Hono } from 'hono';
import { cacheGet, cacheSet } from '../../cache/memory.js';
import { getPool } from '../../db/client.js';
import { getAllStrategyPerformances } from '../../risk/strategy-performance.js';
import { logger } from '../../utils/logger.js';

export const strategyLabRoutes = new Hono();

// ── GET /strategy-lab/overview ─────────────────────────────────
strategyLabRoutes.get('/strategy-lab/overview', async (c) => {
  try {
    // 5분 캐시 — 전략 성과 집계는 무거운 쿼리, 실시간 불필요
    const cached = cacheGet<{ strategies: unknown[] }>('api:strategy-lab:overview');
    if (cached) return c.json(cached);

    const [paperPerfs, livePerfs, graduations] = await Promise.all([
      getAllStrategyPerformances(30, true),
      getAllStrategyPerformances(30, false),
      getPool()
        .query(`
        SELECT * FROM strategy_graduations
        WHERE status IN ('PENDING', 'AUTO_APPLIED', 'APPROVED')
        ORDER BY created_at DESC LIMIT 50
      `)
        .catch(() => ({ rows: [] })),
    ]);

    const modes = new Set([...paperPerfs.map((p) => p.mode), ...livePerfs.map((p) => p.mode)]);
    const strategies = [...modes].map((mode) => ({
      mode,
      paper: paperPerfs.find((p) => p.mode === mode) ?? null,
      live: livePerfs.find((p) => p.mode === mode) ?? null,
      graduation: graduations.rows.find((g: any) => g.strategy_mode === mode) ?? null,
    }));

    const result = { strategies };
    cacheSet('api:strategy-lab:overview', result, 300); // 5분 TTL
    return c.json(result);
  } catch (e: any) {
    return c.json({ strategies: [], error: e.message }, 500);
  }
});

// ── GET /strategy-lab/insights ─────────────────────────────────
strategyLabRoutes.get('/strategy-lab/insights', async (c) => {
  try {
    const result = await getPool()
      .query(`
      SELECT * FROM strategy_insights
      WHERE sample_count >= 5
      ORDER BY
        CASE WHEN is_actionable THEN 0 ELSE 1 END,
        win_rate DESC
      LIMIT 50
    `)
      .catch(() => ({ rows: [] }));
    return c.json({ insights: result.rows });
  } catch (e: any) {
    return c.json({ insights: [], error: e.message }, 500);
  }
});

// ── GET /strategy-lab/approvals ─────────────────────────────────
strategyLabRoutes.get('/strategy-lab/approvals', async (c) => {
  try {
    const [pending, history] = await Promise.all([
      getPool()
        .query(`
        SELECT * FROM strategy_graduations
        WHERE status = 'PENDING' AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
      `)
        .catch(() => ({ rows: [] })),
      getPool()
        .query(`
        SELECT * FROM strategy_graduations
        WHERE status != 'PENDING'
        ORDER BY decided_at DESC NULLS LAST, created_at DESC
        LIMIT 30
      `)
        .catch(() => ({ rows: [] })),
    ]);
    return c.json({ pending: pending.rows, history: history.rows });
  } catch (e: any) {
    return c.json({ pending: [], history: [], error: e.message }, 500);
  }
});

// ── POST /strategy-lab/approvals/:id/approve ────────────────────
strategyLabRoutes.post('/strategy-lab/approvals/:id/approve', async (c) => {
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: 'invalid id' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const reason = (body as any).reason ?? '';

  const pool = getPool();

  // 승인 대상 졸업 기록 조회 (applied_changes 기록용)
  const { rows } = await pool.query(
    `SELECT id, strategy_mode, risk_level, trades, win_rate, profit_factor, mdd, total_pnl_krw
     FROM strategy_graduations WHERE id = $1 AND status = 'PENDING'`,
    [id],
  );
  if (!rows.length) return c.json({ ok: false, error: '유효한 대기 건이 없습니다' }, 404);

  const grad = rows[0];
  const appliedChanges = {
    approvedAt: new Date().toISOString(),
    approvedBy: 'CEO',
    reason,
    strategyMode: grad.strategy_mode,
    riskLevel: grad.risk_level,
    promotedStats: {
      trades: grad.trades,
      winRate: Number(grad.win_rate),
      profitFactor: Number(grad.profit_factor),
      mdd: Number(grad.mdd),
      totalPnlKrw: Number(grad.total_pnl_krw),
    },
  };

  const { rowCount } = await pool.query(
    `
    UPDATE strategy_graduations
    SET status = 'APPROVED', decided_by = 'CEO', approval_reason = $1,
        decided_at = NOW(), applied_changes = $2
    WHERE id = $3
  `,
    [reason, JSON.stringify(appliedChanges), id],
  );

  if (!rowCount) return c.json({ ok: false, error: '업데이트 실패' }, 500);

  // 캐시 무효화 — 다음 조회 시 최신 상태 반영
  cacheSet('api:strategy-lab:overview', null as any, 0);

  // Paper-only 전략 캐시 무효화 — 졸업 승인 후 즉시 Live 적용
  try {
    const { invalidatePaperOnlyCache } = await import('../../automation/strategy-graduation.js');
    invalidatePaperOnlyCache();
  } catch { /* 모듈 로드 실패 시 무시 — 30분 후 자동 만료 */ }

  logger.info(`🎓 CEO 승인: 졸업 #${id} (${grad.strategy_mode}) → LIVE 전략 반영`, { component: 'STRATEGY_LAB' });
  return c.json({ ok: true, strategyMode: grad.strategy_mode, appliedChanges });
});

// ── POST /strategy-lab/approvals/:id/reject ─────────────────────
strategyLabRoutes.post('/strategy-lab/approvals/:id/reject', async (c) => {
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: 'invalid id' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const reason = (body as any).reason ?? '';

  const { rowCount } = await getPool().query(
    `
    UPDATE strategy_graduations
    SET status = 'REJECTED', decided_by = 'CEO', rejected_reason = $1, decided_at = NOW()
    WHERE id = $2 AND status = 'PENDING'
  `,
    [reason, id],
  );

  if (!rowCount) return c.json({ ok: false, error: '유효한 대기 건이 없습니다' }, 404);
  logger.info(`❌ CEO 거부: 졸업 #${id}`, { component: 'STRATEGY_LAB' });
  return c.json({ ok: true });
});

// ── POST /strategy-lab/refresh-insights ─────────────────────────
strategyLabRoutes.post('/strategy-lab/refresh-insights', async (c) => {
  import('../../automation/strategy-lab/insight-engine.js')
    .then((m) => m.generateAndStoreInsights(60))
    .catch((e) => logger.error(`인사이트 갱신 실패: ${e}`, { component: 'STRATEGY_LAB' }));
  return c.json({ ok: true, message: '인사이트 분석 시작' });
});
