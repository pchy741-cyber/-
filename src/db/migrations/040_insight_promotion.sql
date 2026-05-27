-- 040: 연습모드 인사이트 → 실전 프로모션 기능
-- paper에서 검증된 좋은 인사이트를 live로 안전하게 복사

-- 프로모션 추적 컬럼
ALTER TABLE learned_insights ADD COLUMN IF NOT EXISTS promoted_from_id UUID REFERENCES learned_insights(id) ON DELETE SET NULL;
ALTER TABLE learned_insights ADD COLUMN IF NOT EXISTS source_mode TEXT DEFAULT 'native';
ALTER TABLE learned_insights ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;
ALTER TABLE learned_insights ADD COLUMN IF NOT EXISTS is_promoted BOOLEAN DEFAULT FALSE;

-- 실전 검증 추적
ALTER TABLE learned_insights ADD COLUMN IF NOT EXISTS live_validation_status TEXT DEFAULT NULL;
ALTER TABLE learned_insights ADD COLUMN IF NOT EXISTS live_win_count INTEGER DEFAULT 0;
ALTER TABLE learned_insights ADD COLUMN IF NOT EXISTS live_loss_count INTEGER DEFAULT 0;
ALTER TABLE learned_insights ADD COLUMN IF NOT EXISTS live_validated_at TIMESTAMPTZ;

-- 중복 프로모션 방지 (같은 paper 인사이트를 2번 프로모션 불가)
CREATE UNIQUE INDEX IF NOT EXISTS uix_insights_promoted_source
  ON learned_insights(promoted_from_id)
  WHERE promoted_from_id IS NOT NULL;

-- 프로모션 가능 후보 빠른 조회
CREATE INDEX IF NOT EXISTS idx_insights_promotable
  ON learned_insights(is_paper, category, confidence DESC)
  WHERE is_paper = TRUE AND category IN ('WIN_PATTERN', 'TIMING', 'SIZING');
