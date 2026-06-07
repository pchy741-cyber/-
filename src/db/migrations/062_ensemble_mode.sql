-- 앙상블 AI 스코어링 모드
-- 'fallback' = 기존 순차 폴백, 'ensemble' = 병렬 합산
ALTER TABLE strategy_config ADD COLUMN IF NOT EXISTS
  ai_scoring_mode VARCHAR(20) NOT NULL DEFAULT 'fallback';

-- 앙상블 설정 (가중치, 전략, 최소모델수)
ALTER TABLE strategy_config ADD COLUMN IF NOT EXISTS
  ensemble_config JSONB NOT NULL DEFAULT '{"weights":{"gemini":0.30,"gpt":0.35,"claude":0.20,"rss":0.15},"strategy":"weighted_avg","minModels":2}';
