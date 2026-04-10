-- ============================================
-- 004: 성능 인덱스 + 안정성 개선
-- ============================================

-- orders 테이블 — 상태별 조회 (unfilled-order-job, executor)
CREATE INDEX IF NOT EXISTS idx_orders_status_created
  ON orders(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_stock_code
  ON orders(stock_code);

CREATE INDEX IF NOT EXISTS idx_orders_kis_order_no
  ON orders(kis_order_no)
  WHERE kis_order_no IS NOT NULL;

-- transaction_chains 테이블 — 열린 체인 조회 (매 Track B 실행마다)
CREATE INDEX IF NOT EXISTS idx_chains_status
  ON transaction_chains(status)
  WHERE status != 'CLOSED';

CREATE INDEX IF NOT EXISTS idx_chains_stock_code
  ON transaction_chains(stock_code);

CREATE INDEX IF NOT EXISTS idx_chains_strategy_mode
  ON transaction_chains(strategy_mode, status);

-- ai_scores 테이블 — 최신 스코어 조회
CREATE INDEX IF NOT EXISTS idx_scores_stock_date
  ON ai_scores(stock_code, score_date DESC);

CREATE INDEX IF NOT EXISTS idx_scores_date
  ON ai_scores(score_date DESC);

-- watchlist 테이블 — 활성 종목 조회
CREATE INDEX IF NOT EXISTS idx_watchlist_active
  ON watchlist(is_active)
  WHERE is_active = true;

-- portfolio_snapshots — 최근 스냅샷 조회
CREATE INDEX IF NOT EXISTS idx_snapshots_at
  ON portfolio_snapshots(snapshot_at DESC);

-- risk_events — 최근 이벤트 조회
CREATE INDEX IF NOT EXISTS idx_risk_events_created
  ON risk_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risk_events_severity
  ON risk_events(severity, created_at DESC);

-- system_log — 컴포넌트별 로그 조회 (timestamp 컬럼 사용)
CREATE INDEX IF NOT EXISTS idx_system_log_component
  ON system_log(component, timestamp DESC);

-- avg_buy_price NOT NULL 기본값 (NULL 방지)
ALTER TABLE transaction_chains
  ALTER COLUMN avg_buy_price SET DEFAULT 0;

ALTER TABLE transaction_chains
  ALTER COLUMN target_profit_pct SET DEFAULT 4.0;

ALTER TABLE transaction_chains
  ALTER COLUMN stop_loss_pct SET DEFAULT -3.0;

-- 기존 NULL 값 정리
UPDATE transaction_chains
  SET avg_buy_price = 0 WHERE avg_buy_price IS NULL;

UPDATE transaction_chains
  SET target_profit_pct = 4.0 WHERE target_profit_pct IS NULL;

UPDATE transaction_chains
  SET stop_loss_pct = -3.0 WHERE stop_loss_pct IS NULL;
