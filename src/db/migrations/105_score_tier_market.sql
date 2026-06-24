-- 105: score_tier_params에 market 컬럼 추가 (KR/US 분리 보정)
-- 기존 행은 KR로 간주

ALTER TABLE score_tier_params
  ADD COLUMN IF NOT EXISTS market VARCHAR(4) NOT NULL DEFAULT 'KR';

-- 기존 unique 제약 제거 후 market 포함으로 재생성
ALTER TABLE score_tier_params
  DROP CONSTRAINT IF EXISTS score_tier_params_tier_min_tier_max_key;

ALTER TABLE score_tier_params
  ADD CONSTRAINT score_tier_params_tier_market_uniq UNIQUE (tier_min, tier_max, market);
