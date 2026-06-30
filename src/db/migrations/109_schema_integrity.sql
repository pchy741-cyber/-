-- 109: 전수조사 발견 — 스키마 무결성 수정
-- (1) transaction_chains.metadata DDL 누락 보충 (partial-tp.ts에서 사용 중이나 DDL 없었음)
-- (2) 누락 인덱스 추가
-- (3) CHECK 제약 추가

-- ══════════════════════════════════════════════════════════════
-- 1. transaction_chains.metadata — partial_tp_stage 추적용 JSONB
-- ══════════════════════════════════════════════════════════════
ALTER TABLE transaction_chains ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- ══════════════════════════════════════════════════════════════
-- 2. 누락 인덱스
-- ══════════════════════════════════════════════════════════════
-- orders: trigger_source 기반 필터 (해외 FILLED 등 20+곳 사용)
CREATE INDEX IF NOT EXISTS idx_orders_trigger_source ON orders (trigger_source, created_at DESC);

-- transaction_chains: closed_at 기반 쿨다운 체크 빈번
CREATE INDEX IF NOT EXISTS idx_chains_closed_at ON transaction_chains (closed_at DESC) WHERE closed_at IS NOT NULL;

-- portfolio_snapshots: is_paper + snapshot_at 복합 인덱스 (모든 쿼리 패턴)
CREATE INDEX IF NOT EXISTS idx_snapshots_paper_time ON portfolio_snapshots (is_paper, snapshot_at DESC);

-- ══════════════════════════════════════════════════════════════
-- 3. CHECK 제약 — 매직 스트링 DB 레벨 검증
-- ══════════════════════════════════════════════════════════════
-- strategy_config.mode 유효값 검증
DO $$ BEGIN
  ALTER TABLE strategy_config ADD CONSTRAINT chk_strategy_config_mode
    CHECK (mode IN ('SWING','DEFENSE','SCALPING','DIVIDEND','SNIPER','BOTTOM_FISHING','EOD_BETTING','BREAKOUT'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- transaction_chains.strategy_mode 유효값 검증
DO $$ BEGIN
  ALTER TABLE transaction_chains ADD CONSTRAINT chk_chains_strategy_mode
    CHECK (strategy_mode IN ('SWING','DEFENSE','SCALPING','DIVIDEND','SNIPER','BOTTOM_FISHING','EOD_BETTING','BREAKOUT'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- transaction_chains.status 유효값 검증
DO $$ BEGIN
  ALTER TABLE transaction_chains ADD CONSTRAINT chk_chains_status
    CHECK (status IN ('OPEN','AVERAGING','PROFIT_TAKING','CLOSED'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- orders.status 유효값 검증
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT chk_orders_status
    CHECK (status IN ('PENDING','FILLED','PARTIAL','CANCELLED','FAILED'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- orders.side 유효값 검증
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT chk_orders_side
    CHECK (side IN ('BUY','SELL'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- overseas_holdings.strategy_bucket 유효값 검증
DO $$ BEGIN
  ALTER TABLE overseas_holdings ADD CONSTRAINT chk_overseas_strategy_bucket
    CHECK (strategy_bucket IN ('SWING','CORE','TACTICAL'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- orders.trading_mode 유효값 검증
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT chk_orders_trading_mode
    CHECK (trading_mode IN ('paper','live','p_arch'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ══════════════════════════════════════════════════════════════
-- 4. 미사용 컬럼 삭제
-- ══════════════════════════════════════════════════════════════
ALTER TABLE portfolio_allocation_config DROP COLUMN IF EXISTS parking_pct;
ALTER TABLE portfolio_allocation_config DROP COLUMN IF EXISTS dividend_pct;
ALTER TABLE push_subscriptions DROP COLUMN IF EXISTS user_agent;
ALTER TABLE capture_snapshots DROP COLUMN IF EXISTS screenshot_count;
