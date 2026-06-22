-- defense_park_state 실전/연습 분리
-- paper/live 각각 독립적인 파킹 상태 유지

ALTER TABLE defense_park_state
  ADD COLUMN IF NOT EXISTS is_paper BOOLEAN NOT NULL DEFAULT FALSE;

-- 기존 활성 레코드는 live(false) 소속으로 유지 (이미 DEFAULT FALSE)

-- 기존 unique index 교체: (is_active=TRUE) 전체 → (is_paper) 별 고유
DROP INDEX IF EXISTS idx_defense_park_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_defense_park_active_paper
  ON defense_park_state(is_paper) WHERE is_active = TRUE;
