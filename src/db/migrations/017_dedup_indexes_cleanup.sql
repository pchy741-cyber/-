-- Migration 017: 중복 인덱스 제거
-- idx_ai_scores_lookup (001) = idx_scores_stock_date (004) → 001 제거
-- idx_snapshots_time (001) = idx_snapshots_at (004) → 001 제거

DROP INDEX IF EXISTS idx_ai_scores_lookup;
DROP INDEX IF EXISTS idx_snapshots_time;
