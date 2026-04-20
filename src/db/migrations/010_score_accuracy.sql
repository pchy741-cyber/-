-- 010: score accuracy tracking — 종목별 AI 예측 정확도 누적
-- 체인 종료 시마다 해당 종목의 진입 당시 스코어 vs 실제 결과 기록

CREATE TABLE IF NOT EXISTS score_accuracy (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_code    VARCHAR(20) NOT NULL,
  chain_id      UUID REFERENCES transaction_chains(id),
  entry_score   SMALLINT,           -- Track A 진입 당시 composite_score
  entry_signal  VARCHAR(20),        -- BUY / STRONG_BUY / HOLD 등
  entry_confidence DECIMAL(4,3),
  realized_pnl_pct DECIMAL(8,4),   -- 실현 손익률 (%)
  outcome       VARCHAR(10) NOT NULL CHECK (outcome IN ('WIN','LOSS','BREAK_EVEN')),
  holding_days  SMALLINT,
  close_reason  TEXT,
  strategy_mode VARCHAR(15),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_score_accuracy_stock ON score_accuracy(stock_code);
CREATE INDEX IF NOT EXISTS idx_score_accuracy_recorded ON score_accuracy(recorded_at DESC);
