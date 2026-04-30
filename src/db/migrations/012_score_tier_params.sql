-- 012: 점수 티어별 실거래 역산 파라미터 (자기학습 피드백)
CREATE TABLE IF NOT EXISTS score_tier_params (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_min       SMALLINT NOT NULL,   -- 점수 하한 (60, 70, 80, 90)
  tier_max       SMALLINT NOT NULL,   -- 점수 상한 (69, 79, 89, 100)
  alloc_pct      DECIMAL(5,4) NOT NULL, -- 총자산 대비 투자비율 (예: 0.12 = 12%)
  win_rate       DECIMAL(5,4),        -- 실제 승률
  avg_pnl_pct    DECIMAL(8,4),        -- 실제 평균 수익률
  sample_count   SMALLINT DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tier_min, tier_max)
);

-- 초기값 삽입 (데이터 부족 시 fallback)
INSERT INTO score_tier_params (tier_min, tier_max, alloc_pct, sample_count) VALUES
  (60, 69, 0.06, 0),
  (70, 79, 0.10, 0),
  (80, 89, 0.15, 0),
  (90, 100, 0.20, 0)
ON CONFLICT (tier_min, tier_max) DO NOTHING;
