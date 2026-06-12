-- 자동 실패 학습 결과 적재 테이블
-- 매일 02:30 KST runFailureLearning 실행 결과 저장
CREATE TABLE IF NOT EXISTS failure_patterns (
  id SERIAL PRIMARY KEY,
  stock_code TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_trades INT NOT NULL,
  win_rate NUMERIC(4,3),
  worst_loss_pct NUMERIC(6,2),
  consecutive_losses INT DEFAULT 0,
  recommendation TEXT NOT NULL,  -- WATCH / BLOCK_30D / BLOCK_60D / BLOCK_180D / BLOCK_FOREVER
  reason TEXT,
  close_reasons JSONB DEFAULT '{}'::jsonb,
  UNIQUE (stock_code, mode)
);

CREATE INDEX IF NOT EXISTS idx_failure_patterns_mode_rec
  ON failure_patterns(mode, recommendation, analyzed_at DESC);
