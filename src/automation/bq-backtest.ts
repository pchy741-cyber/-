/**
 * 📊 BigQuery 백테스트 가속 — quantops-trading 프로젝트 무료 한도 활용
 *
 * 무료 한도:
 *  - 매월 1TB 처리 무료
 *  - 저장: 매월 10GB 무료
 *  - $300 크레딧 (신규 GCP 가입 시)
 *
 * 활용:
 *  - orders 테이블 매월 → BigQuery 자동 적재 (이미 BigQueryPipeline 존재)
 *  - 1년 백테스트 SQL → BigQuery 30초 (PG는 10분+)
 *  - 전략 파라미터 그리드 서치 가속
 *
 * Gemini 미관여 — 순수 데이터 처리
 */

import { logger } from '../utils/logger.js';

const COMP = 'BQ_BACKTEST';

export interface BacktestResult {
  strategyMode: string;
  startDate: string;
  endDate: string;
  totalTrades: number;
  winRate: number;
  avgPnlPct: number;
  totalPnlPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  sharpeRatio: number;
}

/**
 * BigQuery로 백테스트 — orders + transaction_chains 분석
 * (BigQueryPipeline이 활성화되어 데이터가 적재되어 있어야 함)
 */
export async function runBqBacktest(opts: {
  strategyMode?: string;
  daysBack?: number;
  isPaper?: boolean;
}): Promise<BacktestResult | null> {
  try {
    const { BigQuery } = await import('@google-cloud/bigquery');
    const bq = new BigQuery({ projectId: 'quantops-trading' });
    const daysBack = opts.daysBack ?? 365;
    const isPaper = opts.isPaper ?? false;
    const modeFilter = opts.strategyMode ? `AND strategy_mode = '${opts.strategyMode}'` : '';

    const query = `
      WITH closed_chains AS (
        SELECT
          stock_code,
          strategy_mode,
          realized_pnl,
          (realized_pnl / NULLIF(total_invested, 0)) * 100 AS pnl_pct,
          opened_at,
          closed_at
        FROM \`quantops-trading.quantops.transaction_chains\`
        WHERE status = 'CLOSED'
          AND is_paper = @isPaper
          AND closed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${daysBack} DAY)
          ${modeFilter}
      ),
      cumulative AS (
        SELECT
          pnl_pct,
          closed_at,
          SUM(pnl_pct) OVER (ORDER BY closed_at) AS cum_pnl,
          MAX(SUM(pnl_pct) OVER (ORDER BY closed_at))
            OVER (ORDER BY closed_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS peak_pnl
        FROM closed_chains
      )
      SELECT
        '${opts.strategyMode ?? 'ALL'}' AS strategy_mode,
        FORMAT_TIMESTAMP('%Y-%m-%d', MIN(cc.closed_at)) AS start_date,
        FORMAT_TIMESTAMP('%Y-%m-%d', MAX(cc.closed_at)) AS end_date,
        COUNT(*) AS total_trades,
        COUNTIF(cc.pnl_pct > 0) / NULLIF(COUNT(*), 0) * 100 AS win_rate,
        AVG(cc.pnl_pct) AS avg_pnl_pct,
        SUM(cc.pnl_pct) AS total_pnl_pct,
        SUM(CASE WHEN cc.pnl_pct > 0 THEN cc.pnl_pct ELSE 0 END) /
          NULLIF(ABS(SUM(CASE WHEN cc.pnl_pct < 0 THEN cc.pnl_pct ELSE 0 END)), 0) AS profit_factor,
        STDDEV(cc.pnl_pct) AS std_pnl,
        (SELECT MAX(c.peak_pnl - c.cum_pnl) FROM cumulative c) AS max_drawdown_pct
      FROM closed_chains cc
    `;
    const [rows] = await bq.query({
      query,
      params: { isPaper },
      types: { isPaper: 'BOOL' },
    });
    if (rows.length === 0) return null;
    const r = rows[0] as Record<string, unknown>;
    const avgPnl = Number(r.avg_pnl_pct ?? 0);
    const stdPnl = Number(r.std_pnl ?? 1);
    const sharpe = stdPnl > 0 ? avgPnl / stdPnl : 0;

    return {
      strategyMode: String(r.strategy_mode ?? 'ALL'),
      startDate: String(r.start_date ?? ''),
      endDate: String(r.end_date ?? ''),
      totalTrades: Number(r.total_trades ?? 0),
      winRate: Number(r.win_rate ?? 0),
      avgPnlPct: avgPnl,
      totalPnlPct: Number(r.total_pnl_pct ?? 0),
      maxDrawdownPct: Number(r.max_drawdown_pct ?? 0),
      profitFactor: Number(r.profit_factor ?? 0),
      sharpeRatio: sharpe,
    };
  } catch (e) {
    logger.warn(`BQ 백테스트 실패: ${e instanceof Error ? e.message : String(e)}`, { component: COMP });
    return null;
  }
}

/** 모든 전략 모드 백테스트 비교 — 최적 모드 찾기 */
export async function compareAllStrategies(daysBack = 365, isPaper = false): Promise<BacktestResult[]> {
  const modes = ['SWING', 'SCALPING', 'DEFENSE', 'SNIPER', 'BOTTOM_FISHING'];
  const results: BacktestResult[] = [];
  for (const mode of modes) {
    const r = await runBqBacktest({ strategyMode: mode, daysBack, isPaper });
    if (r) results.push(r);
  }
  // sharpe 내림차순 정렬
  return results.sort((a, b) => b.sharpeRatio - a.sharpeRatio);
}
