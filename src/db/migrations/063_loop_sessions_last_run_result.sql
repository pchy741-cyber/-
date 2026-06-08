-- loop_sessions에 last_run_result 컬럼 추가 (loop-mode.ts에서 참조)
ALTER TABLE loop_sessions ADD COLUMN IF NOT EXISTS last_run_result TEXT;
