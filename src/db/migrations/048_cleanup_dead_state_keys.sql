-- 048: overseas_state에 축적된 dead 키 (이미 청산된 포지션의 잔류 상태) 일괄 정리
-- cleanupPositionState() 통합 헬퍼가 향후 방지하지만, 기존 누적분은 이 마이그레이션으로 제거

-- 1) maxprice, partial_tp_stage, dynamic_tpsl, scale_in, turtle_trail 키 중
--    현재 보유하지 않는 종목의 orphan 키 삭제
DELETE FROM overseas_state
WHERE key ~ '^[pl]_(maxprice|partial_tp_stage|dynamic_tpsl|scale_in|turtle_trail)_'
  AND SUBSTRING(key FROM '[^_]+$') NOT IN (
    SELECT stock_code FROM overseas_holdings WHERE quantity > 0
  );

-- 2) sync_sell_pending_ 디바운스 키 중 현재 보유 중인 종목의 잔류 키 삭제
DELETE FROM overseas_state
WHERE key LIKE 'sync_sell_pending_%'
  AND SUBSTRING(key FROM 'sync_sell_pending_(.+)$') NOT IN (
    SELECT stock_code FROM overseas_holdings WHERE quantity > 0 AND is_paper = false
  );

-- 3) manual_sell_cd_ 쿨다운 키 중 24시간 이상 경과한 것 삭제
DELETE FROM overseas_state
WHERE key LIKE 'manual_sell_cd_%'
  AND (
    value::jsonb->>'at' IS NULL
    OR (value::jsonb->>'at')::timestamptz < NOW() - INTERVAL '24 hours'
  );

-- 4) concentration_code가 현재 보유하지 않는 종목을 가리키면 삭제
DELETE FROM overseas_state
WHERE key IN ('p_concentration_code', 'l_concentration_code')
  AND value NOT IN (
    SELECT stock_code FROM overseas_holdings WHERE quantity > 0
  );
