-- Migration 020: Paper/live chain separation
-- transaction_chains에 is_paper 컬럼 추가 — 모드 전환 시 포지션 섞임 방지

ALTER TABLE transaction_chains ADD COLUMN IF NOT EXISTS is_paper BOOLEAN NOT NULL DEFAULT true;

-- 기존 체인: orders.trading_mode로 역추론 (매수 첫 주문 기준)
UPDATE transaction_chains tc
SET is_paper = (
  SELECT COALESCE(
    (SELECT trading_mode FROM orders
     WHERE chain_id = tc.id AND side = 'BUY'
     ORDER BY created_at ASC LIMIT 1) != 'live',
    true
  )
);

CREATE INDEX IF NOT EXISTS idx_chains_mode ON transaction_chains(is_paper, status);
