-- 103: overseas_holdings.max_price 컬럼 누락 수정
-- trade-tuner.ts, overseas.ts 등에서 max_price 참조하지만 DDL에 없어 런타임 에러
ALTER TABLE overseas_holdings ADD COLUMN IF NOT EXISTS max_price NUMERIC DEFAULT NULL;
