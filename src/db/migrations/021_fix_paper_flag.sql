-- Migration 021: is_paper 플래그 교정
-- 020에서 first-BUY 기준으로 설정했으나, 모드 전환 타이밍 레이스로 오분류된 체인 수정
-- 규칙: paper 주문만 있는 체인 → is_paper=true / live 주문만 있는 체인 → is_paper=false

-- paper 주문만 있는데 is_paper=false 인 체인 → true로 교정
UPDATE transaction_chains tc
SET is_paper = true
WHERE tc.is_paper = false
  AND NOT EXISTS (
    SELECT 1 FROM orders
    WHERE chain_id = tc.id AND trading_mode = 'live' AND status = 'FILLED'
  )
  AND EXISTS (
    SELECT 1 FROM orders
    WHERE chain_id = tc.id AND trading_mode = 'paper' AND status = 'FILLED'
  );

-- live 주문만 있는데 is_paper=true 인 체인 → false로 교정
UPDATE transaction_chains tc
SET is_paper = false
WHERE tc.is_paper = true
  AND NOT EXISTS (
    SELECT 1 FROM orders
    WHERE chain_id = tc.id AND trading_mode = 'paper' AND status = 'FILLED'
  )
  AND EXISTS (
    SELECT 1 FROM orders
    WHERE chain_id = tc.id AND trading_mode = 'live' AND status = 'FILLED'
  );
