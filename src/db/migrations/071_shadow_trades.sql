-- Shadow Tracker: AI 점수 상위 종목 가상매매 추적 (OOS 검증용)
-- 목적: AI 점수 → 실제 수익 예측력 검증 (Out-of-Sample forward testing)
-- 주의: 이 테이블은 실제 매매 기록이 아닌 가상 추적 데이터

CREATE TABLE IF NOT EXISTS shadow_trades (
  id             BIGSERIAL PRIMARY KEY,
  market         TEXT NOT NULL,           -- 'KR' | 'US'
  stock_code     TEXT NOT NULL,
  ai_score       NUMERIC(8,2) NOT NULL,   -- 진입 시점 AI 점수
  entry_price    NUMERIC(18,4) NOT NULL,
  tp_price       NUMERIC(18,4) NOT NULL,  -- +5.0% TP
  sl_price       NUMERIC(18,4) NOT NULL,  -- -2.5% SL
  exit_price     NUMERIC(18,4),
  exit_reason    TEXT,                    -- 'TP' | 'SL' | 'EOD'
  gross_pnl_pct  NUMERIC(10,4),          -- (exit - entry) / entry * 100
  friction_pct   NUMERIC(8,4) NOT NULL,  -- KR 0.25% / US 0.03%
  net_pnl_pct    NUMERIC(10,4),          -- gross_pnl_pct - friction_pct
  is_closed      BOOLEAN NOT NULL DEFAULT FALSE,
  entered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exited_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_shadow_trades_market_open ON shadow_trades(market, is_closed, entered_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_code        ON shadow_trades(stock_code, entered_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_date        ON shadow_trades(entered_at DESC);

COMMENT ON TABLE shadow_trades IS 'Shadow Tracker — AI 점수 상위 종목 가상매매 추적 (OOS 검증용, 실제 매매 아님)';
