-- 104: transaction_chains에 stock_name 컬럼 추가
-- ai-loop.ts:83 (SELECT), builder.ts:194 (UPDATE)에서 참조하지만 DDL에 없어 silent fail
-- watchlist JOIN 없이 직접 조회/캐싱 가능하도록 컬럼 추가
ALTER TABLE transaction_chains ADD COLUMN IF NOT EXISTS stock_name VARCHAR(100) DEFAULT NULL;

-- 기존 체인: watchlist에서 stock_name 백필
UPDATE transaction_chains tc
SET stock_name = w.stock_name
FROM watchlist w
WHERE tc.stock_code = w.stock_code
  AND (tc.stock_name IS NULL OR tc.stock_name = tc.stock_code);
