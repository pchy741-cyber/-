-- 108: 성능 인덱스 v3 (전수조사 PERF 12)
-- 감사 워크플로우에서 누락 확인된 2개 인덱스

-- 1. score_accuracy: stock_code + market + is_paper + 날짜 복합
--    win-rate.ts (stock_code=ANY + market + is_paper + recorded_at 90일)
--    self-learning/index.ts (stock_code=ANY + is_paper + recorded_at 90일)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_score_accuracy_mkt_date
  ON score_accuracy (stock_code, market, is_paper, recorded_at DESC);

-- 2. system_log: level 필터 + 타임스탬프
--    qa-watchdog.ts: level='error' AND timestamp >= NOW()-1h
--    daily-email-report.ts: level IN ('error','warn') AND timestamp >= ...
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_system_log_level
  ON system_log (level, timestamp DESC);
