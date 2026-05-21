-- Migration 019: Schema cleanup
-- 감사 결과 발견된 3가지 불일치 수정

-- #1: 고아 컬럼 제거
-- 018이 last_used_at을 추가했으나 코드는 016에서 추가된 last_used만 사용
ALTER TABLE push_subscriptions DROP COLUMN IF EXISTS last_used_at;

-- #2: stock_code VARCHAR 통일
-- watchlist: VARCHAR(10) / ai_scores·transaction_chains·orders: VARCHAR(6) → 10으로 확장
-- 미국주식 티커(GOOGL 등) 참조 가능하도록 맞춤
ALTER TABLE ai_scores          ALTER COLUMN stock_code TYPE VARCHAR(10);
ALTER TABLE transaction_chains ALTER COLUMN stock_code TYPE VARCHAR(10);
ALTER TABLE orders             ALTER COLUMN stock_code TYPE VARCHAR(10);
