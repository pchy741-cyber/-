-- 058: 복합 인덱스 추가 (성능 최적화)
-- transaction_chains: Track B 매 3분 조회 (is_paper + status)
CREATE INDEX IF NOT EXISTS idx_chains_is_paper_status ON transaction_chains(is_paper, status);

-- portfolio_snapshots: 스냅샷 조회 (is_paper + snapshot_at)
CREATE INDEX IF NOT EXISTS idx_snapshots_is_paper_at ON portfolio_snapshots(is_paper, snapshot_at DESC);

-- orders: 미체결 주문 조회 + 성과 분석 (trading_mode + status + created_at)
CREATE INDEX IF NOT EXISTS idx_orders_mode_status_created ON orders(trading_mode, status, created_at DESC);
