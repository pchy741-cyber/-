-- v10: 인사이트 삭제 반복 버그 수정
-- 기존: DELETE → 재생성 루프 (dismiss 기억 없음)
-- 수정: soft-delete (is_dismissed) → saveInsights가 dismissed 행 보존

ALTER TABLE learned_insights ADD COLUMN IF NOT EXISTS is_dismissed BOOLEAN DEFAULT FALSE;
ALTER TABLE learned_insights ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

-- dismissed 인사이트는 목록 조회에서 제외
CREATE INDEX IF NOT EXISTS idx_insights_dismissed
  ON learned_insights (is_paper, is_dismissed)
  WHERE is_dismissed IS NOT TRUE;
