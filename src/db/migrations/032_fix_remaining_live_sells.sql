-- 032_fix_remaining_live_sells.sql
-- 봇 체인의 SELL 주문이 dashboard UI로 실행되어 trigger_source='MANUAL'로 기록된 케이스 교정
-- 원칙: 체인의 BUY가 전부 paper이면, 그 체인의 SELL도 paper여야 함

-- 1. BUY 주문이 전부 paper인데 체인이 아직 live(is_paper=false)인 경우 → paper로 교정
UPDATE transaction_chains tc
SET is_paper = true
WHERE is_paper = false
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.chain_id = tc.id
      AND o.side = 'BUY'
      AND o.trading_mode = 'live'
  );

-- 2. paper 체인에 연결된 모든 live SELL 주문 → paper로 교정
UPDATE orders o
SET trading_mode = 'paper'
FROM transaction_chains tc
WHERE o.chain_id = tc.id
  AND tc.is_paper = true
  AND o.trading_mode = 'live';

-- 3. chain_id가 없는 live 주문 중 trigger_source가 봇인 것 → paper
--    (이미 031에서 처리했지만 혹시 남은 것 재처리)
UPDATE orders
SET trading_mode = 'paper'
WHERE trading_mode = 'live'
  AND chain_id IS NULL
  AND (trigger_source IS NULL OR trigger_source NOT IN ('MANUAL'));
