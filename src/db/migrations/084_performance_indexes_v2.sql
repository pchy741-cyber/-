-- 084: 성능 인덱스 v2 — getPendingDomesticOrders / getOpenChains / overseas_state 최적화
-- 조건부 인덱스로 활성 데이터만 인덱싱 → 스캔 범위 축소

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_mode_status_created
  ON orders (trading_mode, status, created_at DESC)
  WHERE status IN ('PENDING', 'PARTIAL');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chains_paper_status_opened
  ON transaction_chains (is_paper, status, opened_at DESC)
  WHERE status != 'CLOSED';

-- overseas_state key lookup 최적화 (100+ reads per cycle)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_overseas_state_key
  ON overseas_state (key);

-- 최근 매도 종목 조회 최적화 (getRecentlySoldStocks CTE)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chains_closed_recent
  ON transaction_chains (is_paper, status, closed_at DESC)
  WHERE status = 'CLOSED';
