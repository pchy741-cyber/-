-- 031_force_bot_trades_paper.sql
-- 봇 트레이드는 전부 paper로 강제 교정
-- 원칙: trigger_source가 'MANUAL'이 아닌 모든 거래 = paper
-- 실계좌로 유저가 직접 산 것(MANUAL)만 live

-- 1. 봇이 만든 주문 전부 paper로 교정
UPDATE orders
SET trading_mode = 'paper'
WHERE trading_mode = 'live'
  AND (trigger_source IS NULL OR trigger_source != 'MANUAL');

-- 2. MANUAL 주문이 하나도 없는 체인 → paper로 교정
UPDATE transaction_chains tc
SET is_paper = true
WHERE is_paper = false
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.chain_id = tc.id
      AND o.trigger_source = 'MANUAL'
  );

-- 3. MANUAL 주문이 있는 체인은 live 유지 (is_paper = false)
-- (이미 false이므로 변경 불필요, 확인용)

-- 4. 봇 체인에 연결된 SELL 주문도 paper로 통일
UPDATE orders o
SET trading_mode = 'paper'
FROM transaction_chains tc
WHERE o.chain_id = tc.id
  AND tc.is_paper = true
  AND o.trading_mode = 'live';
