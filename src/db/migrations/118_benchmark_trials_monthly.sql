-- v25 P1-1: 벤치마크 일별 종가 (SPY, KOSPI)
CREATE TABLE IF NOT EXISTS benchmark_prices (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,                -- 'SPY' | 'KOSPI'
  price_date DATE NOT NULL,
  close_price NUMERIC NOT NULL,
  source TEXT NOT NULL DEFAULT 'finnhub',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, price_date)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_prices_lookup
  ON benchmark_prices (symbol, price_date DESC);

-- v25 P1-2: 토너먼트/캘리브레이션 시도 기록 (DSR용)
CREATE TABLE IF NOT EXISTS strategy_trials (
  id BIGSERIAL PRIMARY KEY,
  tournament_id TEXT,                  -- 토너먼트/캘리브레이션 세션 ID
  params_hash TEXT NOT NULL,           -- 변형 파라미터 해시
  strategy_mode TEXT NOT NULL,
  sharpe_ratio NUMERIC,
  win_rate NUMERIC,
  total_pnl NUMERIC,
  sample_count INT NOT NULL DEFAULT 0,
  evaluation_days INT NOT NULL DEFAULT 30,
  is_paper BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategy_trials_tournament
  ON strategy_trials (tournament_id, strategy_mode);

-- v25 P2: 월별 수익률 뷰 (quantstats 히트맵 데이터)
CREATE OR REPLACE VIEW monthly_returns AS
SELECT
  is_paper,
  EXTRACT(YEAR FROM (snapshot_at AT TIME ZONE 'Asia/Seoul')) AS year,
  EXTRACT(MONTH FROM (snapshot_at AT TIME ZONE 'Asia/Seoul')) AS month,
  -- 월 첫/끝 종가 기반 수익률
  (MAX(total_value) FILTER (WHERE snapshot_at = last_snap) /
   NULLIF(MAX(total_value) FILTER (WHERE snapshot_at = first_snap), 0) - 1) * 100 AS return_pct
FROM (
  SELECT *,
    FIRST_VALUE(snapshot_at) OVER (PARTITION BY is_paper, DATE_TRUNC('month', snapshot_at AT TIME ZONE 'Asia/Seoul')
      ORDER BY snapshot_at ASC) AS first_snap,
    FIRST_VALUE(snapshot_at) OVER (PARTITION BY is_paper, DATE_TRUNC('month', snapshot_at AT TIME ZONE 'Asia/Seoul')
      ORDER BY snapshot_at DESC) AS last_snap
  FROM portfolio_snapshots
) sub
GROUP BY is_paper, year, month
ORDER BY year, month;
