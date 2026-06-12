-- AI 점수 시계열 — 갱신 때마다 추가 (UPSERT 대신 INSERT)
-- UI 그래프 + 변화 추적용
CREATE TABLE IF NOT EXISTS ai_scores_history (
  id SERIAL PRIMARY KEY,
  stock_code TEXT NOT NULL,
  composite_score NUMERIC(5,2),
  technical_score NUMERIC(5,2),
  sentiment_score NUMERIC(5,2),
  source TEXT, -- 'quick_rss', 'ensemble', 'enhanced' 등
  delta_from_prev NUMERIC(5,2), -- 직전 대비 변화
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_scores_history_code_time
  ON ai_scores_history(stock_code, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_scores_history_time
  ON ai_scores_history(recorded_at DESC);

-- 30일+ 자동 정리 (운영 데이터)
-- data-archiver.ts에서 별도 처리
