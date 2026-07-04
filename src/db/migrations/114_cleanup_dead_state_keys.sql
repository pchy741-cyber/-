-- 114: overseas_state 데드 키 정리 v2
-- partialtpdone_* (partial_tp_stage_*로 대체됨) 잔류 키 제거
-- 048에서 prefix-less 키 삭제했지만 mode-prefixed 버전(p_/l_) 잔류 가능

DELETE FROM overseas_state
WHERE key LIKE '%partialtpdone_%';

-- orphan maxprice/dynamic_tpsl 재정리 (048 이후 누적분)
DELETE FROM overseas_state
WHERE key ~ '^[pl]_(maxprice|dynamic_tpsl)_'
  AND SUBSTRING(key FROM '[^_]+$') NOT IN (
    SELECT stock_code FROM overseas_holdings WHERE quantity > 0
  );

-- 만료된 manual_sell_cd_ 키 재정리
DELETE FROM overseas_state
WHERE key LIKE 'manual_sell_cd_%'
  AND (
    value::jsonb->>'at' IS NULL
    OR (value::jsonb->>'at')::timestamptz < NOW() - INTERVAL '24 hours'
  );
