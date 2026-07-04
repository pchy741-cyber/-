-- 토너먼트 전략별 일일 성과 추적 (Paper 전수조사 강화)
CREATE TABLE IF NOT EXISTS tournament_results (
  id SERIAL PRIMARY KEY,
  strategy_mode TEXT NOT NULL,
  run_date DATE NOT NULL DEFAULT CURRENT_DATE,
  decisions_count INT DEFAULT 0,
  buys INT DEFAULT 0,
  sells INT DEFAULT 0,
  realized_pnl NUMERIC(14,2) DEFAULT 0,
  win_count INT DEFAULT 0,
  loss_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(strategy_mode, run_date)
);

CREATE INDEX IF NOT EXISTS idx_tournament_results_date ON tournament_results(run_date DESC);
