-- 034: seed_capital 컬럼 추가 — KIS 동기화 시드 저장용 (부팅 시 KIS 순자산으로 자동 갱신)
ALTER TABLE portfolio_allocation_config ADD COLUMN IF NOT EXISTS seed_capital NUMERIC NOT NULL DEFAULT 0;
