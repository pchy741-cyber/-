-- Migration 018: 인라인 DDL 통합
-- main.ts / settings.ts / overseas.ts / self-learning.ts 에 흩어져 있던
-- CREATE/ALTER TABLE 구문을 여기에 집중 관리 (소스코드에서 제거 가능)

-- ── portfolio_allocation_config: 거래모드 오버라이드 ──
ALTER TABLE portfolio_allocation_config
  ADD COLUMN IF NOT EXISTS trading_mode_override VARCHAR(10);

-- ── strategy_config: 전략 문서·프롬프트 컬럼 ──
ALTER TABLE strategy_config
  ADD COLUMN IF NOT EXISTS notebooklm_prompt TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS strategy_document  TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS risk_prompt        TEXT DEFAULT '';

-- ── learned_insights: 자기학습 컬럼 ──
ALTER TABLE learned_insights
  ADD COLUMN IF NOT EXISTS recommendation TEXT,
  ADD COLUMN IF NOT EXISTS param_change   JSONB,
  ADD COLUMN IF NOT EXISTS is_applied     BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS applied_at     TIMESTAMPTZ;

-- ── overseas_holdings: 스캘핑 TP/SL 컬럼 ──
ALTER TABLE overseas_holdings
  ADD COLUMN IF NOT EXISTS scalp_tp NUMERIC DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS scalp_sl NUMERIC DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_scalp BOOLEAN DEFAULT FALSE;

-- ── push_subscriptions: 마지막 사용 시각 ──
ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
