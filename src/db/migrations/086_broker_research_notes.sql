-- 086_broker_research_notes.sql
-- 증권사 리서치 노트 — URL 크롤링으로 수집, Track A Gemini에 주입

CREATE TABLE IF NOT EXISTS broker_research_notes (
  id          SERIAL PRIMARY KEY,
  url         TEXT,
  title       TEXT,
  content     TEXT NOT NULL,
  memo        TEXT,
  fetched_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 최근 노트 조회 인덱스
CREATE INDEX IF NOT EXISTS idx_broker_research_fetched
  ON broker_research_notes (fetched_at DESC);
