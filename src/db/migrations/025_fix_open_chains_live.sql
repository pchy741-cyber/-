-- Migration 025: 실전 OPEN 체인 완전 교정
-- 서버가 paper 모드로 부팅되어 실전 주문이 trading_mode='paper'로 저장된 문제 수정
-- 현재 OPEN 상태 체인 = 실제 보유 포지션이므로 전부 실전으로 전환

-- [1] OPEN 체인 전체를 실전으로 교정
UPDATE transaction_chains
SET is_paper = false
WHERE status != 'CLOSED';

-- [2] OPEN 체인에 속한 주문을 trading_mode='live'로 교정
-- (paper 모드로 잘못 저장된 실전 주문 복구)
UPDATE orders
SET trading_mode = 'live'
WHERE chain_id IN (
  SELECT id FROM transaction_chains WHERE status != 'CLOSED'
)
AND trading_mode = 'paper';

-- [3] 고아 주문(chain_id NULL) 중 OPEN/PENDING 상태인 것도 교정
UPDATE orders
SET trading_mode = 'live'
WHERE chain_id IS NULL
  AND status IN ('OPEN', 'PENDING')
  AND trading_mode = 'paper';
