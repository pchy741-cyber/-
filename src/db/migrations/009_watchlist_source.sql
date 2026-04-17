-- 009: watchlist source tracking
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS source VARCHAR(30) NOT NULL DEFAULT 'MANUAL';
-- MANUAL: user added via dashboard
-- KIS_SYNC: synced from KIS interest group
-- AUTO: auto-added by trading engine
