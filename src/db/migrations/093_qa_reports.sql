-- 093: QA Watchdog 리포트 영구 저장 (인메모리 → DB)

CREATE TABLE IF NOT EXISTS qa_reports (
  id SERIAL PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  elapsed_sec NUMERIC NOT NULL DEFAULT 0,
  issues JSONB NOT NULL DEFAULT '[]',
  critical INTEGER NOT NULL DEFAULT 0,
  warning INTEGER NOT NULL DEFAULT 0,
  info INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pass' CHECK (status IN ('pass', 'warn', 'fail'))
);

CREATE INDEX IF NOT EXISTS idx_qa_reports_run_at ON qa_reports(run_at DESC);

-- 30일 넘은 리포트 자동 정리 (cron에서 호출)
-- DELETE FROM qa_reports WHERE run_at < NOW() - INTERVAL '30 days';
