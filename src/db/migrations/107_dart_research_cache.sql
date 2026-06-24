-- DART 퀀트 분석 결과 DB 캐시
-- 동일 종목+동일 분기 재분석 방지 (분기 변경 시만 재실행)
CREATE TABLE IF NOT EXISTS dart_research_cache (
  stock_code VARCHAR(10) NOT NULL,
  year VARCHAR(4) NOT NULL,
  quarter VARCHAR(10) NOT NULL,
  result JSONB NOT NULL,
  fundamental_score NUMERIC,
  piotroski_score INTEGER,
  analyzed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (stock_code, year, quarter)
);

CREATE INDEX IF NOT EXISTS idx_dart_cache_analyzed ON dart_research_cache (analyzed_at DESC);
