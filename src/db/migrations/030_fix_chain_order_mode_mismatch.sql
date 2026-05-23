-- 030_fix_chain_order_mode_mismatch.sql
-- 체인 is_paper와 주문 trading_mode 불일치 수정
-- 원인: 서버 모드 전환 중 체인 생성 시 config.isPaper를 사용하여
--       BUY 주문은 paper인데 체인은 live로 기록된 케이스

-- 1. BUY 주문이 paper인데 체인이 live인 OPEN 체인 → paper로 수정
UPDATE transaction_chains tc
SET is_paper = true
WHERE tc.status IN ('OPEN', 'AVERAGING', 'PROFIT_TAKING')
  AND tc.is_paper = false
  AND EXISTS (
    SELECT 1 FROM orders o
    WHERE o.chain_id = tc.id
      AND o.side = 'BUY'
      AND o.status = 'FILLED'
      AND o.trading_mode = 'paper'
  );

-- 2. BUY 주문이 live인데 체인이 paper인 OPEN 체인 → live로 수정
UPDATE transaction_chains tc
SET is_paper = false
WHERE tc.status IN ('OPEN', 'AVERAGING', 'PROFIT_TAKING')
  AND tc.is_paper = true
  AND EXISTS (
    SELECT 1 FROM orders o
    WHERE o.chain_id = tc.id
      AND o.side = 'BUY'
      AND o.status = 'FILLED'
      AND o.trading_mode = 'live'
  );

-- 3. chain_id 없는 paper BUY 주문 → 해당 종목의 OPEN live 체인에 연결
-- (BUY 주문의 stock_code가 OPEN 체인의 stock_code와 매칭되고, 수량도 일치)
UPDATE orders o
SET chain_id = tc.id
FROM transaction_chains tc
WHERE o.chain_id IS NULL
  AND o.side = 'BUY'
  AND o.status = 'FILLED'
  AND o.stock_code = tc.stock_code
  AND tc.status IN ('OPEN', 'AVERAGING', 'PROFIT_TAKING')
  AND o.filled_quantity = tc.total_quantity;

-- 4. 연결 후 해당 체인의 is_paper도 주문 모드에 맞게 수정
UPDATE transaction_chains tc
SET is_paper = (o.trading_mode = 'paper')
FROM orders o
WHERE o.chain_id = tc.id
  AND o.side = 'BUY'
  AND o.status = 'FILLED'
  AND tc.status IN ('OPEN', 'AVERAGING', 'PROFIT_TAKING')
  AND tc.is_paper != (o.trading_mode = 'paper');

-- 5. SELL 주문의 trading_mode도 체인 모드에 맞게 통일
UPDATE orders o
SET trading_mode = CASE WHEN tc.is_paper THEN 'paper' ELSE 'live' END
FROM transaction_chains tc
WHERE o.chain_id = tc.id
  AND o.side = 'SELL'
  AND o.status = 'FILLED'
  AND o.trading_mode != CASE WHEN tc.is_paper THEN 'paper' ELSE 'live' END;
