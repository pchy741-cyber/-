-- 036_fix_pk_retry.sql
-- 035의 DO block이 statement splitter와 호환안됨 → 재시도

-- 기존 PK 삭제 (IF EXISTS로 안전)
ALTER TABLE overseas_holdings DROP CONSTRAINT IF EXISTS overseas_holdings_pkey;

-- 새 PK 추가 (is_paper 포함)
ALTER TABLE overseas_holdings ADD PRIMARY KEY (exchange, stock_code, is_paper);

-- 기존 unique index 삭제 (PK가 이미 유니크를 보장하므로 중복)
DROP INDEX IF EXISTS overseas_holdings_exch_code_paper_idx
