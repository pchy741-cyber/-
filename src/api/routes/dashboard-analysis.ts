import { Hono } from 'hono';
import { getDefenseParkState } from '../../ai/track-b/defense-park.js';
import { IDLE_PARK_CODES } from '../../ai/track-b/trading-rules.js';
import { getCachedScores } from '../../cache/redis.js';
import { config } from '../../config/index.js';
import { getActiveStrategy, getActiveWatchlist, getLatestScores, getOpenChains, getPool } from '../../db/client.js';
import { getAccountBalance } from '../../kis/account.js';
import { getDailyChart, isMarketOpen } from '../../kis/market.js';
import { analyzeTechnicals } from '../../analysis/indicators.js';
import { getInvestorFlow } from '../../automation/investor-flow.js';
import { fetchShortSellingData } from '../../automation/short-selling.js';
import { fetchAnalystConsensus } from '../../automation/analyst-consensus.js';
import { getAiStatus } from '../../cache/ai-status.js';
import { getPaperBalance } from '../../risk/engine.js';
import { getKillSwitchStatus } from '../../risk/kill-switch.js';
import { getDinnerMoneyStats } from '../../automation/profit-withdraw.js';
import { logger } from '../../utils/logger.js';
import { getKnownStockName, isInvalidStockName } from './dashboard.js';

export const dashboardAnalysisRoutes = new Hono();

// ── 종목 상세 분석 (기술적 지표 + 수급 + 공매도 + 목표가) ──
dashboardAnalysisRoutes.get('/stock/:code/analysis', async (c) => {
  const stockCode = c.req.param('code');
  const defaultResult = { technicals: null, flow: null, shorts: null, consensus: null };

  const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  try {
    const [chart, flow, shorts, consensus] = await Promise.allSettled([
      withTimeout(getDailyChart(stockCode, 65), 6000),
      withTimeout(getInvestorFlow(stockCode, 5).catch(() => null), 4000),
      withTimeout(fetchShortSellingData(stockCode, 5).catch(() => null), 4000),
      withTimeout(fetchAnalystConsensus(stockCode).catch(() => null), 4000),
    ]);

    let technicals = null;
    if (chart.status === 'fulfilled' && chart.value.length >= 20) {
      const candles = chart.value.map((c: any) => ({
        date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      }));
      technicals = analyzeTechnicals(candles);
    }

    return c.json({
      stockCode,
      technicals,
      flow: flow.status === 'fulfilled' ? flow.value : null,
      shorts: shorts.status === 'fulfilled' ? shorts.value : null,
      consensus: consensus.status === 'fulfilled' ? consensus.value : null,
    });
  } catch {
    return c.json({ stockCode, ...defaultResult });
  }
});

// ── 매매 상태 진단 (왜 매수 안 하는지) ──
dashboardAnalysisRoutes.get('/trading-status', async (c) => {
  try {
    const [killSwitch, defensePark, strategy, scores, watchlist, recentLossCodes] = await Promise.all([
      Promise.resolve(getKillSwitchStatus()),
      getDefenseParkState().catch(() => ({ isActive: false, entryReason: null })),
      getActiveStrategy().catch(() => null),
      (async () => {
        const wl = await getActiveWatchlist().catch(() => []);
        const codes = wl.map((w: any) => w.stock_code);
        const s = await getCachedScores(codes).catch(() => []);
        return s.length > 0 ? s : await getLatestScores(codes).catch(() => []);
      })(),
      getActiveWatchlist().catch(() => []),
      (async () => {
        const { getRecentLossStocks } = await import('../../db/client.js');
        return getRecentLossStocks(7).catch(() => new Set<string>());
      })(),
    ]);

    const mode = (strategy?.mode ?? 'SWING') as string;
    const { STRATEGY_PARAMS } = await import('../../config/constants.js');
    const defaultThreshold = (STRATEGY_PARAMS as any)[mode]?.buyThreshold ?? 62;
    const buyThreshold = strategy?.buy_threshold ?? defaultThreshold;
    const marketOpen = isMarketOpen();

    const blocks: { reason: string; detail: string; severity: 'warn' | 'info' | 'ok' }[] = [];

    if (killSwitch.active) {
      blocks.push({ reason: '긴급정지 (Kill Switch)', detail: killSwitch.reason ?? '수동 발동', severity: 'warn' });
    }

    if (defensePark.isActive) {
      blocks.push({ reason: '방어 파킹 중', detail: defensePark.entryReason ?? '하락세 감지 → 현금 ETF 보호', severity: 'warn' });
    }

    if (!marketOpen) {
      blocks.push({ reason: '장 마감', detail: '09:00~15:30 외 시간 — 매수 불가', severity: 'info' });
    }

    if (mode === 'DEFENSE') {
      blocks.push({ reason: 'DEFENSE 모드', detail: `AI 점수 ${buyThreshold}점 이상만 진입 — 기준 매우 높음`, severity: 'warn' });
    }

    const candidates = scores.filter((s: any) => (s.composite_score ?? 0) >= buyThreshold);
    const topScore = scores.length > 0 ? Math.max(...scores.map((s: any) => s.composite_score ?? 0)) : 0;
    if (scores.length === 0) {
      blocks.push({ reason: 'AI 스코어 없음', detail: 'Track A 미실행 or 캐시 만료 — 기술적 지표 fallback 사용 중', severity: 'info' });
    } else if (candidates.length === 0) {
      blocks.push({ reason: `매수 후보 없음 (최고 ${topScore}점)`, detail: `현재 임계치 ${buyThreshold}점 — 모든 감시 종목 점수 미달`, severity: 'warn' });
    }

    if (recentLossCodes.size > 0) {
      const watchCodes = new Set(watchlist.map((w: any) => w.stock_code));
      const bannedInWatch = [...recentLossCodes].filter((c) => watchCodes.has(c));
      if (bannedInWatch.length > 0) {
        blocks.push({ reason: `손실 밴 ${bannedInWatch.length}종목`, detail: `7일 내 손절 ${bannedInWatch.length}종목 재진입 금지: ${bannedInWatch.slice(0, 3).join(', ')}`, severity: 'info' });
      }
    }

    if (watchlist.length < 3) {
      blocks.push({ reason: '감시목록 부족', detail: `현재 ${watchlist.length}종목 — 3종목 이상 권장`, severity: 'warn' });
    }

    const hasHardBlock = blocks.some(b => b.severity === 'warn' && (
      b.reason.includes('긴급정지') || b.reason.includes('방어 파킹') || b.reason.includes('후보 없음') || b.reason.includes('DEFENSE')
    ));
    const overallStatus: 'ACTIVE' | 'WATCHING' | 'BLOCKED' = killSwitch.active || defensePark.isActive
      ? 'BLOCKED'
      : hasHardBlock
        ? 'WATCHING'
        : 'ACTIVE';

    const aiEngineStatus = getAiStatus();
    const geminiBlocked = aiEngineStatus.gemini === 'quota' || aiEngineStatus.gemini === 'error';
    const claudeBlocked = aiEngineStatus.claude === 'no_credit' || aiEngineStatus.claude === 'error';
    if (geminiBlocked && claudeBlocked) {
      blocks.push({ reason: 'AI 엔진 전체 실패', detail: '기술적 지표 fallback으로 자동 매매 계속 진행 중 — AI 점수 기반 필터만 비활성 (30분 후 자동 재시도)', severity: 'info' });
    } else if (geminiBlocked) {
      blocks.push({ reason: 'Gemini 오류/한도', detail: `${aiEngineStatus.gemini === 'quota' ? '무료 할당량 초과' : '연결 오류'} — 30분 후 자동 재시도`, severity: 'info' });
    }

    return c.json({
      overallStatus,
      mode,
      buyThreshold,
      marketOpen,
      topScore,
      candidateCount: candidates.length,
      watchlistCount: watchlist.length,
      lossBlockedCount: recentLossCodes.size,
      aiEngine: { claude: aiEngineStatus.claude, gemini: aiEngineStatus.gemini, active: aiEngineStatus.activeEngine },
      blocks,
    });
  } catch (err) {
    return c.json({ overallStatus: 'UNKNOWN', blocks: [], error: String(err) });
  }
});

// ── AI 엔진 상태 ──
dashboardAnalysisRoutes.get('/ai-status', (c) => {
  return c.json(getAiStatus());
});

// ── Vertex AI 직접 연결 테스트 ──
dashboardAnalysisRoutes.get('/ai/gemini-test', async (c) => {
  const start = Date.now();
  const TEST_MODEL = 'gemini-2.0-flash (Vertex AI)';
  try {
    const { callVertexGemini: callTest } = await import('../../utils/vertex-gemini.js');
    const text = await Promise.race([
      callTest('You are a test assistant.', 'Reply with exactly one word: OK'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout_10s')), 10000)),
    ]);
    const latencyMs = Date.now() - start;
    return c.json({ ok: !!text, latencyMs, model: TEST_MODEL, error: null, errorDetail: null, rawError: '', response: text?.slice(0, 50) });
  } catch (err) {
    const errStr = String(err);
    const latencyMs = Date.now() - start;
    let error = 'unknown';
    let errorDetail = '원인 불명 — 로그를 확인하세요';
    const rawError = errStr.slice(0, 300);

    if (errStr.includes('timeout')) { error = 'timeout'; errorDetail = '10초 내 응답 없음 — Cloud Run 네트워크 또는 Gemini 서버 과부하'; }
    else if (errStr.includes('429') || errStr.includes('quota') || errStr.includes('RESOURCE_EXHAUSTED') || errStr.includes('Resource has been exhausted')) {
      error = 'quota'; errorDetail = '무료 할당량 초과 (429) — Google AI Studio에서 사용량 확인 후 내일 재시도';
    }
    else if ((errStr.includes('400') && (errStr.includes('API key') || errStr.includes('API_KEY'))) || errStr.includes('INVALID_ARGUMENT')) {
      error = 'invalid_key'; errorDetail = 'API 키가 유효하지 않습니다 — 설정에서 키를 재발급하세요';
    }
    else if (errStr.includes('404') || errStr.includes('NOT_FOUND')) { error = 'model_not_found'; errorDetail = `모델 없음 (404) — ${TEST_MODEL} 접근 불가`; }
    else if (errStr.includes('403') || errStr.includes('PERMISSION_DENIED')) { error = 'permission'; errorDetail = '접근 권한 없음 (403) — API 키 허용 범위 확인 필요'; }
    else if (errStr.includes('503') || errStr.includes('UNAVAILABLE')) { error = 'unavailable'; errorDetail = 'Gemini 서비스 일시 불가 (503) — 잠시 후 재시도'; }

    logger.warn('Gemini 연결 테스트 실패', { error, rawError, component: 'GEMINI_TEST' });
    return c.json({ ok: false, latencyMs, model: TEST_MODEL, error, errorDetail, rawError });
  }
});

// ── 시스템 로그 ──
dashboardAnalysisRoutes.get('/logs', async (c) => {
  const limit = Math.min(Math.max(1, Number(c.req.query('limit') ?? 100)), 500);
  const component = c.req.query('component');

  try {
    let sql = 'SELECT * FROM system_log';
    const params: any[] = [];

    if (component) {
      sql += ' WHERE component = $1';
      params.push(component);
    }

    sql += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const { rows } = await getPool().query(sql, params);
    return c.json(rows);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 최근 7일 전략 모드 전환 이력 ──
dashboardAnalysisRoutes.get('/strategy/history', async (c) => {
  try {
    const { rows } = await getPool().query(
      `SELECT timestamp AS created_at, message
         FROM system_log
        WHERE component = 'REGIME'
          AND level = 'WARN'
          AND message LIKE '전략 자동 전환%'
          AND timestamp >= NOW() - INTERVAL '7 days'
        ORDER BY timestamp DESC
        LIMIT 20`,
    );
    const events = rows.map((r: any) => {
      const m = String(r.message).match(/전략 자동 전환: (\w+) → (\w+)/);
      return { ts: r.created_at, from: m?.[1] ?? '', to: m?.[2] ?? '', message: r.message };
    });
    return c.json(events);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 종목 5일 스코어 이력 (스파크라인용) ──
dashboardAnalysisRoutes.get('/stock/:code/score-history', async (c) => {
  try {
    const code = c.req.param('code');
    const { rows } = await getPool().query(
      `SELECT composite_score, created_at
         FROM ai_scores
        WHERE stock_code = $1
          AND created_at >= NOW() - INTERVAL '7 days'
        ORDER BY created_at ASC
        LIMIT 10`,
      [code],
    );
    return c.json(rows.map((r: any) => ({ score: Number(r.composite_score), ts: r.created_at })));
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 종목 AI 점수 세부 분해 (투명성 패널) ──
dashboardAnalysisRoutes.get('/stock/:code/score-detail', async (c) => {
  try {
    const code = c.req.param('code');
    const { rows } = await getPool().query(
      `SELECT composite_score, fundamental_score, technical_score, sentiment_score, gemini_summary, created_at
         FROM ai_scores
        WHERE stock_code = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [code],
    );
    if (rows.length === 0) return c.json(null);
    const r = rows[0];
    return c.json({
      composite: Number(r.composite_score),
      fundamental: Number(r.fundamental_score),
      technical: Number(r.technical_score),
      sentiment: Number(r.sentiment_score),
      summary: (() => {
        const gs = r.gemini_summary;
        if (!gs) return null;
        const obj = typeof gs === 'string' ? (() => { try { return JSON.parse(gs); } catch { return null; } })() : gs;
        if (obj?.key_facts?.length > 0) return (obj.key_facts as string[]).slice(0, 3).join(' · ');
        if (typeof gs === 'string') return gs.slice(0, 200);
        return null;
      })(),
      updatedAt: r.created_at,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── Track B 즉시 수동 실행 ──
dashboardAnalysisRoutes.post('/run-track-b', async (c) => {
  try {
    const { runTrackBJob } = await import('../../scheduler/track-b-job.js');
    runTrackBJob().catch((e: Error) => logger.error(`수동 Track B 실패: ${e.message}`, { component: 'MANUAL' }));
    logger.info('수동 Track B 실행 요청됨', { component: 'MANUAL' });
    return c.json({ ok: true, message: 'Track B 실행 시작됨 (10~30초 소요)' });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── Track A 즉시 수동 실행 (AI 점수 강제 갱신) ──
dashboardAnalysisRoutes.post('/run-track-a', async (c) => {
  try {
    const { runTrackAJob } = await import('../../scheduler/track-a-job.js');
    runTrackAJob().catch((e: Error) => logger.error(`수동 Track A 실패: ${e.message}`, { component: 'MANUAL' }));
    logger.info('수동 Track A 실행 요청됨', { component: 'MANUAL' });
    return c.json({ ok: true, message: 'Track A 실행 시작됨 (2~5분 소요)' });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 방어 파킹 수동 강제 해제 + KODEX 200 즉시 시장가 매도 ──
dashboardAnalysisRoutes.post('/release-defense-park', async (c) => {
  try {
    const { deactivateDefensePark } = await import('../../ai/track-b/defense-park.js');
    const { getPositionForStock } = await import('../../kis/account.js');
    const { placeOrder } = await import('../../kis/order.js');

    await deactivateDefensePark('CEO 수동 해제');
    logger.info('방어 파킹 수동 강제 해제됨', { component: 'MANUAL' });

    const position = await getPositionForStock('069500');
    let sellMsg = '';
    if (position && position.quantity > 0) {
      const result = await placeOrder({ stockCode: '069500', side: 'SELL', quantity: position.quantity });
      logger.info(`🛡️ KODEX 200 즉시 매도: ${position.quantity}주 → ${result.success ? '성공' : '실패'} (${result.message})`, { component: 'MANUAL' });
      sellMsg = `KODEX 200 ${position.quantity}주 매도 완료. `;
    }

    let syncMsg = '';
    try {
      const balanceFn = config.isPaper ? getPaperBalance : getAccountBalance;
      const [balance, openChains] = await Promise.all([balanceFn(), getOpenChains()]);
      const PARK_SET = new Set(IDLE_PARK_CODES as readonly string[]);
      const chainedCodes = new Set(openChains.map((ch: any) => ch.stock_code));
      const orphans = (balance.positions ?? [])
        .map((p: any) => ({
          stockCode: String(p.stockCode ?? ''),
          quantity: Number(p.quantity ?? p.holdingQuantity ?? 0),
          avgBuyPrice: Number(p.avgBuyPrice ?? p.purchasePrice ?? 0),
          stockName: p.stockName ?? undefined,
        }))
        .filter((p) => p.stockCode.length === 6 && p.quantity > 0 && p.avgBuyPrice > 0 && !PARK_SET.has(p.stockCode) && !chainedCodes.has(p.stockCode));

      if (orphans.length > 0) {
        const { createChain, insertOrder } = await import('../../db/client.js');
        const synced: string[] = [];
        for (const pos of orphans) {
          try {
            const knownName = getKnownStockName(pos.stockCode) ?? pos.stockName ?? pos.stockCode;
            await getPool().query(
              `INSERT INTO watchlist (stock_code, stock_name, market, source) VALUES ($1, $2, 'KOSPI', 'KIS_SYNC') ON CONFLICT (stock_code) DO NOTHING`,
              [pos.stockCode, knownName],
            );
            const chainId = await createChain({
              stock_code: pos.stockCode, status: 'OPEN', strategy_mode: 'SWING',
              avg_buy_price: pos.avgBuyPrice, total_quantity: pos.quantity,
              total_invested: pos.avgBuyPrice * pos.quantity, realized_pnl: 0,
              target_profit_pct: 2.5, stop_loss_pct: -1.5, max_averaging_count: 1, current_averaging_count: 0,
            });
            await insertOrder({
              chain_id: chainId, stock_code: pos.stockCode, side: 'BUY', order_type: '01',
              quantity: pos.quantity, price: pos.avgBuyPrice, kis_order_no: `SYNC_${pos.stockCode}`,
              kis_status: null, filled_quantity: pos.quantity, filled_price: pos.avgBuyPrice,
              status: 'FILLED', trading_mode: config.tradingMode, trigger_source: 'SYNC',
              ai_reasoning: 'KIS 잔고 동기화 — 파킹 해제 시 자동 복구',
            });
            synced.push(pos.stockCode);
          } catch { /* skip individual failure */ }
        }
        syncMsg = `보유종목 ${synced.length}개 대시보드 복구 완료.`;
        logger.info(`🔄 파킹 해제 후 포지션 자동 복구: ${synced.join(', ')}`, { component: 'MANUAL' });
      }
    } catch (syncErr: any) {
      logger.warn(`포지션 자동 복구 실패: ${syncErr.message}`, { component: 'MANUAL' });
    }

    return c.json({ ok: true, message: `파킹 해제 완료. ${sellMsg}${syncMsg}자동매매 재개`.trim() });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 수익 통계 (누적 총수익 + 월별 분해) ──
dashboardAnalysisRoutes.get('/profit-stats', async (c) => {
  try {
    const market = (c.req.query('market') ?? 'KR') as 'KR' | 'US';
    const isKr = market === 'KR';
    const pool = getPool();

    const codeFilter = isKr
      ? `AND tc.stock_code ~ '^[0-9]{6}$'`
      : `AND tc.stock_code !~ '^[0-9]{6}$'`;

    const { rows: monthly } = await pool.query(`
      SELECT
        to_char(closed_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM') AS month,
        SUM(realized_pnl) AS pnl,
        COUNT(*) AS trades
      FROM transaction_chains
      WHERE status = 'CLOSED'
        AND closed_at >= NOW() - INTERVAL '12 months'
        ${codeFilter}
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    const { rows: total } = await pool.query(`
      SELECT COALESCE(SUM(realized_pnl), 0) AS total_pnl
      FROM transaction_chains
      WHERE status = 'CLOSED'
        ${codeFilter}
    `);

    const { rows: thisMonth } = await pool.query(`
      SELECT COALESCE(SUM(realized_pnl), 0) AS pnl
      FROM transaction_chains
      WHERE status = 'CLOSED'
        AND closed_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Seoul')
        ${codeFilter}
    `);

    const dinnerMoney = market === 'KR' ? await getDinnerMoneyStats() : null;

    return c.json({
      market,
      totalCumulative: Number(total[0]?.total_pnl ?? 0),
      thisMonthPnl: Number(thisMonth[0]?.pnl ?? 0),
      monthly: monthly.map((r: any) => ({ month: r.month, pnl: Number(r.pnl ?? 0), trades: Number(r.trades ?? 0) })),
      dinnerMoney,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── KIS 잔고 → DB 포지션 동기화 (고아 포지션 복구) ──
dashboardAnalysisRoutes.post('/sync-positions', async (c) => {
  try {
    const balanceFn = config.isPaper ? getPaperBalance : getAccountBalance;
    const [balance, openChains] = await Promise.all([balanceFn(), getOpenChains()]);

    const kisPositions: Array<{ stockCode: string; quantity: number; avgBuyPrice: number; stockName?: string }> =
      (balance.positions ?? [])
        .filter((p: any) => Number(p.quantity ?? p.holdingQuantity ?? 0) > 0)
        .map((p: any) => ({
          stockCode: String(p.stockCode ?? ''),
          quantity: Number(p.quantity ?? p.holdingQuantity ?? 0),
          avgBuyPrice: Number(p.avgBuyPrice ?? p.purchasePrice ?? 0),
          stockName: p.stockName ?? undefined,
        }))
        .filter((p: any) => p.stockCode.length === 6 && p.quantity > 0 && p.avgBuyPrice > 0);

    const PARK_SET = new Set(IDLE_PARK_CODES as readonly string[]);
    const tradingPositions = kisPositions.filter((p) => !PARK_SET.has(p.stockCode));
    const chainedCodes = new Set(openChains.map((ch: any) => ch.stock_code));
    const orphans = tradingPositions.filter((p) => !chainedCodes.has(p.stockCode));

    if (orphans.length === 0) {
      return c.json({ ok: true, synced: 0, message: '동기화할 고아 포지션 없음 (이미 정상 상태)' });
    }

    const { createChain, insertOrder } = await import('../../db/client.js');
    const synced: string[] = [];

    for (const pos of orphans) {
      try {
        const knownName = getKnownStockName(pos.stockCode) ?? pos.stockName ?? pos.stockCode;
        await getPool().query(
          `INSERT INTO watchlist (stock_code, stock_name, market, source)
           VALUES ($1, $2, 'KOSPI', 'KIS_SYNC')
           ON CONFLICT (stock_code) DO NOTHING`,
          [pos.stockCode, knownName],
        );

        const chainId = await createChain({
          stock_code: pos.stockCode, status: 'OPEN', strategy_mode: 'SWING',
          avg_buy_price: pos.avgBuyPrice, total_quantity: pos.quantity,
          total_invested: pos.avgBuyPrice * pos.quantity, realized_pnl: 0,
          target_profit_pct: 2.5, stop_loss_pct: -1.5, max_averaging_count: 1, current_averaging_count: 0,
        });

        await insertOrder({
          chain_id: chainId, stock_code: pos.stockCode, side: 'BUY', order_type: '01',
          quantity: pos.quantity, price: pos.avgBuyPrice, kis_order_no: `SYNC_${pos.stockCode}`,
          kis_status: null, filled_quantity: pos.quantity, filled_price: pos.avgBuyPrice,
          status: 'FILLED', trading_mode: config.tradingMode, trigger_source: 'SYNC',
          ai_reasoning: 'KIS 잔고 동기화 — 기존 보유 포지션 복구',
        });

        synced.push(pos.stockCode);
        logger.info(`🔄 포지션 동기화: ${pos.stockCode} ${pos.quantity}주 @ ${pos.avgBuyPrice.toLocaleString()}원`, { component: 'SYNC' });
      } catch (innerErr: any) {
        logger.error(`포지션 동기화 실패 (${pos.stockCode}): ${innerErr.message}`, { component: 'SYNC' });
      }
    }

    return c.json({
      ok: true,
      synced: synced.length,
      codes: synced,
      message: `${synced.length}종목 복구 완료 — 다음 Track B 실행부터 손절/익절 자동 적용`,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// suppress unused import warning
void isInvalidStockName;
