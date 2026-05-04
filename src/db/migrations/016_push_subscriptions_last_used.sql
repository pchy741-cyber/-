-- push_subscriptions 테이블 last_used 컬럼 추가 (없는 경우에만)
ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS last_used TIMESTAMPTZ DEFAULT NOW();
