-- Strategy Lab: paper → live 졸업 기록 + CEO 승인 워크플로우
CREATE TABLE IF NOT EXISTS strategy_graduations (
  id            SERIAL PRIMARY KEY,
  strategy_mode TEXT NOT NULL,
  risk_level    TEXT NOT NULL DEFAULT 'HIGH',
  status        TEXT NOT NULL DEFAULT 'PENDING',

  trades        INT NOT NULL DEFAULT 0,
  win_rate      DECIMAL(5,4) NOT NULL DEFAULT 0,
  profit_factor DECIMAL(6,2) NOT NULL DEFAULT 0,
  mdd           DECIMAL(6,2) NOT NULL DEFAULT 0,
  total_pnl_krw BIGINT NOT NULL DEFAULT 0,
  avg_holding_days DECIMAL(5,1) NOT NULL DEFAULT 0,
  criteria_margin  JSONB,

  auto_applied    BOOLEAN NOT NULL DEFAULT FALSE,
  decided_by      TEXT,
  approval_reason TEXT,
  rejected_reason TEXT,
  applied_changes JSONB,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days'
);

CREATE INDEX IF NOT EXISTS idx_strat_grad_status ON strategy_graduations(status, strategy_mode);
CREATE INDEX IF NOT EXISTS idx_strat_grad_created ON strategy_graduations(created_at DESC);

-- Strategy Lab: 조건별 성과 인사이트
CREATE TABLE IF NOT EXISTS strategy_insights (
  id            SERIAL PRIMARY KEY,
  strategy_mode TEXT NOT NULL,
  condition_key TEXT NOT NULL,
  condition_label TEXT NOT NULL,
  win_rate      DECIMAL(5,4) NOT NULL DEFAULT 0,
  profit_factor DECIMAL(6,2) NOT NULL DEFAULT 0,
  sample_count  INT NOT NULL DEFAULT 0,
  avg_pnl_pct   DECIMAL(6,2) NOT NULL DEFAULT 0,
  insight_text  TEXT NOT NULL,
  is_actionable BOOLEAN DEFAULT FALSE,
  suggested_action JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_strat_insights_key
  ON strategy_insights(strategy_mode, condition_key);
