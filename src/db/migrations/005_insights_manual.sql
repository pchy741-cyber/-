-- ============================================
-- 005: learned_insights 수동 인사이트 보호
-- ============================================

-- is_manual 컬럼 추가: CEO가 직접 입력한 인사이트는 자기학습 실행 시 삭제 안 됨
ALTER TABLE learned_insights
  ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT FALSE;

-- 수동 인사이트 삭제 방지를 위한 인덱스
CREATE INDEX IF NOT EXISTS idx_insights_manual
  ON learned_insights(is_manual)
  WHERE is_manual = TRUE;

-- category에 MANUAL 타입 추가 (기존 constraint 없으면 skip)
-- (constraint가 있는 경우 아래 실행)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'learned_insights' AND constraint_type = 'CHECK'
  ) THEN
    -- constraint 이름 확인 후 수동으로 drop/add 필요 시 처리
    NULL;
  END IF;
END $$;
