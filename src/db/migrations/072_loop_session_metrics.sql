-- 루프 세션 메트릭 + 자동복구 추적 컬럼
ALTER TABLE loop_sessions ADD COLUMN IF NOT EXISTS buy_count INT DEFAULT 0;
ALTER TABLE loop_sessions ADD COLUMN IF NOT EXISTS sell_count INT DEFAULT 0;
ALTER TABLE loop_sessions ADD COLUMN IF NOT EXISTS realized_pnl_krw NUMERIC DEFAULT 0;
ALTER TABLE loop_sessions ADD COLUMN IF NOT EXISTS error_count INT DEFAULT 0;
ALTER TABLE loop_sessions ADD COLUMN IF NOT EXISTS last_recovery_at TIMESTAMPTZ;
ALTER TABLE loop_sessions ADD COLUMN IF NOT EXISTS paused_reason TEXT;
ALTER TABLE loop_sessions ADD COLUMN IF NOT EXISTS kill_switch_pauses INT DEFAULT 0;
