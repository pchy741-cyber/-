-- 108: transaction_chains 누락 컬럼 추가
-- C2: partial-tp.ts가 metadata JSONB 참조하지만 DDL 없음
-- C3: migration 070이 notes TEXT 참조하지만 DDL 없음

ALTER TABLE transaction_chains ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE transaction_chains ADD COLUMN IF NOT EXISTS notes TEXT;
