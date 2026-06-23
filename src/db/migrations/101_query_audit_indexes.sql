-- 쿼리 전수조사 결과 — 누락 인덱스 추가
-- overseas_holdings: quantity>0 AND is_paper 쿼리 일 15회+ (full scan → index scan)
CREATE INDEX IF NOT EXISTS idx_overseas_holdings_active
  ON overseas_holdings (is_paper) WHERE quantity > 0;

-- pending_decisions: status='PENDING' 필터 빈번
CREATE INDEX IF NOT EXISTS idx_pending_decisions_status
  ON pending_decisions (status) WHERE status = 'PENDING';

-- defense_park_state: is_active=TRUE + ORDER BY entered_at DESC
CREATE INDEX IF NOT EXISTS idx_defense_park_active
  ON defense_park_state (entered_at DESC) WHERE is_active = TRUE;
