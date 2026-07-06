-- v28: 집행 품질 측정 — 슬리피지 원장
CREATE TABLE IF NOT EXISTS slippage_ledger (
  id SERIAL PRIMARY KEY,
  order_no VARCHAR(30) NOT NULL,
  stock_code VARCHAR(20) NOT NULL,
  side VARCHAR(4) NOT NULL,
  signal_price NUMERIC(12,2),
  orderbook_snapshot JSONB,
  placed_price NUMERIC(12,2),
  filled_price NUMERIC(12,2),
  chase_count INT DEFAULT 0,
  elapsed_ms INT,
  strategy_mode VARCHAR(30),
  is_paper BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
