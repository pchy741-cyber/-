-- 008: 인사이트 실행력 강화 — 권장사항 + 자동 파라미터 적용 컬럼 추가
ALTER TABLE learned_insights
  ADD COLUMN IF NOT EXISTS recommendation TEXT,         -- 구체적 행동 권장 (UI 표시)
  ADD COLUMN IF NOT EXISTS param_change JSONB,          -- 자동 적용 가능한 파라미터 변경
  ADD COLUMN IF NOT EXISTS is_applied BOOLEAN DEFAULT false,  -- 전략에 적용 여부
  ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;      -- 적용 시각
