-- v28: 환전 실측 테이블
CREATE TABLE IF NOT EXISTS fx_ledger (
  id SERIAL PRIMARY KEY,
  direction VARCHAR(10) NOT NULL, -- KRW_TO_USD / USD_TO_KRW
  amount_usd NUMERIC(12,2),
  base_rate NUMERIC(8,2),
  actual_rate NUMERIC(8,2),
  spread_pct NUMERIC(5,4),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
