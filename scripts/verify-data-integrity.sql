-- ═══════════════════════════════════════════════════════════════════
-- Paper/Live 데이터 정합성 검증 쿼리
-- 실행: Cloud SQL Proxy 연결 후 psql로 실행
-- ═══════════════════════════════════════════════════════════════════

-- 1) orders.trading_mode vs transaction_chains.is_paper 불일치
--    주문이 live인데 체인이 paper이거나 그 반대
SELECT 'MODE_MISMATCH' AS check_type,
       o.id AS order_id, o.chain_id, o.trading_mode,
       tc.is_paper AS chain_is_paper, o.side, o.stock_code, o.created_at
FROM orders o
JOIN transaction_chains tc ON o.chain_id = tc.id
WHERE (o.trading_mode = 'paper' AND tc.is_paper = FALSE)
   OR (o.trading_mode = 'live' AND tc.is_paper = TRUE)
ORDER BY o.created_at DESC
LIMIT 50;

-- 2) 체인 없는 주문 (고아 주문) — chain_id가 있는데 해당 체인이 삭제됨
SELECT 'ORPHAN_ORDER' AS check_type,
       o.id, o.chain_id, o.stock_code, o.side, o.trading_mode, o.created_at
FROM orders o
LEFT JOIN transaction_chains tc ON o.chain_id = tc.id
WHERE o.chain_id IS NOT NULL AND tc.id IS NULL
ORDER BY o.created_at DESC
LIMIT 20;

-- 3) OPEN 체인인데 avg_buy_price = 0 또는 NULL (가격 오염)
SELECT 'ZERO_AVG_PRICE' AS check_type,
       id, stock_code, stock_name, is_paper, avg_buy_price,
       total_quantity, opened_at
FROM transaction_chains
WHERE status = 'OPEN'
  AND (avg_buy_price IS NULL OR avg_buy_price = 0)
  AND total_quantity > 0;

-- 4) OPEN 체인인데 매수 주문이 없는 경우 (유령 체인)
SELECT 'GHOST_CHAIN' AS check_type,
       tc.id, tc.stock_code, tc.is_paper, tc.total_quantity, tc.opened_at
FROM transaction_chains tc
LEFT JOIN orders o ON o.chain_id = tc.id AND o.side = 'BUY' AND o.status = 'FILLED'
WHERE tc.status = 'OPEN'
  AND tc.total_quantity > 0
  AND o.id IS NULL;

-- 5) 해외 overseas_holdings: is_paper 플래그 vs overseas_state 키 불일치
SELECT 'OVERSEAS_MODE_MISMATCH' AS check_type,
       oh.stock_code, oh.is_paper,
       os_paper.key AS paper_state_key,
       os_live.key AS live_state_key
FROM overseas_holdings oh
LEFT JOIN overseas_state os_paper ON os_paper.key = 'p_maxprice_' || oh.stock_code
LEFT JOIN overseas_state os_live  ON os_live.key  = 'l_maxprice_' || oh.stock_code
WHERE oh.quantity > 0
  AND ((oh.is_paper = TRUE AND os_paper.key IS NULL AND os_live.key IS NOT NULL)
    OR (oh.is_paper = FALSE AND os_live.key IS NULL AND os_paper.key IS NOT NULL));

-- 6) 미체결 주문 오래된 것 (1시간 이상 PENDING/SUBMITTED)
SELECT 'STALE_PENDING' AS check_type,
       id, stock_code, side, quantity, price, trading_mode, status, created_at,
       NOW() - created_at AS age
FROM orders
WHERE status IN ('PENDING', 'SUBMITTED')
  AND created_at < NOW() - INTERVAL '1 hour'
ORDER BY created_at;

-- 7) 일별 모드별 거래 요약 (최근 7일) — paper/live 거래량 균형 확인
SELECT date_trunc('day', created_at)::date AS day,
       trading_mode,
       COUNT(*) AS order_count,
       COUNT(CASE WHEN side = 'BUY' THEN 1 END) AS buys,
       COUNT(CASE WHEN side = 'SELL' THEN 1 END) AS sells,
       COALESCE(SUM(CASE WHEN side = 'BUY' THEN filled_price * filled_quantity END), 0)::bigint AS buy_volume,
       COALESCE(SUM(CASE WHEN side = 'SELL' THEN filled_price * filled_quantity END), 0)::bigint AS sell_volume
FROM orders
WHERE created_at >= NOW() - INTERVAL '7 days'
  AND status = 'FILLED'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- 8) overseas_state 중복/오염 키 (paper/live 접두사 혼재)
SELECT 'OVERSEAS_STATE_CONFLICT' AS check_type,
       REPLACE(REPLACE(key, 'p_maxprice_', ''), 'l_maxprice_', '') AS code,
       COUNT(*) AS key_count,
       array_agg(key) AS conflicting_keys
FROM overseas_state
WHERE key LIKE '%maxprice_%'
GROUP BY REPLACE(REPLACE(key, 'p_maxprice_', ''), 'l_maxprice_', '')
HAVING COUNT(*) > 2;
