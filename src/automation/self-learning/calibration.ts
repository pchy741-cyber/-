import { getCtxIsPaper } from '../../config/context.js';
import { getPool, logSystem } from '../../db/client.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';
import type { InsightParamChange, LearnedInsight } from './index.js';

// 모듈 레벨 stale timestamp 제거 — 사용 시점에서 생성
// (이전: const now = new Date().toISOString() 모듈 로드 시 1회 평가 → 장기 운영 시 고정)

// SQL injection 방지: 동적 컬럼명을 화이트리스트 매핑으로 안전하게 치환
const SAFE_COLUMN_MAP: Record<string, string> = {
  stop_loss_pct: 'stop_loss_pct',
  take_profit_pct: 'take_profit_pct',
  buy_threshold: 'buy_threshold',
  mode: 'mode',
};
function safeColumnName(field: string): string | null {
  return SAFE_COLUMN_MAP[field] ?? null;
}

export async function analyzeBuyThreshold(): Promise<LearnedInsight[]> {
  try {
    const { rows: cfgRows } = await getPool().query(
      `SELECT buy_threshold FROM strategy_config WHERE is_active = true AND is_paper = $1 LIMIT 1`,
      [getCtxIsPaper()],
    );
    const currentThreshold: number = cfgRows[0]?.buy_threshold ?? 58;

    // v9-fix: 데이터 스누핑 방지 — 최근 14일 데이터 제외 (holdout gap)
    // 학습 데이터(14~90일 전)와 적용 기간(최근 14일)을 분리하여 오버피팅 방지
    const { rows } = await getPool().query(
      `SELECT entry_score, outcome, realized_pnl_pct
         FROM score_accuracy
        WHERE recorded_at BETWEEN NOW() - INTERVAL '90 days' AND NOW() - INTERVAL '14 days'
          AND entry_score IS NOT NULL
          AND is_paper = $1
        ORDER BY entry_score`,
      [getCtxIsPaper()],
    );

    if (rows.length < 30) return []; // v9: 15→30 최소 샘플 강화

    const below = rows.filter((r: any) => Number(r.entry_score) < currentThreshold);
    const above = rows.filter((r: any) => Number(r.entry_score) >= currentThreshold);

    if (below.length < 5 || above.length < 5) return [];

    const belowWinRate = below.filter((r: any) => r.outcome === 'WIN').length / below.length;
    const aboveWinRate = above.filter((r: any) => r.outcome === 'WIN').length / above.length;
    const belowAvgPnl = below.reduce((s: number, r: any) => s + Number(r.realized_pnl_pct), 0) / below.length;

    const totalSamples = rows.length;
    const confidence = Math.min(0.85, 0.55 + totalSamples * 0.015);
    const insights: LearnedInsight[] = [];

    if (belowWinRate < 0.38 && belowAvgPnl < 0 && aboveWinRate > belowWinRate + 0.1) {
      let bestThreshold = currentThreshold + 5;
      let bestAboveWinRate = 0;
      for (let t = currentThreshold + 3; t <= Math.min(80, currentThreshold + 12); t += 3) {
        const atOrAbove = rows.filter((r: any) => Number(r.entry_score) >= t);
        if (atOrAbove.length < 5) break;
        const wr = atOrAbove.filter((r: any) => r.outcome === 'WIN').length / atOrAbove.length;
        if (wr > bestAboveWinRate) {
          bestAboveWinRate = wr;
          bestThreshold = t;
        }
      }

      insights.push({
        category: 'WIN_PATTERN',
        insight: `매수 임계값 자동최적화: ${currentThreshold}점 미만 실거래 승률 ${(belowWinRate * 100).toFixed(0)}% (${below.length}건, 평균손익 ${belowAvgPnl.toFixed(1)}%). 임계값 ${bestThreshold}점으로 상향하면 진입 품질 개선.`,
        recommendation: `buy_threshold: ${currentThreshold} → ${bestThreshold} (실거래 ${totalSamples}건 분석)`,
        paramChange: {
          field: 'buy_threshold',
          value: bestThreshold,
          reason: `임계값 이하 승률 ${(belowWinRate * 100).toFixed(0)}% 개선 목적`,
        },
        confidence,
        sampleCount: totalSamples,
        lastUpdated: new Date().toISOString(),
      });
    }

    if (belowWinRate >= 0.52 && belowAvgPnl > 0 && currentThreshold > 55 && below.length >= 8) {
      const suggestedThreshold = Math.max(53, currentThreshold - 5);
      insights.push({
        category: 'WIN_PATTERN',
        insight: `매수 임계값 자동최적화: ${currentThreshold}점 미만에서도 승률 ${(belowWinRate * 100).toFixed(0)}% (${below.length}건, 평균손익 ${belowAvgPnl.toFixed(1)}%). 임계값 ${suggestedThreshold}점 하향으로 기회 확대 가능.`,
        recommendation: `buy_threshold: ${currentThreshold} → ${suggestedThreshold}`,
        paramChange: {
          field: 'buy_threshold',
          value: suggestedThreshold,
          reason: `임계값 이하도 수익 확인 → 기회 확대`,
        },
        confidence: confidence * 0.85,
        sampleCount: totalSamples,
        lastUpdated: new Date().toISOString(),
      });
    }

    if (insights.length > 0) {
      logger.info(
        `🎯 buy_threshold 분석: 현재 ${currentThreshold}점 | 이하승률 ${(belowWinRate * 100).toFixed(0)}%(${below.length}건) | 이상승률 ${(aboveWinRate * 100).toFixed(0)}%(${above.length}건) → ${insights.length}건 권장`,
        { component: 'LEARN' },
      );
    }

    return insights;
  } catch (err) {
    logger.warn(`buy_threshold 분석 실패: ${err}`, { component: 'LEARN' });
    return [];
  }
}

export async function calibrateScoreTierParams(): Promise<void> {
  try {
    // v9-fix: 데이터 스누핑 방지 — 최근 14일 제외 (holdout gap)
    const { rows: accuracyData } = await getPool().query(
      `SELECT entry_score, outcome, realized_pnl_pct
       FROM score_accuracy
       WHERE recorded_at BETWEEN NOW() - INTERVAL '120 days' AND NOW() - INTERVAL '14 days'
         AND entry_score IS NOT NULL
         AND is_paper = $1
         AND (market IS NULL OR market = 'KR')
       ORDER BY recorded_at DESC`,
      [getCtxIsPaper()],
    );

    if (accuracyData.length < 30) {
      logger.info('점수 티어 보정: 데이터 부족 (최소 30건 필요)', { component: 'LEARN' });
      return;
    }

    const tiers = [
      { min: 60, max: 69 },
      { min: 70, max: 79 },
      { min: 80, max: 89 },
      { min: 90, max: 100 },
    ];

    interface TierStats {
      data: Array<{ outcome: string; realized_pnl_pct: number }>;
      winRate: number;
      avgPnl: number;
      avgWin: number;
      avgLoss: number;
      stdev: number;
    }

    const tierStats: Record<string, TierStats> = {};

    for (const tier of tiers) {
      const tierKey = `${tier.min}-${tier.max}`;
      const tierData = accuracyData.filter((d) => d.entry_score >= tier.min && d.entry_score <= tier.max);

      // v9-fix: 티어별 최소 샘플 5→10 강화 (소수 데이터 오버피팅 방지)
      if (tierData.length < 10) {
        tierStats[tierKey] = { data: [], winRate: 0, avgPnl: 0, avgWin: 0, avgLoss: 0, stdev: 0 };
        continue;
      }

      const wins = tierData.filter((d) => d.outcome === 'WIN');
      const losses = tierData.filter((d) => d.outcome === 'LOSS');

      const winRate = wins.length / tierData.length;
      const avgPnl = tierData.reduce((s, d) => s + d.realized_pnl_pct, 0) / tierData.length;
      const avgWin = wins.length > 0 ? wins.reduce((s, d) => s + d.realized_pnl_pct, 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? losses.reduce((s, d) => s + d.realized_pnl_pct, 0) / losses.length : 0;

      const variance = tierData.reduce((s, d) => s + (d.realized_pnl_pct - avgPnl) ** 2, 0) / tierData.length;
      const stdev = Math.sqrt(variance);

      tierStats[tierKey] = { data: tierData, winRate, avgPnl, avgWin, avgLoss, stdev };
    }

    const updates: Array<{
      tier_min: number;
      tier_max: number;
      alloc_pct: number;
      win_rate: number;
      avg_pnl_pct: number;
      sample_count: number;
    }> = [];

    for (const tier of tiers) {
      const tierKey = `${tier.min}-${tier.max}`;
      const stats = tierStats[tierKey];

      if (stats.data.length < 10) continue; // v9: 5→10 (위 필터와 일치)

      const { winRate, avgWin, avgLoss } = stats;

      let kelly = 0;
      if (avgLoss !== 0) {
        const ratio = avgWin / Math.abs(avgLoss);
        kelly = winRate - (1 - winRate) / ratio;
      }

      // Kelly 음수 시 tier별 차별화 유지 (기존: 전 티어 0.04 → 점수 구분 무의미)
      if (kelly < 0) {
        kelly = tier.min >= 90 ? 0.1 : tier.min >= 80 ? 0.08 : tier.min >= 70 ? 0.06 : 0.04;
      } else {
        kelly = Math.min(kelly * 0.3, 0.22);
      }

      let allocPct = kelly;
      if (stats.data.length < 10) {
        const { rows: currentRows } = await getPool()
          .query(`SELECT alloc_pct FROM score_tier_params WHERE tier_min = $1 AND tier_max = $2`, [tier.min, tier.max])
          .catch(() => ({ rows: [] }));

        if (currentRows.length > 0) {
          const currentAlloc = Number(currentRows[0].alloc_pct);
          allocPct = (kelly + currentAlloc) / 2;
        }
      }

      updates.push({
        tier_min: tier.min,
        tier_max: tier.max,
        alloc_pct: allocPct,
        win_rate: winRate,
        avg_pnl_pct: stats.avgPnl,
        sample_count: stats.data.length,
      });
    }

    for (const update of updates) {
      await getPool().query(
        `INSERT INTO score_tier_params (tier_min, tier_max, alloc_pct, win_rate, avg_pnl_pct, sample_count, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (tier_min, tier_max)
         DO UPDATE SET alloc_pct=$3, win_rate=$4, avg_pnl_pct=$5, sample_count=$6, updated_at=NOW()`,
        [update.tier_min, update.tier_max, update.alloc_pct, update.win_rate, update.avg_pnl_pct, update.sample_count],
      );
    }

    const summary = updates
      .map(
        (u) =>
          `[${u.tier_min}-${u.tier_max}: ${(u.alloc_pct * 100).toFixed(1)}%, 승률 ${(u.win_rate * 100).toFixed(0)}%, n=${u.sample_count}]`,
      )
      .join(' ');
    logger.info(`점수 티어 파라미터 갱신: ${summary}`, { component: 'LEARN' });
    await logSystem('INFO', 'LEARN', `점수 티어 보정: ${summary}`).catch(() => {});
  } catch (err) {
    logger.warn(`점수 티어 보정 실패: ${err}`, { component: 'LEARN' });
  }
}

/**
 * 앙상블 가중치 자동 튜닝 — 최근 30일 모델별 실거래 성과 기반
 *
 * 1. score_accuracy + ai_scores에서 모델별 참여 거래의 승률/PnL 분석
 * 2. 가중치 = normalize(win_rate × avg_positive_pnl)
 * 3. 안전범위: 각 모델 최소 0.10, 최대 0.50
 * 4. paper + live 동시 업데이트
 */
export async function autoTuneEnsembleWeights(): Promise<void> {
  const isPaper = getCtxIsPaper();
  try {
    // 모델별 참여 거래 성과 분석 (14~60일 전 — holdout gap 14일 적용)
    // v11-fix: 데이터 스누핑 방지 — 최근 14일 제외하여 학습/평가 기간 분리
    const { rows: modelStats } = await getPool().query(
      `SELECT
         ai.model,
         COUNT(*)::int AS total,
         SUM(CASE WHEN sa.outcome = 'WIN' THEN 1 ELSE 0 END)::int AS wins,
         ROUND(AVG(CASE WHEN sa.realized_pnl_pct > 0 THEN sa.realized_pnl_pct ELSE 0 END)::numeric, 3) AS avg_positive_pnl
       FROM ai_scores ai
       JOIN score_accuracy sa ON ai.stock_code = sa.stock_code
         AND sa.recorded_at >= ai.scored_at - INTERVAL '1 day'
         AND sa.recorded_at <= ai.scored_at + INTERVAL '7 days'
       WHERE ai.scored_at BETWEEN NOW() - INTERVAL '60 days' AND NOW() - INTERVAL '14 days'
         AND sa.is_paper = $1
       GROUP BY ai.model
       HAVING COUNT(*) >= 5`,
      [isPaper],
    );

    if (modelStats.length < 2) {
      logger.info('앙상블 튜닝: 모델 성과 데이터 부족 (최소 2개 모델, 각 5건 이상 필요)', { component: 'LEARN' });
      return;
    }

    // 모델별 성과 점수 = win_rate × avg_positive_pnl
    const MODEL_KEYS = ['gemini', 'gpt', 'claude', 'rss'] as const;
    const scores: Record<string, number> = {};
    for (const row of modelStats) {
      const model = String(row.model).toLowerCase();
      if (!MODEL_KEYS.includes(model as any)) continue;
      const winRate = row.total > 0 ? row.wins / row.total : 0;
      const avgPnl = Math.max(Number(row.avg_positive_pnl), 0.01);
      scores[model] = winRate * avgPnl;
    }

    if (Object.keys(scores).length < 2) return;

    // 데이터 없는 모델은 최소 점수 부여
    for (const key of MODEL_KEYS) {
      if (!(key in scores)) scores[key] = 0.01;
    }

    // 정규화 → 가중치 (최소 0.10, 최대 0.50)
    const totalScore = Object.values(scores).reduce((s, v) => s + v, 0);
    const weights: Record<string, number> = {};
    for (const [model, score] of Object.entries(scores)) {
      const raw = score / totalScore;
      weights[model] = Math.min(0.50, Math.max(0.10, raw));
    }

    // 재정규화 (합계 = 1.0)
    const sum = Object.values(weights).reduce((s, v) => s + v, 0);
    for (const key of Object.keys(weights)) {
      weights[key] = Math.round((weights[key] / sum) * 100) / 100;
    }

    // 기존 가중치 조회 (변경 로깅용)
    const { rows: stratRows } = await getPool().query(
      `SELECT ensemble_config FROM strategy_config WHERE is_active = true AND is_paper = $1 LIMIT 1`,
      [isPaper],
    );
    const oldConfig = stratRows[0]?.ensemble_config as { weights?: Record<string, number> } | null;
    const oldWeights = oldConfig?.weights ?? {};

    // paper + live 동시 업데이트
    const ensembleUpdate = JSON.stringify({
      weights,
      strategy: 'weighted_avg',
      minModels: 2,
    });

    await getPool().query(
      `UPDATE strategy_config SET ensemble_config = $1::jsonb, updated_at = NOW() WHERE is_active = true AND is_paper = $2`,
      [ensembleUpdate, isPaper],
    );

    // 변경 로그
    const changes = Object.entries(weights)
      .map(([m, w]) => {
        const old = oldWeights[m] ?? 0;
        return `${m.charAt(0).toUpperCase() + m.slice(1)} ${(old * 100).toFixed(0)}%→${(w * 100).toFixed(0)}%`;
      })
      .join(', ');

    logger.info(`🎯 앙상블 가중치 자동조정 (${isPaper ? '연습' : '실전'}): ${changes}`, { component: 'LEARN' });
    await logSystem('INFO', 'LEARN', `앙상블 가중치 자동조정: ${changes}`).catch(() => {});
    await sendTelegramMessage(
      `🎯 *앙상블 가중치 자동조정* (${isPaper ? '연습' : '실전'})\n${changes}`,
    ).catch(() => {});
  } catch (err) {
    logger.warn(`앙상블 가중치 튜닝 실패: ${err}`, { component: 'LEARN' });
  }
}

export async function validatePromotedInsights(): Promise<void> {
  const { rows: promoted } = await getPool().query(
    `SELECT * FROM learned_insights
     WHERE source_mode = 'promoted_from_paper'
       AND live_validation_status = 'pending'
       AND is_paper = false`,
  );

  if (promoted.length === 0) return;

  for (const insight of promoted) {
    if (!insight.promoted_at) continue;

    const daysSincePromotion = (Date.now() - new Date(insight.promoted_at).getTime()) / 86400000;
    if (daysSincePromotion < 14) continue;

    const { rows: trades } = await getPool().query(
      `SELECT realized_pnl FROM transaction_chains
       WHERE is_paper = false AND status = 'CLOSED'
         AND closed_at >= $1`,
      [insight.promoted_at],
    );

    const wins = trades.filter((t: any) => Number(t.realized_pnl) > 0).length;
    const losses = trades.filter((t: any) => Number(t.realized_pnl) <= 0).length;
    const total = wins + losses;

    if (total < 5) continue;

    const winRate = wins / total;

    if (winRate >= 0.55) {
      await getPool().query(
        `UPDATE learned_insights
         SET live_validation_status = 'validated',
             confidence = LEAST(confidence / 0.7, 0.95),
             live_win_count = $1, live_loss_count = $2,
             live_validated_at = NOW()
         WHERE id = $3`,
        [wins, losses, insight.id],
      );
      logger.info(
        `프로모션 검증 완료: ${String(insight.insight).slice(0, 50)}... → validated (승률 ${(winRate * 100).toFixed(0)}%)`,
        { component: 'LEARN' },
      );
    } else if (daysSincePromotion >= 30 && winRate < 0.4) {
      await getPool().query(
        `UPDATE learned_insights
         SET live_validation_status = 'invalidated',
             confidence = confidence * 0.5,
             live_win_count = $1, live_loss_count = $2,
             live_validated_at = NOW()
         WHERE id = $3`,
        [wins, losses, insight.id],
      );
      logger.info(
        `프로모션 무효화: ${String(insight.insight).slice(0, 50)}... → invalidated (승률 ${(winRate * 100).toFixed(0)}%)`,
        { component: 'LEARN' },
      );
    }
  }
}

/**
 * 적용된 인사이트의 효과를 추적하고 악화 시 자동 롤백
 *
 * 적용 후 14일 경과한 인사이트만 평가:
 * - score_accuracy 테이블에서 적용 전후 승률/PnL 비교
 * - 성과 악화 판정: 승률 10%p 이상 하락 OR 평균 PnL 부호 반전
 * - 악화 시: strategy_config 롤백 + is_applied=false + is_dismissed=true
 */
export async function evaluateAppliedInsights(): Promise<void> {
  const isPaper = getCtxIsPaper();
  try {
    const { rows: applied } = await getPool().query(
      `SELECT * FROM learned_insights
       WHERE is_applied = true
         AND applied_at IS NOT NULL
         AND applied_at <= NOW() - INTERVAL '14 days'
         AND COALESCE(is_dismissed, false) IS NOT TRUE
         AND is_paper = $1`,
      [isPaper],
    );

    if (applied.length === 0) return;

    for (const insight of applied) {
      const appliedAt = insight.applied_at;
      if (!appliedAt) continue;

      // 적용 전 14일간의 성과
      const { rows: beforeRows } = await getPool().query(
        `SELECT
           COUNT(*)::int AS total,
           SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END)::int AS wins,
           ROUND(AVG(realized_pnl_pct)::numeric, 2) AS avg_pnl
         FROM score_accuracy
         WHERE recorded_at BETWEEN ($1::timestamptz - INTERVAL '14 days') AND $1::timestamptz
           AND is_paper = $2`,
        [appliedAt, isPaper],
      );

      // 적용 후 14일간의 성과
      const { rows: afterRows } = await getPool().query(
        `SELECT
           COUNT(*)::int AS total,
           SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END)::int AS wins,
           ROUND(AVG(realized_pnl_pct)::numeric, 2) AS avg_pnl
         FROM score_accuracy
         WHERE recorded_at BETWEEN $1::timestamptz AND ($1::timestamptz + INTERVAL '14 days')
           AND is_paper = $2`,
        [appliedAt, isPaper],
      );

      const before = beforeRows[0];
      const after = afterRows[0];

      // 최소 5건 이상 데이터 필요
      if (!before || !after || before.total < 5 || after.total < 5) continue;

      const beforeWinRate = before.wins / before.total;
      const afterWinRate = after.wins / after.total;
      const beforeAvgPnl = Number(before.avg_pnl);
      const afterAvgPnl = Number(after.avg_pnl);

      // 악화 판정: 승률 10%p 이상 하락 OR 평균 PnL 부호 반전 (양→음)
      const winRateDropped = afterWinRate < beforeWinRate - 0.10;
      const pnlFlipped = beforeAvgPnl > 0 && afterAvgPnl < 0;
      const isWorsened = winRateDropped || pnlFlipped;

      if (!isWorsened) {
        logger.info(
          `✅ 인사이트 효과 양호: ${String(insight.insight).slice(0, 40)}... (승률 ${(beforeWinRate * 100).toFixed(0)}%→${(afterWinRate * 100).toFixed(0)}%, PnL ${beforeAvgPnl}→${afterAvgPnl})`,
          { component: 'LEARN' },
        );
        continue;
      }

      // 롤백: details에서 이전값 복원
      const details = insight.details as Record<string, any> | null;
      const previousValue = details?.previous_value;
      const appliedField = details?.applied_field;

      if (previousValue != null && appliedField) {
        const safeCol = safeColumnName(appliedField);
        if (safeCol) {
          await getPool().query(
            `UPDATE strategy_config SET ${safeCol} = $1 WHERE is_active = true AND is_paper = $2`,
            [previousValue, isPaper],
          );
          logger.info(
            `🔄 인사이트 롤백: ${appliedField} → ${previousValue} (이전값 복원)`,
            { component: 'LEARN' },
          );
        }
      }

      // 인사이트 비활성화
      await getPool().query(
        `UPDATE learned_insights SET is_applied = false, is_dismissed = true WHERE id = $1`,
        [insight.id],
      );

      const reason = winRateDropped
        ? `승률 ${(beforeWinRate * 100).toFixed(0)}%→${(afterWinRate * 100).toFixed(0)}% (${((afterWinRate - beforeWinRate) * 100).toFixed(1)}%p 하락)`
        : `평균PnL ${beforeAvgPnl}%→${afterAvgPnl}% (부호 반전)`;

      await logSystem('WARN', 'LEARN', `인사이트 자동 롤백: ${reason} — ${String(insight.insight).slice(0, 50)}`).catch(() => {});
      await sendTelegramMessage(
        `🚫 *인사이트 자동 롤백*\n${reason}\n• ${String(insight.insight).slice(0, 80)}`,
      ).catch(() => {});

      logger.warn(
        `🚫 인사이트 롤백: ${String(insight.insight).slice(0, 50)}... — ${reason}`,
        { component: 'LEARN' },
      );
    }
  } catch (err) {
    logger.warn(`인사이트 효과 평가 실패: ${err}`, { component: 'LEARN' });
  }
}

/**
 * Paper 인사이트 → Live 자동 프로모션
 *
 * 조건: confidence >= 0.75, sample_count >= 10, paramChange 있음
 * 이미 같은 field가 live에 promote된 인사이트 있으면 스킵
 * promote 시 live strategy_config에 paramChange 즉시 반영
 */
export async function autoPromotePaperInsights(): Promise<void> {
  try {
    // Paper 인사이트 중 프로모션 대상 조회
    const { rows: candidates } = await getPool().query(
      `SELECT * FROM learned_insights
       WHERE is_paper = true
         AND confidence >= 0.75
         AND sample_count >= 10
         AND param_change IS NOT NULL
         AND COALESCE(is_dismissed, false) IS NOT TRUE
         AND COALESCE(is_promoted, false) IS NOT TRUE`,
    );

    if (candidates.length === 0) return;

    // 이미 promote된 live 인사이트의 field 목록
    const { rows: existingPromoted } = await getPool().query(
      `SELECT param_change->>'field' AS field FROM learned_insights
       WHERE is_paper = false
         AND source_mode = 'promoted_from_paper'
         AND COALESCE(is_dismissed, false) IS NOT TRUE`,
    );
    const promotedFields = new Set(existingPromoted.map((r: any) => r.field));

    // Live strategy_config 조회
    const { rows: liveStratRows } = await getPool().query(
      `SELECT * FROM strategy_config WHERE is_active = true AND is_paper = false LIMIT 1`,
    );
    const liveStrategy = liveStratRows[0];
    if (!liveStrategy) {
      logger.warn('자동 프로모션: live strategy_config 없음 — 스킵', { component: 'LEARN' });
      return;
    }

    const PARAM_RANGES: Record<string, { min: number; max: number }> = {
      stop_loss_pct: { min: -30, max: -1 },
      take_profit_pct: { min: 0.5, max: 50 },
      buy_threshold: { min: 0, max: 100 },
    };

    const promoted: string[] = [];

    for (const candidate of candidates) {
      const paramChange = candidate.param_change as InsightParamChange;
      if (!paramChange?.field) continue;

      // 이미 같은 field가 promote 되어 있으면 스킵
      if (promotedFields.has(paramChange.field)) continue;

      // 허용 필드 검증 (SQL injection 방지 — 화이트리스트 매핑)
      const safeField = safeColumnName(paramChange.field);
      if (!safeField) continue;

      // 값 범위 검증
      const range = PARAM_RANGES[paramChange.field];
      if (range && typeof paramChange.value === 'number') {
        if (paramChange.value < range.min || paramChange.value > range.max) continue;
      }

      const oldVal = liveStrategy[paramChange.field];
      if (oldVal === paramChange.value) continue;

      // Live learned_insights에 promote된 행 생성
      const promotedConfidence = Math.round(candidate.confidence * 0.8 * 100) / 100;
      await getPool().query(
        `INSERT INTO learned_insights
         (category, insight, confidence, sample_count, last_updated, details, recommendation,
          param_change, is_paper, is_manual, source_mode, promoted_at, live_validation_status)
         VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, false, true, 'promoted_from_paper', NOW(), 'pending')
         ON CONFLICT (category, insight, is_paper) DO UPDATE
           SET confidence = EXCLUDED.confidence,
               sample_count = EXCLUDED.sample_count,
               last_updated = EXCLUDED.last_updated,
               source_mode = EXCLUDED.source_mode,
               promoted_at = EXCLUDED.promoted_at,
               live_validation_status = EXCLUDED.live_validation_status`,
        [
          candidate.category,
          candidate.insight,
          promotedConfidence,
          candidate.sample_count,
          JSON.stringify({
            ...((candidate.details as Record<string, unknown>) ?? {}),
            previous_value: oldVal,
            applied_field: paramChange.field,
            promoted_from_paper_id: candidate.id,
          }),
          candidate.recommendation,
          JSON.stringify(paramChange),
        ],
      );

      // Live strategy_config에 paramChange 즉시 반영 (safeField는 위에서 검증됨)
      await getPool().query(
        `UPDATE strategy_config SET ${safeField} = $1 WHERE is_active = true AND is_paper = false`,
        [paramChange.value],
      );

      // Paper 원본에 promoted 마크
      await getPool().query(
        `UPDATE learned_insights SET is_promoted = true WHERE id = $1`,
        [candidate.id],
      );

      promotedFields.add(paramChange.field);
      promoted.push(`${paramChange.field}: ${oldVal} → ${paramChange.value}`);
      logger.info(
        `🔄 연습→실전 프로모션: ${paramChange.field}=${paramChange.value} (confidence=${promotedConfidence})`,
        { component: 'LEARN' },
      );
    }

    if (promoted.length > 0) {
      await logSystem('INFO', 'LEARN', `연습→실전 자동 튜닝: ${promoted.join(', ')}`).catch(() => {});
      await sendTelegramMessage(
        `🔄 *연습→실전 자동 튜닝*\n${promoted.map((p) => `• ${p}`).join('\n')}`,
      ).catch(() => {});
    }
  } catch (err) {
    logger.warn(`자동 프로모션 실패: ${err}`, { component: 'LEARN' });
  }
}
