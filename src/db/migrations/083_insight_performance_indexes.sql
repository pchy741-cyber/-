-- 인사이트 성능강화 인덱스
-- learned_insights: 프롬프트 조회 (status + confidence DESC)
CREATE INDEX IF NOT EXISTS idx_learned_insights_status_confidence
  ON learned_insights (status, confidence DESC);

-- learned_insights: 카테고리별 최신순 조회
CREATE INDEX IF NOT EXISTS idx_learned_insights_category_created
  ON learned_insights (category, created_at DESC);

-- trade_history: 분석 쿼리 속도 (executed_at DESC)
CREATE INDEX IF NOT EXISTS idx_trade_history_executed_at
  ON trade_history (executed_at DESC);
