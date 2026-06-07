/**
 * 전략 인사이트 엔진 — "이럴 때 이렇게 하면 수익이 났다" 팩트 분석
 *
 * Paper 거래 데이터를 다차원 분석 → strategy_insights 테이블 UPSERT
 */

import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';

export interface StrategyInsight {
  strategyMode: string;
  conditionKey: string;
  conditionLabel: string;
  winRate: number;
  profitFactor: number;
  sampleCount: number;
  avgPnlPct: number;
  insightText: string;
  isActionable: boolean;
}

const MIN_SAMPLES = 5;

/** 전략 인사이트 생성 + DB 저장 */
export async function generateAndStoreInsights(days: number = 60): Promise<void> {
  const insights = await generateStrategyInsights(days);
  if (insights.length === 0) {
    logger.info('🧪 인사이트: 충분한 데이터 없음', { component: 'STRATEGY_LAB' });
    return;
  }

  const pool = getPool();
  let upserted = 0;
  for (const i of insights) {
    try {
      await pool.query(`
        INSERT INTO strategy_insights
          (strategy_mode, condition_key, condition_label, win_rate, profit_factor,
           sample_count, avg_pnl_pct, insight_text, is_actionable, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (strategy_mode, condition_key) DO UPDATE SET
          condition_label = $3, win_rate = $4, profit_factor = $5,
          sample_count = $6, avg_pnl_pct = $7, insight_text = $8,
          is_actionable = $9, updated_at = NOW()
      `, [
        i.strategyMode, i.conditionKey, i.conditionLabel,
        i.winRate, i.profitFactor, i.sampleCount, i.avgPnlPct,
        i.insightText, i.isActionable,
      ]);
      upserted++;
    } catch { /* individual insert fail → skip */ }
  }

  logger.info(`🧪 인사이트 갱신: ${upserted}/${insights.length}건 저장`, { component: 'STRATEGY_LAB' });
}

/** 전략 인사이트 분석 (DB 조회 → 집계) */
export async function generateStrategyInsights(days: number = 60): Promise<StrategyInsight[]> {
  const insights: StrategyInsight[] = [];

  try {
    const [byMode, byHour, byDow, byHolding, bySource] = await Promise.all([
      analyzeByStrategyMode(days),
      analyzeByHour(days),
      analyzeByDayOfWeek(days),
      analyzeByHoldingBucket(days),
      analyzeByEntrySource(days),
    ]);
    insights.push(...byMode, ...byHour, ...byDow, ...byHolding, ...bySource);
  } catch (e) {
    logger.warn(`인사이트 분석 실패: ${e}`, { component: 'STRATEGY_LAB' });
  }

  return insights.filter(i => i.sampleCount >= MIN_SAMPLES);
}

// ── 전략별 전체 비교 ──────────────────────────────────────────────────
async function analyzeByStrategyMode(days: number): Promise<StrategyInsight[]> {
  const { rows } = await getPool().query(`
    SELECT strategy_mode,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE realized_pnl > 0) as wins,
      SUM(realized_pnl) as total_pnl,
      AVG(CASE WHEN realized_pnl > 0 THEN realized_pnl END) as avg_win,
      AVG(CASE WHEN realized_pnl <= 0 THEN ABS(realized_pnl) END) as avg_loss,
      AVG(CASE WHEN avg_buy_price > 0 THEN
        ((COALESCE((SELECT filled_price FROM orders WHERE chain_id = tc.id AND side='SELL' AND status='FILLED' ORDER BY created_at DESC LIMIT 1), avg_buy_price) - avg_buy_price) / avg_buy_price * 100)
      END) as avg_pnl_pct
    FROM transaction_chains tc
    WHERE status = 'CLOSED' AND is_paper = true
      AND closed_at >= NOW() - ($1 * INTERVAL '1 day')
    GROUP BY strategy_mode
    HAVING COUNT(*) >= $2
  `, [days, MIN_SAMPLES]);

  return rows.map((r: any) => buildInsight(r.strategy_mode, 'mode:overall', '전체', r, `${r.strategy_mode} 전체 성과`));
}

// ── 시간대별 분석 ──────────────────────────────────────────────────────
async function analyzeByHour(days: number): Promise<StrategyInsight[]> {
  const { rows } = await getPool().query(`
    SELECT strategy_mode,
      EXTRACT(HOUR FROM opened_at AT TIME ZONE 'Asia/Seoul')::int as entry_hour,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE realized_pnl > 0) as wins,
      SUM(realized_pnl) as total_pnl,
      AVG(CASE WHEN realized_pnl > 0 THEN realized_pnl END) as avg_win,
      AVG(CASE WHEN realized_pnl <= 0 THEN ABS(realized_pnl) END) as avg_loss,
      AVG(CASE WHEN avg_buy_price > 0 THEN
        ((COALESCE((SELECT filled_price FROM orders WHERE chain_id = tc.id AND side='SELL' AND status='FILLED' ORDER BY created_at DESC LIMIT 1), avg_buy_price) - avg_buy_price) / avg_buy_price * 100)
      END) as avg_pnl_pct
    FROM transaction_chains tc
    WHERE status = 'CLOSED' AND is_paper = true
      AND closed_at >= NOW() - ($1 * INTERVAL '1 day')
    GROUP BY strategy_mode, entry_hour
    HAVING COUNT(*) >= $2
  `, [days, MIN_SAMPLES]);

  return rows.map((r: any) =>
    buildInsight(r.strategy_mode, `hour:${r.entry_hour}`, `${r.entry_hour}시대 진입`, r,
      `${r.strategy_mode} ${r.entry_hour}시대 진입`));
}

// ── 요일별 분석 ──────────────────────────────────────────────────────
async function analyzeByDayOfWeek(days: number): Promise<StrategyInsight[]> {
  const dowNames = ['일', '월', '화', '수', '목', '금', '토'];
  const { rows } = await getPool().query(`
    SELECT strategy_mode,
      EXTRACT(DOW FROM opened_at AT TIME ZONE 'Asia/Seoul')::int as entry_dow,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE realized_pnl > 0) as wins,
      SUM(realized_pnl) as total_pnl,
      AVG(CASE WHEN realized_pnl > 0 THEN realized_pnl END) as avg_win,
      AVG(CASE WHEN realized_pnl <= 0 THEN ABS(realized_pnl) END) as avg_loss,
      AVG(CASE WHEN avg_buy_price > 0 THEN
        ((COALESCE((SELECT filled_price FROM orders WHERE chain_id = tc.id AND side='SELL' AND status='FILLED' ORDER BY created_at DESC LIMIT 1), avg_buy_price) - avg_buy_price) / avg_buy_price * 100)
      END) as avg_pnl_pct
    FROM transaction_chains tc
    WHERE status = 'CLOSED' AND is_paper = true
      AND closed_at >= NOW() - ($1 * INTERVAL '1 day')
    GROUP BY strategy_mode, entry_dow
    HAVING COUNT(*) >= $2
  `, [days, MIN_SAMPLES]);

  return rows.map((r: any) =>
    buildInsight(r.strategy_mode, `dow:${r.entry_dow}`, `${dowNames[r.entry_dow]}요일 진입`, r,
      `${r.strategy_mode} ${dowNames[r.entry_dow]}요일 진입`));
}

// ── 보유기간별 분석 ──────────────────────────────────────────────────
async function analyzeByHoldingBucket(days: number): Promise<StrategyInsight[]> {
  const { rows } = await getPool().query(`
    SELECT strategy_mode,
      CASE
        WHEN EXTRACT(EPOCH FROM (closed_at - opened_at))/3600 < 8 THEN 'intraday'
        WHEN EXTRACT(EPOCH FROM (closed_at - opened_at))/86400 <= 3 THEN '1-3d'
        WHEN EXTRACT(EPOCH FROM (closed_at - opened_at))/86400 <= 7 THEN '3-7d'
        ELSE '7d+'
      END as hold_bucket,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE realized_pnl > 0) as wins,
      SUM(realized_pnl) as total_pnl,
      AVG(CASE WHEN realized_pnl > 0 THEN realized_pnl END) as avg_win,
      AVG(CASE WHEN realized_pnl <= 0 THEN ABS(realized_pnl) END) as avg_loss,
      AVG(CASE WHEN avg_buy_price > 0 THEN
        ((COALESCE((SELECT filled_price FROM orders WHERE chain_id = tc.id AND side='SELL' AND status='FILLED' ORDER BY created_at DESC LIMIT 1), avg_buy_price) - avg_buy_price) / avg_buy_price * 100)
      END) as avg_pnl_pct
    FROM transaction_chains tc
    WHERE status = 'CLOSED' AND is_paper = true
      AND closed_at >= NOW() - ($1 * INTERVAL '1 day')
    GROUP BY strategy_mode, hold_bucket
    HAVING COUNT(*) >= $2
  `, [days, MIN_SAMPLES]);

  const bucketLabels: Record<string, string> = {
    'intraday': '당일 청산', '1-3d': '1~3일 보유', '3-7d': '3~7일 보유', '7d+': '7일+ 보유',
  };
  return rows.map((r: any) =>
    buildInsight(r.strategy_mode, `hold:${r.hold_bucket}`, bucketLabels[r.hold_bucket] ?? r.hold_bucket, r,
      `${r.strategy_mode} ${bucketLabels[r.hold_bucket] ?? r.hold_bucket}`));
}

// ── 진입소스별 분석 ──────────────────────────────────────────────────
async function analyzeByEntrySource(days: number): Promise<StrategyInsight[]> {
  const { rows } = await getPool().query(`
    SELECT tc.strategy_mode,
      COALESCE(
        (SELECT o.trigger_source FROM orders o WHERE o.chain_id = tc.id AND o.side = 'BUY' ORDER BY o.created_at LIMIT 1),
        'UNKNOWN'
      ) as entry_source,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE tc.realized_pnl > 0) as wins,
      SUM(tc.realized_pnl) as total_pnl,
      AVG(CASE WHEN tc.realized_pnl > 0 THEN tc.realized_pnl END) as avg_win,
      AVG(CASE WHEN tc.realized_pnl <= 0 THEN ABS(tc.realized_pnl) END) as avg_loss,
      AVG(CASE WHEN tc.avg_buy_price > 0 THEN
        ((COALESCE((SELECT filled_price FROM orders WHERE chain_id = tc.id AND side='SELL' AND status='FILLED' ORDER BY created_at DESC LIMIT 1), tc.avg_buy_price) - tc.avg_buy_price) / tc.avg_buy_price * 100)
      END) as avg_pnl_pct
    FROM transaction_chains tc
    WHERE tc.status = 'CLOSED' AND tc.is_paper = true
      AND tc.closed_at >= NOW() - ($1 * INTERVAL '1 day')
    GROUP BY tc.strategy_mode, entry_source
    HAVING COUNT(*) >= $2
  `, [days, MIN_SAMPLES]);

  return rows.map((r: any) =>
    buildInsight(r.strategy_mode, `source:${r.entry_source}`, `${r.entry_source} 진입`, r,
      `${r.strategy_mode} ${r.entry_source} 진입`));
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────

function buildInsight(
  mode: string, key: string, label: string,
  row: { total: number; wins: number; avg_win: number | null; avg_loss: number | null; avg_pnl_pct: number | null },
  prefix: string,
): StrategyInsight {
  const total = Number(row.total);
  const wins = Number(row.wins);
  const wr = total > 0 ? wins / total : 0;
  const avgWin = Number(row.avg_win ?? 0);
  const avgLoss = Number(row.avg_loss ?? 1);
  const pf = avgLoss > 0 ? avgWin / avgLoss : 0;
  const avgPnl = Number(row.avg_pnl_pct ?? 0);
  const isActionable = wr > 0.6 && pf > 1.5 && total >= 10;

  return {
    strategyMode: mode,
    conditionKey: key,
    conditionLabel: label,
    winRate: Math.round(wr * 10000) / 10000,
    profitFactor: Math.round(pf * 100) / 100,
    sampleCount: total,
    avgPnlPct: Math.round(avgPnl * 100) / 100,
    insightText: `${prefix}: 승률 ${(wr * 100).toFixed(0)}%, PF ${pf.toFixed(2)} (${total}건)`,
    isActionable,
  };
}
