-- 054: 배당 + 선물 feature flag 활성화
UPDATE feature_flags SET enabled = TRUE, updated_at = NOW() WHERE key = 'dividend_investing' AND enabled = FALSE;
UPDATE feature_flags SET enabled = TRUE, updated_at = NOW() WHERE key = 'overseas_futures' AND enabled = FALSE;
