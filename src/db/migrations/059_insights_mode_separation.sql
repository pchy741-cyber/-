-- 059: learned_insights paper/live 완전 분리
-- 기존 unique constraint (category, insight)를 (category, insight, is_paper)로 변경
-- 크로스오염 방지: paper 학습이 live 학습을 덮어쓰는 문제 해결

-- 기존 unique index 직접 제거 (이름이 있으면)
DROP INDEX IF EXISTS uix_insights_category_insight;
DROP INDEX IF EXISTS idx_insights_category_insight;
DROP INDEX IF EXISTS learned_insights_category_insight_key;

-- 중복 제거 (같은 category+insight+is_paper 중 최신만 유지)
DELETE FROM learned_insights a USING learned_insights b
WHERE a.last_updated < b.last_updated AND a.category = b.category AND a.insight = b.insight AND a.is_paper = b.is_paper;

-- 새 unique index: (category, insight, is_paper)
CREATE UNIQUE INDEX IF NOT EXISTS uix_insights_category_insight_mode
  ON learned_insights(category, insight, is_paper);
