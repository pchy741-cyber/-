import { getCtxIsPaper } from '../../config/context.js';
import { getPool, logSystem } from '../../db/client.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { sendPushNotification } from '../../notifications/web-push.js';
import { logger } from '../../utils/logger.js';

import {
  analyzeAveraging,
  analyzeConfidenceCorrelation,
  analyzeEarlyExitMissedProfit,
  analyzeHoldingPeriod,
  analyzeHoldingPeriodByEntry,
  analyzeHotStocks,
  analyzeLossStreakRisk,
  analyzeModePerformance,
  analyzeOptimalEntryWindows,
  analyzeProfitRatio,
  analyzeQuickProfitTaking,
  analyzeSniperByMarketRegime,
  analyzeSniperPerformance,
  analyzeStockPerformance,
  analyzeStockWinRateAcceleration,
  analyzeStrategyStrengths,
  analyzeWinRateTrend,
} from './analyzers.js';
import { analyzeBuyThreshold, calibrateScoreTierParams, validatePromotedInsights } from './calibration.js';
import { analyzeOverseasAll } from './overseas-analyzers.js';
import {
  analyzeDayOfWeekPerformance,
  analyzeOptimalTrailingStop,
  analyzeParkingDecisions,
  analyzeTimeOfDayPerformance,
} from './time-analyzers.js';

// ── Types ──

export interface InsightParamChange {
  field: 'mode' | 'stop_loss_pct' | 'take_profit_pct' | 'buy_threshold';
  value: string | number;
  reason: string;
}

export interface LearnedInsight {
  id?: string;
  category: 'WIN_PATTERN' | 'LOSS_PATTERN' | 'TIMING' | 'SIZING';
  insight: string;
  confidence: number;
  sampleCount: number;
  lastUpdated: string;
  details?: Record<string, any>;
  recommendation?: string;
  paramChange?: InsightParamChange;
  isApplied?: boolean;
}

export interface EnrichedChain {
  chain: any;
  pnlPct: number;
  holdingDays: number;
  entryType: 'SNIPER' | 'TRACK_B' | 'UNKNOWN';
  sniperType: string | null;
  initialConfidence: number | null;
}

export interface LearnedParameters {
  trailingStopMultipliers: Record<string, number>;
}

// ── Orchestrator ──

const _now = new Date().toISOString();

export async function analyzeTradeHistory(): Promise<LearnedInsight[]> {
  logger.info('🧠 자기학습 분석 시작', { component: 'LEARN' });

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const { rows: chains } = await getPool().query(
    `SELECT tc.*,
       COALESCE(json_agg(o.*) FILTER (WHERE o.id IS NOT NULL), '[]') AS orders
     FROM transaction_chains tc
     LEFT JOIN orders o ON o.chain_id = tc.id
     WHERE tc.status = 'CLOSED' AND tc.closed_at >= $1 AND tc.is_paper = $2
     GROUP BY tc.id
     ORDER BY tc.closed_at DESC`,
    [ninetyDaysAgo.toISOString(), getCtxIsPaper()],
  );

  if (!chains || chains.length < 3) {
    logger.info('학습 데이터 부족 (최소 3건 필요)', { component: 'LEARN' });
    return [];
  }

  const enrichedChains: EnrichedChain[] = chains.map((chain) => {
    const open = new Date(chain.opened_at);
    const close = new Date(chain.closed_at);
    const holdingDays = (close.getTime() - open.getTime()) / (1000 * 60 * 60 * 24);
    const pnlPct = (Number(chain.realized_pnl) / Number(chain.total_invested)) * 100;

    const firstOrder = (chain.orders as any[])?.find((o) => o.side === 'BUY');
    let entryType: EnrichedChain['entryType'] = 'UNKNOWN';
    let sniperType: string | null = null;
    let initialConfidence: number | null = null;

    if (firstOrder?.ai_reasoning) {
      const reasoning = firstOrder.ai_reasoning;
      if (reasoning.includes('[SNIPER')) {
        entryType = 'SNIPER';
        const sniperMatch = reasoning.match(/\[SNIPER\s(.*?)]/);
        if (sniperMatch) sniperType = sniperMatch[1];

        const confidenceMatch = reasoning.match(/신뢰도\s(\d+)%/);
        if (confidenceMatch) initialConfidence = parseInt(confidenceMatch[1], 10);
      } else if (reasoning.includes('Track B')) {
        entryType = 'TRACK_B';
      }
    }

    return { chain, pnlPct, holdingDays, entryType, sniperType, initialConfidence };
  });

  const wins = enrichedChains.filter((c) => Number(c.chain.realized_pnl) > 0);
  const losses = enrichedChains.filter((c) => Number(c.chain.realized_pnl) <= 0);

  /** 개별 async analyzer 30초 타임아웃 래퍼 */
  const safeAsync = async (fn: () => Promise<LearnedInsight[]>, label: string): Promise<LearnedInsight[]> => {
    try {
      return await withTimeout(fn(), 30_000, label);
    } catch (e) {
      logger.warn(`⚠️ ${label} 실패/타임아웃 — 스킵: ${e}`, { component: 'LEARN' });
      return [];
    }
  };

  const parkingInsights = await safeAsync(() => analyzeParkingDecisions(), 'parkingDecisions');

  const domesticOnly = enrichedChains.filter((c) => {
    const orders = c.chain.orders as any[];
    return !orders?.some((o: any) => o.trigger_source === 'OVERSEAS');
  });

  const insights: LearnedInsight[] = [
    ...analyzeAveraging(wins, losses),
    ...analyzeHoldingPeriod(wins, losses),
    ...analyzeModePerformance(enrichedChains),
    ...analyzeStockPerformance(enrichedChains),
    ...analyzeStockWinRateAcceleration(enrichedChains),
    ...analyzeWinRateTrend(chains),
    ...analyzeSniperPerformance(wins, losses),
    ...analyzeConfidenceCorrelation(enrichedChains),
    ...analyzeHoldingPeriodByEntry(wins),
    ...(await safeAsync(() => analyzeOptimalTrailingStop(enrichedChains), 'optimalTrailingStop')),
    ...analyzeSniperByMarketRegime(enrichedChains),
    ...analyzeLossStreakRisk(enrichedChains),
    ...analyzeProfitRatio(wins, losses),
    ...analyzeQuickProfitTaking(wins),
    // ── 🔥 기회 발견 (긍정적 인사이트) ──
    ...analyzeOptimalEntryWindows(wins),
    ...analyzeHotStocks(enrichedChains),
    ...analyzeStrategyStrengths(enrichedChains),
    ...analyzeEarlyExitMissedProfit(wins, losses),
    ...parkingInsights,
    // 시간대/요일 분석은 해외(OVERSEAS) 체인 제외 — 시장 시간대가 다름
    ...analyzeTimeOfDayPerformance(domesticOnly),
    ...analyzeDayOfWeekPerformance(domesticOnly),
    ...(await safeAsync(() => analyzeBuyThreshold(), 'buyThreshold')),
    // ── 해외주식 학습 (섹터/체결사유/종목/보유기간) ──
    ...(await safeAsync(() => analyzeOverseasAll(getCtxIsPaper()), 'overseasAll')),
  ];

  if (insights.length > 0) {
    await saveInsights(insights);
    await autoApplyInsights(insights).catch((e) => logger.warn(`자동 적용 실패: ${e}`, { component: 'LEARN' }));
  }

  return insights;
}

// ── DB Functions ──

async function saveInsights(insights: LearnedInsight[]): Promise<void> {
  if (insights.length > 0) {
    const isPaper = getCtxIsPaper();

    // v10: dismissed 인사이트 키 조회 (삭제된 인사이트 재생성 방지)
    let dismissedKeys = new Set<string>();
    try {
      const { rows: dismissed } = await getPool().query(
        `SELECT category, insight FROM learned_insights
         WHERE is_dismissed = true AND is_paper = $1`,
        [isPaper],
      );
      dismissedKeys = new Set(dismissed.map((r: any) => `${r.category}::${r.insight}`));
    } catch { /* dismissed 컬럼 미존재 시 무시 */ }

    // v10: dismissed 행 보존 — is_dismissed IS NOT TRUE 조건 추가
    await getPool()
      .query(
        `DELETE FROM learned_insights
       WHERE is_manual IS NOT TRUE
         AND COALESCE(is_promoted, false) IS NOT TRUE
         AND COALESCE(source_mode, 'native') = 'native'
         AND COALESCE(is_dismissed, false) IS NOT TRUE
         AND is_paper = $1`,
        [isPaper],
      )
      .catch(() =>
        getPool().query(
          'DELETE FROM learned_insights WHERE is_manual IS NOT TRUE AND COALESCE(is_dismissed, false) IS NOT TRUE AND is_paper = $1',
          [isPaper],
        ),
      );

    for (const insight of insights) {
      // v10: 이전에 사용자가 dismiss한 인사이트는 재생성하지 않음
      const key = `${insight.category}::${insight.insight}`;
      if (dismissedKeys.has(key)) continue;

      const { rows: inserted } = await getPool().query(
        `INSERT INTO learned_insights (category, insight, confidence, sample_count, last_updated, details, recommendation, param_change, is_paper)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (category, insight, is_paper) DO UPDATE
           SET confidence = EXCLUDED.confidence,
               sample_count = EXCLUDED.sample_count,
               last_updated = EXCLUDED.last_updated,
               details = EXCLUDED.details,
               recommendation = EXCLUDED.recommendation,
               param_change = EXCLUDED.param_change
         RETURNING id`,
        [
          insight.category,
          insight.insight,
          insight.confidence,
          insight.sampleCount,
          insight.lastUpdated,
          insight.details ? JSON.stringify(insight.details) : null,
          insight.recommendation ?? null,
          insight.paramChange ? JSON.stringify(insight.paramChange) : null,
          isPaper,
        ],
      );
      if (inserted[0]?.id) insight.id = String(inserted[0].id);
    }

    const _summary = insights.map((i) => `[${i.category}] ${i.insight}`).join('\n');
    await logSystem('INFO', 'LEARN', `자기학습 완료: ${insights.length}개 인사이트 추출`).catch(() => {});

    await sendTelegramMessage(
      `🧠 *자기학습 완료*\n${insights.length}개 패턴 학습\n\n` +
        insights
          .slice(0, 5)
          .map((i) => `• ${i.insight.split('—')[0]}`)
          .join('\n'),
    ).catch((e) => logger.warn(`자기학습 알림 실패: ${e}`, { component: 'LEARN' }));

    logger.info(`🧠 자기학습 완료: ${insights.length}개 인사이트`, { component: 'LEARN' });
  }
}

// ── 캐시: getLearnedInsightsForPrompt 결과 (TTL 1시간) ──
let _insightsPromptCache: { key: string; value: string; expiresAt: number } | null = null;

export async function getLearnedInsightsForPrompt(): Promise<string> {
  const isPaper = getCtxIsPaper();
  const cacheKey = `insights-prompt:${isPaper}`;
  if (_insightsPromptCache && _insightsPromptCache.key === cacheKey && Date.now() < _insightsPromptCache.expiresAt) {
    return _insightsPromptCache.value;
  }

  const { rows: data } = await getPool().query(
    'SELECT * FROM learned_insights WHERE is_paper = $1 ORDER BY confidence DESC, sample_count DESC LIMIT 15',
    [isPaper],
  );

  if (!data || data.length === 0) return '';

  const validationTag = (row: any): string => {
    if (!row.source_mode || row.source_mode !== 'promoted_from_paper') return '';
    if (row.live_validation_status === 'validated') return '【실전확인완료】';
    return '【연습검증·실전확인중】';
  };

  const lossPatterns = data.filter((d) => d.category === 'LOSS_PATTERN');
  const winPatterns = data.filter((d) => d.category === 'WIN_PATTERN');
  const timingInsights = data.filter((d) => d.category === 'TIMING');
  const sizingInsights = data.filter((d) => d.category === 'SIZING');

  const lines = [
    '\n## 📈 실거래 학습 인사이트 — 수익 극대화 + 손실 최소화',
    '실제 매매 데이터 분석 결과입니다. 수익 패턴을 우선 적용하고, 손실 패턴을 회피하세요.',
  ];

  // 🔥 수익 패턴 먼저 (긍정적 기회를 최우선 표시)
  if (winPatterns.length > 0) {
    lines.push('\n### 🔥 수익 기회 — 이 조건이 충족되면 적극 매수! 포지션 확대!');
    for (const insight of winPatterns) {
      const confidence = (insight.confidence * 100).toFixed(0);
      const mandatory =
        insight.confidence >= 0.85
          ? '【반드시 매수】'
          : insight.confidence >= 0.7
            ? '【적극 매수 — 비중 확대】'
            : '【기회 포착】';
      lines.push(
        `  ${validationTag(insight)}${mandatory} ${insight.insight} (신뢰도 ${confidence}%, 근거 ${insight.sample_count}건)`,
      );
    }
  }

  if (lossPatterns.length > 0) {
    lines.push('\n### ⚠️ 손실 회피 — 다음 상황에서는 매수를 자제하세요:');
    for (const insight of lossPatterns) {
      const confidence = (insight.confidence * 100).toFixed(0);
      const mandatory = insight.confidence >= 0.75 ? '【주의】' : '【참고】';
      lines.push(
        `  ${validationTag(insight)}${mandatory} ${insight.insight} (신뢰도 ${confidence}%, 근거 ${insight.sample_count}건)`,
      );
    }
  }

  if (timingInsights.length > 0) {
    lines.push('\n### ⏱️ 타이밍 인사이트:');
    for (const insight of timingInsights) {
      lines.push(
        `  ${validationTag(insight)}- ${insight.insight} (신뢰도 ${(insight.confidence * 100).toFixed(0)}%, 근거 ${insight.sample_count}건)`,
      );
    }
  }

  if (sizingInsights.length > 0) {
    lines.push('\n### 📊 투자 규모 인사이트:');
    for (const insight of sizingInsights) {
      lines.push(
        `  ${validationTag(insight)}- ${insight.insight} (신뢰도 ${(insight.confidence * 100).toFixed(0)}%, 근거 ${insight.sample_count}건)`,
      );
    }
  }

  const { rows: stockAccRows } = await getPool()
    .query(
      `SELECT stock_code,
            COUNT(*)::int AS total,
            SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END)::int AS wins,
            ROUND(AVG(realized_pnl_pct)::numeric,2) AS avg_pnl
       FROM score_accuracy
      WHERE recorded_at >= NOW() - INTERVAL '90 days'
        AND is_paper = false
      GROUP BY stock_code
      HAVING COUNT(*) >= 3
      ORDER BY (SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END)::float / COUNT(*)) DESC
      LIMIT 10`,
    )
    .catch(() => ({ rows: [] }));

  if (stockAccRows.length > 0) {
    const highWinStocks = stockAccRows.filter((r: any) => r.wins / r.total >= 0.65);
    const lowWinStocks = stockAccRows.filter((r: any) => r.wins / r.total <= 0.35);

    if (highWinStocks.length > 0) {
      lines.push('\n### 🏆 실거래 검증 고승률 종목 — 매수 신호 시 즉시 우선 진입 (포지션 30% 이상 확대):');
      for (const r of highWinStocks) {
        const winPct = Math.round((r.wins / r.total) * 100);
        lines.push(
          `  • ${r.stock_code}: 승률 ${winPct}% (${r.wins}/${r.total}건, 평균수익 ${r.avg_pnl > 0 ? '+' : ''}${r.avg_pnl}%) → 기준점수 15점 낮춰서 진입, 포지션 최대치`,
        );
      }
    }
    if (lowWinStocks.length > 0) {
      lines.push('\n### ⚠️ 저승률 종목 — 매수 신호 와도 기준점수 +15점 이상 요구:');
      for (const r of lowWinStocks) {
        const winPct = Math.round((r.wins / r.total) * 100);
        lines.push(`  • ${r.stock_code}: 승률 ${winPct}% (${r.wins}/${r.total}건) → 매우 높은 확신 없으면 진입 SKIP`);
      }
    }
  }

  lines.push(
    '\n> 위 인사이트는 과거 실거래 결과로 도출된 통계적 패턴입니다. 단순 스코어보다 이 인사이트를 우선 적용하세요.',
  );

  const result = lines.join('\n');
  _insightsPromptCache = { key: cacheKey, value: result, expiresAt: Date.now() + 3600_000 }; // 1시간 TTL
  return result;
}

export async function autoApplyInsights(insights: LearnedInsight[]): Promise<void> {
  // v4: Live 모드에서도 고신뢰 인사이트 자동 적용 (신뢰도 0.85+ & 표본 15건+)
  // Paper: 신뢰도 0.7+ (기존 유지)
  // Live:  신뢰도 0.85+ & sampleCount 15+ (안전한 자동 적용)
  const isPaper = getCtxIsPaper();
  const minConfidence = isPaper ? 0.7 : 0.85;
  const minSamples = isPaper ? 0 : 15;
  const toApply = insights.filter(
    (i) => i.confidence >= minConfidence && i.paramChange && !i.isApplied && (i.sampleCount ?? 0) >= minSamples,
  );
  if (toApply.length === 0) return;

  try {
    const { rows } = await getPool().query(
      `SELECT * FROM strategy_config WHERE is_active = true AND is_paper = $1 ORDER BY updated_at DESC LIMIT 1`,
      [isPaper],
    );
    const current = rows[0];
    if (!current) return;

    const sorted = toApply.sort((a, b) => {
      if (a.paramChange?.field === 'mode') return -1;
      if (b.paramChange?.field === 'mode') return 1;
      return b.confidence - a.confidence;
    });

    const ALLOWED_PARAM_FIELDS = ['stop_loss_pct', 'take_profit_pct', 'buy_threshold', 'mode'] as const;
    const applied: string[] = [];
    for (const insight of sorted.slice(0, 5)) {
      const { field, value } = insight.paramChange!;
      if (!(ALLOWED_PARAM_FIELDS as readonly string[]).includes(field)) {
        logger.warn(`🚫 허용되지 않은 필드 업데이트 차단: ${field}`, { component: 'LEARN' });
        continue;
      }
      const oldVal = current[field];
      if (oldVal === value) continue;

      await getPool().query(`UPDATE strategy_config SET ${field} = $1 WHERE is_active = true AND is_paper = $2`, [
        value,
        isPaper,
      ]);
      if (insight.id) {
        await getPool().query(`UPDATE learned_insights SET is_applied = true, applied_at = NOW() WHERE id = $1`, [
          insight.id,
        ]);
      } else {
        await getPool().query(
          `UPDATE learned_insights SET is_applied = true, applied_at = NOW() WHERE category = $1 AND insight = $2`,
          [insight.category, insight.insight],
        );
      }
      applied.push(`${field}: ${oldVal} → ${value}`);
      logger.info(`🤖 인사이트 자동 적용: ${field}=${value} (${insight.insight.slice(0, 40)}...)`, {
        component: 'LEARN',
      });
    }

    if (applied.length > 0) {
      await logSystem('INFO', 'LEARN', `인사이트 자동 전략 적용: ${applied.join(', ')}`).catch(() => {});
      await sendTelegramMessage(`🤖 *자기학습 자동 전략 적용*\n${applied.map((a) => `• ${a}`).join('\n')}`).catch(
        () => {},
      );
    }
  } catch (err) {
    logger.warn(`인사이트 자동 적용 실패: ${err}`, { component: 'LEARN' });
  }
}

export async function applyInsightById(insightId: string): Promise<{ ok: boolean; message: string }> {
  try {
    const { rows } = await getPool().query(`SELECT * FROM learned_insights WHERE id = $1`, [insightId]);
    const insight = rows[0];
    if (!insight) return { ok: false, message: '인사이트를 찾을 수 없음' };
    if (!insight.param_change) return { ok: false, message: '자동 적용 가능한 파라미터 변경 없음' };
    if (insight.is_applied) return { ok: false, message: '이미 적용됨' };

    const { field, value } = insight.param_change as InsightParamChange;
    const ALLOWED_PARAM_FIELDS = ['stop_loss_pct', 'take_profit_pct', 'buy_threshold', 'mode'];
    if (!ALLOWED_PARAM_FIELDS.includes(field)) return { ok: false, message: `허용되지 않은 필드: ${field}` };

    const targetIsPaper = insight.is_paper;
    const { rows: stratRows } = await getPool().query(
      `SELECT * FROM strategy_config WHERE is_active = true AND is_paper = $1 LIMIT 1`,
      [targetIsPaper],
    );
    const current = stratRows[0];
    if (!current) return { ok: false, message: '활성 전략 없음' };

    await getPool().query(`UPDATE strategy_config SET ${field} = $1 WHERE is_active = true AND is_paper = $2`, [
      value,
      targetIsPaper,
    ]);
    await getPool().query(`UPDATE learned_insights SET is_applied = true, applied_at = NOW() WHERE id = $1`, [
      insightId,
    ]);

    const message = `${field}: ${current[field]} → ${value}`;
    await logSystem('INFO', 'LEARN', `인사이트 수동 적용: ${message}`).catch(() => {});
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: `적용 실패: ${err}` };
  }
}

export async function getInsightsForDashboard(): Promise<LearnedInsight[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM learned_insights ORDER BY confidence DESC, sample_count DESC LIMIT 20`,
  );
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    insight: r.insight,
    confidence: Number(r.confidence),
    sampleCount: r.sample_count,
    lastUpdated: r.last_updated,
    details: r.details,
    recommendation: r.recommendation,
    paramChange: r.param_change as InsightParamChange | undefined,
    isApplied: r.is_applied,
  }));
}

export async function getLearnedParameters(): Promise<LearnedParameters> {
  const params: LearnedParameters = {
    trailingStopMultipliers: {},
  };

  const { rows: data } = await getPool().query(
    'SELECT details FROM learned_insights WHERE category = $1 AND confidence > $2',
    ['TIMING', 0.65],
  );

  if (!data || data.length === 0) return params;

  for (const insight of data) {
    const details = insight.details as any;
    if (details?.param === 'ATR_MULTIPLIER' && details.sniperType && typeof details.value === 'number') {
      params.trailingStopMultipliers[details.sniperType] = details.value;
    }
  }

  return params;
}

export async function getStockAccuracyContext(stockCodes: string[]): Promise<string> {
  if (stockCodes.length === 0) return '';
  try {
    const { rows } = await getPool().query(
      `SELECT
         stock_code,
         COUNT(*)::int                                      AS total,
         SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END)::int AS wins,
         ROUND(AVG(realized_pnl_pct)::numeric, 2)          AS avg_pnl_pct,
         ROUND(AVG(CASE WHEN outcome='WIN' THEN realized_pnl_pct END)::numeric, 2) AS avg_win_pct,
         ROUND(AVG(CASE WHEN outcome='LOSS' THEN realized_pnl_pct END)::numeric, 2) AS avg_loss_pct,
         ROUND(AVG(entry_score)::numeric, 0)                AS avg_entry_score
       FROM score_accuracy
      WHERE stock_code = ANY($1)
        AND recorded_at >= NOW() - INTERVAL '90 days'
        AND is_paper = false
      GROUP BY stock_code
      HAVING COUNT(*) >= 3
      ORDER BY stock_code`,
      [stockCodes],
    );

    if (rows.length === 0) return '';

    const lines = ['\n## 📊 종목별 실거래 정확도 (최근 90일)'];
    for (const r of rows) {
      const winRate = Math.round((r.wins / r.total) * 100);
      const bias =
        winRate >= 60
          ? `✅ 승률 높음 — 신호 강하면 적극 매수`
          : winRate <= 35
            ? `⚠️ 승률 낮음 — 더 높은 스코어(+10) 요구`
            : `→ 보통`;
      lines.push(
        `  ${r.stock_code}: 승률 ${winRate}%(${r.wins}/${r.total}건) | 평균손익 ${r.avg_pnl_pct > 0 ? '+' : ''}${r.avg_pnl_pct}% | 진입스코어평균 ${r.avg_entry_score}점 ${bias}`,
      );
    }
    lines.push('> 위 승률이 낮은 종목은 composite_score를 10점 더 엄격하게 적용하세요.');
    return lines.join('\n');
  } catch {
    return '';
  }
}

/** Promise에 타임아웃을 걸어 하나가 느려도 전체 차단 방지 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 타임아웃 (${ms}ms)`)), ms)),
  ]);
}

export async function runDailyLearning(): Promise<void> {
  try {
    // 전체 5분 타임아웃 — 개별 analyzer는 analyzeTradeHistory 내부에서 30초 제한
    const insights = await withTimeout(analyzeTradeHistory(), 5 * 60_000, 'runDailyLearning');
    if (insights.length === 0) {
      logger.info('자기학습: 분석 결과 없음', { component: 'LEARN' });
      return;
    }
    const isPaper = getCtxIsPaper();
    for (const ins of insights) {
      await getPool()
        .query(
          `INSERT INTO learned_insights (category, insight, confidence, sample_count, details, recommendation, param_change, is_paper, last_updated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (category, insight, is_paper)
         DO UPDATE SET confidence=$3, sample_count=$4, details=$5, recommendation=$6, param_change=$7, last_updated=NOW()`,
          [
            ins.category,
            ins.insight,
            ins.confidence,
            ins.sampleCount,
            ins.details ? JSON.stringify(ins.details) : null,
            ins.recommendation ?? null,
            ins.paramChange ? JSON.stringify(ins.paramChange) : null,
            isPaper,
          ],
        )
        .catch(() => {});
    }
    logger.info(`🧠 자기학습 인사이트 ${insights.length}건 저장`, { component: 'LEARN' });
    await autoApplyInsights(insights);
    // 황금비율 자동 조정: 30일 전략별 성과 → 가중치 자동 튜닝
    try {
      const { autoTuneRegimeWeights } = await import('../regime-allocator.js');
      await autoTuneRegimeWeights();
    } catch (e) {
      logger.warn(`황금비율 자동조정 실패: ${e}`, { component: 'LEARN' });
    }
    await calibrateScoreTierParams().catch((e) => logger.warn(`티어 파라미터 보정 실패: ${e}`, { component: 'LEARN' }));
    if (!getCtxIsPaper()) {
      await validatePromotedInsights().catch((e) => logger.warn(`프로모션 검증 실패: ${e}`, { component: 'LEARN' }));
    }

    // 웹 푸시 알림 — 학습 완료 요약
    const appliedCount = insights.filter((i) => i.isApplied).length;
    const paramChangeable = insights.filter((i) => i.paramChange && !i.isApplied).length;
    const bodyParts: string[] = [];
    if (appliedCount > 0) bodyParts.push(`${appliedCount}개 자동 적용`);
    if (paramChangeable > 0) bodyParts.push(`${paramChangeable}개 적용 대기`);
    bodyParts.push('설정에서 확인하세요');
    await sendPushNotification({
      title: `🧠 자기학습 완료 — ${insights.length}개 인사이트`,
      body: bodyParts.join(' · '),
      tag: 'learning-complete',
      url: '/?tab=settings',
    }).catch(() => {});
  } catch (err) {
    logger.warn(`자기학습 실패: ${err}`, { component: 'LEARN' });
  }
}

// Re-export calibration for direct access
export { validatePromotedInsights } from './calibration.js';
export { getOverseasInsightsForPrompt } from './overseas-analyzers.js';
