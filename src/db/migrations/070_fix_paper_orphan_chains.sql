-- Paper 고아 체인 정리: migration 069에서 orders만 삭제했고 transaction_chains는 남아 있어
-- integrity-check가 "수량 불일치 + 고아 체인" 2 critical 오류를 반복 발생시킴
-- 해결: is_paper=true OPEN 체인 중 FILLED 주문이 없는 것들을 CLOSED 처리

-- 1. 고아 paper 체인 → CLOSED (삭제보다 안전 — 이력 보존)
UPDATE transaction_chains
SET status = 'CLOSED',
    closed_at = NOW(),
    notes = COALESCE(notes, '') || ' [auto-closed: orphan after migration-069]'
WHERE is_paper = true
  AND status IN ('OPEN', 'AVERAGING', 'PROFIT_TAKING')
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.chain_id = transaction_chains.id AND o.status = 'FILLED'
  );

-- 2. 수량 불일치 paper 체인 → total_quantity를 실제 주문 합산으로 보정
UPDATE transaction_chains tc
SET total_quantity = COALESCE((
  SELECT COALESCE(SUM(CASE WHEN o.side='BUY' THEN o.filled_quantity ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN o.side='SELL' THEN o.filled_quantity ELSE 0 END), 0)
  FROM orders o WHERE o.chain_id = tc.id AND o.status = 'FILLED'
), 0)
WHERE tc.is_paper = true
  AND tc.status IN ('OPEN', 'AVERAGING', 'PROFIT_TAKING')
  AND tc.total_quantity != COALESCE((
    SELECT COALESCE(SUM(CASE WHEN o.side='BUY' THEN o.filled_quantity ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN o.side='SELL' THEN o.filled_quantity ELSE 0 END), 0)
    FROM orders o WHERE o.chain_id = tc.id AND o.status = 'FILLED'
  ), 0);

-- 3. 남은 paper OPEN 체인 중 total_quantity=0 → CLOSED
UPDATE transaction_chains
SET status = 'CLOSED',
    closed_at = NOW(),
    notes = COALESCE(notes, '') || ' [auto-closed: qty=0 after quantity-fix]'
WHERE is_paper = true
  AND status IN ('OPEN', 'AVERAGING', 'PROFIT_TAKING')
  AND total_quantity <= 0;
