-- Strategy Lab v2: 인사이트 승인 플로우, 스플릿 테스트, CEO 개입 추적
-- Migration 089

-- strategy_insights: 승인 플로우 + suggested_action 추가
ALTER TABLE strategy_insights
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS suggested_action JSONB,
  ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS applied_by TEXT;

CREATE INDEX IF NOT EXISTS idx_strategy_insights_status ON strategy_insights(status);

-- strategy_splits: A/B 파라미터 분할 테스트 테이블
CREATE TABLE IF NOT EXISTS strategy_splits (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  strategy_mode   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | COMPLETED | CANCELLED
  variant_a       JSONB NOT NULL,   -- 현재 실전 파라미터 (control)
  variant_b       JSONB NOT NULL,   -- 테스트할 파라미터 변형 (treatment)
  min_trades      INT NOT NULL DEFAULT 20,
  paper_pnl_a     DECIMAL(12,2) DEFAULT 0,
  paper_pnl_b     DECIMAL(12,2) DEFAULT 0,
  trades_a        INT DEFAULT 0,
  trades_b        INT DEFAULT 0,
  win_rate_a      DECIMAL(5,4) DEFAULT 0,
  win_rate_b      DECIMAL(5,4) DEFAULT 0,
  winner          TEXT,             -- 'A' | 'B' | null
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_strategy_splits_status ON strategy_splits(status, strategy_mode);

-- CEO 오버라이드 성과 추적
CREATE TABLE IF NOT EXISTS ceo_overrides (
  id              SERIAL PRIMARY KEY,
  override_key    TEXT NOT NULL,
  category        TEXT NOT NULL,
  value           JSONB NOT NULL,
  description     TEXT,
  pnl_before      DECIMAL(12,2),   -- 적용 전 24h 누적 PnL
  pnl_after       DECIMAL(12,2),   -- 적용 후 24h 누적 PnL
  impact_pct      DECIMAL(8,2),    -- (pnl_after - pnl_before) / |pnl_before| * 100
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at      TIMESTAMPTZ,
  removed_reason  TEXT
);

CREATE INDEX IF NOT EXISTS idx_ceo_overrides_active ON ceo_overrides(removed_at) WHERE removed_at IS NULL;
