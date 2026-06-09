-- ai_overrides: (key) 단독 unique → (key, is_paper) 복합 unique로 전환
-- 기존: ON CONFLICT (key) → paper/live가 같은 key 쓰면 서로 덮어씀 (교차 오염!)
-- 수정: ON CONFLICT (key, is_paper) → paper/live 독립 행으로 분리

-- 1. 중복 데이터 정리 (혹시 같은 key에 paper/live 둘 다 있으면 최신 것만 남김)
DELETE FROM ai_overrides a
USING (
  SELECT key, is_paper, MAX(updated_at) AS latest
  FROM ai_overrides
  GROUP BY key, is_paper
) keep
WHERE a.key = keep.key
  AND a.is_paper = keep.is_paper
  AND a.updated_at < keep.latest;

-- 2. 기존 UNIQUE (key) 제약 제거
ALTER TABLE ai_overrides DROP CONSTRAINT IF EXISTS ai_overrides_key_key;

-- 3. (key, is_paper) 복합 unique 추가
ALTER TABLE ai_overrides
  ADD CONSTRAINT ai_overrides_key_paper_unique UNIQUE (key, is_paper);
