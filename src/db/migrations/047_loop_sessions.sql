-- 루프 세션 영속화 + 틱 이력
CREATE TABLE IF NOT EXISTS loop_sessions (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  total_runs INT DEFAULT 0,
  consecutive_errors INT DEFAULT 0,
  phase TEXT DEFAULT 'REVIEWING',
  stop_reason TEXT,
  session_brief JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loop_ticks (
  id SERIAL PRIMARY KEY,
  session_id INT REFERENCES loop_sessions(id),
  tick_num INT NOT NULL,
  result TEXT NOT NULL,
  duration_ms INT,
  interval_ms INT,
  market_phase TEXT,
  executed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loop_sessions_active ON loop_sessions(ended_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_loop_ticks_session ON loop_ticks(session_id);
