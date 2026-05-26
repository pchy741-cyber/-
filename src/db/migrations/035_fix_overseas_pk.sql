-- 035_fix_overseas_pk.sql
-- overseas_holdings PK: (exchange, stock_code) → (exchange, stock_code, is_paper)

-- is_paper 컬럼 보장
ALTER TABLE overseas_holdings ADD COLUMN IF NOT EXISTS is_paper BOOLEAN NOT NULL DEFAULT true;

-- 기존 PK 삭제
ALTER TABLE overseas_holdings DROP CONSTRAINT IF EXISTS overseas_holdings_pkey;

-- 새 PK 추가 (is_paper 포함)
ALTER TABLE overseas_holdings ADD PRIMARY KEY (exchange, stock_code, is_paper);

-- 기존 unique index 삭제 (PK가 이미 유니크를 보장)
DROP INDEX IF EXISTS overseas_holdings_exch_code_paper_idx;

-- orders 복합인덱스: risk-intelligence 쿼리 최적화
CREATE INDEX IF NOT EXISTS idx_orders_overseas_sell_analytics
  ON orders (trigger_source, status, side, created_at DESC)
  WHERE trigger_source = 'OVERSEAS' AND status = 'FILLED' AND side = 'SELL';

-- DB 오래된 partialtpdone_* 키 정리 (3단계로 이전됨)
DELETE FROM overseas_state WHERE key LIKE 'partialtpdone_%'
