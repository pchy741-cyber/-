-- LTH (Long-Term Hold): 장기보유 플래그
-- LTH=true 종목은 Track B의 일반 SL/TP 자동매도를 무시하고 보유
-- 단, 심각한 하락장(isDowntrendMode)에서는 매도 후 당일 재매수 허용

ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS long_term_hold BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN watchlist.long_term_hold IS 'true: 장기보유 종목 — 일반 SL/TP 무시, 하락장(-5%↓)에서만 매도 후 재매수';
