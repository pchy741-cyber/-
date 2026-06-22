-- 095: 스키마 정합성 감사 결과 수정
-- 1) 고아 테이블 제거
-- 2) sync_sell_pending prefix 누락으로 축적된 고아 키 정리

-- ── 1. profit_withdraw_config: DDL 003에서 생성, 코드에서 0회 참조 → DROP ──
DROP TABLE IF EXISTS profit_withdraw_config;

-- ── 2. overseas_state: prefix 없는 sync_sell_pending 고아 키 정리 ──
-- kis-sync.ts가 'sync_sell_pending_AAPL' (prefix 없음)로 생성했으나
-- positionStateKeys() cleanup이 'l_sync_sell_pending_AAPL' (prefix 있음)로 삭제 시도
-- → unprefixed 키가 영구 잔류. 코드 수정과 함께 기존 고아 키 일괄 제거
DELETE FROM overseas_state
WHERE key LIKE 'sync_sell_pending_%'
  AND key NOT LIKE 'l_sync_sell_pending_%'
  AND key NOT LIKE 'p_sync_sell_pending_%';
