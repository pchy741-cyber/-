import { Hono } from 'hono';
import { getPool } from '../../../db/client.js';
import { runTrackAJob } from '../../../scheduler/track-a-job.js';
import { logger } from '../../../utils/logger.js';
import { resolveRequestMode } from '../../guards/live-pin.js';

export const manualTriggersRoutes = new Hono();

// ── 수동 실행 API ──
manualTriggersRoutes.post('/run-track-a', async (c) => {
  const body = await c.req.json();
  runTrackAJob(body.sources).catch((e) => logger.error(`Track A 수동 실행 실패: ${e}`, { component: 'SETTINGS' }));
  return c.json({ ok: true, message: 'Track A 수동 실행 시작' });
});

manualTriggersRoutes.post('/run-track-b', async (c) => {
  const { runTrackBJob } = await import('../../../scheduler/track-b-job.js');
  runTrackBJob().catch((e) => logger.error(`Track B 수동 실행 실패: ${e}`, { component: 'SETTINGS' }));
  return c.json({ ok: true, message: 'Track B 수동 실행 시작' });
});

manualTriggersRoutes.post('/run-overseas', async (c) => {
  const { runOverseasJob } = await import('../../../scheduler/overseas-job.js');
  runOverseasJob().catch((e) => logger.error(`해외주식 수동 실행 실패: ${e}`, { component: 'SETTINGS' }));
  return c.json({ ok: true, message: '해외주식 수동 실행 시작' });
});

// Paper 해외 전용 수동 실행 — 리필 + 뉴스 프리페치 + Paper 매매
manualTriggersRoutes.post('/run-overseas-paper', async (c) => {
  const { runWithMode } = await import('../../../config/context.js');
  const { checkAndRefillOverseasPaper } = await import('../../../scheduler/overseas/state.js');
  const { runOverseasJob } = await import('../../../scheduler/overseas-job.js');
  const { prefetchAllNews } = await import('../../routes/dashboard-news.js');

  (async () => {
    try {
      // 1. 뉴스 프리페치 (해외 세션용 테마/요약 갱신)
      await prefetchAllNews();
      logger.info('📰 Paper 해외 실행 전 뉴스 프리페치 완료', { component: 'SETTINGS' });

      // 2. Paper 자금 리필 (강제)
      await runWithMode(true, async () => {
        const refilled = await checkAndRefillOverseasPaper(true);
        if (refilled) logger.info('🔄 Paper 해외 자금 강제 리필 완료', { component: 'SETTINGS' });
      });

      // 3. Paper 모드로 overseas job 실행
      await runWithMode(true, async () => {
        await runOverseasJob({ isPaper: true });
      });
      logger.info('🇺🇸 Paper 해외 수동 실행 완료', { component: 'SETTINGS' });
    } catch (e) {
      logger.error(`Paper 해외 수동 실행 실패: ${e}`, { component: 'SETTINGS' });
    }
  })();

  return c.json({ ok: true, message: 'Paper 해외 실행 시작 (뉴스 프리페치 + 리필 + 매매)' });
});

// KIS 잔고 강제 동기화 — 장 마감 중에도 호출 가능 (유령 포지션 정리)
manualTriggersRoutes.post('/sync-overseas-holdings', async (c) => {
  try {
    const { syncHoldingsFromKIS, reconcileCashWithKIS } = await import('../../../scheduler/overseas/kis-sync.js');
    const { runWithMode } = await import('../../../config/context.js');
    // live 컨텍스트에서 실행 — paper TR ID 대신 live TR ID 사용 보장
    await runWithMode(false, async () => {
      await syncHoldingsFromKIS();
      await reconcileCashWithKIS();
    });
    return c.json({ ok: true, message: 'KIS 잔고 + 현금 동기화 완료 (live)' });
  } catch (e) {
    logger.error(`KIS 강제 동기화 실패: ${e}`, { component: 'SETTINGS' });
    return c.json({ ok: false, error: 'Internal server error' }, 500);
  }
});

// Live 현금 수동 보정 — KIS 동기화 안될 때 직접 설정
manualTriggersRoutes.post('/cash-fix', async (c) => {
  try {
    const body = await c.req.json<{ amount_krw: number; pin?: string }>();
    if (!body.amount_krw || body.amount_krw < 0) return c.json({ error: '양수 금액 필요' }, 400);
    // live 보정이므로 PIN 검증
    const { validateLivePin } = await import('../../guards/live-pin.js');
    const pinCheck = validateLivePin(false, body.pin);
    if (!pinCheck.ok) return c.json({ error: pinCheck.error }, 403);

    const { setCash } = await import('../../../scheduler/overseas/state.js');
    const { runWithMode } = await import('../../../config/context.js');
    await runWithMode(false, () => setCash(body.amount_krw, false));
    return c.json({ ok: true, cashKrw: body.amount_krw });
  } catch (e) {
    logger.error(`현금 수동 보정 실패: ${e}`, { component: 'SETTINGS' });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * 실전 보유 포지션 직접 정정 — US 장 마감 중 KIS API 실패 시 수동 정정
 * body: { holdings: [{ code, exchange, qty, avg_price }], clearOthers: true }
 * clearOthers=true: body에 없는 종목은 전부 삭제 (유령 포지션 정리)
 */
manualTriggersRoutes.post('/overseas-holdings-fix', async (c) => {
  try {
    // Live 포지션 변경이므로 PIN 검증 필수
    const { validateLivePin } = await import('../../guards/live-pin.js');
    const { getPool } = await import('../../../db/client.js');
    const body = await c.req.json<{
      holdings: Array<{ code: string; exchange: string; qty: number; avg_price: number }>;
      clearOthers?: boolean;
      pin?: string;
    }>();
    const pinCheck = validateLivePin(false, body.pin);
    if (!pinCheck.ok) return c.json({ error: pinCheck.error }, 403);
    const pool = getPool();
    const updated: string[] = [];
    const cleared: string[] = [];

    if (body.clearOthers) {
      const keepCodes = body.holdings.map((h) => h.code);
      const { rows: existing } = await pool.query('SELECT stock_code FROM overseas_holdings WHERE is_paper = false');
      for (const row of existing) {
        if (!keepCodes.includes(row.stock_code)) {
          await pool.query('DELETE FROM overseas_holdings WHERE stock_code=$1 AND is_paper=false', [row.stock_code]);
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
          [h.code, h.exchange, h.qty, h.avg_price],
        );
        updated.push(`${h.code}(${h.qty}@$${h.avg_price})`);
      }
    }

    logger.info(`🔧 해외 포지션 수동 정정: 업데이트[${updated.join(',')}] 삭제[${cleared.join(',')}]`, {
      component: 'SETTINGS',
    });
    return c.json({ ok: true, updated, cleared });
  } catch (e) {
    logger.error(`해외 포지션 수동 정정 실패: ${e}`, { component: 'SETTINGS' });
    return c.json({ ok: false, error: 'Internal server error' }, 500);
  }
});

// ── Auto Pilot Loop ──
manualTriggersRoutes.get('/loop/status', async (c) => {
  const { getLoopStatus } = await import('../../../scheduler/loop-mode.js');
  return c.json(getLoopStatus());
});

manualTriggersRoutes.post('/loop/start', async (c) => {
  const { startLoop } = await import('../../../scheduler/loop-mode.js');
  const result = await startLoop();
  if (!result.ok) return c.json(result, 409);
  logger.info('Auto Pilot 시작 (대시보드)', { component: 'SETTINGS' });
  return c.json(result);
});

manualTriggersRoutes.post('/loop/stop', async (c) => {
  const { stopLoop } = await import('../../../scheduler/loop-mode.js');
  const result = await stopLoop('수동 정지 (대시보드)');
  logger.info('Auto Pilot 정지 (대시보드)', { component: 'SETTINGS' });
  return c.json(result);
});

// ── 체인 TP/SL 점수 기반 복원 (1회성 보정) ──
manualTriggersRoutes.post('/fix-chain-tpsl', async (c) => {
  try {
    const { getScoreBasedParams } = await import('../../../config/constants.js');
    const pool = getPool();
    // 열린 체인 목록
    const { rows: chains } = await pool.query(
      `SELECT id, stock_code FROM transaction_chains WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING') AND is_paper = $1`,
      [resolveRequestMode(c)],
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
      await pool.query(`UPDATE transaction_chains SET target_profit_pct=$1, stop_loss_pct=$2 WHERE id=$3`, [
        takeProfitPct,
        stopLossPct,
        chain.id,
      ]);
      updated++;
    }
    logger.info(`🔧 체인 TP/SL 복원: ${updated}/${chains.length}개`, { component: 'SETTINGS' });
    return c.json({ ok: true, updated, total: chains.length });
  } catch (err: any) {
    logger.error(`체인 TP/SL 복원 실패: ${err.message}`, { component: 'SETTINGS' });
    return c.json({ ok: false, error: 'Internal server error' }, 500);
  }
});

// 종목명 즉시 보정 (코드로만 저장된 종목 → KRX API로 이름 조회)
manualTriggersRoutes.post('/fix-names', async (c) => {
  const { fixWatchlistNames } = await import('../../../kis/interest-group.js');
  fixWatchlistNames()
    .then((r) => logger.info(`종목명 보정 완료: ${r.fixed}/${r.total}건`, { component: 'SETTINGS' }))
    .catch((e) => logger.error(`종목명 보정 실패: ${e}`, { component: 'SETTINGS' }));
  return c.json({ ok: true, message: '종목명 보정 시작 (KRX API 조회 중...)' });
});

// 자기학습 즉시 실행 (평일 18:30 자동 외 수동 트리거)
manualTriggersRoutes.post('/run-self-learning', async (c) => {
  const { analyzeTradeHistory } = await import('../../../automation/self-learning.js');
  const { runWithMode } = await import('../../../config/context.js');
  const isPaper = resolveRequestMode(c);
  runWithMode(isPaper, () => analyzeTradeHistory())
    .then((insights) => logger.info(`자기학습 완료 (${isPaper ? '연습' : '실전'}): ${insights.length}개 인사이트`, { component: 'SETTINGS' }))
    .catch((e) => logger.error(`자기학습 실패: ${e}`, { component: 'SETTINGS' }));
  return c.json({ ok: true, message: `자기학습 시작 (${isPaper ? '연습' : '실전'}, 백그라운드 실행, 완료 시 텔레그램 알림)` });
});

// 워치리스트 순환 즉시 실행 (일요일 19:00 자동 외 수동 트리거)
manualTriggersRoutes.post('/run-watchlist-rotation', async (c) => {
  const { runWatchlistRotation } = await import('../../../automation/watchlist-rotation.js');
  runWatchlistRotation()
    .then(() => logger.info(`워치리스트 순환 완료`, { component: 'SETTINGS' }))
    .catch((e) => logger.error(`워치리스트 순환 실패: ${e}`, { component: 'SETTINGS' }));
  return c.json({ ok: true, message: '워치리스트 순환 시작 (저점수 종목 제거 + 고점수 종목 자동 추가)' });
});

// KOSPI 레짐 차단 수동 우회
manualTriggersRoutes.post('/kospi-regime/override', async (c) => {
  const { setKospiOverrideExpiry } = await import('../../../risk/kospi-override.js');
  // 오늘 자정까지 유효한 우회 플래그 설정
  // KST 23:59:59.999 = UTC 14:59:59.999
  const midnight = new Date();
  midnight.setUTCHours(14, 59, 59, 999);
  // 이미 KST 다음 날이면 (UTC 15:00~24:00) 다음 날 자정
  if (Date.now() > midnight.getTime()) midnight.setUTCDate(midnight.getUTCDate() + 1);
  setKospiOverrideExpiry(midnight.getTime());
  logger.warn('⚠️ KOSPI 레짐 차단 수동 우회 활성화 (당일만)', { component: 'SETTINGS' });
  const { notifyAlert } = await import('../../../notifications/web-push.js');
  notifyAlert('⚠️ KOSPI 하락장 차단 우회', 'CEO 수동 지시 — Live 매수 오늘 하루 우회 활성').catch(() => {});
  return c.json({ ok: true, expiresAt: midnight.toISOString(), message: 'KOSPI 레짐 차단 우회 활성 (자정 자동 해제)' });
});
