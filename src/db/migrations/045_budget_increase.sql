-- 045: 선물 예산 상한 증가 (10만 → 50만)
UPDATE futures_budget SET max_budget_krw = 500000 WHERE id = 1;
UPDATE feature_flags SET config = '{"description":"해외선물 마이크로 트레이딩 (극소액)","max_budget_krw":500000}' WHERE key = 'overseas_futures';
