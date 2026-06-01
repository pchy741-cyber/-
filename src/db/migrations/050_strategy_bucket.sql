-- 황금비율 자금배분: 보유종목 버킷 태깅
ALTER TABLE overseas_holdings ADD COLUMN IF NOT EXISTS strategy_bucket TEXT DEFAULT 'SWING';
