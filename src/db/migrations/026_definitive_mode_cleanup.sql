-- 026_definitive_mode_cleanup.sql
-- 마스터 스키마 정리: Paper/Live 데이터 완전 분리
-- 020~025 마이그레이션이 반복 수정한 문제를 한 번에 정리

-- ============================================================
-- Phase 1: 누락 컬럼 추가
-- ============================================================
ALTER TABLE overseas_holdings ADD COLUMN IF NOT EXISTS is_paper BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE score_accuracy ADD COLUMN IF NOT EXISTS is_paper BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- Phase 2: score_accuracy 역산 (체인 연결)
-- ============================================================
UPDATE score_accuracy sa
SET is_paper = tc.is_paper
FROM transaction_chains tc
WHERE sa.chain_id = tc.id
  AND sa.is_paper IS DISTINCT FROM tc.is_paper;

-- ============================================================
-- Phase 3: 체인 최종 분류 (우선순위 캐스케이드)
-- ============================================================

-- 3a: KIS 주문번호 있으면 → 무조건 실전 (VTS는 실제 주문번호 절대 안 줌)
UPDATE transaction_chains tc SET is_paper = false
WHERE is_paper = true
  AND EXISTS (SELECT 1 FROM orders o WHERE o.chain_id = tc.id
    AND o.kis_order_no IS NOT NULL AND TRIM(o.kis_order_no) != '');

-- 3b: FILLED live 주문 있으면 → 실전
UPDATE transaction_chains tc SET is_paper = false
WHERE is_paper = true
  AND EXISTS (SELECT 1 FROM orders o WHERE o.chain_id = tc.id
    AND o.trading_mode = 'live' AND o.status = 'FILLED');

-- 3c: paper 주문만 있으면 → 연습
UPDATE transaction_chains tc SET is_paper = true
WHERE is_paper = false
  AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.chain_id = tc.id
    AND (o.trading_mode = 'live'
      OR (o.kis_order_no IS NOT NULL AND TRIM(o.kis_order_no) != '')))
  AND EXISTS (SELECT 1 FROM orders o WHERE o.chain_id = tc.id AND o.trading_mode = 'paper');

-- ============================================================
-- Phase 4: 주문 trading_mode 체인에 맞춤 정합성 확보
-- ============================================================

-- 실전 체인의 paper 주문 → live로
UPDATE orders o SET trading_mode = 'live'
FROM transaction_chains tc
WHERE o.chain_id = tc.id AND tc.is_paper = false AND o.trading_mode = 'paper';

-- 연습 체인의 live 주문 (KIS 번호 없는 것만) → paper로
UPDATE orders o SET trading_mode = 'paper'
FROM transaction_chains tc
WHERE o.chain_id = tc.id AND tc.is_paper = true AND o.trading_mode = 'live'
  AND o.kis_order_no IS NULL;

-- ============================================================
-- Phase 5: 중복 OPEN 체인 정리 + UNIQUE 제약조건
-- ============================================================

-- 중복 제거 (stock_code+is_paper 그룹에서 최신 1개만 남기고 CLOSED)
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY stock_code, is_paper ORDER BY opened_at DESC
  ) AS rn
  FROM transaction_chains
  WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING')
)
UPDATE transaction_chains tc
SET status = 'CLOSED', closed_at = NOW(),
    close_reason = '026: 중복 OPEN 체인 정리'
FROM ranked r WHERE tc.id = r.id AND r.rn > 1;

-- Partial unique index
DROP INDEX IF EXISTS uix_chain_stock_mode_open;
CREATE UNIQUE INDEX uix_chain_stock_mode_open
  ON transaction_chains (stock_code, is_paper)
  WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING');

-- ============================================================
-- Phase 6: 인덱스
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_overseas_holdings_mode ON overseas_holdings(is_paper);
CREATE INDEX IF NOT EXISTS idx_score_accuracy_mode ON score_accuracy(is_paper, recorded_at DESC);
