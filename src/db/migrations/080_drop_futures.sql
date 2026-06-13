-- 080: 선물 기능 완전 제거 — 테이블/인덱스/feature flag 정리

DROP TABLE IF EXISTS futures_positions CASCADE;
DROP TABLE IF EXISTS futures_trades CASCADE;
DROP TABLE IF EXISTS futures_budget CASCADE;

DELETE FROM feature_flags WHERE key = 'overseas_futures';
