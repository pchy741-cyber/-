-- 060: 059에서 중복 때문에 인덱스 생성 실패한 경우 재시도
-- 중복 제거 후 unique index 재생성

-- 중복 제거 (같은 category+insight+is_paper 중 최신만 유지)
DELETE FROM learned_insights a USING learned_insights b
WHERE a.last_updated < b.last_updated AND a.category = b.category AND a.insight = b.insight AND a.is_paper = b.is_paper;

-- unique index (이미 있으면 스킵)
CREATE UNIQUE INDEX IF NOT EXISTS uix_insights_category_insight_mode
  ON learned_insights(category, insight, is_paper);
