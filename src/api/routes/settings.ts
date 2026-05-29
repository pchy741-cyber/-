import { Hono } from 'hono';
import { STRATEGY_PARAMS } from '../../config/constants.js';
import { config, baseIsPaper, setTradingModeOverride, getEffectiveTradingMode } from '../../config/index.js';
import { getActiveStrategy, getPool, isMemoryMode, logSystem } from '../../db/client.js';
import { memSetActiveStrategy } from '../../db/memory-store.js';
import { activateKillSwitchAll, deactivateKillSwitchAll, getKillSwitchStatusAll, activateKillSwitch, deactivateKillSwitch, getKillSwitchStatus } from '../../risk/kill-switch.js';
import type { KillSwitchScope } from '../../risk/kill-switch.js';
import { resetCooldown, getCooldownStatus } from '../../risk/trade-gate.js';
import { getSeedCapitalStatus, setSeedCapital } from '../../risk/seed-capital.js';
import { runTrackAJob } from '../../scheduler/track-a-job.js';
import { logger } from '../../utils/logger.js';
import { invalidateDashboardCache } from './dashboard.js';

export const settingsRoutes = new Hono();

// ── Kill Switch 제어 (KR/OVERSEAS 분리) ──
settingsRoutes.get('/kill-switch', (c) => {
  const scope = c.req.query('scope') as KillSwitchScope | undefined;
  if (scope === 'KR' || scope === 'OVERSEAS') {
    return c.json(getKillSwitchStatus(scope));
  }
  // scope 미지정 → 양쪽 모두 반환
  return c.json(getKillSwitchStatusAll());
});

settingsRoutes.post('/kill-switch/activate', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
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
    return c.json({ ok: false, error: err?.message ?? 'kill switch activate failed' }, 500);
  }
});

settingsRoutes.post('/kill-switch/deactivate', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const force = body.force === true;
    const scope = body.scope as KillSwitchScope | undefined;

    if (scope === 'KR' || scope === 'OVERSEAS') {
      await deactivateKillSwitch(force, scope);
    } else {
      await deactivateKillSwitchAll(force);
    }

    // Kill Switch 해제 시 스냅샷도 현재 잔고로 리셋 → 재활성화 방지
    try {
      const { getAccountBalance } = await import('../../kis/account.js');
      const { getPaperBalance } = await import('../../risk/paper-balance.js');
      const { insertSnapshot } = await import('../../db/client.js');
      const balance = baseIsPaper ? await getPaperBalance() : await getAccountBalance();
      const totalValue = balance.totalDeposit + balance.totalEvalAmount;
      await insertSnapshot({
        total_value: totalValue,
        cash_balance: balance.orderableCash,
        invested_value: balance.totalEvalAmount,
        unrealized_pnl: balance.totalProfitLoss,
        daily_pnl: 0,
        daily_pnl_pct: 0,
        positions: balance.positions,
      });
      logger.info(`✅ Kill Switch 해제 + 스냅샷 리셋 (${totalValue.toLocaleString()}원)`, { component: 'SETTINGS' });
    } catch (snapErr) {
      logger.warn(`⚠️ Kill Switch 해제 성공, 스냅샷 리셋 실패: ${snapErr}`, { component: 'SETTINGS' });
    }

    return c.json({ ok: true, status: getKillSwitchStatusAll() });
  } catch (err: any) {
    return c.json({ ok: false, error: err?.message ?? 'kill switch deactivate failed' }, 500);
  }
});

// ── 기준자본 (Seed Capital) 조회/설정 ──
settingsRoutes.get('/seed-capital', (c) => {
  return c.json(getSeedCapitalStatus());
});

settingsRoutes.put('/seed-capital', async (c) => {
  const body = await c.req.json();
  const market = body.market === 'OVERSEAS' ? 'OVERSEAS' : 'KR';
  const amount = Number(body.amount);
  if (!amount || amount <= 0) return c.json({ error: '금액은 0보다 커야 합니다' }, 400);

  await setSeedCapital(market, amount);
  return c.json({ ok: true, status: getSeedCapitalStatus() });
});

// ── 연속손실 쿨다운 제어 ──
settingsRoutes.get('/cooldown', async (c) => {
  return c.json(await getCooldownStatus());
});

settingsRoutes.post('/cooldown/reset', async (c) => {
  resetCooldown();
  logger.info('🔓 쿨다운 수동 초기화 (대시보드)', { component: 'TRADE_GATE' });
  return c.json({ ok: true, status: await getCooldownStatus() });
});

// ── 전략 설정 (CEO 프롬프트 관리) ──
settingsRoutes.get('/strategy', async (c) => {
  const strategy = await getActiveStrategy();
  return c.json(strategy ?? { mode: 'SWING', message: '설정 없음' });
});

settingsRoutes.put('/strategy', async (c) => {
  const body = await c.req.json();

  const requestedMode = (body.mode ?? 'SWING') as keyof typeof STRATEGY_PARAMS;
  const modeBase = STRATEGY_PARAMS[requestedMode] ?? STRATEGY_PARAMS.SWING;
  const strategyData = {
    mode: requestedMode,
    notebooklm_prompt: body.notebooklm_prompt ?? '',
    gemini_prompt: body.gemini_prompt ?? '',
    gpt_prompt: body.gpt_prompt ?? '',
    claude_prompt: body.claude_prompt ?? '',
    // UI 입력값이 constants 최솟값 미달이면 constants 우선
    buy_threshold: body.buy_threshold != null ? Math.max(body.buy_threshold, modeBase.buyThreshold) : modeBase.buyThreshold,
    stop_loss_pct: body.stop_loss_pct != null ? Math.min(body.stop_loss_pct, modeBase.stopLossPct) : modeBase.stopLossPct,
    take_profit_pct: body.take_profit_pct != null ? Math.max(body.take_profit_pct, modeBase.takeProfitPct) : modeBase.takeProfitPct,
    strategy_document: body.strategy_document ?? '',
    risk_prompt: body.risk_prompt ?? '',
  };

  // 감사 로그: 변경 전 상태 스냅샷
  const prevStrategy = await getActiveStrategy().catch(() => null);

  // 인메모리 모드: DB 없이도 전략 변경 가능
  if (isMemoryMode()) {
    const updated = memSetActiveStrategy(strategyData);
    const diff = buildStrategyDiff(prevStrategy, strategyData);
    await logSystem('INFO', 'STRATEGY_AUDIT', `전략 변경: ${diff}`, { prev: prevStrategy, next: strategyData }).catch(() => {});
    logger.info(`📋 전략 변경 감사: ${diff}`, { component: 'SETTINGS' });
    invalidateDashboardCache();
    return c.json(updated);
  }

  try {
    // UPDATE 우선 (기존 활성 전략 덮어쓰기) → 없으면 INSERT
    const isPaper = baseIsPaper;
    const { rowCount } = await getPool().query(
      `UPDATE strategy_config
       SET mode=$1, notebooklm_prompt=$2, gemini_prompt=$3, gpt_prompt=$4, claude_prompt=$5,
           buy_threshold=$6, stop_loss_pct=$7, take_profit_pct=$8, strategy_document=$9, risk_prompt=$10,
           updated_at=NOW()
       WHERE is_active = true AND is_paper = $11`,
      [strategyData.mode, strategyData.notebooklm_prompt, strategyData.gemini_prompt,
       strategyData.gpt_prompt, strategyData.claude_prompt, strategyData.buy_threshold,
       strategyData.stop_loss_pct, strategyData.take_profit_pct,
       strategyData.strategy_document, strategyData.risk_prompt, isPaper],
    );

    if ((rowCount ?? 0) === 0) {
      // 활성 전략이 없으면 새로 INSERT
      await getPool().query(
        `INSERT INTO strategy_config (mode, is_active, notebooklm_prompt, gemini_prompt, gpt_prompt, claude_prompt, buy_threshold, stop_loss_pct, take_profit_pct, strategy_document, risk_prompt, is_paper)
         VALUES ($1, true, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [strategyData.mode, strategyData.notebooklm_prompt, strategyData.gemini_prompt,
         strategyData.gpt_prompt, strategyData.claude_prompt, strategyData.buy_threshold,
         strategyData.stop_loss_pct, strategyData.take_profit_pct,
         strategyData.strategy_document, strategyData.risk_prompt, isPaper],
      );
    }

    const { rows } = await getPool().query(
      `SELECT * FROM strategy_config WHERE is_active = true AND is_paper = $1 ORDER BY updated_at DESC LIMIT 1`,
      [isPaper],
    );
    const diff = buildStrategyDiff(prevStrategy, strategyData);
    await logSystem('INFO', 'STRATEGY_AUDIT', `전략 변경: ${diff}`, { prev: prevStrategy, next: strategyData }).catch(() => {});
    logger.info(`📋 전략 변경 감사: ${diff}`, { component: 'SETTINGS' });
    invalidateDashboardCache(); // 모드 변경 즉시 캐시 무효화 → 프론트엔드 즉시 반영
    return c.json(rows[0]);
  } catch (err: any) {
    // DB 실패 시 인메모리 폴백 — 경고 포함
    logger.warn(`전략 DB 저장 실패 → 인메모리 폴백: ${err.message}`, { component: 'SETTINGS' });
    const updated = memSetActiveStrategy(strategyData);
    invalidateDashboardCache();
    return c.json({ ...updated, _warning: 'DB 저장 실패 — 인메모리만 반영 (서버 재시작 시 초기화)' });
  }
});

// ── 전략 변경 감사 로그 조회 ──
settingsRoutes.get('/strategy/audit', async (c) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, level, message, details, created_at
       FROM system_log
       WHERE component = 'STRATEGY_AUDIT'
       ORDER BY created_at DESC
       LIMIT 50`,
    );
    return c.json(rows);
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

/** 변경된 필드만 요약 문자열 반환 */
function buildStrategyDiff(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
): string {
  if (!prev) return `신규 설정 (mode=${next.mode})`;
  const KEYS = ['mode', 'buy_threshold', 'stop_loss_pct', 'take_profit_pct'] as const;
  const changed = KEYS.filter((k) => String(prev[k] ?? '') !== String(next[k] ?? ''));
  if (changed.length === 0) return '프롬프트 텍스트만 변경';
  return changed.map((k) => `${k}: ${prev[k]} → ${next[k]}`).join(', ');
}

// ── 푸시 알림 ──
settingsRoutes.get('/push/vapid-key', async (c) => {
  const { getVapidPublicKey, initVapid } = await import('../../notifications/web-push.js');
  // 아직 초기화 안 됐을 경우 대기
  if (!getVapidPublicKey()) await initVapid();
  return c.json({ publicKey: getVapidPublicKey() });
});

settingsRoutes.get('/push/status', async (c) => {
  const { isVapidReady, getSubscriptionCount, getVapidPublicKey } = await import('../../notifications/web-push.js');
  const count = isVapidReady() ? await getSubscriptionCount() : 0;
  return c.json({
    ready: isVapidReady(),
    publicKey: getVapidPublicKey(),
    deviceCount: count,
  });
});

settingsRoutes.post('/push/subscribe', async (c) => {
  const subscription = await c.req.json();
  const { saveSubscription } = await import('../../notifications/web-push.js');
  await saveSubscription(subscription);
  return c.json({ ok: true });
});

settingsRoutes.post('/push/test', async (c) => {
  const { sendPushNotification, isVapidReady } = await import('../../notifications/web-push.js');
  if (!isVapidReady()) return c.json({ ok: false, error: 'VAPID 미준비' }, 503);
  await sendPushNotification({
    title: '🔔 QUANTOPS 알림 테스트',
    body: '매수·매도·긴급상황 알림이 이렇게 옵니다. 실제 거래 시 즉시 알림됩니다.',
    tag: 'test-' + Date.now(),
    url: '/',
  });
  return c.json({ ok: true });
});

settingsRoutes.delete('/push/subscriptions', async (c) => {
  const { purgeAllSubscriptions } = await import('../../notifications/web-push.js');
  const count = await purgeAllSubscriptions();
  return c.json({ ok: true, deleted: count });
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

// KIS 잔고 강제 동기화 — 장 마감 중에도 호출 가능 (유령 포지션 정리)
settingsRoutes.post('/sync-overseas-holdings', async (c) => {
  try {
    const { syncHoldingsFromKIS } = await import('../../scheduler/overseas/kis-sync.js');
    await syncHoldingsFromKIS();
    return c.json({ ok: true, message: 'KIS 잔고 동기화 완료' });
  } catch (e) {
    logger.error(`KIS 강제 동기화 실패: ${e}`, { component: 'SETTINGS' });
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

/**
 * 실전 보유 포지션 직접 정정 — US 장 마감 중 KIS API 실패 시 수동 정정
 * body: { holdings: [{ code, exchange, qty, avg_price }], clearOthers: true }
 * clearOthers=true: body에 없는 종목은 전부 삭제 (유령 포지션 정리)
 */
settingsRoutes.post('/overseas-holdings-fix', async (c) => {
  try {
    const { getPool } = await import('../../db/client.js');
    const body = await c.req.json<{
      holdings: Array<{ code: string; exchange: string; qty: number; avg_price: number }>;
      clearOthers?: boolean;
    }>();
    const pool = getPool();
    const updated: string[] = [];
    const cleared: string[] = [];

    if (body.clearOthers) {
      const keepCodes = body.holdings.map(h => h.code);
      const { rows: existing } = await pool.query(
        'SELECT stock_code FROM overseas_holdings WHERE is_paper = false'
      );
      for (const row of existing) {
        if (!keepCodes.includes(row.stock_code)) {
          await pool.query(
            'DELETE FROM overseas_holdings WHERE stock_code=$1 AND is_paper=false',
            [row.stock_code]
          );
          cleared.push(row.stock_code);
        }
      }
    }

    for (const h of body.holdings) {
      if (h.qty <= 0) {
        await pool.query('DELETE FROM overseas_holdings WHERE stock_code=$1 AND is_paper=false', [h.code]);
        cleared.push(h.code);
      } else {
        await pool.query(
          `INSERT INTO overseas_holdings (stock_code, exchange, quantity, avg_price, bought_at, is_paper)
           VALUES ($1,$2,$3,$4,NOW(),false)
           ON CONFLICT (exchange,stock_code,is_paper) DO UPDATE SET quantity=$3, avg_price=$4`,
          [h.code, h.exchange, h.qty, h.avg_price]
        );
        updated.push(`${h.code}(${h.qty}@$${h.avg_price})`);
      }
    }

    logger.info(`🔧 해외 포지션 수동 정정: 업데이트[${updated.join(',')}] 삭제[${cleared.join(',')}]`, { component: 'SETTINGS' });
    return c.json({ ok: true, updated, cleared });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

// ── Auto Pilot Loop ──
settingsRoutes.get('/loop/status', async (c) => {
  const { getLoopStatus } = await import('../../scheduler/loop-mode.js');
  return c.json(getLoopStatus());
});

settingsRoutes.post('/loop/start', async (c) => {
  const { startLoop } = await import('../../scheduler/loop-mode.js');
  const result = await startLoop();
  if (!result.ok) return c.json(result, 409);
  logger.info('Auto Pilot 시작 (대시보드)', { component: 'SETTINGS' });
  return c.json(result);
});

settingsRoutes.post('/loop/stop', async (c) => {
  const { stopLoop } = await import('../../scheduler/loop-mode.js');
  const result = await stopLoop('수동 정지 (대시보드)');
  logger.info('Auto Pilot 정지 (대시보드)', { component: 'SETTINGS' });
  return c.json(result);
});

// ── 체인 TP/SL 점수 기반 복원 (1회성 보정) ──
settingsRoutes.post('/fix-chain-tpsl', async (c) => {
  try {
    const { getScoreBasedParams } = await import('../../config/constants.js');
    const pool = getPool();
    // 열린 체인 목록
    const { rows: chains } = await pool.query(
      `SELECT id, stock_code FROM transaction_chains WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING') AND is_paper = $1`,
      [baseIsPaper],
    );
    // 최신 AI 점수 조회
    const { rows: scores } = await pool.query(
      `SELECT DISTINCT ON (stock_code) stock_code, composite_score FROM ai_scores ORDER BY stock_code, score_date DESC`,
    );
    const scoreMap = new Map<string, number>(scores.map((s: any) => [s.stock_code, Number(s.composite_score)]));
    let updated = 0;
    for (const chain of chains) {
      const score = scoreMap.get(chain.stock_code);
      if (!score || score < 60) continue;
      const { takeProfitPct, stopLossPct } = getScoreBasedParams(score);
      await pool.query(
        `UPDATE transaction_chains SET target_profit_pct=$1, stop_loss_pct=$2 WHERE id=$3`,
        [takeProfitPct, stopLossPct, chain.id],
      );
      updated++;
    }
    logger.info(`🔧 체인 TP/SL 복원: ${updated}/${chains.length}개`, { component: 'SETTINGS' });
    return c.json({ ok: true, updated, total: chains.length });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

// ── 인사이트 관리 ──
// GET: 전체 인사이트 조회
settingsRoutes.get('/insights', async (c) => {
  try {
    // paper/live 공유: 모든 인사이트 통합 조회
    const { rows } = await getPool().query(
      `SELECT *
       FROM learned_insights ORDER BY is_manual DESC, confidence DESC LIMIT 50`,
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
      `INSERT INTO learned_insights (category, insight, confidence, sample_count, last_updated, is_manual, is_paper)
       VALUES ($1, $2, $3, 1, NOW(), TRUE, $4) RETURNING *`,
      [category, insight, body.confidence ?? 0.8, baseIsPaper],
    );
    return c.json(rows[0]);
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// POST: 인사이트 파라미터 전략 적용
settingsRoutes.post('/insights/:id/apply', async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id 필요' }, 400);
  try {
    const { applyInsightById } = await import('../../automation/self-learning.js');
    const result = await applyInsightById(id);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// DELETE: 인사이트 삭제 (수동/자동 모두 삭제 가능)
settingsRoutes.delete('/insights/:id', async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id 필요' }, 400);
  try {
    await getPool().query('DELETE FROM learned_insights WHERE id = $1', [id]);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// ── 연습→실전 인사이트 프로모션 ──

// GET: 프로모션 가능한 paper 인사이트 후보 목록
settingsRoutes.get('/insights/promotable', async (c) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, category, insight, confidence, sample_count, last_updated, recommendation, param_change
       FROM learned_insights
       WHERE is_paper = true
         AND category IN ('WIN_PATTERN', 'TIMING', 'SIZING')
         AND confidence >= 0.6
         AND sample_count >= 3
         AND COALESCE(is_promoted, false) IS NOT TRUE
       ORDER BY confidence DESC, sample_count DESC
       LIMIT 10`,
    );
    return c.json(rows);
  } catch (err: any) {
    // 마이그레이션 전 — 프로모션 컬럼 없으면 빈 배열
    return c.json([]);
  }
});

// POST: paper 인사이트를 live로 프로모션 (CEO 수동 승인만)
settingsRoutes.post('/insights/:id/promote', async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id 필요' }, 400);

  try {
    // 1. 원본 확인 (반드시 paper 인사이트)
    const { rows: sourceRows } = await getPool().query(
      `SELECT * FROM learned_insights WHERE id = $1 AND is_paper = true`,
      [id],
    );
    const source = sourceRows[0];
    if (!source) return c.json({ error: '연습모드 인사이트를 찾을 수 없습니다' }, 404);

    // 2. LOSS_PATTERN은 프로모션 불가 (경고용이지 실전 적용 대상 아님)
    if (source.category === 'LOSS_PATTERN') {
      return c.json({ error: 'LOSS_PATTERN은 프로모션할 수 없습니다 (경고 전용)' }, 400);
    }

    // 3. 이미 프로모션 됐는지 확인
    const { rows: existing } = await getPool().query(
      `SELECT id FROM learned_insights WHERE promoted_from_id = $1`,
      [id],
    );
    if (existing.length > 0) return c.json({ error: '이미 프로모션된 인사이트입니다' }, 409);

    // 4. live로 복사 (confidence 0.7배, is_manual=true로 자기학습 삭제 방지)
    const reducedConfidence = Math.round(Number(source.confidence) * 0.7 * 100) / 100;
    const promotedInsight = `[연습검증] ${source.insight}`;

    const { rows: promoted } = await getPool().query(
      `INSERT INTO learned_insights
        (category, insight, confidence, sample_count, last_updated, details,
         recommendation, param_change, is_paper, is_manual,
         promoted_from_id, source_mode, promoted_at, live_validation_status)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, false, true,
               $8, 'promoted_from_paper', NOW(), 'pending')
       RETURNING *`,
      [
        source.category,
        promotedInsight,
        reducedConfidence,
        source.sample_count,
        source.details ? JSON.stringify(source.details) : null,
        source.recommendation,
        source.param_change ? JSON.stringify(source.param_change) : null,
        id,
      ],
    );

    // 5. 원본에 promoted 마킹 (자기학습 재생성 시 삭제 방지)
    await getPool().query(
      `UPDATE learned_insights SET is_promoted = true WHERE id = $1`,
      [id],
    );

    // 6. 텔레그램 알림
    const { sendTelegramMessage } = await import('../../notifications/telegram.js');
    await sendTelegramMessage(
      `🔄 *연습→실전 인사이트 프로모션*\n` +
      `카테고리: ${source.category}\n` +
      `내용: ${String(source.insight).slice(0, 80)}...\n` +
      `신뢰도: ${source.confidence} → ${reducedConfidence} (0.7x 적용)\n` +
      `실전 검증 대기 중`,
    ).catch(() => {});

    await logSystem('INFO', 'PROMOTE', `연습→실전 프로모션: [${source.category}] ${String(source.insight).slice(0, 60)}`).catch(() => {});

    return c.json({ ok: true, promoted: promoted[0] });
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// POST: 프로모션 취소 (live에서 제거 + 원본 is_promoted 복원)
settingsRoutes.post('/insights/:id/revoke', async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id 필요' }, 400);

  try {
    const { rows } = await getPool().query(
      `SELECT * FROM learned_insights WHERE id = $1 AND source_mode = 'promoted_from_paper'`,
      [id],
    );
    if (!rows[0]) return c.json({ error: '프로모션된 인사이트가 아닙니다' }, 404);

    const originalId = rows[0].promoted_from_id;

    // live에서 프로모션 인사이트 삭제
    await getPool().query('DELETE FROM learned_insights WHERE id = $1', [id]);

    // 원본 paper 인사이트 is_promoted 복원
    if (originalId) {
      await getPool().query(
        'UPDATE learned_insights SET is_promoted = false WHERE id = $1',
        [originalId],
      );
    }

    await logSystem('INFO', 'PROMOTE', `프로모션 취소: ${String(rows[0].insight).slice(0, 60)}`).catch(() => {});

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

// 자기학습 즉시 실행 (평일 18:30 자동 외 수동 트리거)
settingsRoutes.post('/run-self-learning', async (c) => {
  const { analyzeTradeHistory } = await import('../../automation/self-learning.js');
  analyzeTradeHistory()
    .then((insights) => logger.info(`자기학습 완료: ${insights.length}개 인사이트`, { component: 'SETTINGS' }))
    .catch((e) => logger.error(`자기학습 실패: ${e}`, { component: 'SETTINGS' }));
  return c.json({ ok: true, message: '자기학습 시작 (백그라운드 실행, 완료 시 텔레그램 알림)' });
});

// ── 거래 모드 전환 (모의/실전) ──
settingsRoutes.get('/trading-mode', async (c) => {
  try {
    const { rows } = await getPool().query('SELECT trading_mode_override FROM portfolio_allocation_config WHERE is_paper = false ORDER BY id DESC LIMIT 1');
    const dbMode = rows[0]?.trading_mode_override ?? null;
    return c.json({ mode: dbMode ?? getEffectiveTradingMode(), dbOverride: dbMode });
  } catch {
    return c.json({ mode: getEffectiveTradingMode(), dbOverride: null });
  }
});

settingsRoutes.post('/trading-mode', async (c) => {
  const body = await c.req.json();
  const mode: 'paper' | 'live' = body.mode === 'live' ? 'live' : 'paper';

  // 안전 가드: 해외 Job 실행 중 모드 전환 차단 (paper/live 데이터 혼재 방지)
  try {
    const { isOverseasJobRunning } = await import('../../scheduler/overseas-job.js');
    if (isOverseasJobRunning()) {
      return c.json({ error: '해외 Job 실행 중 — 1분 후 다시 시도하세요' }, 409);
    }
  } catch {}

  // 안전 가드: PENDING 주문 존재 시 모드 전환 차단 (체결 대기 중 모드 변경 → 데이터 불일치)
  try {
    const currentMode = getEffectiveTradingMode();
    const { rows: pendingRows } = await getPool().query(
      `SELECT COUNT(*) as cnt FROM orders WHERE status = 'PENDING' AND trading_mode = $1`,
      [currentMode],
    );
    const pendingCount = Number(pendingRows[0]?.cnt ?? 0);
    if (pendingCount > 0) {
      return c.json({ error: `미체결 주문 ${pendingCount}건 존재 — 체결/취소 후 모드 전환하세요` }, 409);
    }
  } catch (e) {
    logger.warn(`모드 전환 PENDING 체크 실패: ${e}`, { component: 'SETTINGS' });
  }

  setTradingModeOverride(mode);
  try {
    // UPDATE 시도 (live 행만 대상 — 행이 없으면 rowCount=0)
    const { rowCount } = await getPool().query(
      'UPDATE portfolio_allocation_config SET trading_mode_override=$1 WHERE is_paper = false',
      [mode],
    );
    if ((rowCount ?? 0) === 0) {
      // 행이 없으면 기본값으로 INSERT (live 행)
      await getPool().query(
        `INSERT INTO portfolio_allocation_config
           (kr_pct, us_pct, sector_semiconductor, sector_bio, sector_defense,
            sector_finance, sector_etc, trailing_stop_pct, trading_mode_override, is_paper)
         VALUES (70, 30, 30, 20, 25, 20, 30, 5, $1, false)`,
        [mode],
      );
    }
  } catch (e: any) {
    logger.warn(`거래 모드 DB 저장 실패: ${e.message}`, { component: 'SETTINGS' });
  }
  logger.info(`🔄 거래 모드 전환: ${mode.toUpperCase()} (CEO 대시보드)`, { component: 'SETTINGS' });
  const { invalidateModeCache, prewarmDashboard } = await import('./dashboard.js');
  invalidateModeCache(mode); // 새 모드 캐시만 무효화 (이전 모드 캐시 보존 → 되돌아갈 때 즉시 응답)
  prewarmDashboard().catch(() => {}); // 새 모드 캐시 background 선제 빌드
  return c.json({ ok: true, mode });
});

// ── 투자비율 설정 (국내/미국 비율 + 섹터 한도) ──
const ALLOC_DEFAULTS = {
  kr_pct: 70, us_pct: 30,
  sector_semiconductor: 30, sector_bio: 20, sector_defense: 25, sector_finance: 20, sector_etc: 30,
  trailing_stop_pct: 5,
};

settingsRoutes.get('/portfolio/allocation', async (c) => {
  try {
    const isPaper = baseIsPaper;
    const { rows } = await getPool().query('SELECT * FROM portfolio_allocation_config WHERE is_paper = $1 ORDER BY id DESC LIMIT 1', [isPaper]);
    if (rows.length === 0) {
      const { rows: ins } = await getPool().query(
        `INSERT INTO portfolio_allocation_config (kr_pct, us_pct, sector_semiconductor, sector_bio, sector_defense, sector_finance, sector_etc, trailing_stop_pct, is_paper)
         VALUES (70, 30, 30, 20, 25, 20, 30, 5, $1) RETURNING *`,
        [isPaper],
      );
      return c.json(ins[0]);
    }
    return c.json(rows[0]);
  } catch (err: any) {
    return c.json(ALLOC_DEFAULTS);
  }
});

settingsRoutes.put('/portfolio/allocation', async (c) => {
  const body = await c.req.json();
  const kr = Math.max(0, Math.min(100, Number(body.kr_pct ?? 70)));
  const us = Math.max(0, Math.min(100, Number(body.us_pct ?? 30)));
  if (Math.abs(kr + us - 100) > 1) return c.json({ error: `국내+미국 합계가 100%여야 합니다 (현재 ${kr + us}%)` }, 400);

  const semi = Math.max(0, Math.min(100, Number(body.sector_semiconductor ?? 30)));
  const bio = Math.max(0, Math.min(100, Number(body.sector_bio ?? 20)));
  const defense = Math.max(0, Math.min(100, Number(body.sector_defense ?? 25)));
  const finance = Math.max(0, Math.min(100, Number(body.sector_finance ?? 20)));
  const etc = Math.max(0, Math.min(100, Number(body.sector_etc ?? 30)));
  const trailStop = Math.max(1, Math.min(20, Number(body.trailing_stop_pct ?? 5)));

  try {
    const isPaperAlloc = baseIsPaper;
    const { rows: existing } = await getPool().query('SELECT id FROM portfolio_allocation_config WHERE is_paper = $1 ORDER BY id DESC LIMIT 1', [isPaperAlloc]);
    let result;
    if (existing.length > 0) {
      const { rows } = await getPool().query(
        `UPDATE portfolio_allocation_config SET kr_pct=$1, us_pct=$2, sector_semiconductor=$3, sector_bio=$4,
         sector_defense=$5, sector_finance=$6, sector_etc=$7, trailing_stop_pct=$8, updated_at=NOW() WHERE id=$9 RETURNING *`,
        [kr, us, semi, bio, defense, finance, etc, trailStop, existing[0].id],
      );
      result = rows[0];
    } else {
      const { rows } = await getPool().query(
        `INSERT INTO portfolio_allocation_config (kr_pct, us_pct, sector_semiconductor, sector_bio, sector_defense, sector_finance, sector_etc, trailing_stop_pct, is_paper)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [kr, us, semi, bio, defense, finance, etc, trailStop, isPaperAlloc],
      );
      result = rows[0];
    }
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// ── DEFENSE 모드 수동 해제 (strategy_config + defense_park 동시 리셋) ──
settingsRoutes.post('/defense-mode/deactivate', async (c) => {
  try {
    const pool = getPool();

    // 1. strategy_config → SWING + constants 값으로 복원 (하드코딩 70 금지)
    const swingP = STRATEGY_PARAMS.SWING;
    await pool.query(
      `UPDATE strategy_config SET mode='SWING', buy_threshold=$1, stop_loss_pct=$2, take_profit_pct=$3, updated_at=NOW() WHERE is_active=true AND is_paper=$4`,
      [swingP.buyThreshold, swingP.stopLossPct, swingP.takeProfitPct, baseIsPaper],
    ).catch(() => {});

    // 인메모리 전략도 동기화
    if (isMemoryMode()) {
      const cur = await getActiveStrategy();
      memSetActiveStrategy({ ...(cur ?? {}), mode: 'SWING', buy_threshold: swingP.buyThreshold, stop_loss_pct: swingP.stopLossPct, take_profit_pct: swingP.takeProfitPct });
    }

    // 2. defense_park_state 해제
    const { deactivateDefensePark } = await import('../../ai/track-b/defense-park.js');
    await deactivateDefensePark('CEO 수동 해제 (대시보드)');

    // 3. 푸시 알림
    const { notifyAlert } = await import('../../notifications/web-push.js');
    notifyAlert('✅ DEFENSE 모드 해제', `SWING 매매 모드 복귀 (매수 기준 ${swingP.buyThreshold}점)`).catch(() => {});

    logger.info('✅ DEFENSE 모드 수동 해제 완료', { component: 'SETTINGS' });
    return c.json({ ok: true, message: `DEFENSE 모드 해제 — SWING 복귀 (매수 기준 ${swingP.buyThreshold}점)` });
  } catch (err: any) {
    return c.json({ ok: false, error: err?.message ?? 'defense deactivate failed' }, 500);
  }
});

// 워치리스트 순환 즉시 실행 (일요일 19:00 자동 외 수동 트리거)
settingsRoutes.post('/run-watchlist-rotation', async (c) => {
  const { runWatchlistRotation } = await import('../../automation/watchlist-rotation.js');
  runWatchlistRotation()
    .then(() => logger.info(`워치리스트 순환 완료`, { component: 'SETTINGS' }))
    .catch((e) => logger.error(`워치리스트 순환 실패: ${e}`, { component: 'SETTINGS' }));
  return c.json({ ok: true, message: '워치리스트 순환 시작 (저점수 종목 제거 + 고점수 종목 자동 추가)' });
});
