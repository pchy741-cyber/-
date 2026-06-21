import { Hono } from 'hono';
import { invalidateDashboardCache } from '../../../cache/dashboard-cache.js';
import { STRATEGY_PARAMS } from '../../../config/constants.js';
import { invalidateAllocCache } from '../../../db/alloc-risk-cache.js';
import { getActiveStrategy, getPool, isMemoryMode } from '../../../db/client.js';
import { memSetActiveStrategy } from '../../../db/memory-store.js';
import { logger } from '../../../utils/logger.js';
import { resolveRequestMode } from '../../guards/live-pin.js';

export const allocationRoutes = new Hono();

// ── 투자비율 설정 (국내/미국 비율 + 섹터 한도) ──
export const ALLOC_DEFAULTS = {
  kr_pct: 0,
  us_pct: 100,
  sector_semiconductor: 30,
  sector_bio: 20,
  sector_defense: 25,
  sector_finance: 20,
  sector_etc: 30,
  trailing_stop_pct: 5,
};

// 설정 필드별 연결 상태 — 프론트엔드에서 "미연결" 경고 표시용
export const SETTINGS_META = {
  kr_pct: { connected: true, desc: '국내 비중 — risk-engine, overseas-job, cross-market-rotation에서 사용' },
  us_pct: { connected: true, desc: '미국 비중 — overseas-job, cross-market-rotation에서 사용' },
  trailing_stop_pct: { connected: true, desc: '트레일링 스탑 — risk-guard에서 사용' },
  sector_semiconductor: {
    connected: true,
    desc: '반도체+배터리 섹터 비중 한도(%) — risk-engine checkSectorExposure',
  },
  sector_bio: { connected: true, desc: '바이오 섹터 비중 한도(%) — risk-engine' },
  sector_defense: { connected: true, desc: '방산 섹터 비중 한도(%) — risk-engine' },
  sector_finance: { connected: true, desc: '금융 섹터 비중 한도(%) — risk-engine' },
  sector_etc: { connected: true, desc: '기타(인터넷/전력/조선/가전) 비중 한도(%) — risk-engine' },
};

allocationRoutes.get('/portfolio/allocation', async (c) => {
  try {
    // ?isPaper=true/false 쿼리 파라미터로 모드 명시 가능, 없으면 현재 모드
    const qp = c.req.query('isPaper');
    const isPaper = qp !== undefined ? qp === 'true' : resolveRequestMode(c);
    const { rows } = await getPool().query(
      'SELECT * FROM portfolio_allocation_config WHERE is_paper = $1 ORDER BY id DESC LIMIT 1',
      [isPaper],
    );
    if (rows.length === 0) {
      const { rows: ins } = await getPool().query(
        `INSERT INTO portfolio_allocation_config
         (kr_pct, us_pct, sector_semiconductor, sector_bio, sector_defense, sector_finance, sector_etc,
          trailing_stop_pct, is_paper, position_cap_pct, max_invested_pct, cash_reserve_pct, max_positions, max_daily_trades)
         VALUES (0, 100, 30, 20, 25, 20, 30, 5, $1, $2, $3, $4, $5, $6) RETURNING *`,
        [isPaper, isPaper ? 40 : 25, isPaper ? 97 : 88, isPaper ? 3 : 20, isPaper ? 20 : 8, isPaper ? 20 : 3],
      );
      return c.json({ ...ins[0], _settingsMeta: SETTINGS_META });
    }
    return c.json({ ...rows[0], _settingsMeta: SETTINGS_META });
  } catch (_err: any) {
    return c.json({ ...ALLOC_DEFAULTS, _settingsMeta: SETTINGS_META });
  }
});

// 실전/연습 양쪽 동시 반환 — 프론트엔드 독립 설정 패널용
allocationRoutes.get('/portfolio/allocation/both', async (c) => {
  try {
    const pool = getPool();
    const [liveRes, paperRes] = await Promise.all([
      pool.query('SELECT * FROM portfolio_allocation_config WHERE is_paper = false ORDER BY id DESC LIMIT 1'),
      pool.query('SELECT * FROM portfolio_allocation_config WHERE is_paper = true ORDER BY id DESC LIMIT 1'),
    ]);
    const live = liveRes.rows[0] ?? {
      kr_pct: 0,
      us_pct: 100,
      position_cap_pct: 25,
      max_invested_pct: 88,
      cash_reserve_pct: 20,
      max_positions: 8,
      max_daily_trades: 3,
    };
    const paper = paperRes.rows[0] ?? {
      kr_pct: 70,
      us_pct: 30,
      position_cap_pct: 40,
      max_invested_pct: 97,
      cash_reserve_pct: 3,
      max_positions: 20,
      max_daily_trades: 20,
    };
    return c.json({ live, paper });
  } catch (err: any) {
    logger.warn(`포트폴리오 양쪽 조회 실패: ${err?.message}`, { component: 'SETTINGS' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

allocationRoutes.put('/portfolio/allocation', async (c) => {
  const body = await c.req.json();
  const kr = Math.max(0, Math.min(100, Number(body.kr_pct ?? 0)));
  const us = Math.max(0, Math.min(100, Number(body.us_pct ?? 100)));
  if (Math.abs(kr + us - 100) > 1) return c.json({ error: `국내+미국 합계가 100%여야 합니다 (현재 ${kr + us}%)` }, 400);

  const semi = Math.max(0, Math.min(100, Number(body.sector_semiconductor ?? 30)));
  const bio = Math.max(0, Math.min(100, Number(body.sector_bio ?? 20)));
  const defense = Math.max(0, Math.min(100, Number(body.sector_defense ?? 25)));
  const finance = Math.max(0, Math.min(100, Number(body.sector_finance ?? 20)));
  const etc = Math.max(0, Math.min(100, Number(body.sector_etc ?? 30)));
  const trailStop = Math.max(1, Math.min(20, Number(body.trailing_stop_pct ?? 5)));
  // 리스크 파라미터 — body에 있으면 사용, 없으면 현재 DB 값 유지
  const posCapPct =
    body.position_cap_pct !== undefined ? Math.max(5, Math.min(60, Number(body.position_cap_pct))) : null;
  const maxInvPct =
    body.max_invested_pct !== undefined ? Math.max(50, Math.min(100, Number(body.max_invested_pct))) : null;
  const cashResPct =
    body.cash_reserve_pct !== undefined ? Math.max(0, Math.min(50, Number(body.cash_reserve_pct))) : null;
  const maxPos = body.max_positions !== undefined ? Math.max(1, Math.min(30, Number(body.max_positions))) : null;
  const maxDailyTr =
    body.max_daily_trades !== undefined ? Math.max(1, Math.min(50, Number(body.max_daily_trades))) : null;

  try {
    // body.isPaper 명시 우선, 없으면 현재 서버 모드 — 실전/연습 교차 오염 방지
    const isPaperAlloc = body.isPaper !== undefined ? Boolean(body.isPaper) : resolveRequestMode(c);
    const { rows: existing } = await getPool().query(
      'SELECT * FROM portfolio_allocation_config WHERE is_paper = $1 ORDER BY id DESC LIMIT 1',
      [isPaperAlloc],
    );
    let result: { rows: any[] };
    if (existing.length > 0) {
      const ex = existing[0];
      const { rows } = await getPool().query(
        `UPDATE portfolio_allocation_config
         SET kr_pct=$1, us_pct=$2, sector_semiconductor=$3, sector_bio=$4,
             sector_defense=$5, sector_finance=$6, sector_etc=$7, trailing_stop_pct=$8,
             position_cap_pct=$9, max_invested_pct=$10, cash_reserve_pct=$11,
             max_positions=$12, max_daily_trades=$13, updated_at=NOW()
         WHERE id=$14 RETURNING *`,
        [
          kr,
          us,
          semi,
          bio,
          defense,
          finance,
          etc,
          trailStop,
          posCapPct ?? ex.position_cap_pct,
          maxInvPct ?? ex.max_invested_pct,
          cashResPct ?? ex.cash_reserve_pct,
          maxPos ?? ex.max_positions,
          maxDailyTr ?? ex.max_daily_trades,
          ex.id,
        ],
      );
      result = rows[0];
    } else {
      const def = isPaperAlloc
        ? { cap: 40, inv: 97, cash: 3, pos: 20, tr: 20 }
        : { cap: 25, inv: 88, cash: 20, pos: 8, tr: 3 };
      const { rows } = await getPool().query(
        `INSERT INTO portfolio_allocation_config
         (kr_pct, us_pct, sector_semiconductor, sector_bio, sector_defense, sector_finance, sector_etc,
          trailing_stop_pct, is_paper, position_cap_pct, max_invested_pct, cash_reserve_pct, max_positions, max_daily_trades)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [
          kr,
          us,
          semi,
          bio,
          defense,
          finance,
          etc,
          trailStop,
          isPaperAlloc,
          posCapPct ?? def.cap,
          maxInvPct ?? def.inv,
          cashResPct ?? def.cash,
          maxPos ?? def.pos,
          maxDailyTr ?? def.tr,
        ],
      );
      result = rows[0];
    }
    invalidateAllocCache();
    return c.json(result);
  } catch (err: any) {
    logger.warn(`포트폴리오 배분 저장 실패: ${err?.message}`, { component: 'SETTINGS' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── DEFENSE 모드 수동 해제 (strategy_config + defense_park 동시 리셋) ──
allocationRoutes.post('/defense-mode/deactivate', async (c) => {
  try {
    const pool = getPool();

    // 1. strategy_config → SWING + constants 값으로 복원 (하드코딩 70 금지)
    const swingP = STRATEGY_PARAMS.SWING;
    await pool
      .query(
        `UPDATE strategy_config SET mode='SWING', buy_threshold=$1, stop_loss_pct=$2, take_profit_pct=$3, updated_at=NOW() WHERE is_active=true AND is_paper=$4`,
        [swingP.buyThreshold, swingP.stopLossPct, swingP.takeProfitPct, resolveRequestMode(c)],
      )
      .catch(() => {});

    // 인메모리 전략도 동기화
    if (isMemoryMode()) {
      const cur = await getActiveStrategy();
      memSetActiveStrategy({
        ...(cur ?? {}),
        mode: 'SWING',
        buy_threshold: swingP.buyThreshold,
        stop_loss_pct: swingP.stopLossPct,
        take_profit_pct: swingP.takeProfitPct,
      });
    }

    // 2. defense_park_state 해제
    const { deactivateDefensePark } = await import('../../../ai/track-b/defense-park.js');
    await deactivateDefensePark('CEO 수동 해제 (대시보드)');

    // 3. 푸시 알림
    const { notifyAlert } = await import('../../../notifications/web-push.js');
    notifyAlert('✅ DEFENSE 모드 해제', `SWING 매매 모드 복귀 (매수 기준 ${swingP.buyThreshold}점)`).catch(() => {});

    logger.info('✅ DEFENSE 모드 수동 해제 완료', { component: 'SETTINGS' });
    return c.json({ ok: true, message: `DEFENSE 모드 해제 — SWING 복귀 (매수 기준 ${swingP.buyThreshold}점)` });
  } catch (err: any) {
    logger.error(`DEFENSE 모드 해제 실패: ${err?.message}`, { component: 'SETTINGS' });
    return c.json({ ok: false, error: 'Internal server error' }, 500);
  }
});

// ── 비중 자동조정 제안 (pending_decisions category='rebalance') ──

// 대기 중인 비중 제안 목록
allocationRoutes.get('/portfolio/rebalance-proposals', async (c) => {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, situation, context, created_at, expires_at
     FROM pending_decisions
     WHERE category = 'rebalance' AND status = 'PENDING' AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 10`,
  );
  return c.json({ proposals: rows });
});

// 비중 제안 승인
allocationRoutes.post('/portfolio/rebalance-proposals/:id/approve', async (c) => {
  const decisionId = Number(c.req.param('id'));
  if (!decisionId) return c.json({ ok: false, error: 'invalid id' }, 400);
  const { approveAllocationProposal } = await import('../../../automation/cross-market-rotation.js');
  const result = await approveAllocationProposal(decisionId);
  if (result.ok) invalidateDashboardCache();
  return c.json(result, result.ok ? 200 : 400);
});

// 비중 제안 거부
allocationRoutes.post('/portfolio/rebalance-proposals/:id/reject', async (c) => {
  const decisionId = Number(c.req.param('id'));
  if (!decisionId) return c.json({ ok: false, error: 'invalid id' }, 400);
  const pool = getPool();
  await pool.query(
    `UPDATE pending_decisions SET status='DECIDED', decision=$1, decided_at=NOW() WHERE id=$2 AND category='rebalance'`,
    [JSON.stringify({ action: 'REJECTED' }), decisionId],
  );
  logger.info(`❌ 비중 제안 거부 (id=${decisionId})`, { component: 'SETTINGS' });
  return c.json({ ok: true, message: '제안이 거부되었습니다' });
});

// 비중 제안 수동 트리거 (성과 분석 후 즉시 제안)
allocationRoutes.post('/portfolio/propose-rebalance', async (c) => {
  const { proposeAllocationRebalance } = await import('../../../automation/cross-market-rotation.js');
  proposeAllocationRebalance()
    .then(() => logger.info('📊 비중 제안 수동 트리거 완료', { component: 'SETTINGS' }))
    .catch((e) => logger.error(`비중 제안 수동 트리거 실패: ${e}`, { component: 'SETTINGS' }));
  return c.json({ ok: true, message: '30일 성과 분석 중... 제안이 생성되면 알림이 발송됩니다' });
});
