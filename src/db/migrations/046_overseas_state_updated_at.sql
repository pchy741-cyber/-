-- 046: overseas_state 에 updated_at 추가 + 자동갱신 트리거
-- 대시보드에서 스테일 데이터(2시간+) 감지 → 국내 잔고 API 폴백

ALTER TABLE overseas_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE OR REPLACE FUNCTION update_overseas_state_ts()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_overseas_state_ts ON overseas_state;
CREATE TRIGGER trg_overseas_state_ts
  BEFORE INSERT OR UPDATE ON overseas_state
  FOR EACH ROW EXECUTE FUNCTION update_overseas_state_ts();
