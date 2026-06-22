/**
 * AI Loop API — Claude Code/Cursor AI가 매매를 지능적으로 조절하는 엔드포인트
 *
 * 핵심: 구독형 AI(Opus급 추론)를 API 토큰 비용 없이 활용.
 * Claude Code 터미널에서 주기적으로 snapshot → 분석 → command 사이클 실행.
 *
 * 안전 설계:
 * - 모든 오버라이드에 TTL (자동 만료)
 * - 값 범위 검증 (bounded)
 * - paper/live 모드 완전 격리
 * - 감사 로그 (ai_command_log)
 * - Kill switch 오버라이드 차단
 */
import { Hono } from 'hono';
import {
  type AiCommand,
  getAllOverrides,
  getCommandHistory,
  type OverrideCategory,
  removeOverride,
  setOverride,
} from '../../ai/ai-overrides.js';
import { getCtxIsPaper } from '../../config/context.js';
import { getActiveWatchlist, getLatestScores, getOpenChains, getPool } from '../../db/client.js';
import { getAccountBalance } from '../../kis/account.js';
import { getMarketSentiment } from '../../market/consensus.js';
import { isKillSwitchActive } from '../../risk/kill-switch.js';
import { getPaperBalance } from '../../risk/paper-balance.js';
import { computePaperCash } from '../../scheduler/overseas/state.js';
import { logger } from '../../utils/logger.js';
import { getFxRate } from './dashboard/helpers.js';

export const aiLoopRoutes = new Hono();

// ── GET /api/ai-loop/snapshot — 전체 트레이딩 상태 스냅샷 ─────────────
// Claude Code가 이 데이터를 읽고 Opus급 추론으로 분석
aiLoopRoutes.get('/ai-loop/snapshot', async (c) => {
  const isPaper = getCtxIsPaper();
  const mode = isPaper ? 'paper' : 'live';

  try {
    // 병렬로 모든 데이터 수집
    const [
      chains,
      watchlist,
      overrides,
      balance,
      overseasResult,
      winRateResult,
      recentTradesResult,
      consensusSentiment,
    ] = await Promise.all([
      getOpenChains(isPaper),
      getActiveWatchlist(),
      getAllOverrides(isPaper),
      isPaper ? getPaperBalance() : getAccountBalance(true).catch(() => null),
      getPool()
        .query(
          'SELECT stock_code, exchange, quantity, avg_price FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1',
          [isPaper],
        )
        .catch(() => ({ rows: [] })),
      getPool()
        .query(
          `
        SELECT stock_code,
               COUNT(*) FILTER (WHERE pnl_pct > 0) AS wins,
               COUNT(*) FILTER (WHERE pnl_pct <= 0) AS losses,
               ROUND(AVG(pnl_pct)::numeric, 2) AS avg_pnl,
               COUNT(*) AS total
        FROM transaction_chains
        WHERE status = 'CLOSED' AND is_paper = $1
          AND closed_at > NOW() - INTERVAL '90 days'
        GROUP BY stock_code
        ORDER BY total DESC LIMIT 30
      `,
          [isPaper],
        )
        .catch(() => ({ rows: [] })),
      getPool()
        .query(
          `
        SELECT stock_code, stock_name, strategy_mode, pnl_pct, trigger_source,
               opened_at, closed_at
        FROM transaction_chains
        WHERE status = 'CLOSED' AND is_paper = $1
          AND closed_at > NOW() - INTERVAL '7 days'
        ORDER BY closed_at DESC LIMIT 20
      `,
          [isPaper],
        )
        .catch(() => ({ rows: [] })),
      Promise.resolve(getMarketSentiment()),
    ]);

    // AI 점수 + KOSPI 레짐 + 전체 수익률 병렬 로드
    const codes = watchlist.map((w) => w.stock_code);
    const [scores, regimeResult, overallStats] = await Promise.all([
      codes.length > 0 ? getLatestScores(codes) : Promise.resolve([]),
      getPool()
        .query(
          `SELECT kospi_level, kospi_change_pct, memo FROM system_log
         WHERE component = 'MARKET_REGIME' ORDER BY created_at DESC LIMIT 1`,
        )
        .catch(() => ({ rows: [] })),
      getPool()
        .query(
          `
        SELECT
          COUNT(*) AS total_trades,
          COUNT(*) FILTER (WHERE pnl_pct > 0) AS total_wins,
          ROUND(AVG(pnl_pct)::numeric, 2) AS avg_pnl,
          ROUND(SUM(CASE WHEN pnl_pct > 0 THEN pnl_pct ELSE 0 END)::numeric, 2) AS total_profit_pct,
          ROUND(SUM(CASE WHEN pnl_pct < 0 THEN pnl_pct ELSE 0 END)::numeric, 2) AS total_loss_pct
        FROM transaction_chains
        WHERE status = 'CLOSED' AND is_paper = $1
          AND closed_at > NOW() - INTERVAL '30 days'
      `,
          [isPaper],
        )
        .catch(() => ({ rows: [{}] })),
    ]);

    // 국내 포지션 요약
    const positions = chains.map((ch) => {
      const c = ch as Record<string, unknown>;
      return {
        stockCode: ch.stock_code,
        stockName: c.stock_name ?? ch.stock_code,
        quantity: ch.total_quantity,
        avgBuyPrice: ch.avg_buy_price,
        strategy: ch.strategy_mode,
        openedAt: ch.opened_at,
        peakPrice: ch.peak_price_since_open ?? 0,
        triggerSource: c.trigger_source ?? null,
      };
    });

    // 해외 포지션 + 투자금 합산
    let overseasInvestedUsd = 0;
    const overseasPositions = overseasResult.rows.map((r: Record<string, unknown>) => {
      const qty = Number(r.quantity);
      const avg = Number(r.avg_price);
      overseasInvestedUsd += qty * avg;
      return { stockCode: r.stock_code, exchange: r.exchange, quantity: qty, avgPrice: avg };
    });

    // 해외 현금 + 환율 → 통합증거금 계산
    let overseasCashKrw = 0;
    const { FALLBACK_FX_RATE } = await import('../../config/constants.js');
    let FX_RATE = await getFxRate().catch(() => FALLBACK_FX_RATE);
    if (FX_RATE <= 0) FX_RATE = FALLBACK_FX_RATE;
    if (isPaper) {
      const usdCash = await computePaperCash().catch(() => 0);
      overseasCashKrw = usdCash * FX_RATE;
    } else {
      const { rows: osCashRows } = await getPool()
        .query(`SELECT value FROM overseas_state WHERE key = 'cash'`)
        .catch(() => ({ rows: [] }));
      overseasCashKrw = osCashRows.length > 0 ? Number(osCashRows[0].value) * FX_RATE : 0;
    }
    const overseasInvestedKrw = overseasInvestedUsd * FX_RATE;

    // 승률 요약
    const winRateStats = winRateResult.rows.map((r: Record<string, unknown>) => ({
      stockCode: r.stock_code,
      wins: Number(r.wins),
      losses: Number(r.losses),
      avgPnl: Number(r.avg_pnl),
      total: Number(r.total),
      winRate: Number(r.total) > 0 ? Math.round((Number(r.wins) / Number(r.total)) * 100) : 0,
    }));

    // 최근 거래
    const recentTrades = recentTradesResult.rows.map((r: Record<string, unknown>) => ({
      stockCode: r.stock_code,
      stockName: r.stock_name,
      strategy: r.strategy_mode,
      pnlPct: Number(r.pnl_pct),
      trigger: r.trigger_source,
      closedAt: r.closed_at,
    }));

    const stats = (overallStats.rows[0] as Record<string, unknown>) ?? {};

    const snapshot = {
      mode,
      timestamp: new Date().toISOString(),
      killSwitch: {
        kr: isKillSwitchActive('KR'),
        overseas: isKillSwitchActive('OVERSEAS'),
      },
      eodOnlyMode: await (async () => {
        try {
          const { isEodOnlyMode } = await import('../../risk/trade-gate-stats.js');
          return await isEodOnlyMode();
        } catch {
          return false;
        }
      })(),
      balance: balance
        ? (() => {
            const domCash = balance.orderableCash || 0;
            const domInvested = balance.purchaseCost || balance.totalEvalAmount || 0;
            const unifiedCash = Math.round(domCash + overseasCashKrw);
            const totalInvested = Math.round(domInvested + overseasInvestedKrw);
            return {
              totalAsset: Math.round(unifiedCash + domInvested + overseasInvestedKrw),
              cash: unifiedCash,
              invested: totalInvested,
              profitLoss: balance.totalProfitLoss || 0,
              // 디버그: 내역 분리
              _domestic: { cash: Math.round(domCash), invested: Math.round(domInvested) },
              _overseas: {
                cashKrw: Math.round(overseasCashKrw),
                investedKrw: Math.round(overseasInvestedKrw),
                fxRate: FX_RATE,
              },
            };
          })()
        : null,
      regime: regimeResult.rows[0] ?? null,
      consensus: consensusSentiment,
      positions,
      overseasPositions,
      scores: scores.slice(0, 30).map((s) => ({
        stockCode: s.stock_code,
        score: s.composite_score,
        confidence: s.confidence,
        signal: s.signal,
        reasoning: s.reasoning?.slice(0, 200),
      })),
      performance: {
        last30d: {
          totalTrades: Number(stats.total_trades ?? 0),
          wins: Number(stats.total_wins ?? 0),
          winRate:
            Number(stats.total_trades) > 0
              ? Math.round((Number(stats.total_wins) / Number(stats.total_trades)) * 100)
              : 0,
          avgPnl: Number(stats.avg_pnl ?? 0),
          totalProfitPct: Number(stats.total_profit_pct ?? 0),
          totalLossPct: Number(stats.total_loss_pct ?? 0),
        },
        perStock: winRateStats,
      },
      recentTrades,
      activeOverrides: overrides,
      // AI에게 제공하는 사용 가능한 명령 가이드
      availableCommands: {
        setOverride: {
          categories: ['stock', 'risk', 'threshold', 'signal'],
          examples: [
            { key: '005930_scoreAdj', value: 5, category: 'stock', reason: 'Samsung 실적 호조 예상', ttlMinutes: 120 },
            {
              key: 'minBuyScore',
              value: 75,
              category: 'threshold',
              reason: '시장 변동성 증가, 기준 상향',
              ttlMinutes: 60,
            },
            { key: '005930_blacklist', value: true, category: 'stock', reason: '단기 과매수, RSI 78', ttlMinutes: 180 },
            {
              key: 'NVDA_forceHold',
              value: true,
              category: 'signal',
              reason: 'NVIDIA 실적 발표 대기',
              ttlMinutes: 240,
            },
            { key: 'maxPositionPct', value: 15, category: 'risk', reason: '보수적 포지션 축소', ttlMinutes: 120 },
            { key: '005930_trailTighten', value: 1.0, category: 'stock', reason: '수익 보호 강화', ttlMinutes: 60 },
          ],
          bounds: {
            scoreAdj: '-20 ~ +20',
            minBuyScore: '55 ~ 95',
            maxPositionPct: '5% ~ 25%',
            stopLossPct: '-10% ~ -1%',
            takeProfitPct: '2% ~ 15%',
            trailTighten: '0 ~ 3%',
          },
        },
      },
    };

    return c.json(snapshot);
  } catch (err) {
    logger.error(`AI Loop snapshot 실패: ${err}`, { component: 'AI_LOOP' });
    return c.json({ error: 'Snapshot 생성 실패' }, 500);
  }
});

// ── POST /api/ai-loop/command — AI 명령 수신 및 실행 ──────────────────
aiLoopRoutes.post('/ai-loop/command', async (c) => {
  const isPaper = getCtxIsPaper();

  let body: { commands: AiCommand[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.commands || !Array.isArray(body.commands)) {
    return c.json({ error: 'commands 배열이 필요합니다' }, 400);
  }

  if (body.commands.length > 20) {
    return c.json({ error: '한 번에 최대 20개 명령만 허용' }, 400);
  }

  const results: Array<{ key: string; ok: boolean; error?: string }> = [];

  for (const cmd of body.commands) {
    if (!cmd.key) {
      results.push({ key: '(missing)', ok: false, error: 'key 필수' });
      continue;
    }

    switch (cmd.type) {
      case 'setOverride': {
        if (cmd.value === undefined) {
          results.push({ key: cmd.key, ok: false, error: 'value 필수' });
          break;
        }
        const category = cmd.category ?? 'stock';
        const validCategories: OverrideCategory[] = ['stock', 'risk', 'threshold', 'signal'];
        if (!validCategories.includes(category)) {
          results.push({ key: cmd.key, ok: false, error: `invalid category: ${category}` });
          break;
        }
        const result = await setOverride(
          category,
          cmd.key,
          cmd.value,
          cmd.reason ?? null,
          cmd.ttlMinutes ?? 120,
          isPaper,
        );
        results.push({ key: cmd.key, ...result });
        break;
      }
      case 'removeOverride': {
        const result = await removeOverride(cmd.key, isPaper);
        results.push({ key: cmd.key, ...result });
        break;
      }
      default:
        results.push({ key: cmd.key, ok: false, error: `unknown type: ${cmd.type}` });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok).length;
  logger.info(`🤖 AI Loop 명령 처리: ${ok}건 성공, ${fail}건 실패`, { component: 'AI_LOOP' });

  return c.json({ processed: results.length, ok, fail, results });
});

// ── GET /api/ai-loop/overrides — 활성 오버라이드 목록 ─────────────────
aiLoopRoutes.get('/ai-loop/overrides', async (c) => {
  const isPaper = getCtxIsPaper();
  const overrides = await getAllOverrides(isPaper);
  return c.json({ mode: isPaper ? 'paper' : 'live', count: overrides.length, overrides });
});

// ── DELETE /api/ai-loop/overrides/:key — 특정 오버라이드 삭제 ─────────
aiLoopRoutes.delete('/ai-loop/overrides/:key', async (c) => {
  const key = c.req.param('key');
  const isPaper = getCtxIsPaper();
  const result = await removeOverride(key, isPaper);
  return c.json(result);
});

// ── GET /api/ai-loop/history — 명령 이력 ──────────────────────────────
aiLoopRoutes.get('/ai-loop/history', async (c) => {
  const rawLimit = Number(c.req.query('limit'));
  const limit = Math.min(100, Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50);
  const history = await getCommandHistory(limit);
  return c.json({ count: history.length, history });
});

// ── POST /api/ai-loop/clear — 모든 오버라이드 초기화 ──────────────────
aiLoopRoutes.post('/ai-loop/clear', async (c) => {
  const isPaper = getCtxIsPaper();
  try {
    const { rowCount } = await getPool().query('DELETE FROM ai_overrides WHERE is_paper = $1', [isPaper]);
    logger.info(`🤖 AI 오버라이드 전체 초기화: ${rowCount}건 삭제 (${isPaper ? 'paper' : 'live'})`, {
      component: 'AI_LOOP',
    });
    return c.json({ ok: true, deleted: rowCount });
  } catch (err) {
    return c.json({ ok: false, error: 'Internal server error' }, 500);
  }
});

// ── POST /api/ai-loop/autopilot — AutoPilot 즉시 실행 ────────────────
aiLoopRoutes.post('/ai-loop/autopilot', async (c) => {
  const isPaper = getCtxIsPaper();
  try {
    const { runAutoPilot } = await import('../../ai/auto-pilot.js');
    const result = await runAutoPilot(isPaper);
    return c.json(result);
  } catch (err) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════
//  판단 큐 (Decision Queue) — 서버가 감지, AI가 판단
// ═══════════════════════════════════════════════════════════════

// ── GET /api/ai-loop/pending — 대기 중인 판단 요청 조회 ───────────────
aiLoopRoutes.get('/ai-loop/pending', async (c) => {
  const isPaper = getCtxIsPaper();
  try {
    const { rows } = await getPool().query(
      `SELECT id, situation, category, stock_code, context, urgency, created_at, expires_at
       FROM pending_decisions
       WHERE status = 'PENDING' AND is_paper = $1
       ORDER BY urgency ASC, created_at ASC`,
      [isPaper],
    );
    return c.json({
      mode: isPaper ? 'paper' : 'live',
      pending: rows.length,
      decisions: rows,
    });
  } catch (err) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── POST /api/ai-loop/decide — AI의 판단 결과 제출 ────────────────────
// Claude Code가 pending을 분석한 후 결정을 제출
aiLoopRoutes.post('/ai-loop/decide', async (c) => {
  const isPaper = getCtxIsPaper();
  let body: {
    decisions: Array<{
      id: number;
      action: string;
      reason: string;
      commands?: Array<{ type: string; category?: string; key: string; value?: unknown; ttlMinutes?: number }>;
    }>;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.decisions || !Array.isArray(body.decisions)) {
    return c.json({ error: 'decisions 배열 필요' }, 400);
  }

  const results: Array<{ id: number; ok: boolean; commandsApplied?: number }> = [];

  for (const dec of body.decisions) {
    if (!dec.id || !dec.action || !dec.reason) {
      results.push({ id: dec.id ?? 0, ok: false });
      continue;
    }

    // 판단 결과 저장
    await getPool().query(
      `UPDATE pending_decisions
       SET status = 'DECIDED', decision = $1, decided_at = NOW()
       WHERE id = $2 AND status = 'PENDING' AND is_paper = $3`,
      [JSON.stringify({ action: dec.action, reason: dec.reason }), dec.id, isPaper],
    );

    // 판단에 따른 명령 자동 실행
    let applied = 0;
    if (dec.commands && Array.isArray(dec.commands)) {
      for (const cmd of dec.commands) {
        if (cmd.type === 'setOverride' && cmd.key && cmd.value !== undefined) {
          const res = await setOverride(
            (cmd.category as OverrideCategory) ?? 'stock',
            cmd.key,
            cmd.value,
            `[AI Decision #${dec.id}] ${dec.reason}`,
            cmd.ttlMinutes ?? 120,
            isPaper,
          );
          if (res.ok) applied++;
        } else if (cmd.type === 'removeOverride' && cmd.key) {
          await removeOverride(cmd.key, isPaper);
          applied++;
        }
      }
    }

    results.push({ id: dec.id, ok: true, commandsApplied: applied });
    logger.info(`🧠 판단 완료 #${dec.id}: ${dec.action} — ${dec.reason} (${applied}건 명령 적용)`, {
      component: 'AI_LOOP',
    });
  }

  return c.json({ processed: results.length, results });
});

// ── GET /api/ai-loop/queue-stats — 큐 통계 ───────────────────────────
aiLoopRoutes.get('/ai-loop/queue-stats', async (c) => {
  try {
    const { rows } = await getPool().query(`
      SELECT status, COUNT(*) AS cnt,
             COUNT(*) FILTER (WHERE urgency = 1) AS urgent
      FROM pending_decisions
      WHERE created_at > NOW() - INTERVAL '24 hours'
        AND is_paper = $1
      GROUP BY status
    `, [getCtxIsPaper()]);
    const stats: Record<string, { count: number; urgent: number }> = {};
    for (const r of rows) {
      stats[r.status as string] = { count: Number(r.cnt), urgent: Number(r.urgent) };
    }
    return c.json(stats);
  } catch (err) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── GET /api/ai-loop/scores/history — AI 점수 시계열 (UI 그래프용) ──
aiLoopRoutes.get('/ai-loop/scores/history', async (c) => {
  try {
    const code = c.req.query('stock_code') ?? '';
    const rawHours = Number(c.req.query('hours') ?? 24);
    const hours = Math.min(168, Math.max(1, Number.isFinite(rawHours) ? rawHours : 24));
    const rawLimitVal = Number(c.req.query('limit') ?? 100);
    const limit = Math.min(500, Math.max(10, Number.isFinite(rawLimitVal) ? rawLimitVal : 100));
    if (!code) return c.json({ error: 'stock_code required' }, 400);

    const { rows } = await getPool().query(
      `SELECT composite_score, technical_score, sentiment_score, source, delta_from_prev, recorded_at
       FROM ai_scores_history
       WHERE stock_code = $1
         AND recorded_at > NOW() - ($2 || ' hours')::interval
       ORDER BY recorded_at ASC LIMIT $3`,
      [code, hours, limit],
    );

    // 마지막 갱신 시각 + 다음 갱신 예상 시각
    const { getKrMarketPhase } = await import('../../scheduler/loop-mode.js');
    const phase = getKrMarketPhase();
    const intervalMin =
      phase === 'GOLDEN_AM' || phase === 'GOLDEN_PM' ? 3 : phase === 'CURSED' ? 15 : 10;
    const lastRunAt = rows[rows.length - 1]?.recorded_at ?? null;
    const nextRunAt = lastRunAt
      ? new Date(new Date(lastRunAt).getTime() + intervalMin * 60_000).toISOString()
      : null;

    return c.json({
      stock_code: code,
      points: rows.map((r) => ({
        score: Number(r.composite_score),
        technical: Number(r.technical_score),
        sentiment: Number(r.sentiment_score),
        source: r.source,
        delta: r.delta_from_prev != null ? Number(r.delta_from_prev) : null,
        at: r.recorded_at,
      })),
      meta: {
        phase,
        intervalMin,
        lastRunAt,
        nextRunAt,
      },
    });
  } catch (err) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── GET /api/ai-loop/scores/refresh-status — 다음 갱신 카운트다운 ──
aiLoopRoutes.get('/ai-loop/scores/refresh-status', async (c) => {
  try {
    const { rows } = await getPool().query(
      `SELECT value FROM system_state WHERE key = 'quick_rescore_last_run' LIMIT 1`,
    );
    const data = rows[0]?.value;
    const lastRun =
      data != null
        ? typeof data === 'string'
          ? JSON.parse(data)
          : data
        : null;
    const { getKrMarketPhase } = await import('../../scheduler/loop-mode.js');
    const phase = getKrMarketPhase();
    const intervalMin =
      phase === 'GOLDEN_AM' || phase === 'GOLDEN_PM' ? 3 : phase === 'CURSED' ? 15 : 10;
    const lastAt = lastRun?.at ?? null;
    const nextAt = lastAt
      ? new Date(new Date(lastAt).getTime() + intervalMin * 60_000).toISOString()
      : null;
    const secondsToNext = nextAt ? Math.max(0, Math.floor((new Date(nextAt).getTime() - Date.now()) / 1000)) : null;
    return c.json({
      phase,
      intervalMin,
      lastRunAt: lastAt,
      nextRunAt: nextAt,
      secondsToNext,
      scored: lastRun?.scored ?? 0,
      elapsedSec: lastRun?.elapsedSec ?? null,
    });
  } catch (err) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── GET /api/loop/sessions — 루프 세션 히스토리 + 메트릭 ──
// 강화 #1: 세션별 매수/매도/PnL/에러/킬스위치 정지 횟수 등 노출
aiLoopRoutes.get('/loop/sessions', async (c) => {
  try {
    const rawSessionLimit = Number(c.req.query('limit') ?? 20);
    const sessionLimit = Math.min(100, Math.max(1, Number.isFinite(rawSessionLimit) ? rawSessionLimit : 20));
    const { getLoopSessionsHistory, getLoopStatus } = await import('../../scheduler/loop-mode.js');
    const [history, currentStatus] = await Promise.all([getLoopSessionsHistory(sessionLimit), Promise.resolve(getLoopStatus())]);
    const cur = currentStatus as Record<string, unknown>;
    return c.json({
      current: {
        active: cur.active,
        phase: cur.phase,
        totalRuns: cur.totalRuns,
        buyCount: cur.buyCount,
        sellCount: cur.sellCount,
        realizedPnlKrw: Math.round(Number(cur.realizedPnlKrw ?? 0)),
        recoveryAttempts: cur.recoveryAttempts,
        killSwitchPauses: cur.killSwitchPauses,
        pausedReason: cur.pausedReason,
        adaptiveIntervalMs: cur.adaptiveIntervalMs,
      },
      history,
    });
  } catch (err) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});
