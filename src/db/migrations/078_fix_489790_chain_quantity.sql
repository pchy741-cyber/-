-- 489790(한화비전) 체인: BUY 2주 FILLED인데 체인 quantity=0 불일치 수정
-- orders 테이블 기준으로 체인 quantity/invested 동기화
UPDATE transaction_chains
SET total_quantity = sub.total_qty,
    total_invested = sub.total_inv
FROM (
  SELECT chain_id,
         SUM(CASE WHEN side='BUY' THEN quantity ELSE -quantity END) AS total_qty,
         SUM(CASE WHEN side='BUY' THEN quantity * filled_price ELSE 0 END) AS total_inv
  FROM orders
  WHERE chain_id = 'b97ec292-d153-4de2-b7ec-46ac0a3e2386'
    AND status = 'FILLED'
  GROUP BY chain_id
) sub
WHERE transaction_chains.id = sub.chain_id
  AND transaction_chains.total_quantity = 0;
