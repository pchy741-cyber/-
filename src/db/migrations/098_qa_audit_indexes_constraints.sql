-- v10.10.5: QA 전수조사 — 누락 인덱스 + CHECK 제약조건 추가
-- 2026-06-23

-- ── 1. CRITICAL: score_accuracy 인덱스 누락 (15+ 쿼리 영향) ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_score_accuracy_paper_date
  ON score_accuracy (is_paper, recorded_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_score_accuracy_calibration
  ON score_accuracy (is_paper, recorded_at DESC, entry_score)
  WHERE entry_score IS NOT NULL;

-- ── 2. learned_insights 커버링 인덱스 (confidence 정렬) ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_insights_paper_confidence
  ON learned_insights (is_paper, confidence DESC)
  WHERE COALESCE(is_dismissed, false) IS NOT TRUE;

-- ── 3. 중복 인덱스 제거 (overseas_state PK와 동일) ──
DROP INDEX CONCURRENTLY IF EXISTS idx_overseas_state_key;

-- ── 4. 중복 인덱스 정리 (transaction_chains) ──
-- idx_chains_paper_status_opened(084)가 idx_chains_mode(020) + idx_chains_is_paper_status(058) 상위호환
DROP INDEX CONCURRENTLY IF EXISTS idx_chains_mode;
DROP INDEX CONCURRENTLY IF EXISTS idx_chains_is_paper_status;

-- ── 5. orders 중복 인덱스 정리 + partial index 재생성 ──
DROP INDEX CONCURRENTLY IF EXISTS idx_orders_trading_mode;
-- 084에서 이름 충돌로 생성 실패한 partial index 재생성 (다른 이름)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_mode_pending
  ON orders (trading_mode, status, created_at DESC)
  WHERE status IN ('PENDING', 'PARTIAL');

-- ── 6. CHECK 제약조건 추가 (데이터 무결성) ──
DO $$ BEGIN
  -- transaction_chains.status 검증
  BEGIN
    ALTER TABLE transaction_chains
      ADD CONSTRAINT chk_chains_status
      CHECK (status IN ('OPEN', 'AVERAGING', 'PROFIT_TAKING', 'CLOSED'));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  -- orders.side 검증
  BEGIN
    ALTER TABLE orders
      ADD CONSTRAINT chk_orders_side
      CHECK (side IN ('BUY', 'SELL'));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  -- orders.status 검증
  BEGIN
    ALTER TABLE orders
      ADD CONSTRAINT chk_orders_status
      CHECK (status IN ('PENDING', 'PARTIAL', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;
