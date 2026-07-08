-- SEC(미국) 리서치 결과 DB 캐시 — 재배포/재시작에도 유지 (인메모리 _resultCache 보완)
-- 버튼 캐시우선: 자동로드가 Gemini 없이 DB에서 즉시 반환
CREATE TABLE IF NOT EXISTS sec_research_cache (
  ticker VARCHAR(10) NOT NULL,
  year INTEGER NOT NULL,
  result JSONB NOT NULL,
  fundamental_score NUMERIC,
  analyzed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (ticker, year)
);

CREATE INDEX IF NOT EXISTS idx_sec_cache_analyzed ON sec_research_cache (analyzed_at DESC);
