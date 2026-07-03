-- Tier 7: 레짐별 자기학습을 위한 market_regime 컬럼 추가
-- nullable → 기존 쿼리 영향 없음

ALTER TABLE score_accuracy
  ADD COLUMN IF NOT EXISTS market_regime VARCHAR(10);
