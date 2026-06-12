import { getCtxIsPaper } from '../../config/context.js';
import { getPool, logSystem } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import type { LearnedInsight } from './index.js';

const now = new Date().toISOString();

export async function analyzeBuyThreshold(): Promise<LearnedInsight[]> {
  try {
    const { rows: cfgRows } = await getPool().query(
      `SELECT buy_threshold FROM strategy_config WHERE is_active = true AND is_paper = $1 LIMIT 1`,
      [getCtxIsPaper()],
    );
    const currentThreshold: number = cfgRows[0]?.buy_threshold ?? 58;

    const { rows } = await getPool().query(
      `SELECT entry_score, outcome, realized_pnl_pct
         FROM score_accuracy
        WHERE recorded_at >= NOW() - INTERVAL '90 days'
          AND entry_score IS NOT NULL
          AND is_paper = false
        ORDER BY entry_score`,
    );

    if (rows.length < 15) return [];

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
        lastUpdated: now,
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
        lastUpdated: now,
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
    const { rows: accuracyData } = await getPool().query(
      `SELECT entry_score, outcome, realized_pnl_pct
       FROM score_accuracy
       WHERE recorded_at >= NOW() - INTERVAL '120 days'
         AND entry_score IS NOT NULL
         AND is_paper = false
         AND (market IS NULL OR market = 'KR')
       ORDER BY recorded_at DESC`,
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

      if (tierData.length < 5) {
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

      if (stats.data.length < 5) continue;

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
