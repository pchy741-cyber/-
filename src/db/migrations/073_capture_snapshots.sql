-- 캡쳐 진단 시계열 보존 (Copilot 점수, 이슈, 권장 액션)
CREATE TABLE IF NOT EXISTS capture_snapshots (
  id SERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  trigger TEXT NOT NULL,                    -- manual, kill_switch, loop_paused, mdd_danger, error_burst, scheduled
  score INT NOT NULL,
  issues JSONB DEFAULT '[]'::jsonb,         -- [{id, level, label}]
  actions JSONB DEFAULT '[]'::jsonb,        -- [{id, level, action, target?}]
  loop_session_id INT,                       -- FK loop_sessions(id) — 발생 시점 루프 세션
  telegram_sent BOOLEAN DEFAULT false,
  screenshot_count INT DEFAULT 0,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capture_snapshots_mode_at ON capture_snapshots(mode, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_snapshots_trigger ON capture_snapshots(trigger, captured_at DESC);
