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
    return c.json({ strategies: [], error: 'Internal server error' }, 500);
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
    return c.json({ insights: [], error: 'Internal server error' }, 500);
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
    return c.json({ pending: [], history: [], error: 'Internal server error' }, 500);
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

// ── POST /strategy-lab/insights/:id/approve ────────────────────────
strategyLabRoutes.post('/strategy-lab/insights/:id/approve', async (c) => {
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: 'invalid id' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const reason = (body as any).reason ?? '';

  const pool = getPool();

  // 대상 인사이트 조회
  const { rows } = await pool.query(
    `
    SELECT id, strategy_mode, condition_key, suggested_action
    FROM strategy_insights
    WHERE id = $1 AND status = 'PENDING'
  `,
    [id],
  );
  if (!rows.length) return c.json({ ok: false, error: '유효한 대기 인사이트가 없습니다' }, 404);

  const insight = rows[0];
  const suggestedAction = insight.suggested_action ? JSON.parse(insight.suggested_action) : null;

  // 인사이트 상태 업데이트
  await pool.query(
    `
    UPDATE strategy_insights
    SET status = 'APPROVED', applied_at = NOW(), applied_by = 'CEO'
    WHERE id = $1
  `,
    [id],
  );

  // suggested_action의 type에 따라 strategy_config 업데이트
  if (suggestedAction && suggestedAction.type === 'TP_ADJUSTMENT') {
    await pool.query(
      `
      UPDATE strategy_config
      SET take_profit_pct = $1, updated_at = NOW()
      WHERE mode = $2 AND is_active = true
    `,
      [suggestedAction.value, insight.strategy_mode],
    ).catch(() => {
      /* strategy_config가 없으면 무시 */
    });
  } else if (suggestedAction && suggestedAction.type === 'SCORE_THRESHOLD') {
    // buy_threshold 업데이트 (minScore)
    await pool.query(
      `
      UPDATE strategy_config
      SET buy_threshold = $1, updated_at = NOW()
      WHERE mode = $2 AND is_active = true
    `,
      [suggestedAction.value, insight.strategy_mode],
    ).catch(() => {
      /* strategy_config가 없으면 무시 */
    });
  } else if (suggestedAction && suggestedAction.type === 'AVERAGING_POLICY') {
    // max_averaging_count 업데이트 — transaction_chains 스키마 변경 필요 (skip)
    logger.info(`📋 인사이트 승인: AVERAGING_POLICY (파라미터 수동 적용 필요)`, {
      component: 'STRATEGY_LAB',
    });
  }

  logger.info(
    `✅ 인사이트 승인: #${id} (${insight.strategy_mode}:${insight.condition_key}) → ${suggestedAction?.type ?? 'N/A'}`,
    { component: 'STRATEGY_LAB' },
  );
  return c.json({ ok: true, insight: { id, strategyMode: insight.strategy_mode, appliedAction: suggestedAction } });
});

// ── POST /strategy-lab/insights/:id/reject ─────────────────────────
strategyLabRoutes.post('/strategy-lab/insights/:id/reject', async (c) => {
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: 'invalid id' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const reason = (body as any).reason ?? '';

  const { rowCount } = await getPool().query(
    `
    UPDATE strategy_insights
    SET status = 'REJECTED'
    WHERE id = $1 AND status = 'PENDING'
  `,
    [id],
  );

  if (!rowCount) return c.json({ ok: false, error: '유효한 대기 인사이트가 없습니다' }, 404);
  logger.info(`❌ 인사이트 거부: #${id}`, { component: 'STRATEGY_LAB' });
  return c.json({ ok: true });
});

// ── GET /strategy-lab/splits ────────────────────────────────────────
strategyLabRoutes.get('/strategy-lab/splits', async (c) => {
  try {
    const result = await getPool()
      .query(
        `
      SELECT id, name, description, strategy_mode, status, min_trades,
             paper_pnl_a, paper_pnl_b, trades_a, trades_b, win_rate_a, win_rate_b,
             winner, created_at, completed_at
      FROM strategy_splits
      WHERE status IN ('ACTIVE', 'COMPLETED')
      ORDER BY created_at DESC
      LIMIT 50
    `,
      )
      .catch(() => ({ rows: [] }));
    return c.json({ splits: result.rows });
  } catch (e: any) {
    return c.json({ splits: [], error: 'Internal server error' }, 500);
  }
});

// ── POST /strategy-lab/splits ───────────────────────────────────────
strategyLabRoutes.post('/strategy-lab/splits', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { name, description, strategy_mode, variant_a, variant_b, min_trades } = body as any;

  if (!name || !strategy_mode || !variant_a || !variant_b) {
    return c.json({ ok: false, error: 'missing required fields' }, 400);
  }

  try {
    const { rows } = await getPool().query(
      `
      INSERT INTO strategy_splits (name, description, strategy_mode, variant_a, variant_b, min_trades, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
      RETURNING id, name, strategy_mode, status, created_at
    `,
      [name, description, strategy_mode, JSON.stringify(variant_a), JSON.stringify(variant_b), min_trades ?? 20],
    );

    if (!rows.length) return c.json({ ok: false, error: 'insertion failed' }, 500);

    logger.info(`📊 스플릿 생성: #${rows[0].id} (${strategy_mode})`, { component: 'STRATEGY_LAB' });
    return c.json({ ok: true, split: rows[0] });
  } catch (e: any) {
    return c.json({ ok: false, error: 'Internal server error' }, 500);
  }
});

// ── DELETE /strategy-lab/splits/:id ─────────────────────────────────
strategyLabRoutes.delete('/strategy-lab/splits/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: 'invalid id' }, 400);

  const { rowCount } = await getPool().query(
    `
    UPDATE strategy_splits
    SET status = 'CANCELLED'
    WHERE id = $1 AND status = 'ACTIVE'
  `,
    [id],
  );

  if (!rowCount) return c.json({ ok: false, error: 'split not found or not active' }, 404);
  logger.info(`❌ 스플릿 취소: #${id}`, { component: 'STRATEGY_LAB' });
  return c.json({ ok: true });
});

// ── POST /strategy-lab/splits/:id/complete ──────────────────────────
strategyLabRoutes.post('/strategy-lab/splits/:id/complete', async (c) => {
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: 'invalid id' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const winner = (body as any).winner ?? 'A'; // 'A' | 'B'

  if (!['A', 'B'].includes(winner)) {
    return c.json({ ok: false, error: 'invalid winner (must be A or B)' }, 400);
  }

  const { rowCount } = await getPool().query(
    `
    UPDATE strategy_splits
    SET status = 'COMPLETED', winner = $2, completed_at = NOW()
    WHERE id = $1 AND status = 'ACTIVE'
  `,
    [id, winner],
  );

  if (!rowCount) return c.json({ ok: false, error: 'split not found or not active' }, 404);
  logger.info(`✅ 스플릿 완료: #${id} (Winner = ${winner})`, { component: 'STRATEGY_LAB' });
  return c.json({ ok: true, split: { id, winner, completedAt: new Date().toISOString() } });
});

// ── GET /strategy-lab/ceo-overrides ─────────────────────────────────
strategyLabRoutes.get('/strategy-lab/ceo-overrides', async (c) => {
  try {
    const result = await getPool()
      .query(
        `
      SELECT id, override_key, category, description, pnl_before, pnl_after, impact_pct,
             created_at, removed_at, removed_reason
      FROM ceo_overrides
      ORDER BY created_at DESC
      LIMIT 100
    `,
      )
      .catch(() => ({ rows: [] }));

    // 활성/비활성 분류
    const active = result.rows.filter((r: any) => !r.removed_at);
    const history = result.rows.filter((r: any) => r.removed_at);

    return c.json({ active, history });
  } catch (e: any) {
    return c.json({ active: [], history: [], error: 'Internal server error' }, 500);
  }
});

// ── POST /strategy-lab/ceo-overrides/:id/remove ─────────────────────
strategyLabRoutes.post('/strategy-lab/ceo-overrides/:id/remove', async (c) => {
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: 'invalid id' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const reason = (body as any).reason ?? 'CEO requested removal';

  const { rowCount } = await getPool().query(
    `
    UPDATE ceo_overrides
    SET removed_at = NOW(), removed_reason = $2
    WHERE id = $1 AND removed_at IS NULL
  `,
    [id, reason],
  );

  if (!rowCount) return c.json({ ok: false, error: 'override not found or already removed' }, 404);
  logger.info(`🔄 CEO 오버라이드 제거: #${id}`, { component: 'STRATEGY_LAB' });
  return c.json({ ok: true });
});
