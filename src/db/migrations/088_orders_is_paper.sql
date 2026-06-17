-- 088_orders_is_paper.sql
-- orders 테이블에 is_paper 컬럼 추가 (trading_mode에서 derived)
-- 원인: trade-routes.ts, daily-report.ts 등 7개 파일이 orders.is_paper를 참조하지만
--       001_initial.sql에 컬럼이 없어 DB 에러 → 매매내역 전체 미표시 버그
--
-- live=false, paper/p_arch=true (p_arch = paper 아카이브 모드)

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS is_paper BOOLEAN
  GENERATED ALWAYS AS (trading_mode IN ('paper', 'p_arch')) STORED;

CREATE INDEX IF NOT EXISTS idx_orders_is_paper ON orders(is_paper, created_at DESC);
