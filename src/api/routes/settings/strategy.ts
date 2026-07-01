import { Hono } from 'hono';
import { invalidateDashboardCache } from '../../../cache/dashboard-cache.js';
import { STRATEGY_PARAMS } from '../../../config/constants.js';
import { getActiveStrategy, getPool, isMemoryMode, logSystem } from '../../../db/client.js';
import { memSetActiveStrategy } from '../../../db/memory-store.js';
import { logger } from '../../../utils/logger.js';
import { resolveRequestMode } from '../../guards/live-pin.js';

export const strategyRoutes = new Hono();

// ── 전략 설정 (CEO 프롬프트 관리) ──
strategyRoutes.get('/strategy', async (c) => {
  const strategy = await getActiveStrategy();
  return c.json(strategy ?? { mode: 'SWING', message: '설정 없음' });
});

strategyRoutes.put('/strategy', async (c) => {
  const body = await c.req.json();

  const rawMode = (body.mode ?? 'SWING') as keyof typeof STRATEGY_PARAMS;
  // Live: SCALPING/EOD_BETTING/DIVIDEND 차단 (안정성)
  // Paper: SCALPING/EOD_BETTING 허용 (튜닝용), DIVIDEND 제거
  const isPaperReq = resolveRequestMode(c);
  const LIVE_BLOCKED = new Set(['SCALPING', 'EOD_BETTING', 'DIVIDEND']);
  const PAPER_BLOCKED = new Set(['DIVIDEND']);
  const blockedSet = isPaperReq ? PAPER_BLOCKED : LIVE_BLOCKED;
  const requestedMode = blockedSet.has(rawMode) ? 'SWING' : rawMode;
  const modeBase = STRATEGY_PARAMS[requestedMode] ?? STRATEGY_PARAMS.SWING;
  // 강제 ON: AI 자동 관리 — UI에서 변경 불가
  const useDynamic: boolean = true;
  const aiScoringMode: 'fallback' | 'ensemble' = 'ensemble';
  const ensembleConfig = body.ensemble_config ?? null; // JSONB — null이면 DB 기본값 유지
  const strategyData = {
    mode: requestedMode,
    notebooklm_prompt: body.notebooklm_prompt ?? '',
    gemini_prompt: body.gemini_prompt ?? '',
    gpt_prompt: body.gpt_prompt ?? '',
    claude_prompt: body.claude_prompt ?? '',
    // UI 입력값 허용 (최소 50, 최대 99) — NaN 가드: 비숫자 입력 시 기본값 사용
    buy_threshold: (() => { const v = Number(body.buy_threshold); return body.buy_threshold != null && Number.isFinite(v) ? Math.max(Math.min(v, 99), 50) : modeBase.buyThreshold; })(),
    // CEO 직접 설정 허용 — 범위: -10% ~ -0.5% — NaN 가드
    stop_loss_pct: (() => { const v = Number(body.stop_loss_pct); return body.stop_loss_pct != null && Number.isFinite(v) ? Math.max(Math.min(v, -0.5), -10) : modeBase.stopLossPct; })(),
    // CEO 직접 설정 허용 — 범위: 1% ~ 30% — NaN 가드
    take_profit_pct: (() => { const v = Number(body.take_profit_pct); return body.take_profit_pct != null && Number.isFinite(v) ? Math.max(Math.min(v, 30), 1) : modeBase.takeProfitPct; })(),
    strategy_document: body.strategy_document ?? '',
    risk_prompt: body.risk_prompt ?? '',
    use_dynamic_tpsl: useDynamic,
    ai_scoring_mode: aiScoringMode,
    ensemble_config: ensembleConfig,
  };

  // 감사 로그: 변경 전 상태 스냅샷
  const prevStrategy = await getActiveStrategy().catch(() => null);

  // 인메모리 모드: DB 없이도 전략 변경 가능
  if (isMemoryMode()) {
    const updated = memSetActiveStrategy(strategyData);
    const diff = buildStrategyDiff(prevStrategy, strategyData);
    await logSystem('INFO', 'STRATEGY_AUDIT', `전략 변경: ${diff}`, { prev: prevStrategy, next: strategyData }).catch(
      () => {},
    );
    logger.info(`📋 전략 변경 감사: ${diff}`, { component: 'SETTINGS' });
    invalidateDashboardCache();
    return c.json(updated);
  }

  try {
    // ── 통합 설정: CEO 대시보드에서 변경 시 paper/live 모두 동일하게 적용 ──
    const isPaper = isPaperReq;
    const setParams = [
      strategyData.mode,
      strategyData.notebooklm_prompt,
      strategyData.gemini_prompt,
      strategyData.gpt_prompt,
      strategyData.claude_prompt,
      strategyData.buy_threshold,
      strategyData.stop_loss_pct,
      strategyData.take_profit_pct,
      strategyData.strategy_document,
      strategyData.risk_prompt,
      strategyData.use_dynamic_tpsl,
      strategyData.ai_scoring_mode,
      strategyData.ensemble_config ? JSON.stringify(strategyData.ensemble_config) : null,
    ];
    // ── 현재 모드: 전략 파라미터 + 프롬프트 모두 업데이트 ──
    const { rowCount } = await getPool().query(
      `UPDATE strategy_config
       SET mode=$1, notebooklm_prompt=$2, gemini_prompt=$3, gpt_prompt=$4, claude_prompt=$5,
           buy_threshold=$6, stop_loss_pct=$7, take_profit_pct=$8, strategy_document=$9, risk_prompt=$10,
           use_dynamic_tpsl=$11, ai_scoring_mode=$12,
           ensemble_config=COALESCE($13::jsonb, ensemble_config),
           updated_at=NOW()
       WHERE is_active = true AND is_paper = $14`,
      [...setParams, isPaper],
    );

    // ── 반대 모드: 프롬프트/참고소스만 동기화 (전략 파라미터는 모드별 독립) ──
    await getPool().query(
      `UPDATE strategy_config
       SET notebooklm_prompt=$1, gemini_prompt=$2, gpt_prompt=$3, claude_prompt=$4,
           strategy_document=$5, risk_prompt=$6, updated_at=NOW()
       WHERE is_active = true AND is_paper = $7`,
      [
        strategyData.notebooklm_prompt,
        strategyData.gemini_prompt,
        strategyData.gpt_prompt,
        strategyData.claude_prompt,
        strategyData.strategy_document,
        strategyData.risk_prompt,
        !isPaper,
      ],
    ).catch((e: any) => logger.warn(`반대 모드 프롬프트 동기화 실패: ${e.message}`, { component: 'SETTINGS' }));

    if ((rowCount ?? 0) === 0) {
      // 활성 전략이 없으면 현재 모드로 INSERT
      await getPool().query(
        `INSERT INTO strategy_config (mode, is_active, notebooklm_prompt, gemini_prompt, gpt_prompt, claude_prompt, buy_threshold, stop_loss_pct, take_profit_pct, strategy_document, risk_prompt, use_dynamic_tpsl, is_paper, ai_scoring_mode, ensemble_config)
         VALUES ($1, true, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14::jsonb, '{"weights":{"gemini":0.30,"gpt":0.35,"claude":0.20,"rss":0.15},"strategy":"weighted_avg","minModels":2}'::jsonb))`,
        [...setParams.slice(0, 11), isPaper, ...setParams.slice(11)],
      );
    }

    const { rows } = await getPool().query(
      `SELECT * FROM strategy_config WHERE is_active = true AND is_paper = $1 ORDER BY updated_at DESC LIMIT 1`,
      [isPaper],
    );
    const diff = buildStrategyDiff(prevStrategy, strategyData);
    await logSystem('INFO', 'STRATEGY_AUDIT', `전략 변경 (통합): ${diff}`, {
      prev: prevStrategy,
      next: strategyData,
    }).catch(() => {});
    logger.info(`📋 전략 변경 감사 (통합): ${diff}`, { component: 'SETTINGS' });
    invalidateDashboardCache();
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
strategyRoutes.get('/strategy/audit', async (c) => {
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
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/** 변경된 필드만 요약 문자열 반환 */
export function buildStrategyDiff(prev: Record<string, unknown> | null, next: Record<string, unknown>): string {
  if (!prev) return `신규 설정 (mode=${next.mode})`;
  const KEYS = ['mode', 'buy_threshold', 'stop_loss_pct', 'take_profit_pct', 'ai_scoring_mode'] as const;
  const changed = KEYS.filter((k) => String(prev[k] ?? '') !== String(next[k] ?? ''));
  if (changed.length === 0) return '프롬프트 텍스트만 변경';
  return changed.map((k) => `${k}: ${prev[k]} → ${next[k]}`).join(', ');
}
