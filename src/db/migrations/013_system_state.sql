-- system_state: 프로세스 재시작 후에도 유지되어야 하는 시스템 상태 키-값 저장소
-- Kill Switch 상태 등 in-memory 소실 방지용

CREATE TABLE IF NOT EXISTS system_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION system_state_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_system_state_updated_at
BEFORE UPDATE ON system_state
FOR EACH ROW EXECUTE FUNCTION system_state_updated_at();
