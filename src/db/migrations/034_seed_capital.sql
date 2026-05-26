-- 034: 초기 투자금(seed_capital) 컬럼 추가 — 손실한도 계산 기준
ALTER TABLE portfolio_allocation_config ADD COLUMN IF NOT EXISTS seed_capital NUMERIC NOT NULL DEFAULT 10000000;
