-- Ghost paper OPEN chains 정리 (2026-06-19)
-- 증상: checkAndRefillPaper가 orders를 paper_archived_N으로 아카이브했으나
--       transaction_chains는 OPEN 상태로 잔류 → holdingsCost 계산 시 ghost 비용으로 누적
--       000890(16.85M) + 004490(25.07M) = 41.9M > 시드(30M) → 주문가능금액 0원

-- 1. 현재 paper OPEN chains 현황 (참고용)
SELECT stock_code, status, total_quantity, total_invested, opened_at
FROM transaction_chains
WHERE is_paper = true
  AND status IN ('OPEN','AVERAGING','PROFIT_TAKING')
  AND stock_code ~ '^[0-9]{6}$'
ORDER BY opened_at DESC;

-- 2. paper_archived_% orders와 연결된 chains는 이미 아카이브된 포지션 → CLOSED
UPDATE transaction_chains
SET status = 'CLOSED',
    closed_at = NOW(),
    close_reason = 'ghost_cleanup',
    notes = COALESCE(notes, '') || ' [auto-closed: orders archived to p_arch but chains left OPEN]'
WHERE is_paper = true
  AND status IN ('OPEN','AVERAGING','PROFIT_TAKING')
  AND stock_code ~ '^[0-9]{6}$'
  AND (
    -- (A) 현재 trading_mode='paper' FILLED 주문이 하나도 없는 chains
    NOT EXISTS (
      SELECT 1 FROM orders o
      WHERE o.chain_id = transaction_chains.id
        AND o.status = 'FILLED'
        AND o.trading_mode = 'paper'
    )
    OR
    -- (B) BUY qty <= SELL qty (실질적으로 청산된 포지션)
    (
      SELECT COALESCE(SUM(CASE WHEN o.side='BUY' THEN o.filled_quantity ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN o.side='SELL' THEN o.filled_quantity ELSE 0 END), 0)
      FROM orders o
      WHERE o.chain_id = transaction_chains.id AND o.status = 'FILLED'
    ) <= 0
  );

-- 3. 수량이 0인 chains 추가 정리
UPDATE transaction_chains
SET status = 'CLOSED',
    closed_at = NOW(),
    close_reason = 'zero_qty',
    notes = COALESCE(notes, '') || ' [auto-closed: qty=0]'
WHERE is_paper = true
  AND status IN ('OPEN','AVERAGING','PROFIT_TAKING')
  AND stock_code ~ '^[0-9]{6}$'
  AND total_quantity <= 0;

-- 4. 정리 결과 확인
SELECT
  COUNT(*) FILTER (WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING')) AS open_chains_remaining,
  COUNT(*) FILTER (WHERE status = 'CLOSED') AS closed_chains,
  COALESCE(SUM(total_invested) FILTER (WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING')), 0) AS remaining_invested
FROM transaction_chains
WHERE is_paper = true AND stock_code ~ '^[0-9]{6}$';
